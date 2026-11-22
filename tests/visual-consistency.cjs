'use strict';

// Read-only browser layout regression: synthetic library, mocked IPC, no app data.
// Run directly with: node tests/visual-consistency.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require(process.env.ORBIT_PLAYWRIGHT_PATH || 'playwright');
const {installFixture} = require('./fixtures/renderer.cjs');

const root = path.resolve(__dirname, '..');
const dimensions = [[1440, 900], [910, 610], [768, 700], [390, 730], [320, 568]];
const routes = ['home', 'library', 'favorites', 'recent', 'statistics', 'settings'];
const languages = ['en', 'nl', 'de', 'fr', 'es'];
const themes = ['dark', 'light'];
// Optional review screenshots, written only when the caller supplies a folder.
const screenshotDir = process.env.ORBIT_VISUAL_QA_OUTPUT
  ? path.resolve(process.env.ORBIT_VISUAL_QA_OUTPUT) : null;
const gameName = 'A Truly Extraordinary Adventure of a Very Determined Explorer — '
  + 'Überraschend außergewöhnliche Weltraumexpeditionen mit sehrlangemzusammengesetztemspieltitel';

function serve(request, response) {
  let filename;
  try { filename = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname)); }
  catch { response.writeHead(400).end(); return; }
  if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css',
      '.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp',
      '.woff2':'font/woff2'})[path.extname(filename)] || 'application/octet-stream');
    response.end(fs.readFileSync(filename));
  } catch { response.writeHead(404).end(); }
}

// Audit only meaningful interactive surfaces. Offscreen virtual rows, fixed overlays,
// invisible-at-rest poster buttons and intentionally hidden mobile labels are not failures.
function inspectLayout({route, modal = ''}) {
  const findings = [];
  const viewport = {width:innerWidth, height:innerHeight};
  const rect = element => {
    const box = element.getBoundingClientRect();
    return {left:box.left, right:box.right, top:box.top, bottom:box.bottom,
      width:box.width, height:box.height};
  };
  const describe = element => {
    const marker = element.dataset.action || element.dataset.route || element.id || element.tagName.toLowerCase();
    return `${marker}:${(element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 38)}`;
  };
  const displayed = element => {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const intersects = (a,b) => Math.max(0, Math.min(a.right,b.right)-Math.max(a.left,b.left))
    * Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  const where = route + (modal ? `/${modal}` : '');
  const add = (kind,detail) => findings.push(`${where} ${kind}: ${detail}`);
  const doc = document.documentElement;
  if (doc.scrollWidth > viewport.width + 2) add('document-overflow',`${doc.scrollWidth}px > ${viewport.width}px`);
  if (!modal) {
    const main = document.getElementById('main-scroll');
    if (main && main.scrollWidth > main.clientWidth + 2) {
      const boundary=main.getBoundingClientRect().right;
      const offenders=[...main.querySelectorAll('.page-heading, .settings-card, .setting-row, .setting-control, .statistics-panel, .statistics-metric, .hero, button, select')]
        .filter(node=>displayed(node) && node.getBoundingClientRect().right > boundary + 2)
        .slice(0,5).map(node=>{
          const b=rect(node),style=getComputedStyle(node);
          return `${node.tagName.toLowerCase()}${node.id?'#'+node.id:''}.${String(node.className||'').trim().split(/\s+/).slice(0,2).join('.')}`
            + `[x=${Math.round(b.left)}..${Math.round(b.right)},min=${style.minWidth}]`;
        });
      add('content-overflow',`${main.scrollWidth}px > ${main.clientWidth}px; offenders: ${offenders.join('; ')}`);
    }
    if (route === 'home') {
      const heading = document.querySelector('.hero-content h2');
      const poster = document.querySelector('.hero-portrait');
      if (heading && poster && displayed(heading) && displayed(poster)) {
        const area = intersects(rect(heading),rect(poster));
        if (area > 12) add('hero-title-poster-overlap',`${Math.round(area)}px²`);
      }
      if (heading && viewport.width <= 900) {
        const lineHeight = Number.parseFloat(getComputedStyle(heading).lineHeight);
        if (Number.isFinite(lineHeight) && heading.getBoundingClientRect().height > lineHeight * 5 + 2)
          add('hero-title-height','long title pushes hero actions below five lines');
      }
    }
  } else {
    const dialog = document.querySelector('#modal-root .dialog');
    if (!dialog) add('missing-modal','dialog was not rendered');
    else {
      if (dialog.scrollWidth > dialog.clientWidth + 2)
        add('modal-overflow',`${dialog.scrollWidth}px > ${dialog.clientWidth}px`);
      const bounds = rect(dialog);
      if (bounds.left < -2 || bounds.right > viewport.width + 2 || bounds.top < -2 || bounds.bottom > viewport.height + 2)
        add('modal-outside-viewport',JSON.stringify(bounds));
    }
  }
  const controls = modal
    ? [...document.querySelectorAll('#modal-root .dialog-header button, #modal-root .dialog-footer button, #modal-root .showcase-actions button, #modal-root .showcase-close')]
    : [...document.querySelectorAll('.topbar-right > button, .topbar .searchbox input, .sidebar .nav-item, .page-heading button')];
  if (!modal) {
    const extra = {
      home: '.hero-buttons > button',
      library: '.library-controls select, .library-controls .view-switch button',
      favorites: '.library-controls select, .library-controls .view-switch button',
      recent: '.library-controls select, .library-controls .view-switch button',
      statistics: '.statistics-page [data-action="refresh-statistics"]',
      settings: '.settings-card:first-child select, .settings-card:first-child .switch'
    }[route];
    if (extra) controls.push(...document.querySelectorAll(extra));
  }
  const dialog = modal ? document.querySelector('#modal-root .dialog') : null;
  const candidates = controls.filter(element => displayed(element) && !element.disabled);
  for (const element of candidates) {
    const box = rect(element), style = getComputedStyle(element);
    // A focused/visible control must be directly discoverable, not transparent.
    if (Number(style.opacity) < .08) add('invisible-action',describe(element));
    if (box.width < 3 || box.height < 3) add('zero-size-action',describe(element));
    // The modal itself can scroll vertically; only controls currently on-screen are checked.
    if (box.bottom < -1 || box.top > viewport.height + 1) continue;
    if (box.left < -2 || box.right > viewport.width + 2)
      add('action-outside-viewport',`${describe(element)} ${Math.round(box.left)}..${Math.round(box.right)}`);
    if (dialog && box.top >= rect(dialog).top - 2 && box.bottom <= rect(dialog).bottom + 2 &&
        (box.left < rect(dialog).left - 2 || box.right > rect(dialog).right + 2))
      add('action-outside-modal',describe(element));
  }
  // Compare only logical peers; card overlays, hero art and modal scrims overlap by design.
  const groups = modal
    ? ['#modal-root .dialog-footer', '#modal-root .showcase-actions']
    : ['.topbar-right', '.hero-buttons', '.library-controls .control-right', '.library-controls .control-left'];
  for (const selector of groups) {
    const parent = document.querySelector(selector);
    if (!parent || !displayed(parent)) continue;
    const peers = [...parent.children].filter(displayed).filter(element => {
      const box=rect(element);
      return box.width > 4 && box.height > 4 && box.top < viewport.height && box.bottom > 0;
    });
    for (let i=0;i<peers.length;i++) for (let j=i+1;j<peers.length;j++) {
      const a=rect(peers[i]),b=rect(peers[j]);
      const area=intersects(a,b);
      if (area > 16 && area > Math.min(a.width*a.height,b.width*b.height)*.02)
        add('peer-overlap',`${selector}: ${describe(peers[i])} / ${describe(peers[j])}`);
    }
  }
  return findings;
}

async function inspectControl(page, selector, label, findings, context, container = '') {
  const element = page.locator(selector).first();
  if (await element.count() === 0) { findings.push(`${context} missing-control: ${label}`); return; }
  // Scroll the actual control into its own scroll container before testing visibility/hit area.
  await element.evaluate(node => node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'}));
  const issue = await element.evaluate((node, region) => {
    const box=node.getBoundingClientRect(),style=getComputedStyle(node);
    if (!box.width || !box.height || style.visibility==='hidden' || style.display==='none' || Number(style.opacity)<.08)
      return 'not visibly actionable';
    if (box.left < -2 || box.right > innerWidth+2 || box.top < -2 || box.bottom > innerHeight+2)
      return `outside viewport (${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)})`;
    if (region) {
      const parent=document.querySelector(region),p=parent?.getBoundingClientRect();
      if (!p || box.left < p.left-2 || box.right > p.right+2 || box.top < p.top-2 || box.bottom > p.bottom+2)
        return 'outside containing modal';
    }
    const at=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,box.left+box.width/2)),
      Math.max(0,Math.min(innerHeight-1,box.top+box.height/2)));
    if (!at || (at!==node && !node.contains(at))) return `covered by ${at?.className || at?.tagName || 'unknown'}`;
    return '';
  },container);
  if (issue) findings.push(`${context} ${label}: ${issue}`);
}

(async () => {
  const server = http.createServer(serve);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  const findings = [], runtimeErrors = [];
  let checks=0;
  try {
    if(screenshotDir)fs.mkdirSync(screenshotDir,{recursive:true});
    browser = await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
      ? {headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}
      : {headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL || 'chrome'});
    const context=await browser.newContext({locale:'en-US',viewport:{width:1440,height:900},reducedMotion:'reduce'});
    const page=await context.newPage();
    page.on('pageerror',error => runtimeErrors.push(error.message));
    await page.addInitScript(installFixture,{count:64});
    await page.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
    await page.locator('.home-page .hero').waitFor();
    await page.evaluate(name => {
      const dates=['2026-11-05T17:00:00.000Z','2026-11-04T15:00:00.000Z','2026-11-01T10:00:00.000Z'];
      for(let i=1;i<=3;i++)window.fixture.patch(window.fixture.id(i),{
        name:i===1?name:`Featured Game ${i}`,last_played_at:dates[i-1],
        genre:'A Very Long Category For Browsing',tags:['Cooperative and adventurous storytelling'],
        total_play_seconds:i*3600, favorite:true
      });
      window.orbit.getStatistics=async () => {
        const day=offset=>{const date=new Date('2026-11-07T12:00:00.000Z');date.setUTCDate(date.getUTCDate()-offset);return date.toISOString().slice(0,10);};
        return {days:30,daily:Array.from({length:30},(_,i)=>({date:day(29-i),seconds:i*100})),
          totals:{week:7200,month:13000,allTime:34000},
          recentGames:[{name,source:'epic',seconds:7200,lastPlayedAt:'2026-11-05T17:00:00Z'}],
          meta:{openSessions:0,invalidSessions:0,overlapSeconds:0,adjustedSeconds:0,truncated:false}};
      };
    },gameName);
    const audit = async (route,modal,contextLabel) => {
      const issues=await page.evaluate(inspectLayout,{route,modal});
      checks++;
      for(const issue of issues)findings.push(`${contextLabel}: ${issue}`);
    };
    const go = async route => {
      await page.evaluate(target=>document.querySelector(`.sidebar [data-route="${target}"]`)?.click(),route);
      await page.waitForFunction(target=>{
        const nav=document.querySelector(`.sidebar [data-route="${target}"]`);
        return !!nav?.classList.contains('active') && !!document.querySelector('.page');
      },route);
      if (route==='statistics')await page.locator('.statistics-metrics').waitFor();
    };
    const openModal = async type => {
      await go('library');
      await page.evaluate(target=>{
        const card=document.querySelector('.game-card');
        if (!card)return;
        if(target==='detail') {card.querySelector('.card-open-trigger')?.click();return;}
        card.querySelector('[data-action="game-actions"]').click();
        document.querySelector(`#game-actions-popup [data-action="${target==='edit'?'edit':'remove-confirm'}"]`)?.click();
      },type);
      await page.locator('#modal-root .dialog').waitFor();
      const presented=type==='detail'
        ? await page.locator('#modal-root .showcase-hero-copy h2').textContent()
        : type==='edit'
          ? await page.locator('#modal-root #game-name').inputValue()
          : await page.locator('#modal-root .dialog-header p').textContent();
      if(!presented.includes(gameName))
        findings.push(`${type} modal did not exercise long game name (shown: ${presented.slice(0,90)})`);
    };
    for (const language of languages) {
      for (const theme of themes) {
        await page.evaluate(async settings=>{await window.orbit.saveSettings(settings);},{language,theme,reduceMotion:true});
        await page.waitForFunction(({lang,color})=>document.documentElement.lang===lang&&document.body.dataset.theme===color,
          {lang:language,color:theme});
        for(const [width,height] of dimensions) {
          await page.setViewportSize({width,height});
          const prefix=`${language}/${theme}/${width}x${height}`;
          for(const route of routes) {
            await go(route);
            await audit(route,'',prefix);
            if(screenshotDir && language==='de' && [320,390].includes(width)
                && ['home','settings','statistics'].includes(route))
              await page.screenshot({path:path.join(screenshotDir,`${language}-${theme}-${width}-${route}.png`),animations:'disabled'});
            if(route==='home')await inspectControl(page,'.hero-buttons [data-action="launch"]','hero play',findings,prefix);
            if(route==='settings'){
              await inspectControl(page,'#language-select','language selector',findings,prefix);
              if(width===320)for(const action of ['export','restore'])
                await inspectControl(page,`.settings-card [data-action="${action}"]`,
                  `320px settings ${action}`,findings,prefix);
            }
            if(['library','favorites','recent'].includes(route)){
              await inspectControl(page,'.library-controls #sort-by','library sort',findings,`${prefix}/${route}`);
              const card=page.locator('.game-card').first();
              if(await card.count()) {
                await card.locator('.card-open-trigger').focus();
                await inspectControl(page,'.game-card:first-child .cover-play','focused poster Play',findings,`${prefix}/${route}`);
                await card.hover();
                const caption=await card.locator('.game-label').evaluate(node=>({
                  opacity:Number(getComputedStyle(node).opacity),display:getComputedStyle(node).display}));
                if(caption.display==='none'||caption.opacity<.95)
                  findings.push(`${prefix}/${route} hovering poster must reveal its title and playtime`);
              }
            }
          }
          // Modal coverage at every requested width, both themes, and long translated labels.
          for(const modal of ['detail','edit','remove']) {
            await openModal(modal);
            await audit('library',modal,prefix);
            if(screenshotDir && language==='de' && modal==='edit' && [320,390].includes(width))
              await page.screenshot({path:path.join(screenshotDir,`${language}-${theme}-${width}-editor.png`),animations:'disabled'});
            const dialogRegion='#modal-root .dialog';
            const selector=modal==='detail'?'.detail-showcase .showcase-play':
              modal==='edit'?'#game-form [type="submit"]':'#modal-root [data-action="remove"]';
            await inspectControl(page,selector,`${modal} primary action`,findings,prefix,dialogRegion);
            // The dialog holds keyboard focus, including when opened at 320px.
            await page.keyboard.press('Tab');
            const focusOk=await page.evaluate(()=>!!document.activeElement?.closest('#modal-root .dialog'));
            if(!focusOk)findings.push(`${prefix}/${modal} focus escaped dialog`);
            await page.keyboard.press('Escape');
            await page.locator('#modal-root .dialog').waitFor({state:'detached'});
          }
        }
      }
    }
    // Dedicated empty-route fixtures keep the main 64-game matrix intact.
    // A populated library with no favorites/recent entries exercises distinct
    // empty states; removing all three synthetic games exercises empty library.
    const emptyPage=await context.newPage();
    emptyPage.on('pageerror',error=>runtimeErrors.push(error.message));
    await emptyPage.addInitScript(installFixture,{count:3});
    for(const language of ['nl','de'])for(const theme of themes)for(const [width,height] of [[390,730],[320,568]]) {
      await emptyPage.setViewportSize({width,height});
      await emptyPage.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
      await emptyPage.locator('.home-page .hero').waitFor();
      await emptyPage.evaluate(async settings=>{await window.orbit.saveSettings(settings);},{language,theme,reduceMotion:true});
      const prefix=`${language}/${theme}/${width}x${height}/empty`;
      for(const route of ['favorites','recent']) {
        await emptyPage.evaluate(target=>document.querySelector(`.sidebar [data-route="${target}"]`)?.click(),route);
        await emptyPage.locator('.library-page').waitFor();
        if(!await emptyPage.locator('#virtual-games .empty-state').count())
          findings.push(`${prefix}/${route} missing empty-state message`);
        for(const issue of await emptyPage.evaluate(inspectLayout,{route,modal:''}))findings.push(`${prefix}: ${issue}`);
        checks++;
        await inspectControl(emptyPage,'.library-page .page-heading [data-action="scan"]',
          `${route} empty heading scan`,findings,prefix);
      }
      await emptyPage.evaluate(async()=>{
        for(const game of await window.orbit.listGames())await window.orbit.removeGame(game.id);
        document.querySelector('.sidebar [data-route="library"]')?.click();
      });
      await emptyPage.locator('.library-page .empty-state').waitFor();
      for(const issue of await emptyPage.evaluate(inspectLayout,{route:'library',modal:''}))findings.push(`${prefix}: ${issue}`);
      checks++;
      await inspectControl(emptyPage,'.library-page .page-heading [data-action="scan"]',
        'empty library heading scan',findings,prefix);
      for(const route of ['favorites','recent']) {
        await emptyPage.evaluate(target=>document.querySelector(`.sidebar [data-route="${target}"]`)?.click(),route);
        await emptyPage.locator('.library-page .empty-state h2').waitFor();
        const actual=await emptyPage.locator('.library-page .empty-state h2').textContent();
        const expected=await emptyPage.evaluate(target=>window.OrbitI18n.t(
          target==='favorites'?'No favorites yet':'No games played yet'),route);
        if(actual!==expected)findings.push(`${prefix}/${route} zero-library state must be route-specific`);
        for(const issue of await emptyPage.evaluate(inspectLayout,{route,modal:''}))findings.push(`${prefix}: ${issue}`);
        checks++;
      }
    }
    await emptyPage.close();

    // Large import lists exercise checkbox focus preservation across live locale
    // changes, plus focus restoration when Previous becomes disabled on page 1.
    const importPage=await context.newPage();
    importPage.on('pageerror',error=>runtimeErrors.push(error.message));
    await importPage.addInitScript(installFixture,{count:5});
    for(const [language,width,height] of [['fr',390,730],['de',320,568]]) {
      await importPage.setViewportSize({width,height});
      await importPage.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
      await importPage.locator('.home-page .hero').waitFor();
      await importPage.evaluate(async locale=>{
        await window.orbit.saveSettings({language:locale,reduceMotion:true});
        const template=(await window.orbit.listGames())[0];
        window.orbit.discoverGames=async()=>({
          games:Array.from({length:122},(_,index)=>({...template,
            id:`88888888-8888-4888-8888-${String(index+1).padStart(12,'0')}`,
            source_id:String(900000+index),name:`Discovered Game ${index+1}`,
            alreadyAdded:false})),warnings:[],diagnostics:[]
        });
        document.querySelector('.sidebar [data-route="library"]')?.click();
        document.querySelector('.library-page .page-heading [data-action="scan"]')?.click();
      },language);
      await importPage.locator('#modal-root .import-item').first().waitFor();
      const prefix=`${language}/import/${width}x${height}`;
      for(const issue of await importPage.evaluate(inspectLayout,{route:'library',modal:'import'}))findings.push(`${prefix}: ${issue}`);
      checks++;
      await importPage.locator('[data-import-index="0"]').focus();
      const nextLocale=language==='fr'?'de':'fr';
      await importPage.evaluate(code=>window.OrbitI18n.setLanguage(code),nextLocale);
      await importPage.waitForFunction(code=>document.documentElement.lang===code,nextLocale);
      const retained=await importPage.evaluate(()=>document.activeElement?.dataset.importIndex==='0');
      if(!retained)findings.push(`${prefix} import checkbox focus lost on ${language}->${nextLocale} language change`);
      await importPage.locator('#modal-root [data-action="import-page"][data-page="next"]').click();
      const onSecondPage=await importPage.locator('[data-import-index="100"]').count()===1;
      const nextDisabled=await importPage.locator('#modal-root [data-page="next"]').isDisabled();
      if(!onSecondPage||!nextDisabled)findings.push(`${prefix} import pagination failed to show last 22 records`);
      await importPage.locator('#modal-root [data-action="import-page"][data-page="prev"]').click();
      const onFirstPage=await importPage.locator('[data-import-index="0"]').count()===1;
      const previousDisabled=await importPage.locator('#modal-root [data-page="prev"]').isDisabled();
      if(!onFirstPage||!previousDisabled)findings.push(`${prefix} import pagination failed to restore page 1`);
      const stillInDialog=await importPage.evaluate(()=>!!document.activeElement?.closest('#modal-root .dialog'));
      if(!stillInDialog)findings.push(`${prefix} import Previous page 2->1 lost focus to body`);
      await importPage.keyboard.press('Escape');
      await importPage.locator('#modal-root .dialog').waitFor({state:'detached'});
    }
    await importPage.close();
    // A complete 30-day calendar of zeroes is not a playtime graph. Distinguish
    // it from missing dates and use the real translated empty message.
    const zeroPage=await context.newPage();
    zeroPage.on('pageerror',error=>runtimeErrors.push(error.message));
    await zeroPage.addInitScript(installFixture,{count:3});
    await zeroPage.setViewportSize({width:320,height:568});
    await zeroPage.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
    await zeroPage.locator('.home-page .hero').waitFor();
    await zeroPage.evaluate(async()=>{
      await window.orbit.saveSettings({language:'de',theme:'light',reduceMotion:true});
      const dates=Array.from({length:30},(_,index)=>{
        const date=new Date('2026-11-07T12:00:00.000Z');
        date.setUTCDate(date.getUTCDate()-29+index);
        return {date:date.toISOString().slice(0,10),seconds:0};
      });
      window.orbit.getStatistics=async()=>({days:30,daily:dates,
        totals:{week:0,month:0,allTime:0},recentGames:[],meta:{openSessions:0,invalidSessions:0,truncated:false}});
      document.querySelector('.sidebar [data-route="statistics"]')?.click();
    });
    const zeroChart=zeroPage.locator('.statistics-panel[aria-labelledby="statistics-chart-title"]');
    await zeroChart.locator('.statistics-empty').waitFor();
    const emptyMessage=await zeroChart.locator('.statistics-empty').textContent();
    const translatedMessage=await zeroPage.evaluate(()=>window.OrbitI18n.t('No recorded playtime'));
    if(emptyMessage.trim()!==translatedMessage || await zeroChart.locator('.statistics-bar-slot').count()!==0)
      findings.push('de/light/320 zero-statistics: expected localized no-playtime message and no 30 artificial bars');
    for(const issue of await zeroPage.evaluate(inspectLayout,{route:'statistics',modal:''}))
      findings.push(`de/light/320/zero-statistics: ${issue}`);
    checks++;
    await zeroPage.close();

    // Browser device emulation makes the actual (hover:none)/(pointer:coarse)
    // selectors apply; desktop mouse hover cannot validate touch affordances.
    const touchContext=await browser.newContext({locale:'fr-FR',hasTouch:true,isMobile:true,
      viewport:{width:390,height:730},reducedMotion:'reduce'});
    const touchPage=await touchContext.newPage();
    touchPage.on('pageerror',error=>runtimeErrors.push(error.message));
    await touchPage.addInitScript(installFixture,{count:6});
    await touchPage.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
    await touchPage.locator('.home-page .hero').waitFor();
    await touchPage.evaluate(()=>document.querySelector('.sidebar [data-route="library"]')?.click());
    for(const width of [390,320])for(const theme of themes){
      await touchPage.setViewportSize({width,height:730});
      await touchPage.evaluate(async color=>window.orbit.saveSettings({theme:color,language:'fr'}),theme);
      const appearance=await touchPage.locator('.game-card.poster-card').first().evaluate(card=>{
        const style=selector=>{
          const element=card.querySelector(selector),css=getComputedStyle(element);
          return {display:css.display,opacity:Number(css.opacity)};
        };
        return {touch:matchMedia('(hover:none)').matches||matchMedia('(pointer:coarse)').matches,
          title:style('.game-label'),play:style('.cover-play'),favorite:style('.favorite-float'),menu:style('.card-menu-float')};
      });
      if(!appearance.touch || [appearance.title,appearance.play,appearance.favorite,appearance.menu]
        .some(value=>value.display==='none'||value.opacity<.95))
        findings.push(`fr/${theme}/${width}/touch poster title/actions hidden: ${JSON.stringify(appearance)}`);
      for(const issue of await touchPage.evaluate(inspectLayout,{route:'library',modal:''}))
        findings.push(`fr/${theme}/${width}/touch: ${issue}`);
      checks++;
    }
    await touchContext.close();
    assert.deepEqual(runtimeErrors,[],'Unexpected JavaScript page errors');
    if(findings.length) {
      console.error(`Visual consistency: ${findings.length} issue(s) across ${checks} snapshots:`);
      for(const issue of findings.slice(0,90))console.error(` - ${issue}`);
      if(findings.length>90)console.error(` ... ${findings.length-90} additional finding(s)`);
      process.exitCode=1;
    } else console.log(`Visual consistency PASS: ${checks} route/modal snapshots; 5 languages, 2 themes, 5 viewports, focus and long names; Chrome ${browser.version()}.`);
    await context.close();
  } catch(error) {
    console.error(error);
    process.exitCode=1;
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})();

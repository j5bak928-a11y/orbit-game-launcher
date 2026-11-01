'use strict';
// Optional browser regression suite: mocked IPC, no real games or remote services.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.ORBIT_PLAYWRIGHT_PATH||'playwright');
const {installFixture}=require('./fixtures/renderer.cjs');
const root=path.resolve(__dirname,'..');
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
(async()=>{
 const browser=await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
  ?{headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}
  :{headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL||'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const html=fs.readFileSync(path.join(root,'src/ui/index.html'),'utf8')
   .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/,'')
   .replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g,'')
   .replace('<link rel="stylesheet" href="./styles.css" />',`<style>${fs.readFileSync(path.join(root,'src/ui/styles.css'),'utf8')}</style>`);
  await page.setContent(html);await page.evaluate(installFixture,{count:5000});
  await page.evaluate(()=>{
   window.experience={launches:0,scans:0};
   window.orbit.launchGame=()=>{window.experience.launches++;return new Promise(resolve=>{window.experience.launchResolve=resolve});};
   window.orbit.discoverGames=()=>{window.experience.scans++;return new Promise(resolve=>{window.experience.scanResolve=resolve});};
  });
  for(const file of ['library-updates.js','app.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'src/ui',file),'utf8')});
  await page.locator('.hero').waitFor();assert.match(await page.title(),/Orbit/);
  await page.locator('.shuffle-btn').click();await page.locator('[role=dialog]').waitFor();
  assert.equal(await page.evaluate(()=>window.experience.launches),0,'suggestions must not launch games');await page.keyboard.press('Escape');
  await page.locator('.hero [data-action=launch]').click();
  assert.equal(await page.locator('.hero [data-action=launch]').getAttribute('aria-busy'),'true');
  assert(await page.locator('.hero [data-action=launch]').isDisabled());
  await page.evaluate(()=>document.querySelector('.hero [data-action=launch]').click());
  assert.equal(await page.evaluate(()=>window.experience.launches),1,'duplicate clicks must not launch twice');
  await page.evaluate(()=>window.experience.launchResolve({message:'Fixture launched'}));
  await page.waitForFunction(()=>!document.querySelector('.hero [data-action=launch]').disabled);
  await page.locator('nav [data-route=library]').click();
  // Exercise long names and missing covers in the real layout before large-library checks.
  await page.evaluate(()=>window.fixture.patch(window.fixture.id(1),{name:'A Remarkably Long Game Title With Several Words And A Final Subtitle'}));
  await page.locator('#global-search').fill('A Remarkably Long Game Title');
  await page.waitForFunction(()=>document.querySelectorAll('.game-card').length===1);
  const label=page.locator('.game-card .game-name');
  assert.equal(await label.evaluate(el=>getComputedStyle(el).webkitLineClamp),'2');
  assert(await label.evaluate(el=>el.getBoundingClientRect().height>16),'long names use a second line');
  assert.equal(await page.locator('.game-card .cover-placeholder-title').count(),1);
  await page.locator('.game-card').click();
  assert.equal(await page.locator('[role=dialog] .detail-playtime').count(),1);
  assert.equal(await page.locator('[role=dialog] [data-action=edit]').count(),1);
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.fixture.patch(window.fixture.id(1),{name:'Game 00000'}));
  await page.locator('#global-search').fill('');
  await page.waitForFunction(()=>document.querySelectorAll('.game-card').length>1);
  assert.equal(await page.locator('#source-filter').count(),0,'platform filters should have one visible control');
  await page.locator('.platform-chip[data-source=epic]').click();
  assert.equal(await page.locator('#game-result-count').textContent(),'2500 games');
  assert.match(await page.locator('#active-filters').textContent(),/Epic Games/);
  await page.locator('#active-filters [data-action=clear-filters]').click();
  assert.equal(await page.locator('#game-result-count').textContent(),'5000 games');
  await page.keyboard.press('Control+k');assert(await page.locator('#global-search').evaluate(node=>node===document.activeElement));
  await page.locator('#global-search').fill('Game 00003');
  await page.waitForFunction(()=>document.querySelectorAll('.game-card').length===1);
  await page.locator('.game-card').focus();await page.keyboard.press('Enter');await page.locator('[role=dialog]').waitFor();
  await page.keyboard.press('Tab');assert(await page.locator('[role=dialog]').evaluate(node=>node.contains(document.activeElement)));
  await page.keyboard.press('Escape');assert(await page.locator('.game-card').evaluate(node=>node===document.activeElement));
  await page.locator('#global-search').fill('');await settle(page);
  await page.locator('.library-page .page-heading [data-action=scan]').click();
  assert.equal(await page.locator('.library-page .page-heading [data-action=scan]').getAttribute('aria-busy'),'true');
  await page.evaluate(()=>window.experience.scanResolve({games:[],warnings:['Fixture warning'],diagnostics:[
   {provider:'steam',status:'ok',games:5000,warnings:0,durationMs:17},
   {provider:'epic',status:'warning',games:0,warnings:1,durationMs:2},
   {provider:'folder',status:'error',games:0,warnings:1,durationMs:1,path:'/fixture/unavailable'}
  ]}));
  await page.locator('.scan-diagnostics summary').click();
  assert.equal(await page.locator('.diagnostic').count(),3);await page.keyboard.press('Escape');
  assert.equal(await page.locator('.library-page .page-heading [data-action=scan]').getAttribute('aria-busy'),'false');
  const measurements=[];
  for(const width of [1440,1181,1180,910,750,500,390]){
   await page.setViewportSize({width,height:width===910?610:900});
   await page.locator('[data-action=view][data-view=grid]').click();
   for(const fraction of [0,.25,.75,1]){
    await page.evaluate(value=>{const scroll=document.getElementById('main-scroll');scroll.scrollTop=(scroll.scrollHeight-scroll.clientHeight)*value;},fraction);
    await settle(page);
    const result=await page.evaluate(()=>{
     const container=document.querySelector('[data-virtual-items]'),cards=[...container.children],style=getComputedStyle(container);
     const columns=style.gridTemplateColumns.split(' ').length,gap=parseFloat(style.gap);
     const rect=cards[0].getBoundingClientRect(),step=cards[columns]?cards[columns].getBoundingClientRect().top-rect.top:rect.height+gap;
     return{count:cards.length,last:cards.at(-1).dataset.id,step,cardStep:rect.height+gap,
      before:parseFloat(container.previousElementSibling.style.height),overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert(result.count<=120,'rendered DOM must stay bounded');assert(!result.overflow,'layout must not overflow the window');
    assert(Math.abs(result.step-result.cardStep)<.1,'rows must not drift');
    assert(Math.abs(result.before/result.step-Math.round(result.before/result.step))<.002,'virtual spacer must align to actual rows');
    if(fraction===1)assert.equal(result.last,'00000000-0000-4000-8000-000000005000','the last record must remain reachable');
    measurements.push({width,fraction,...result});
   }
   await page.locator('[data-action=view][data-view=list]').click();
   await page.evaluate(()=>{const scroll=document.getElementById('main-scroll');scroll.scrollTop=scroll.scrollHeight;});await settle(page);
   assert.equal(await page.locator('.game-row').last().getAttribute('data-id'),'00000000-0000-4000-8000-000000005000');
  }
  await page.setViewportSize({width:1440,height:900});await page.locator('nav [data-route=settings]').click();
  await page.locator('#theme-select').selectOption('light');assert.equal(await page.locator('body').getAttribute('data-theme'),'light');
  // Review regressions: cardinality, incremental empty-library transitions,
  // and real delegated image failure handling need separate small fixtures.
  const reviewFailures=[];
  const fixturePage=async count=>{
   const fixture=await browser.newPage({viewport:{width:910,height:610}});
   fixture.on('pageerror',error=>errors.push(error.message));
   await fixture.setContent(html);await fixture.evaluate(installFixture,{count});
   for(const file of ['library-updates.js','app.js'])await fixture.addScriptTag({content:fs.readFileSync(path.join(root,'src/ui',file),'utf8')});
   await fixture.locator('.hero').waitFor();return fixture;
  };
  for(const playedCount of [1,2,3]){
   const fixture=await fixturePage(3);
   await fixture.evaluate(count=>{for(let index=1;index<=count;index++)window.fixture.patch(window.fixture.id(index),{last_played_at:'2026-10-24T00:00:00.000Z'});},playedCount);
   await settle(fixture);
   const visible=await fixture.locator('.continue-card:visible').count(),expected=Math.min(playedCount,2);
   if(visible!==expected)reviewFailures.push(`910px continuation with ${playedCount} played games: expected ${expected} visible, got ${visible}`);
   await fixture.close();
  }
  {
   const fixture=await fixturePage(0),shuffle=fixture.locator('.sidebar [data-action=shuffle]');
   assert(await shuffle.isDisabled(),'an empty library cannot suggest a game');
   const id=await fixture.evaluate(async()=>{const result=await window.orbit.addGame({name:'First fixture',source:'manual',executable:'C:/Fixture/Game.exe',tags:[]});return result.game.id;});
   await settle(fixture);
   if(await shuffle.isDisabled())reviewFailures.push('adding the first game must enable sidebar suggestions without navigation');
   await fixture.evaluate(id=>window.orbit.removeGame(id),id);await settle(fixture);
   if(!await shuffle.isDisabled())reviewFailures.push('removing the last game must disable sidebar suggestions without navigation');
   await fixture.close();
  }
  {
   const fixture=await fixturePage(1);
   await fixture.evaluate(()=>window.fixture.patch(window.fixture.id(1),{icon:'10000000-0000-4000-8000-000000000001.png'}));
   await fixture.locator('nav [data-route=library]').click();
   await fixture.locator('[data-action=view][data-view=list]').click();
   const icon=fixture.locator('.row-cover img.list-game-icon');
   await icon.evaluate(node=>node.dispatchEvent(new Event('error')));
   assert(await icon.evaluate(node=>node.classList.contains('bad-aspect')),'delegated image errors must mark failed icons');
   if(await icon.evaluate(node=>getComputedStyle(node).display)!=='none')reviewFailures.push('failed list icons must hide so the letter fallback remains visible');
   await fixture.close();
  }
  {
   const fixture=await fixturePage(1);
   await fixture.evaluate(()=>{
    window.coverSearch={};
    window.orbit.findOnlineCover=title=>{window.coverSearch.title=title;return new Promise(resolve=>{window.coverSearch.resolve=resolve});};
    window.orbit.chooseArtwork=async()=> '22222222-2222-4222-8222-222222222222.png';
   });
   await fixture.locator('header [data-action=add]').click();
   await fixture.locator('#game-name').fill('My game');
   await fixture.locator('#game-executable').fill('C:/Games/Game.exe');
   await fixture.locator('#cover-search-title').fill('Fortnite');
   await fixture.locator('#cover-search-title').press('Enter');
   assert.equal(await fixture.evaluate(()=>window.coverSearch.title),'Fortnite');
   assert.equal(await fixture.locator('#game-form').count(),1,'Enter must search without saving the editor');
   await fixture.locator('[data-action=choose-art][data-key=cover]').click();
   await fixture.evaluate(()=>window.coverSearch.resolve({cover:'11111111-1111-4111-8111-111111111111.png',message:'Cover found on Epic Games.'}));
   await fixture.waitForFunction(()=>document.querySelector('#cover-search-status')?.textContent.includes('Cover changed while searching; your selection was kept.'));
   assert.equal(await fixture.locator('#game-cover').inputValue(),'22222222-2222-4222-8222-222222222222.png');
   await fixture.locator('[data-action=find-online-art]').click();
   await fixture.evaluate(()=>window.coverSearch.resolve({cover:'11111111-1111-4111-8111-111111111111.png',message:'Cover found on Epic Games.'}));
   await fixture.waitForFunction(()=>document.querySelector('#cover-search-status')?.textContent.includes('Cover found on Epic Games.'));
   assert.equal(await fixture.locator('#game-name').inputValue(),'My game');
   assert.equal(await fixture.locator('#game-cover').inputValue(),'11111111-1111-4111-8111-111111111111.png');
   await fixture.locator('#game-executable').fill('C:/Games/Game.exe');
   await fixture.locator('#game-form [type=submit]').click();
   await fixture.locator('#game-form').waitFor({state:'detached'});
   const game=await fixture.evaluate(async()=>(await window.orbit.listGames()).find(item=>item.name==='My game'));
   assert.equal(game.cover,'11111111-1111-4111-8111-111111111111.png');
   assert.equal(game.name,'My game');
   assert(!Object.hasOwn(game,'cover-search-title'));
   await fixture.close();
  }
  assert.deepEqual(reviewFailures,[],'interface review regressions');
  assert.deepEqual(errors,[]);
  const report={browser:browser.version(),libraryGames:5000,gridPositions:measurements.length,listBottoms:7,errors,measurements};
  if(process.env.ORBIT_QA_OUTPUT){fs.mkdirSync(process.env.ORBIT_QA_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.ORBIT_QA_OUTPUT,'experience.json'),JSON.stringify(report,null,2)+'\n');}
  console.log(`Experience checks passed: 5,000 games, ${measurements.length} grid positions, 7 list bottoms; filters, launch/scan feedback, keyboard and theme.`);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// Actual browser acceptance with mocked Orbit IPC; no real profile or game launch.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require(process.env.ORBIT_PLAYWRIGHT_PATH||'playwright');
const {installFixture}=require('./fixtures/renderer.cjs');
const root=path.resolve(__dirname,'..');

const server=http.createServer((request,response)=>{
 const file=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
 if(!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
 try{
  response.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'})[path.extname(file)]||'application/octet-stream');
  response.end(fs.readFileSync(file));
 }catch{response.writeHead(404).end();}
});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
  ?{headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}
  :{headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL||'chrome'});
 try{
  const context=await browser.newContext({locale:'nl-NL',viewport:{width:1440,height:900}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(installFixture,{count:24});
  await page.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
  await page.locator('[data-route="settings"]').waitFor();
  await page.waitForFunction(()=>window.OrbitI18n?.getLanguage?.()==='nl');
  assert.equal(await page.locator('html').getAttribute('lang'),'nl','system preference follows OS locale');
  assert.notEqual((await page.locator('[data-route="settings"]').first().textContent()).trim(),'Settings','Dutch navigation is translated');

  await page.locator('[data-route="settings"]').first().click();
  const language=page.locator('#language-select');
  await language.waitFor();
  assert.deepEqual(await language.locator('option').evaluateAll(options=>options.map(option=>option.value)),
   ['system','en','nl','de','fr','es'],'all supported settings options appear');
  for(const code of ['en','de','fr','es','nl']){
   await language.focus();
   await language.selectOption(code);
   await page.waitForFunction(code=>window.OrbitI18n?.getLanguage?.()===code,code);
   assert.equal(await page.locator('html').getAttribute('lang'),code);
   const expected=await page.evaluate(()=>window.OrbitI18n.t('Settings'));
   assert.equal((await page.locator('[data-route="settings"]').first().textContent()).trim(),expected);
   if(code!=='en')assert.notEqual(expected,'Settings',`${code} navigation should not fall back to English`);
   assert.equal(await language.inputValue(),code,'manual selection remains visible');
   assert.equal(await page.evaluate(()=>document.activeElement?.id),'language-select',
    `${code} changing language preserves keyboard focus on the language setting`);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
   assert(!overflow,`${code} settings do not overflow 1440px`);
  }

  await language.selectOption('de');
  await page.locator('[data-route="library"]').first().click();
  const gameId=await page.evaluate(()=>window.fixture.id(1));
  const previousName=await page.locator(`.game-card[data-id="${gameId}"] .game-name`).textContent();
  await page.evaluate(id=>window.fixture.patch(id,{name:'Settings'}),gameId);
  await page.waitForFunction(({id,prev})=>{
   const el=document.querySelector(`.game-card[data-id="${id}"] .game-name`);
   return el&&el.textContent!==prev;
  },{id:gameId,prev:previousName});
  assert.equal(await page.locator(`.game-card[data-id="${gameId}"] .game-name`).textContent(),'Settings','user game names must never be translated');
  await page.locator(`.game-card[data-id="${gameId}"]`).click();
  const detail=page.locator('[role="dialog"].detail-showcase');
  await detail.waitFor();
  const playTranslation=await page.evaluate(()=>window.OrbitI18n.t('Play game'));
  assert.equal((await detail.locator('.showcase-play span').textContent()).trim(),playTranslation,
   'game detail actions translate without changing the underlying game record');
  assert.notEqual(playTranslation,'Play game','German detail action is not English fallback');
  await page.keyboard.press('Escape');

  // A system locale change must not silently throw away unsaved editor input.
  await page.locator(`.game-card[data-id="${gameId}"] .game-menu`).click();
  await page.locator('.game-actions-item[data-action="edit"]').click();
  await page.locator('#game-name').fill('UNSAVED EDIT SHOULD REMAIN');
  await page.locator('#game-tags').fill('Unsaved-custom-tag');
  await page.locator('#cover-search-title').fill('Unsaved cover search');
  await page.locator('#game-cover-fit').selectOption('contain');
  await page.evaluate(()=>{document.getElementById('game-cover').value='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png'});
  await page.locator('#game-tags').focus();
  await page.evaluate(()=>window.OrbitI18n.setLanguage('fr'));
  await page.waitForFunction(()=>document.documentElement.lang==='fr');
  assert.equal(await page.locator('#game-name').inputValue(),'UNSAVED EDIT SHOULD REMAIN',
   'changing locale retains unsaved game title');
  assert.equal(await page.locator('#game-tags').inputValue(),'Unsaved-custom-tag',
   'changing locale retains unsaved game tags');
  assert.equal(await page.locator('#cover-search-title').inputValue(),'Unsaved cover search',
   'changing locale retains unsaved search query');
  assert.equal(await page.locator('#game-cover-fit').inputValue(),'contain',
   'changing locale retains unsaved artwork display choice');
  assert.equal(await page.locator('#game-cover').inputValue(),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png',
   'changing locale retains hidden unsaved cover artwork token');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'game-tags',
   'changing locale retains editor keyboard focus');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.OrbitI18n.setLanguage('de'));

  // Controller shell should use the current language, and react live to changes.
  await page.locator('[data-action="controller-mode"]').first().click();
  const controller=page.locator('#controller-root');
  await controller.waitFor();
  const englishControllerTitle='CONTROLLER MODE';
  const before=(await controller.locator('.tv-brand span').last().textContent()).trim();
  assert.notEqual(before,englishControllerTitle,'controller shell uses selected German locale');
  await page.evaluate(()=>window.OrbitI18n.setLanguage('fr'));
  await page.waitForFunction(()=>document.documentElement.lang==='fr');
  const after=(await controller.locator('.tv-brand span').last().textContent()).trim();
  assert.notEqual(after,before,'controller shell rerenders on locale change');
  await page.keyboard.press('Escape');
  await page.locator('#controller-root').waitFor({state:'detached'});

  await page.setViewportSize({width:390,height:780});
  await page.locator('[data-route="settings"]').first().click();
  assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'settings remain usable at 390px');
  assert.deepEqual(errors,[],'switching locales should not raise runtime errors');
  await context.close();
  console.log('Multilingual renderer passed: system Dutch, en/de/fr/es/nl, settings persistence in session, user game names, controller live switch and narrow layout.');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

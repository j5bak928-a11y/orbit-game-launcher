'use strict';
// Actual renderer and input policy; Electron/gamepad hardware are boundary fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.ORBIT_PLAYWRIGHT_PATH||'playwright');
const {installFixture}=require('./fixtures/renderer.cjs');
const root=path.resolve(__dirname,'..');
const server=http.createServer((request,response)=>{
 const file=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
 if(!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
 try{response.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'})[path.extname(file)]||'application/octet-stream');response.end(fs.readFileSync(file));}catch{response.writeHead(404).end();}
});
const pause=page=>page.waitForTimeout(80);
const assertTouchHeight=async(locator,label)=>{
 const height=await locator.evaluate(node=>node.getBoundingClientRect().height);
 assert(height>=44,`${label} touch target should be at least 44px (got ${height})`);
};
const padButton=async(page,button,held=90,slot=0)=>{
 await page.evaluate(({index,slot})=>{window.mockPads[slot].buttons[index]={pressed:true,value:1,touched:true};},{index:button,slot});
 await page.waitForTimeout(held);
 await page.evaluate(({index,slot})=>{window.mockPads[slot].buttons[index]={pressed:false,value:0,touched:false};},{index:button,slot});
 await pause(page);
};
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE?{headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL||'chrome'});
 try{
  // The production UI defaults to the OS language. Keep historical English
  // label assertions deterministic regardless of the Windows test PC locale.
  const page=await browser.newPage({viewport:{width:1440,height:900},locale:'en-US'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(installFixture,{count:5000});
  await page.addInitScript(()=>{
   window.mockPads=[];Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>{window.controllerTest.padReads++;return window.mockPads;}});
   window.fixture.patch(window.fixture.id(3),{last_played_at:'2026-10-20T12:00:00Z'});
   window.fixture.patch(window.fixture.id(9),{last_played_at:'2026-10-24T12:00:00Z'});
   window.fixture.patch(window.fixture.id(1),{favorite:true});
   // Real image loads with strongly different aspect ratios. These are
   // intentionally NOT ordinary storefront dimensions: custom artwork
   // must remain visible without either cropping or being discarded.
   const token=index=>`00000000-0000-4000-8000-${String(index).padStart(12,'0')}.png`;
   const svg=(width,height,color)=>'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${color}"/><rect width="12" height="${height}" fill="white"/><rect x="${width-12}" width="12" height="${height}" fill="white"/></svg>`
   );
   const images=new Map([[token(991),svg(1200,240,'#215b99')],[token(992),svg(280,280,'#9b4278')],[token(993),svg(700,250,'#529a4f')],[token(994),'data:image/png;base64,not-a-valid-image']]);
   window.OrbitArtworkUrl=key=>images.get(key)||'';
   window.fixture.patch(window.fixture.id(9),{banner:token(991)});
   window.fixture.patch(window.fixture.id(3),{banner:token(992),cover:token(993)});
   window.fixture.patch(window.fixture.id(1),{banner:token(994)});
   window.controllerTest={launches:0,favoriteCalls:0,requests:[],failFullscreen:false,padReads:0,deferEntry:false};
   const set=window.orbit.setFullscreen,launch=window.orbit.launchGame,favorite=window.orbit.favoriteGame;
   window.orbit.setFullscreen=async enabled=>{window.controllerTest.requests.push(enabled);if(window.controllerTest.failFullscreen)throw Error('Fullscreen fixture failure');if(window.controllerTest.deferEntry&&enabled){window.controllerTest.deferEntry=false;await new Promise(resolve=>window.controllerTest.releaseEntry=resolve);}return set(enabled);};
   window.orbit.launchGame=id=>{window.controllerTest.launches++;return new Promise(resolve=>{window.controllerTest.finishLaunch=()=>resolve(launch(id));});};
   window.orbit.favoriteGame=id=>{window.controllerTest.favoriteCalls++;return favorite(id);};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
  await page.bringToFront();
  const entry=page.getByRole('button',{name:'Enter controller mode',exact:true});
  await entry.waitFor({timeout:5000});await entry.click();
  const mode=page.getByRole('dialog',{name:'Orbit controller mode',exact:true});await mode.waitFor();
  const focused=()=>page.evaluate(()=>document.activeElement?.dataset.tvKey||'');
  assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000009');
  const spotlight=mode.locator('.tv-spotlight');
  assert.equal(await spotlight.count(),1,'a single featured panel fills the controller home');
  assert.equal(await spotlight.locator('h2').textContent(),await mode.locator('.tv-recent .tv-card-copy strong').first().textContent(),'the latest game is featured on entry');
  assert.equal(await spotlight.locator('button,[tabindex]').count(),0,'the featured panel must not change controller focus order');
  assert(await page.locator('#app').evaluate(node=>node.inert));
  assert.equal(await mode.locator('.tv-recent [data-tv-game]').first().getAttribute('data-tv-game'),'00000000-0000-4000-8000-000000000009');
  assert(await mode.locator('[data-tv-game]').count()<40,'large libraries must keep rendered cards bounded');
  assert(await mode.locator('.tv-library-heading h1').evaluate(node=>node.getBoundingClientRect().bottom<document.querySelector('.tv-footer').getBoundingClientRect().top),'the library heading stays visible at 1440x900');
  const fullBanner=mode.locator('.tv-recent [data-tv-game="00000000-0000-4000-8000-000000000009"] .tv-game-art');
  await fullBanner.evaluate(img=>img.decode());
  assert.equal(await fullBanner.evaluate(img=>img.naturalWidth/img.naturalHeight),5,'fixture exercises an ultra-wide banner');
  assert.equal(await fullBanner.evaluate(img=>getComputedStyle(img).objectFit),'contain','wide artwork must fit completely without trimming either side');
  assert.equal(await fullBanner.evaluate(img=>img.hidden),false);
  const spotlightArt=spotlight.locator('.tv-spotlight-image .tv-game-art');
  await spotlightArt.evaluate(img=>img.decode());
  assert.equal(await spotlightArt.evaluate(img=>getComputedStyle(img).objectFit),'contain','the featured artwork also preserves ultra-wide images');
  const squareBanner=mode.locator('.tv-recent [data-tv-game="00000000-0000-4000-8000-000000000003"] .tv-game-art');
  await squareBanner.evaluate(img=>img.decode());
  assert.equal(await squareBanner.evaluate(img=>img.hidden),false,'square custom banner must not be rejected as wrong aspect');
  await mode.locator('.tv-recent [data-tv-game="00000000-0000-4000-8000-000000000003"]').click();
  const wideCover=mode.locator('.tv-sheet .tv-game-art');
  await wideCover.evaluate(img=>img.decode());
  assert.equal(await wideCover.evaluate(img=>getComputedStyle(img).objectFit),'contain','detail sheets fit the entire custom cover');
  assert.equal(await wideCover.evaluate(img=>img.hidden),false,'nonstandard wide custom cover remains usable');
  await page.keyboard.press('Escape');
  const brokenBanner=mode.locator('.tv-library [data-tv-game="00000000-0000-4000-8000-000000000001"] .tv-game-art');
  await brokenBanner.waitFor({state:'attached'});
  await page.waitForFunction(()=>document.querySelector('.tv-library [data-tv-game="00000000-0000-4000-8000-000000000001"] .tv-game-art')?.hidden);
  assert.equal(await brokenBanner.evaluate(img=>getComputedStyle(img.parentElement.querySelector('.tv-card-fallback')).display),'grid','broken art still uses icon fallback');
  await page.evaluate(()=>window.orbit.saveSettings({theme:'light'}));
  assert(await mode.locator('.tv-fallback-light:visible').count()>0,'light mode needs a visible light-surface fallback mark');
  assert.equal(await mode.locator('.tv-fallback-dark:visible').count(),0);
  await page.evaluate(()=>window.orbit.saveSettings({theme:'dark'}));
  if(process.env.ORBIT_QA_OUTPUT){fs.mkdirSync(process.env.ORBIT_QA_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-mode.png')});}
  if(process.env.ORBIT_QA_OUTPUT){
   await page.evaluate(()=>window.orbit.saveSettings({theme:'light'}));await pause(page);
   await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-mode-light-1440.png')});
   await page.evaluate(()=>window.orbit.saveSettings({theme:'dark'}));
   await page.setViewportSize({width:390,height:700});await pause(page);
   await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-mode-390x700.png')});
   await page.evaluate(()=>window.OrbitI18n.setLanguage('de'));await pause(page);
   await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-mode-de-390x700.png')});
   await page.evaluate(()=>window.OrbitI18n.setLanguage('fr'));await pause(page);
   await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-mode-fr-390x700.png')});
   await page.evaluate(()=>window.OrbitI18n.setLanguage('en'));
   await page.waitForTimeout(420);
   await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-mode-390x700-settled.png')});
   await page.setViewportSize({width:1440,height:900});await pause(page);
  }
  await page.setViewportSize({width:390,height:700});await pause(page);
  await page.waitForTimeout(450);
  const recentFocusBounds=await page.evaluate(()=>{
   const row=document.querySelector('.tv-recent'),selected=document.activeElement;
   const viewport=row.getBoundingClientRect(),card=selected.getBoundingClientRect();
   return {key:selected.dataset.tvKey,visible:card.left>=viewport.left-2&&card.right<=viewport.right+2,
    cardLeft:Math.round(card.left),cardRight:Math.round(card.right),
    viewportLeft:Math.round(viewport.left),viewportRight:Math.round(viewport.right)};
  });
  assert(recentFocusBounds.visible,`focused recent game must be fully in view after compact resize: ${JSON.stringify(recentFocusBounds)}`);
  await assertTouchHeight(mode.locator('.tv-exit'),'narrow controller Exit');
  await assertTouchHeight(mode.locator('[data-tv-key="filter:all"]'),'narrow All games filter');
  await assertTouchHeight(mode.locator('[data-tv-key="filter:favorites"]'),'narrow Favorites filter');
  assert(await mode.locator('.tv-hints > span').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize)>=10),'small controller hint labels must remain legible');
  const headerFit=await mode.evaluate(root=>{
   const brand=root.querySelector('.tv-brand').getBoundingClientRect();
   const exit=root.querySelector('.tv-exit').getBoundingClientRect();
   return brand.right+4<=exit.left && exit.right<=root.clientWidth+1;
  });
  assert(headerFit,'narrow logo and Exit button must not collide');
  for(const language of ['de','fr']){
   await page.evaluate(code=>window.OrbitI18n.setLanguage(code),language);await pause(page);
   assert(await page.locator('#controller-root').evaluate(root=>{
    const brand=root.querySelector('.tv-brand').getBoundingClientRect();
    const exit=root.querySelector('.tv-exit').getBoundingClientRect();
    return brand.right+4<=exit.left && exit.right<=root.clientWidth+1;
   }),`translated ${language} Exit must not overlap the logo at 390px`);
  }
  await page.evaluate(()=>window.OrbitI18n.setLanguage('en'));
  await page.setViewportSize({width:320,height:700});await pause(page);
  for(const language of ['de','en','fr']){
   await page.evaluate(code=>window.OrbitI18n.setLanguage(code),language);await pause(page);
   for(const theme of ['dark','light']){
    await page.evaluate(value=>window.orbit.saveSettings({theme:value}),theme);await pause(page);
    const bounds=await page.locator('#controller-root').evaluate(root=>{
     const brand=root.querySelector('.tv-brand').getBoundingClientRect();
     const exit=root.querySelector('.tv-exit').getBoundingClientRect();
     const header=root.querySelector('.tv-header').getBoundingClientRect();
     return {brandRight:brand.right,exitLeft:exit.left,exitRight:exit.right,
      headerRight:header.right,viewportWidth:innerWidth,exitHeight:exit.height};
    });
    assert(bounds.brandRight+4<=bounds.exitLeft && bounds.exitRight<=bounds.headerRight+1 &&
     bounds.exitRight<=bounds.viewportWidth+1,`header must fit at 320px in ${language}/${theme}: ${JSON.stringify(bounds)}`);
    assert(bounds.exitHeight>=44,`Exit touch target must be at least 44px at 320px in ${language}/${theme}`);
   }
  }
  await page.evaluate(()=>window.orbit.saveSettings({theme:'dark'}));
  await page.evaluate(()=>window.OrbitI18n.setLanguage('en'));
  await page.setViewportSize({width:1440,height:900});await pause(page);
  await page.setViewportSize({width:910,height:610});await pause(page);
  assert(await spotlight.isVisible(),'the featured panel remains visible at 910x610');
  assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'compact controller hero must not overflow horizontally');
  assert(await mode.locator('.tv-recent .tv-card-copy strong').first().evaluate(node=>node.getBoundingClientRect().bottom<document.querySelector('.tv-footer').getBoundingClientRect().top),'recent titles remain visible in a 910x610 window');
  if(process.env.ORBIT_QA_OUTPUT)await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-mode-910x610.png')});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await mode.locator('.tv-card').first().evaluate(node=>getComputedStyle(node).transitionDuration),'0s','system reduced motion disables focused-card transitions');
  assert.equal(await spotlight.locator('.tv-spotlight-image').evaluate(node=>getComputedStyle(node).animationName),'none','system reduced motion disables hero animations');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{document.body.dataset.reduceMotion='true'});
  assert.equal(await mode.locator('.tv-card').first().evaluate(node=>getComputedStyle(node).transitionDuration),'0s','in-app reduced motion disables focused-card transitions');
  assert.equal(await spotlight.locator('.tv-spotlight-image').evaluate(node=>getComputedStyle(node).animationName),'none','in-app reduced motion disables hero animations');
  await page.evaluate(()=>{delete document.body.dataset.reduceMotion});
  await page.setViewportSize({width:1440,height:900});await pause(page);
  await page.keyboard.press('ArrowRight');assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000003');
  assert.equal(await spotlight.locator('h2').textContent(),await mode.locator('.tv-recent .tv-card-copy strong').nth(1).textContent(),'controller focus updates the backdrop and game identity without changing focus');
  assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000003','updating featured content does not steal focus');
  await page.keyboard.press('Enter');await mode.locator('.tv-sheet').waitFor();
  assert.equal(await focused(),'detail:play');
  const sheet=mode.locator('.tv-sheet');
  assert(await mode.locator('.tv-stage').evaluate(node=>node.inert),'detail mode isolates the background controller controls');
  assert.equal(await sheet.locator('.tv-sheet-backdrop').count(),1,'detail includes an atmospheric artwork layer');
  assert(await sheet.locator('.tv-sheet-art').isVisible(),'detail has prominent visible contained artwork');
  assert.equal(await sheet.locator('.tv-sheet-art .tv-game-art').evaluate(img=>getComputedStyle(img).objectFit),'contain','detail artwork retains nonstandard aspect ratios');
  await page.evaluate(()=>window.orbit.saveSettings({theme:'light'}));
  assert.equal(await sheet.evaluate(node=>getComputedStyle(node).color),'rgb(244, 240, 250)','light theme retains readable text on the dark immersive detail');
  assert.equal(await sheet.locator('[data-tv-key="detail:back"]').evaluate(node=>getComputedStyle(node).color),'rgb(236, 230, 251)','light theme detail actions retain light readable labels');
  await page.evaluate(()=>window.orbit.saveSettings({theme:'dark'}));
  if(process.env.ORBIT_QA_OUTPUT)await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-detail-1440x900.png')});
  await sheet.evaluate(node=>{window.controllerTest.originalSheet=node});
  await page.evaluate(()=>window.fixture.patch(window.fixture.id(90),{genre:'Unrelated background detail refresh'}));
  await pause(page);
  assert(await sheet.evaluate(node=>node===window.controllerTest.originalSheet),'unrelated updates must preserve detail DOM and decoded artwork');
  assert.equal(await focused(),'detail:play','passive background update must preserve focused detail action');
  await page.setViewportSize({width:910,height:610});await pause(page);
  assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'detail view must fit at 910px');
  assert(await sheet.locator('.tv-sheet-art').isVisible(),'compact detail keeps its artwork instead of hiding it');
  if(process.env.ORBIT_QA_OUTPUT)await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-detail-910x610.png')});
  await page.setViewportSize({width:390,height:730});await pause(page);
  assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'mobile detail must not create horizontal overflow');
  assert(await sheet.locator('.tv-sheet-art').isVisible(),'mobile detail includes visible game art');
  await assertTouchHeight(sheet.locator('[data-tv-key="detail:favorite"]'),'mobile favorite action');
  await assertTouchHeight(sheet.locator('[data-tv-key="detail:back"]'),'mobile Back action');
  await mode.locator('[data-tv-key="detail:back"]').focus();
  assert.equal(await focused(),'detail:back','small-screen detail supports keyboard focus on Back');
  await page.keyboard.press('ArrowUp');
  assert(await focused().then(key=>key.startsWith('detail:')),'small-screen directional navigation stays inside the detail');
  if(process.env.ORBIT_QA_OUTPUT)await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-detail-mobile.png')});
  if(process.env.ORBIT_QA_OUTPUT){
   await page.setViewportSize({width:390,height:700});await pause(page);
   await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-detail-390x700.png')});
   await page.evaluate(()=>window.orbit.saveSettings({theme:'light'}));await pause(page);
   await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-detail-light-390x700.png')});
   await page.evaluate(()=>window.orbit.saveSettings({theme:'dark'}));
  }
  await page.setViewportSize({width:1440,height:900});await pause(page);
  await page.keyboard.press('Escape');
  assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000003');
  await page.evaluate(()=>{window.mockPads=[{id:'Standard test controller',index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0,touched:false}))}];window.dispatchEvent(new Event('gamepadconnected'));});
  await page.getByText('Controller connected',{exact:true}).waitFor();await padButton(page,3);
  assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000009');
  await page.waitForTimeout(1100);
  const idleReads=await page.evaluate(()=>window.controllerTest.padReads);
  await page.waitForTimeout(350);
  const idleDelta=(await page.evaluate(()=>window.controllerTest.padReads))-idleReads;
  assert(idleDelta>0&&idleDelta<=11,'an idle connected controller must be sampled without continuous animation frames');
  await padButton(page,0,550);await mode.locator('.tv-sheet').waitFor();assert.equal(await page.evaluate(()=>window.controllerTest.launches),0,'held select must not launch through the sheet');
  await padButton(page,0,750);assert.equal(await page.evaluate(()=>window.controllerTest.launches),1);
  assert.equal(await mode.locator('[data-tv-key="detail:play"]').getAttribute('aria-disabled'),'true','Starting remains focusable but unavailable');
  assert.equal(await focused(),'detail:play','Starting retains selected play action instead of focusing Favorite');
  const favoritesBeforeRepeatedSelect=await page.evaluate(()=>window.controllerTest.favoriteCalls);
  await padButton(page,0,120);
  assert.equal(await page.evaluate(()=>window.controllerTest.launches),1,'double A while starting does not launch twice');
  assert.equal(await page.evaluate(()=>window.controllerTest.favoriteCalls),favoritesBeforeRepeatedSelect,'double A while starting must never toggle Favorite');
  assert.equal(await focused(),'detail:play','repeat A does not move focus away from Starting');
  await padButton(page,2,120);
  assert.equal(await page.evaluate(()=>window.controllerTest.favoriteCalls),favoritesBeforeRepeatedSelect+1,'an explicit X shortcut can intentionally favorite during launch');
  await padButton(page,2,120);
  assert.equal(await page.evaluate(()=>window.controllerTest.favoriteCalls),favoritesBeforeRepeatedSelect+2,'explicit X can restore the original favorite state');
  await padButton(page,1,120);
  assert.equal(await mode.locator('.tv-sheet').count(),0,'Back remains usable while launch is pending');
  await page.keyboard.press('Enter');await mode.locator('.tv-sheet').waitFor();
  assert.equal(await focused(),'detail:play','reopening pending game keeps Starting focused');
  await padButton(page,0,120);
  assert.equal(await page.evaluate(()=>window.controllerTest.favoriteCalls),favoritesBeforeRepeatedSelect+2,'reopening the pending game cannot turn A into Favorite');
  await page.evaluate(()=>window.controllerTest.finishLaunch());await pause(page);
  await page.waitForFunction(()=>document.querySelector('.tv-recent [data-tv-game="00000000-0000-4000-8000-000000000009"]').textContent.includes('Playing now'));
  assert(!await mode.locator('.tv-recent [data-tv-game="00000000-0000-4000-8000-000000000009"]').textContent().then(text=>text.includes('No playtime recorded')),'a running game must not say no playtime recorded');
  const runningReads=await page.evaluate(()=>window.controllerTest.padReads);
  await page.waitForTimeout(350);
  assert((await page.evaluate(()=>window.controllerTest.padReads))-runningReads<=11,'a game running while the launcher remains focused must not trigger a continuous RAF polling loop');
  await padButton(page,1);assert.equal(await mode.locator('.tv-sheet').count(),0);
  await padButton(page,1);await mode.waitFor({state:'detached'});
  assert.equal(await page.locator('#app').evaluate(node=>node.inert),false);
  assert.equal(await page.evaluate(async()=>(await window.orbit.getWindowState()).fullscreen),false);
  assert(await entry.evaluate(node=>node===document.activeElement));
  const stoppedReads=await page.evaluate(()=>window.controllerTest.padReads);await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.controllerTest.padReads),stoppedReads,'controller polling must stop after exit');
  await page.keyboard.press('F11');await mode.waitFor();
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  const blurredReads=await page.evaluate(()=>window.controllerTest.padReads);await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>window.controllerTest.padReads),blurredReads,'blurred mode must not poll');
  await page.evaluate(()=>{window.mockPads[0].buttons[0]={pressed:true,value:1};window.dispatchEvent(new Event('focus'));});
  await page.waitForTimeout(160);assert.equal(await mode.locator('.tv-sheet').count(),0,'resume must not replay held select');
  await page.evaluate(()=>window.mockPads[0].buttons[0]={pressed:false,value:0});await pause(page);
  await page.getByRole('button',{name:'Favorites',exact:true}).click();
  await mode.locator('[data-tv-key="library:00000000-0000-4000-8000-000000000001"]').focus();
  await padButton(page,2);await page.getByText('No favorites yet',{exact:true}).waitFor();
  assert(await mode.locator('.tv-pagination').isHidden(),'an empty Favorites collection has no usable pagination');
  assert(await mode.evaluate(node=>node.contains(document.activeElement)));
  await page.getByRole('button',{name:'All games',exact:true}).click();
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  await mode.locator('[data-tv-key="library:00000000-0000-4000-8000-000000000012"]').focus();
  // Passive library updates must not snap the scroll position back to a
  // focused card when the user is browsing elsewhere using a wheel/touch.
  await page.setViewportSize({width:910,height:610});
  await page.waitForFunction(()=>document.querySelector('.controller-shell')?.style.getPropertyValue('--tv-columns')==='2');
  await page.evaluate(()=>{window.controllerTest.originalFocusedCard=document.activeElement});
  const passivePosition=await page.evaluate(()=>{
   const main=document.querySelector('.tv-main');
   main.scrollTop=main.scrollHeight;
   return main.scrollTop;
  });
  assert(passivePosition>80,'fixture must permit real scrolling');
  await page.evaluate(()=>window.fixture.patch(window.fixture.id(90),{genre:'Updated in background'}));
  await page.waitForTimeout(200);
  const restoredPosition=await page.evaluate(()=>document.querySelector('.tv-main').scrollTop);
  assert(Math.abs(restoredPosition-passivePosition)<3,'unrelated background updates must not reset controller scroll position');
  assert.equal(await focused(),'library:00000000-0000-4000-8000-000000000012','data updates preserve the selected controller game');
  assert(await page.evaluate(()=>window.controllerTest.originalFocusedCard===document.activeElement),'passive updates must preserve the actual focused card node to avoid artwork reloads');
  await page.setViewportSize({width:910,height:900});
  await page.waitForFunction(()=>document.querySelector('.controller-shell')?.style.getPropertyValue('--tv-columns')==='2');
  assert.equal(await focused(),'library:00000000-0000-4000-8000-000000000012','resize must retain the selected game even when its page changes');
  for(const width of [1920,1440,910,500,390]){
   await page.setViewportSize({width,height:width===1920?1080:900});await pause(page);
   assert(await mode.locator('[data-tv-game]').count()<40);
   assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'no horizontal window overflow');
   await mode.locator('.tv-library [data-tv-game]').first().focus();
   await page.keyboard.press('ArrowRight');assert(await focused());
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  assert.match(await focused(),/^library:/);
  await page.evaluate(()=>window.fixture.nativeFullscreen(false));await mode.waitFor({state:'detached'});
  await page.evaluate(()=>window.controllerTest.deferEntry=true);await entry.click();
  await page.waitForFunction(()=>typeof window.controllerTest.releaseEntry==='function');
  await page.keyboard.press('F11');await entry.click();
  await page.evaluate(()=>window.controllerTest.releaseEntry());await mode.waitFor();
  assert.equal(await page.evaluate(async()=>(await window.orbit.getWindowState()).fullscreen),true,'a stale exit must not undo a new entry');
  await page.keyboard.press('Escape');await mode.waitFor({state:'detached'});
  await page.evaluate(()=>window.controllerTest.failFullscreen=true);
  await entry.click();await page.getByText('Fullscreen fixture failure',{exact:true}).waitFor();
  assert.equal(await page.locator('#controller-root').count(),0);
  assert.equal(await page.locator('#app').evaluate(node=>node.inert),false);
  await page.evaluate(()=>window.controllerTest.failFullscreen=false);
  await entry.click();await mode.waitFor();
  await mode.locator('.tv-library [data-tv-game]').first().focus();
  const selected=await page.evaluate(()=>document.activeElement.dataset.tvGame);
  await page.evaluate(id=>window.orbit.removeGame(id),selected);await pause(page);
  await mode.locator(`[data-tv-key="library:${selected}"]`).waitFor({state:'detached'});
  assert(await mode.evaluate(node=>node.contains(document.activeElement)));
  assert.match(await focused(),/^library:/,'removing a selected game should keep focus in the library');
  if(process.env.ORBIT_QA_OUTPUT)await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-recovery.png')});
  await page.keyboard.press('Escape');await mode.waitFor({state:'detached'});
  await page.evaluate(()=>window.fixture.nativeFullscreen(true));await entry.click();await mode.waitFor();
  await page.keyboard.press('Escape');await mode.waitFor({state:'detached'});
  assert.equal(await page.evaluate(async()=>(await window.orbit.getWindowState()).fullscreen),true,'exit preserves an already-fullscreen desktop');
  const empty=await browser.newPage({viewport:{width:910,height:610},locale:'en-US'});
  await empty.addInitScript(installFixture,{count:0});await empty.goto(page.url());await empty.bringToFront();
  await empty.getByRole('button',{name:'Enter controller mode',exact:true}).click();
  await empty.getByRole('heading',{name:'Your next game starts here.'}).waitFor();
  assert.equal(await empty.locator('.tv-spotlight').count(),1,'empty libraries still have a finished welcome hero');
  assert.equal(await empty.locator('.tv-recent').count(),0);
  assert(await empty.locator('.tv-pagination').isHidden(),'empty library hides disabled pagination controls');
  if(process.env.ORBIT_QA_OUTPUT)await empty.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-empty.png')});
  if(process.env.ORBIT_QA_OUTPUT){
   await empty.setViewportSize({width:390,height:700});await pause(empty);
   await empty.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-empty-390x700.png')});
   await empty.evaluate(()=>window.orbit.saveSettings({theme:'light'}));await pause(empty);
   await empty.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-empty-light-390x700.png')});
  }
  await empty.setViewportSize({width:390,height:700});
  await empty.evaluate(()=>window.orbit.saveSettings({theme:'light'}));await pause(empty);
  assert(await empty.locator('.tv-spotlight-empty .tv-logo-light').isHidden(),'dark spotlight must not display the white-tile artwork variant in light mode');
  assert(await empty.locator('.tv-spotlight-empty .tv-logo-dark').isVisible(),'light mode spotlight must retain a visible Orbit mark');
  assert(await empty.locator('.tv-pagination').isHidden(),'empty mobile library leaves no disabled pagination sticking out above the footer');
  for(let index=0;index<8;index++){await empty.keyboard.press('Tab');assert(await empty.locator('#controller-root').evaluate(node=>node.contains(document.activeElement)));}
  await empty.keyboard.press('Escape');assert.equal(await empty.locator('#app').evaluate(node=>node.inert),false);await empty.close();
  const single=await browser.newPage({viewport:{width:910,height:610},locale:'en-US'});
  await single.addInitScript(installFixture,{count:2});
  await single.addInitScript(()=>window.fixture.patch(window.fixture.id(2),{last_played_at:'2026-10-25T12:00:00Z'}));
  await single.goto(page.url());await single.bringToFront();await single.getByRole('button',{name:'Enter controller mode',exact:true}).click();
  assert.equal(await single.locator('.tv-recent [data-tv-game]').count(),1,'one recent game must have exactly one carousel card');
  assert.equal(await single.locator('.tv-spotlight h2').textContent(),await single.locator('.tv-recent strong').textContent());
  await single.keyboard.press('Escape');await single.close();
  const pair=await browser.newPage({viewport:{width:910,height:610},locale:'en-US'});
  await pair.addInitScript(installFixture,{count:2});
  await pair.addInitScript(()=>{for(let i=1;i<=2;i++)window.fixture.patch(window.fixture.id(i),{last_played_at:`2026-10-2${i}T12:00:00Z`});});
  await pair.goto(page.url());await pair.bringToFront();await pair.getByRole('button',{name:'Enter controller mode',exact:true}).click();
  assert.equal(await pair.locator('.tv-recent [data-tv-game]').count(),2,'two recent games retain both controller cards');
  assert.equal(await pair.locator('.tv-spotlight h2').textContent(),await pair.locator('.tv-recent strong').first().textContent());
  await pair.keyboard.press('ArrowRight');
  assert.equal(await pair.locator('.tv-spotlight h2').textContent(),await pair.locator('.tv-recent strong').nth(1).textContent(),'two recent games update the featured panel by focus');
  await pair.keyboard.press('Escape');await pair.close();
  const ownerPage=await browser.newPage({viewport:{width:1440,height:900},locale:'en-US'});
  await ownerPage.addInitScript(installFixture,{count:6});
  await ownerPage.addInitScript(()=>{
   const controller=index=>({id:'Controller '+index,index,connected:true,mapping:'standard',axes:[0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0,touched:false}))});
   window.makeController=controller;window.mockPads=[controller(0),controller(1)];Object.defineProperty(navigator,'getGamepads',{value:()=>window.mockPads});
  });
  await ownerPage.goto(page.url());await ownerPage.bringToFront();await ownerPage.getByRole('button',{name:'Enter controller mode',exact:true}).click();
  assert.equal(await ownerPage.locator('.tv-recent').count(),0,'nonempty libraries with no recents have no empty carousel');
  assert.equal(await ownerPage.locator('.tv-spotlight').count(),1,'nonempty libraries without recents still feature a game');
  if(process.env.ORBIT_QA_OUTPUT)await ownerPage.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-no-recents.png')});
  await ownerPage.getByText('Controller connected',{exact:true}).waitFor();
  await padButton(ownerPage,15,120,1);
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),'library:00000000-0000-4000-8000-000000000002','the first active controller must work even when another idle pad has a lower index');
  await padButton(ownerPage,15,120,0);
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),'library:00000000-0000-4000-8000-000000000002','idle controllers cannot steal ownership after selection');
  await ownerPage.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));});await pause(ownerPage);
  await padButton(ownerPage,15,120,1);
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),'library:00000000-0000-4000-8000-000000000003','returning from a game must preserve the active controller');
  assert.equal(await ownerPage.locator('.tv-controller-status').getAttribute('title'),'Controller 1','status identifies the pad actually navigating');
  const ownerKey=await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey);
  await ownerPage.keyboard.press('PageDown');
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),ownerKey,'page shortcut at the final page must not steal focus');
  await ownerPage.keyboard.press('PageUp');
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),ownerKey,'page shortcut at the first page must not steal focus');
  await ownerPage.keyboard.press('Home');
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),ownerKey,'Recent shortcut with no recent games must preserve focus');
  assert.equal(await ownerPage.locator('.tv-notice').textContent(),'No recently played games yet.');
  await ownerPage.keyboard.press('Enter');
  await ownerPage.locator('.tv-sheet').waitFor();
  const ownerDetailKey=await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey);
  await ownerPage.keyboard.press('Home');
  assert.equal(await ownerPage.locator('.tv-sheet').count(),1,'a Recent shortcut with no matches must not close a game detail');
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),ownerDetailKey,'a failed Recent shortcut keeps detail focus');
  await ownerPage.keyboard.press('Backspace');
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),ownerKey,'Backspace returns to the original game from detail');
  await ownerPage.setViewportSize({width:390,height:700});await pause(ownerPage);
  await ownerPage.evaluate(()=>document.querySelector('.tv-main').scrollTop=0);
  const beforeScroll=await ownerPage.evaluate(()=>document.querySelector('.tv-main').scrollTop);
  await ownerPage.keyboard.press('Shift+ArrowDown');
  assert(await ownerPage.evaluate(()=>document.querySelector('.tv-main').scrollTop)>beforeScroll,'shift+down scrolls controller page like the right stick');
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),ownerKey,'manual scrolling must not move controller selection');
  await ownerPage.evaluate(()=>document.querySelector('.tv-main').scrollTop=0);
  await ownerPage.evaluate(()=>window.mockPads[1].axes[3]=0.95);
  await ownerPage.waitForTimeout(240);
  assert(await ownerPage.evaluate(()=>document.querySelector('.tv-main').scrollTop)>0,'active controller right stick scrolls page vertically');
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),ownerKey,'right-stick scroll never moves the selected game');
  await ownerPage.evaluate(()=>window.mockPads[1].axes[3]=0);
  await pause(ownerPage);
  await ownerPage.evaluate(()=>{
   const old=window.mockPads[1];window.mockPads[1]=null;
   const event=new Event('gamepaddisconnected');Object.defineProperty(event,'gamepad',{value:old});window.dispatchEvent(event);
  });
  await ownerPage.waitForTimeout(120);
  assert.equal(await ownerPage.locator('.tv-controller-status').getAttribute('title'),'','lost controller ownership clears the active-pad status');
  await padButton(ownerPage,9,120,0);
  assert.equal(await ownerPage.locator('.tv-controller-status').getAttribute('title'),'Controller 0','another neutral controller can claim ownership after a disconnect');
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),ownerKey,'reconnection does not select or launch a game');
  await ownerPage.keyboard.press('Escape');await ownerPage.close();
  assert.deepEqual(errors,[]);
  console.log('Controller checks passed: 5,000 games; recent ordering, keyboard/pad navigation, page bounds, scroll parity, reconnect, held input, launch guard, favorites, native exit, failure recovery, removal, 5 widths.');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});

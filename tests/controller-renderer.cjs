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
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
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
   window.controllerTest={launches:0,requests:[],failFullscreen:false,padReads:0,deferEntry:false};
   const set=window.orbit.setFullscreen,launch=window.orbit.launchGame;
   window.orbit.setFullscreen=async enabled=>{window.controllerTest.requests.push(enabled);if(window.controllerTest.failFullscreen)throw Error('Fullscreen fixture failure');if(window.controllerTest.deferEntry&&enabled){window.controllerTest.deferEntry=false;await new Promise(resolve=>window.controllerTest.releaseEntry=resolve);}return set(enabled);};
   window.orbit.launchGame=id=>{window.controllerTest.launches++;return new Promise(resolve=>{window.controllerTest.finishLaunch=()=>resolve(launch(id));});};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
  await page.bringToFront();
  const entry=page.getByRole('button',{name:'Enter controller mode',exact:true});
  await entry.waitFor({timeout:5000});await entry.click();
  const mode=page.getByRole('dialog',{name:'Orbit controller mode',exact:true});await mode.waitFor();
  const focused=()=>page.evaluate(()=>document.activeElement?.dataset.tvKey||'');
  assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000009');
  assert(await page.locator('#app').evaluate(node=>node.inert));
  assert.equal(await mode.locator('.tv-recent [data-tv-game]').first().getAttribute('data-tv-game'),'00000000-0000-4000-8000-000000000009');
  assert(await mode.locator('[data-tv-game]').count()<40,'large libraries must keep rendered cards bounded');
  const fullBanner=mode.locator('.tv-recent [data-tv-game="00000000-0000-4000-8000-000000000009"] .tv-game-art');
  await fullBanner.evaluate(img=>img.decode());
  assert.equal(await fullBanner.evaluate(img=>img.naturalWidth/img.naturalHeight),5,'fixture exercises an ultra-wide banner');
  assert.equal(await fullBanner.evaluate(img=>getComputedStyle(img).objectFit),'contain','wide artwork must fit completely without trimming either side');
  assert.equal(await fullBanner.evaluate(img=>img.hidden),false);
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
  await brokenBanner.waitFor();
  await page.waitForFunction(()=>document.querySelector('.tv-library [data-tv-game="00000000-0000-4000-8000-000000000001"] .tv-game-art')?.hidden);
  assert.equal(await brokenBanner.evaluate(img=>getComputedStyle(img.parentElement.querySelector('.tv-card-fallback')).display),'grid','broken art still uses icon fallback');
  await page.evaluate(()=>window.orbit.saveSettings({theme:'light'}));
  assert(await mode.locator('.tv-fallback-light:visible').count()>0,'light mode needs a visible light-surface fallback mark');
  assert.equal(await mode.locator('.tv-fallback-dark:visible').count(),0);
  await page.evaluate(()=>window.orbit.saveSettings({theme:'dark'}));
  if(process.env.ORBIT_QA_OUTPUT){fs.mkdirSync(process.env.ORBIT_QA_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.ORBIT_QA_OUTPUT,'controller-mode.png')});}
  await page.keyboard.press('ArrowRight');assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000003');
  await page.keyboard.press('Enter');await mode.locator('.tv-sheet').waitFor();
  assert.equal(await focused(),'detail:play');await page.keyboard.press('Escape');
  assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000003');
  await page.evaluate(()=>{window.mockPads=[{id:'Standard test controller',index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0,touched:false}))}];window.dispatchEvent(new Event('gamepadconnected'));});
  await page.getByText('Controller connected',{exact:true}).waitFor();await padButton(page,3);
  assert.equal(await focused(),'recent:00000000-0000-4000-8000-000000000009');
  await padButton(page,0,550);await mode.locator('.tv-sheet').waitFor();assert.equal(await page.evaluate(()=>window.controllerTest.launches),0,'held select must not launch through the sheet');
  await padButton(page,0,750);assert.equal(await page.evaluate(()=>window.controllerTest.launches),1);
  assert(await mode.locator('[data-tv-key="detail:play"]').isDisabled());
  await page.evaluate(()=>window.controllerTest.finishLaunch());await pause(page);
  await page.waitForFunction(()=>document.querySelector('.tv-recent [data-tv-game="00000000-0000-4000-8000-000000000009"]').textContent.includes('Playing now'));
  assert(!await mode.locator('.tv-recent [data-tv-game="00000000-0000-4000-8000-000000000009"]').textContent().then(text=>text.includes('No playtime recorded')),'a running game must not say no playtime recorded');
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
  assert(await mode.evaluate(node=>node.contains(document.activeElement)));
  await page.getByRole('button',{name:'All games',exact:true}).click();
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  await mode.locator('[data-tv-key="library:00000000-0000-4000-8000-000000000012"]').focus();
  // Passive library updates must not snap the scroll position back to a
  // focused card when the user is browsing elsewhere using a wheel/touch.
  await page.setViewportSize({width:910,height:610});
  await page.waitForFunction(()=>document.querySelector('.controller-shell')?.style.getPropertyValue('--tv-columns')==='2');
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
  const empty=await browser.newPage({viewport:{width:910,height:610}});
  await empty.addInitScript(installFixture,{count:0});await empty.goto(page.url());await empty.bringToFront();
  await empty.getByRole('button',{name:'Enter controller mode',exact:true}).click();
  await empty.getByRole('heading',{name:'Your next game starts here.'}).waitFor();
  for(let index=0;index<8;index++){await empty.keyboard.press('Tab');assert(await empty.locator('#controller-root').evaluate(node=>node.contains(document.activeElement)));}
  await empty.keyboard.press('Escape');assert.equal(await empty.locator('#app').evaluate(node=>node.inert),false);await empty.close();
  const ownerPage=await browser.newPage({viewport:{width:1440,height:900}});
  await ownerPage.addInitScript(installFixture,{count:6});
  await ownerPage.addInitScript(()=>{
   const controller=index=>({id:'Controller '+index,index,connected:true,mapping:'standard',axes:[0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0,touched:false}))});
   window.makeController=controller;window.mockPads=[controller(0),controller(1)];Object.defineProperty(navigator,'getGamepads',{value:()=>window.mockPads});
  });
  await ownerPage.goto(page.url());await ownerPage.bringToFront();await ownerPage.getByRole('button',{name:'Enter controller mode',exact:true}).click();
  await ownerPage.getByText('Controller connected',{exact:true}).waitFor();
  await padButton(ownerPage,15,120,1);
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),'library:00000000-0000-4000-8000-000000000002','the first active controller must work even when another idle pad has a lower index');
  await padButton(ownerPage,15,120,0);
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),'library:00000000-0000-4000-8000-000000000002','idle controllers cannot steal ownership after selection');
  await ownerPage.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));});await pause(ownerPage);
  await padButton(ownerPage,15,120,1);
  assert.equal(await ownerPage.evaluate(()=>document.activeElement.dataset.tvKey),'library:00000000-0000-4000-8000-000000000003','returning from a game must preserve the active controller');
  await ownerPage.keyboard.press('Escape');await ownerPage.close();
  assert.deepEqual(errors,[]);
  console.log('Controller checks passed: 5,000 games; recent ordering, keyboard/pad navigation, held input, launch guard, favorites, native exit, failure recovery, removal, 5 widths.');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});

'use strict';
// Actual shared Electron/Tauri renderer in headless Chrome with fake IPC.
// Uses a disposable browser context; never opens real game/app profiles.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
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
  const context=await browser.newContext({viewport:{width:910,height:610},locale:'nl-NL'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript({content:`(${installFixture.toString()})({count:7});const bootstrap=window.orbit.bootstrap;window.orbit.bootstrap=async()=>({...await bootstrap(),version:'0.2.10'});window.fixtureLaunches=0;const launch=window.orbit.launchGame;window.orbit.launchGame=(...args)=>{window.fixtureLaunches++;return launch(...args)};`});
  const url=`http://127.0.0.1:${server.address().port}/src/ui/index.html`;
  await page.goto(url);
  const dialog=page.locator('.whats-new-dialog');
  await dialog.waitFor();
  if(process.env.ORBIT_WHATS_NEW_SCREENSHOT){
   fs.mkdirSync(path.dirname(process.env.ORBIT_WHATS_NEW_SCREENSHOT),{recursive:true});
   await dialog.screenshot({path:process.env.ORBIT_WHATS_NEW_SCREENSHOT});
  }
  assert.equal(await dialog.getAttribute('aria-modal'),'true');
  assert.match(await dialog.locator('#dialog-title').textContent(),/nieuw|neu|new/i);
  assert.equal(await page.locator('.whats-new-version').count(),4,'0.2.10, 0.2.9, 0.2.8 and 0.2.7 changes are visible');
  const allText=await dialog.textContent();
  for(const phrase of ['0.2.10','0.2.9','0.2.8','0.2.7','Rust','Electron','Menu/Options','Nederlands']){
   assert(allText.includes(phrase),`changelog includes ${phrase}`);
  }
  assert.equal(await page.evaluate(()=>window.fixtureLaunches),0,'onboarding never starts a game');
  const sizing=await dialog.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,view:innerHeight,scroll:el.querySelector('.whats-new-content').scrollHeight,client:el.querySelector('.whats-new-content').clientHeight}));
  assert(sizing.height<=sizing.view*.91,'the dialog stays inside a 610px-high Rust WebView2 window');
  assert(sizing.scroll>sizing.client,'long release history scrolls within the modal');
  const scrollbar=await dialog.locator('.whats-new-content').evaluate(node=>{
   const content=getComputedStyle(node);
   const bar=getComputedStyle(node,'::-webkit-scrollbar');
   const thumb=getComputedStyle(node,'::-webkit-scrollbar-thumb');
   const track=getComputedStyle(node,'::-webkit-scrollbar-track');
   return {overflow:content.overflowY,width:bar.width,thumb:thumb.backgroundColor,
    track:track.backgroundColor,scrollbarColor:content.scrollbarColor};
  });
  assert.equal(scrollbar.overflow,'auto','scrollbar styling does not disable scrolling');
  assert.equal(scrollbar.width,'10px','Orbit uses a slim themed scrollbar in Chromium/WebView2');
  assert.match(scrollbar.thumb,/139,\s*122,\s*255/,'thumb follows the Orbit purple accent');
  assert(!scrollbar.track.includes('255, 255, 255'),'the Windows-white scrollbar track is replaced');
  await page.evaluate(()=>document.body.style.setProperty('--accent-rgb','252, 140, 168'));
  assert.match(
   await dialog.locator('.whats-new-content').evaluate(x=>getComputedStyle(x,'::-webkit-scrollbar-thumb').backgroundColor),
   /252,\s*140,\s*168/,
   'custom accent recolors the release notes scrollbar'
  );
  await page.evaluate(()=>document.body.style.removeProperty('--accent-rgb'));
  const scrollArea=dialog.locator('.whats-new-content');
  await scrollArea.hover();
  await page.mouse.wheel(0,400);
  await page.waitForFunction(()=>document.querySelector('.whats-new-content').scrollTop>0);
  if(process.env.ORBIT_WHATS_NEW_SCREENSHOT){
   await dialog.screenshot({path:process.env.ORBIT_WHATS_NEW_SCREENSHOT});
  }
  await scrollArea.evaluate(node=>node.scrollTop=0);
  await scrollArea.evaluate(node=>node.focus());
  await page.keyboard.press('PageDown');
  await page.waitForFunction(()=>document.querySelector('.whats-new-content').scrollTop>0);
  await scrollArea.evaluate(node=>node.scrollTop=0);
  await page.keyboard.press('Tab');
  assert(await dialog.evaluate(el=>el.contains(document.activeElement)),'keyboard focus remains in dialog');
  await dialog.locator('[data-action=close-modal].primary-btn').click();
  await dialog.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>localStorage.getItem('orbit.whatsNew.lastAcknowledgedVersion')),'0.2.10');
  await page.reload();
  await page.locator('[data-route=settings]').waitFor();
  assert.equal(await dialog.count(),0,'already seen notes are not shown on each start');
  const sidebarReopen=page.locator('.sidebar [data-action=whats-new]');
  await sidebarReopen.waitFor();
  await sidebarReopen.click();
  await dialog.waitFor();
  await dialog.locator('.whats-new-close').click();
  await dialog.waitFor({state:'detached'});
  await page.locator('[data-route=settings]').click();
  const reopen=page.locator('.settings-card [data-action=whats-new]');
  await reopen.waitFor();
  await reopen.click();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await reopen.evaluate(x=>x===document.activeElement),true,'Escape restores Settings button focus');
  await page.evaluate(()=>localStorage.setItem('orbit.whatsNew.lastAcknowledgedVersion','0.2.9'));
  await page.reload();
  await dialog.waitFor();
  assert.equal(await page.evaluate(()=>window.fixtureLaunches),0);
  await page.setViewportSize({width:390,height:700});
  assert(await dialog.evaluate(el=>el.getBoundingClientRect().width<=innerWidth),'modal fits narrow screens');
  await page.keyboard.press('Escape');
  // Real app starts with the persisted acknowledgment already present in WebView2.
  // Each scenario uses its own isolated browser context; no live profile is opened.
  for(const {version,acknowledged,denied,visible} of [
   {version:'0.2.10',acknowledged:'0.2.10',visible:false},
   {version:'0.2.10',acknowledged:'0.2.9',visible:true},
   {version:'0.2.10+build.1',visible:true},
   {version:'0.2.10.0',visible:true},
   {version:'0.2.9',visible:false},
   {version:'0.2.10',denied:true,visible:true},
  ]){
   const isolated=await browser.newContext({viewport:{width:910,height:610},locale:'en-US'});
   try{
    const errorsInCase=[];
    const scenario=await isolated.newPage();
    scenario.on('pageerror',error=>errorsInCase.push(error.message));
    const init='('+installFixture.toString()+')({count:3});'
     +'const original=window.orbit.bootstrap;window.orbit.bootstrap=async()=>({...await original(),version:'+JSON.stringify(version)+'});'
     +(acknowledged?'localStorage.setItem("orbit.whatsNew.lastAcknowledgedVersion",'+JSON.stringify(acknowledged)+');':'')
     +(denied?'Object.defineProperty(window,"localStorage",{configurable:true,get(){throw Error("Storage denied")}});':'');
    await scenario.addInitScript({content:init});
    await scenario.goto(url);
    await scenario.locator('.sidebar [data-action=whats-new]').waitFor();
    const notes=scenario.locator('.whats-new-dialog');
    if(visible)await notes.waitFor();
    assert.equal(await notes.count(),Number(visible),'auto-open for version '+version+', acknowledged '+acknowledged+', denied '+denied);
    if(visible){
     await notes.locator('.whats-new-close').click();
     await notes.waitFor({state:'detached'});
    }
    await scenario.locator('.sidebar [data-action=whats-new]').click();
    await notes.waitFor();
    await notes.locator('.whats-new-close').click();
    await notes.waitFor({state:'detached'});
    assert.deepEqual(errorsInCase,[],'no errors for '+version+', denied='+denied);
   }finally{await isolated.close();}
  }
  assert.deepEqual(errors,[]);
  console.log('Whats New PASS: first install, acknowledgment, re-open, version suffixes, denied storage, focus, translations and responsive UI.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());

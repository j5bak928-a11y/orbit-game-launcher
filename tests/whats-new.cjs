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
  await page.addInitScript({content:`(${installFixture.toString()})({count:7});const bootstrap=window.orbit.bootstrap;window.orbit.bootstrap=async()=>({...await bootstrap(),version:'0.2.8'});window.fixtureLaunches=0;const launch=window.orbit.launchGame;window.orbit.launchGame=(...args)=>{window.fixtureLaunches++;return launch(...args)};`});
  const url=`http://127.0.0.1:${server.address().port}/src/ui/index.html`;
  await page.goto(url);
  const dialog=page.locator('.whats-new-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('aria-modal'),'true');
  assert.match(await dialog.locator('#dialog-title').textContent(),/nieuw|neu|new/i);
  assert.equal(await page.locator('.whats-new-version').count(),2,'both 0.2.8 and 0.2.7 changes are visible');
  const allText=await dialog.textContent();
  for(const phrase of ['0.2.8','0.2.7','Rust','Electron','Menu/Options','Nederlands']){
   assert(allText.includes(phrase),`changelog includes ${phrase}`);
  }
  assert.equal(await page.evaluate(()=>window.fixtureLaunches),0,'onboarding never starts a game');
  const sizing=await dialog.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,view:innerHeight,scroll:el.querySelector('.whats-new-content').scrollHeight,client:el.querySelector('.whats-new-content').clientHeight}));
  assert(sizing.height<=sizing.view*.91,'the dialog stays inside a 610px-high Rust WebView2 window');
  assert(sizing.scroll>sizing.client,'long release history scrolls within the modal');
  await page.keyboard.press('Tab');
  assert(await dialog.evaluate(el=>el.contains(document.activeElement)),'keyboard focus remains in dialog');
  await dialog.locator('[data-action=close-modal].primary-btn').click();
  await dialog.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>localStorage.getItem('orbit.whatsNew.lastAcknowledgedVersion')),'0.2.8');
  await page.reload();
  await page.locator('[data-route=settings]').waitFor();
  assert.equal(await dialog.count(),0,'already seen notes are not shown on each start');
  await page.locator('[data-route=settings]').click();
  const reopen=page.locator('[data-action=whats-new]');
  await reopen.waitFor();
  await reopen.click();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await reopen.evaluate(x=>x===document.activeElement),true,'Escape restores Settings button focus');
  await page.evaluate(()=>localStorage.setItem('orbit.whatsNew.lastAcknowledgedVersion','0.2.7'));
  await page.reload();
  await dialog.waitFor();
  assert.equal(await page.evaluate(()=>window.fixtureLaunches),0);
  await page.setViewportSize({width:390,height:700});
  assert(await dialog.evaluate(el=>el.getBoundingClientRect().width<=innerWidth),'modal fits narrow screens');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);
  console.log('Whats New PASS: first install, one-time dismissal, re-open, version update, focus, translations and responsive UI.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());

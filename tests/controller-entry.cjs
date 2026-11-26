'use strict';
// Desktop controller entry: synthetic Gamepad API only; no hardware or game launch.
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
const sleep=page=>page.waitForTimeout(290);

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
  ?{headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}
  :{headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL||'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:910,height:610},locale:'en-US'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(installFixture,{count:8});
  await page.addInitScript(()=>{
   const pad={index:0,id:'Synthetic Xbox standard pad',connected:true,mapping:'standard',
    axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
   // A button held before bootstrap is not an opt-in press.
   pad.buttons[9]={pressed:true,value:1};
   window.entryQA={pads:[pad],reads:0,focused:true,hidden:false,fullscreenCalls:[]};
   Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>{window.entryQA.reads++;return window.entryQA.pads;}});
   Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>window.entryQA.focused});
   Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.entryQA.hidden});
   const setFullscreen=window.orbit.setFullscreen;
   window.orbit.setFullscreen=async enabled=>{
    window.entryQA.fullscreenCalls.push(enabled);
    return setFullscreen(enabled);
   };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
  await page.bringToFront();
  const mode=page.locator('#controller-root');
  const button=page.locator('[data-action="controller-mode"]').first();
  await button.waitFor();
  const pressed=async (index=9,down=true)=>page.evaluate(({index,down})=>{
   window.entryQA.pads[0].buttons[index]={pressed:down,value:down?1:0};
  },{index,down});
  const enter=async()=>{await pressed(9,true);await mode.waitFor({timeout:2500});};
  const exit=async()=>{await page.keyboard.press('Escape');await mode.waitFor({state:'detached',timeout:2500});};
  const noEntry=async message=>{await sleep(page);assert.equal(await mode.count(),0,message);};
  const count=()=>page.evaluate(()=>window.entryQA.fullscreenCalls.length);

  await noEntry('held Menu during bootstrap cannot enter');
  assert.equal(await count(),0,'startup held button must not toggle fullscreen');
  await pressed(9,false);await sleep(page);
  await enter();
  assert.equal(await count(),1,'fresh Menu press enters fullscreen exactly once');
  assert.equal(await page.evaluate(async()=>(await window.orbit.getWindowState()).fullscreen),true);
  await page.waitForTimeout(560);
  assert.equal(await count(),1,'held Menu must not toggle/exit/re-enter repeatedly');
  await exit();
  assert.equal(await count(),2,'Escape restores desktop fullscreen state');
  await noEntry('held Menu after exit must not re-enter');
  await pressed(9,false);await sleep(page);
  await enter();await exit();
  await pressed(9,false);await sleep(page);
  console.log('PASS fresh press, bootstrap hold, sustained hold and post-exit neutral requirement');

  // Blurred windows must not sample or react to a queued Menu press.
  await page.evaluate(()=>{window.entryQA.focused=false;window.dispatchEvent(new Event('blur'));});
  await pressed(9,true);const blurredReads=await page.evaluate(()=>window.entryQA.reads);
  await noEntry('blur ignores Menu');assert.equal(await page.evaluate(()=>window.entryQA.reads),blurredReads,'blur stops desktop pad reads');
  await page.evaluate(()=>{window.entryQA.focused=true;window.dispatchEvent(new Event('focus'));});
  await noEntry('a held Menu must not replay on focus');
  await pressed(9,false);await sleep(page);await enter();await exit();
  await pressed(9,false);await sleep(page);
  console.log('PASS blur/focus pause, resume and held-input neutral gate');

  await page.evaluate(()=>{window.entryQA.hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
  await pressed(9,true);const hiddenReads=await page.evaluate(()=>window.entryQA.reads);
  await noEntry('hidden window ignores Menu');assert.equal(await page.evaluate(()=>window.entryQA.reads),hiddenReads,'hidden windows are not polled');
  await page.evaluate(()=>{window.entryQA.hidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await noEntry('hidden input must not replay after visibility resumes');
  await pressed(9,false);await sleep(page);await enter();await exit();
  await pressed(9,false);await sleep(page);
  console.log('PASS visibility pause and resume without replay');

  // Modal and active game preconditions stop watching, then demand neutral.
  await page.locator('.topbar [data-action="add"]').click();
  await pressed(9,true);const modalReads=await page.evaluate(()=>window.entryQA.reads);
  await noEntry('an open editor must block controller entry');
  assert.equal(await page.evaluate(()=>window.entryQA.reads),modalReads,'modal does not sustain polling');
  await page.locator('#modal-root [data-action="close-modal"]').first().click();
  await noEntry('closing a modal while Menu is held must not trigger entry');
  await pressed(9,false);await sleep(page);await enter();await exit();
  await pressed(9,false);await sleep(page);
  await page.evaluate(()=>window.fixture.setRunning([window.fixture.id(1)]));
  await pressed(9,true);const gameReads=await page.evaluate(()=>window.entryQA.reads);
  await noEntry('running game must block controller entry');
  assert.equal(await page.evaluate(()=>window.entryQA.reads),gameReads,'running game must stop desktop polling');
  await page.evaluate(()=>window.fixture.setRunning([]));
  await noEntry('Menu still held when game ends must not replay');
  await pressed(9,false);await sleep(page);await enter();await exit();
  await pressed(9,false);await sleep(page);
  console.log('PASS modal and running-game safety gates');

  // A launch request that has not resolved yet also blocks desktop entry.
  await page.evaluate(()=>{
   window.orbit.launchGame=()=>new Promise(resolve=>{window.entryQA.completeLaunch=()=>resolve({message:'Fixture launch complete'});});
  });
  await page.locator('[data-route="library"]').first().click();
  await page.locator('.game-card .cover-play').first().click();
  await page.waitForFunction(()=>document.querySelector('.game-card .cover-play')?.disabled);
  await pressed(9,true);
  const pendingReads=await page.evaluate(()=>window.entryQA.reads);
  await noEntry('pending game launch must block controller entry');
  assert.equal(await page.evaluate(()=>window.entryQA.reads),pendingReads,'pending game launch pauses pad reads');
  await page.evaluate(()=>window.entryQA.completeLaunch());
  await page.waitForTimeout(850);
  await noEntry('held Menu after launch completes must not replay');
  await pressed(9,false);await sleep(page);await enter();await exit();
  await pressed(9,false);await sleep(page);
  console.log('PASS in-flight game-launch safety gate');

  // Unsupported/disconnected controllers must never maintain a desktop timer.
  await page.evaluate(()=>{window.entryQA.pads[0].mapping='';window.dispatchEvent(new Event('gamepadconnected'));});
  await pressed(9,true);const unsupportedReads=await page.evaluate(()=>window.entryQA.reads);
  await noEntry('unmapped controller is ignored');
  assert.equal(await page.evaluate(()=>window.entryQA.reads),unsupportedReads,'unmapped controller is not polled');
  await page.evaluate(()=>{window.entryQA.pads=[];window.dispatchEvent(new Event('gamepaddisconnected'));});
  const disconnectedReads=await page.evaluate(()=>window.entryQA.reads);
  await sleep(page);
  assert.equal(await page.evaluate(()=>window.entryQA.reads),disconnectedReads,'no connected controller means no desktop polling');
  await page.evaluate(()=>{
   const pad={index:0,id:'Reconnected standard pad',connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
   pad.buttons[9]={pressed:true,value:1};
   window.entryQA.pads=[pad];
   window.dispatchEvent(new Event('gamepadconnected'));
  });
  await noEntry('a newly connected gamepad holding Menu must not auto-enter');
  await pressed(9,false);await sleep(page);await enter();await exit();
  await pressed(9,false);await sleep(page);
  console.log('PASS disconnected, unsupported, held-on-connect and reconnect behavior');

  // Existing user-controlled routes remain independent of the opt-in gamepad.
  await button.click();await mode.waitFor();await exit();
  await page.keyboard.press('F11');await mode.waitFor();await exit();
  assert.equal(await page.evaluate(async()=>(await window.orbit.getWindowState()).fullscreen),false);
  assert.deepEqual(errors,[],'no browser exceptions');
  console.log('PASS icon and F11 entry/exit parity, 0 runtime errors');
  await page.close();

  // Opt-in startup auto-enter when a standard gamepad is already connected.
  const autoPage=await browser.newPage({viewport:{width:910,height:610},locale:'en-US'});
  const autoErrors=[];
  autoPage.on('pageerror',error=>autoErrors.push(error.message));
  await autoPage.addInitScript(installFixture,{count:4});
  await autoPage.addInitScript(()=>{
   const pad={index:0,id:'Startup Xbox pad',connected:true,mapping:'standard',
    axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
   window.autoQA={pads:[pad]};
   Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>window.autoQA.pads});
   const bootstrap=window.orbit.bootstrap;
   window.orbit.bootstrap=async()=>{
    const data=await bootstrap();
    data.settings.controllerAutoEnter=true;
    return data;
   };
  });
  await autoPage.goto(`http://127.0.0.1:${server.address().port}/src/ui/index.html`);
  await autoPage.bringToFront();
  await autoPage.locator('#controller-root').waitFor({timeout:3000});
  await autoPage.keyboard.press('Escape');
  await autoPage.locator('#controller-root').waitFor({state:'detached',timeout:2500});
  await sleep(autoPage);
  assert.equal(await autoPage.locator('#controller-root').count(),0,'exiting after startup auto-enter must not bounce back in');
  assert.deepEqual(autoErrors,[],'no browser exceptions during startup auto-enter');
  await autoPage.close();
  console.log('PASS startup auto-enter with connected standard gamepad');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;server.close();});

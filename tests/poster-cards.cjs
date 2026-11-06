'use strict';
// Browser fixture for poster-only cards. Never opens installed games or user data.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.ORBIT_PLAYWRIGHT_PATH||'playwright');
const {installFixture}=require('./fixtures/renderer.cjs');

const root=path.resolve(__dirname,'..');
const screenshotDir=process.env.ORBIT_POSTER_CARD_SCREENSHOTS;

test('poster cards keep the existing Orbit shell and expose working artwork actions',async t=>{
 const browser=await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
  ?{headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}
  :{headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL||'chrome'});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const html=fs.readFileSync(path.join(root,'src/ui/index.html'),'utf8')
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/,'')
  .replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g,'')
  .replace('<link rel="stylesheet" href="./styles.css" />','<style>'+fs.readFileSync(path.join(root,'src/ui/styles.css'),'utf8')+'</style>');
 await page.setContent(html);
 await page.evaluate(installFixture,{count:24});
 await page.evaluate(()=>{
  const urls={};
  for(let i=0;i<12;i++){
   const image=document.createElement('canvas');image.width=400;image.height=600;
   const ctx=image.getContext('2d'),shade=ctx.createLinearGradient(0,0,400,600);
   const colors=['#1d306b','#9d3f40','#1d756e','#653c95','#b07724','#315b8c'];
   shade.addColorStop(0,colors[i%colors.length]);shade.addColorStop(1,'#080b19');
   ctx.fillStyle=shade;ctx.fillRect(0,0,400,600);
   ctx.fillStyle='rgba(255,255,255,.13)';
   for(let j=0;j<4;j++){ctx.beginPath();ctx.arc(230+j*45,180+j*110,90,0,Math.PI*2);ctx.fill();}
   ctx.textAlign='center';ctx.fillStyle='#fff';ctx.font='bold 70px Arial';ctx.fillText('ORBIT',200,365);
   ctx.font='bold 43px Arial';ctx.fillText('GAME '+String(i+1).padStart(2,'0'),200,420);
   const token=`77777777-7777-4777-8777-${String(i+1).padStart(12,'0')}.png`;
   urls[token]=image.toDataURL('image/png');
   window.fixture.patch(window.fixture.id(i+1),{cover:token});
  }
  window.OrbitArtworkUrl=token=>urls[token]||null;
 });
 for(const file of ['library-updates.js','app.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'src/ui',file),'utf8')});
 await page.locator('nav [data-route=library]').click();
 const card=page.locator('.poster-card').first();await card.waitFor();
 assert.equal(await page.locator('.sidebar').count(),1,'Orbit sidebar is unchanged');
 assert.equal(await page.locator('.topbar').count(),1,'Orbit header is unchanged');
 assert.equal(await page.locator('.game-actions-popup').count(),0);
 assert.equal(await card.locator('.cover-image').count(),1,'only one cover loads per tile');
 const initial=await card.evaluate(node=>{
  const rect=node.getBoundingClientRect(),cover=node.querySelector('.cover').getBoundingClientRect();
  return {rect:{width:rect.width,height:rect.height},cover:{width:cover.width,height:cover.height},
   caption:getComputedStyle(node.querySelector('.game-label')).opacity,
   play:getComputedStyle(node.querySelector('.cover-play')).opacity};
 });
 assert(Math.abs(initial.cover.height/initial.cover.width-1.5)<.02,'poster retains portrait 2:3 ratio');
 assert(Math.abs(initial.rect.height-initial.cover.height)<2,'no labels appear below the poster');
 assert.equal(initial.play,'0','unselected poster does not obscure its artwork');
 assert.equal(initial.caption,'0','metadata is quiet until card selection');
 await card.hover();
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.poster-card .cover-play')).opacity==='1');
 const buttons=await card.evaluate(node=>{
  const rect=el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
  return {cover:rect(node.querySelector('.cover')),heart:rect(node.querySelector('.favorite-float')),
   menu:rect(node.querySelector('.card-menu-float')),play:rect(node.querySelector('.cover-play'))};
 });
 assert(buttons.heart.x<buttons.cover.x+buttons.cover.width/2,'favorite is top-left');
 assert(buttons.menu.x>buttons.cover.x+buttons.cover.width/2,'menu is top-right');
 assert(buttons.heart.right<buttons.menu.x,'upper corner actions do not overlap');
 assert(buttons.play.width>buttons.cover.width*.7,'wide blue Play button sits on the poster');
 assert(buttons.play.bottom<buttons.cover.bottom+1,'Play stays inside the poster');
 assert.equal(await card.locator('.cover-play').textContent(),'Spelen');
 assert.equal(await card.locator('.cover-play').evaluate(x=>getComputedStyle(x).backgroundColor),'rgb(36, 184, 245)');
 if(screenshotDir){fs.mkdirSync(screenshotDir,{recursive:true});await page.screenshot({path:path.join(screenshotDir,'orbit-posters-desktop.png')});}
 const heart=card.locator('.favorite-float');await heart.click();
 assert(await card.locator('.favorite-float.active').count(),'heart action updates favorite instead of opening details');
 await card.locator('.card-menu-float').click();
 await page.locator('#game-actions-popup').waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#game-actions-popup').count(),0,'Escape closes game card menu');
 await card.locator('.cover-play').click();
 await page.waitForFunction(()=>document.querySelector('.poster-card')?.querySelector('.game-meta')?.textContent.includes('Playing now'));
 assert.equal(await page.locator('[role=dialog]').count(),0,'Play does not open the details dialog');
 await card.focus();await page.keyboard.press('Enter');
 await page.locator('[role=dialog]').waitFor();await page.keyboard.press('Escape');
 assert(await page.locator('.poster-card').first().evaluate(node=>document.activeElement===node),'Escape restores card focus');
 await page.setViewportSize({width:390,height:780});await page.locator('.poster-card').first().hover();
 const narrow=await page.locator('.poster-card').first().evaluate(node=>{
  const cover=node.querySelector('.cover').getBoundingClientRect();
  const heart=node.querySelector('.favorite-float').getBoundingClientRect();
  const menu=node.querySelector('.card-menu-float').getBoundingClientRect();
  const play=node.querySelector('.cover-play').getBoundingClientRect();
  return {coverWidth:cover.width,playWidth:play.width,heartRight:heart.right,menuLeft:menu.left,buttonHeight:play.height};
 });
 assert(narrow.heartRight<narrow.menuLeft,'corner buttons do not overlap on narrow screens');
 assert(narrow.playWidth>narrow.coverWidth*.7,'narrow Play button remains wide');
 assert(narrow.buttonHeight>=34,'touch-sized Play action on narrow layout');
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'orbit-posters-narrow.png')});
 await page.evaluate(()=>window.orbit.saveSettings({reduceMotion:true}));
 assert.equal(await page.locator('.poster-card .cover').first().evaluate(node=>getComputedStyle(node).transitionDuration),'0s','reduced-motion disables card animation');
 assert.deepEqual(errors,[]);
});

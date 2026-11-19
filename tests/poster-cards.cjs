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

async function assertContinuousCaption(card){
 const layout=await card.evaluate(node=>{
  const bounds=selector=>node.querySelector(selector).getBoundingClientRect();
  const label=node.querySelector('.game-label');
  return {
   gradient:getComputedStyle(label).backgroundImage,
   captionBottom:label.getBoundingClientRect().bottom,
   coverBottom:bounds('.cover').bottom,
   textBottom:bounds('.game-meta').bottom,
   playTop:bounds('.cover-play').top
  };
 });
 assert.match(layout.gradient,/^linear-gradient/,'caption keeps a contrast gradient');
 assert(Math.abs(layout.captionBottom-layout.coverBottom)<=2,'gradient continues behind Play to the poster bottom');
 assert(layout.textBottom<=layout.playTop,'metadata stays above Play');
}

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
 assert.equal(await card.locator('.favorite-float').evaluate(x=>getComputedStyle(x).opacity),'0',
  'unselected favorite stays hidden when the card is idle');
 await card.focus();
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.poster-card .favorite-float')).opacity==='1');
 await page.locator('nav [data-route=library]').focus();
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.poster-card .favorite-float')).opacity==='0');
 await card.hover();
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.poster-card .cover-play')).opacity==='1');
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.poster-card .game-label')).opacity==='1');
 assert.equal(await card.locator('.game-name').textContent(),'Game 00000',
  'poster reveals the game title when actions become visible');
 await assertContinuousCaption(card);
 const buttons=await card.evaluate(node=>{
  const rect=el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
  return {cover:rect(node.querySelector('.cover')),heart:rect(node.querySelector('.favorite-float')),
   menu:rect(node.querySelector('.card-menu-float')),play:rect(node.querySelector('.cover-play'))};
 });
 assert(buttons.heart.x<buttons.cover.x+buttons.cover.width/2,'favorite stays top-left');
 assert(buttons.menu.x>buttons.cover.x+buttons.cover.width/2,'menu stays top-right');
 assert(buttons.heart.right<buttons.menu.x,'upper corner actions do not overlap');
 assert(Math.abs(buttons.heart.y-buttons.menu.y)<=1,
  'favorite and actions menu align on the same top row instead of a 6px vertical offset');
 assert.equal(await card.locator('.favorite-float svg').evaluate(x=>getComputedStyle(x).stroke),'rgb(139, 122, 255)',
  'unselected heart outline is purple, not white or gold');
 assert.equal(await card.locator('.favorite-float svg').evaluate(x=>getComputedStyle(x).fill),'none',
  'unselected heart remains an outlined shape');
 assert(buttons.play.width>buttons.cover.width*.7,'wide accent-colored Play button sits on the poster');
 assert(buttons.play.bottom<buttons.cover.bottom+1,'Play stays inside the poster');
 assert.equal(await card.locator('.cover-play').textContent(),'Spelen');
 assert.equal(await card.locator('.cover-play').evaluate(x=>getComputedStyle(x).backgroundColor),'rgb(139, 122, 255)',
  'poster Play uses the same purple accent as other primary buttons');
 assert.equal(await card.locator('.cover-play svg').evaluate(x=>getComputedStyle(x).fill),'rgb(17, 18, 29)',
  'poster Play icon uses the shared dark-on-accent ink');
 await page.evaluate(()=>window.orbit.saveSettings({accent:'#fc8ca8'}));
 assert.equal(await card.locator('.cover-play').evaluate(x=>getComputedStyle(x).backgroundColor),'rgb(252, 140, 168)',
  'poster Play follows a changed accent preference instead of staying hard-coded blue');
 await page.evaluate(()=>window.orbit.saveSettings({accent:'#8b7aff'}));
 if(screenshotDir){fs.mkdirSync(screenshotDir,{recursive:true});await page.screenshot({path:path.join(screenshotDir,'orbit-posters-desktop.png')});}
 const heart=card.locator('.favorite-float');await heart.click();
 await card.locator('.favorite-float.active').waitFor({state:'attached'});
 await page.mouse.move(0,0);
 await page.locator('nav [data-route=library]').focus();
 assert.equal(await card.locator('.favorite-float.active').evaluate(x=>getComputedStyle(x).opacity),'1',
  'selected favorites stay visible without card hover or keyboard focus');
 await card.hover();
 assert(await card.locator('.favorite-float.active').count(),'heart action updates favorite instead of opening details');
 assert.equal(await card.locator('.favorite-float').getAttribute('aria-pressed'),'true');
 assert.equal(await card.locator('.favorite-float svg').evaluate(x=>getComputedStyle(x).fill),'rgb(139, 122, 255)',
  'favorited poster heart is fully filled purple, not partially transparent');
 assert.equal(await card.locator('.favorite-float svg').evaluate(x=>getComputedStyle(x).stroke),'rgb(139, 122, 255)',
  'favorited poster heart outline matches the purple fill even on hover');
 await page.evaluate(()=>window.orbit.saveSettings({accent:'#fc8ca8'}));
 assert.equal(await card.locator('.favorite-float svg').evaluate(x=>getComputedStyle(x).fill),'rgb(252, 140, 168)',
  'selected heart follows a customized accent');
 assert.equal(await card.locator('.favorite-float svg').evaluate(x=>getComputedStyle(x).stroke),'rgb(252, 140, 168)',
  'selected heart stroke follows the customized accent too');
 await page.evaluate(()=>window.orbit.saveSettings({accent:'#8b7aff'}));
 await heart.click();
 await page.waitForFunction(()=>document.querySelector('.poster-card .favorite-float')?.getAttribute('aria-pressed')==='false');
 await page.mouse.move(0,0);
 await page.locator('nav [data-route=library]').focus();
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.poster-card .favorite-float')).opacity==='0');
 await card.hover();
 assert.equal(await card.locator('.favorite-float svg').evaluate(x=>getComputedStyle(x).fill),'none',
  'removing a favorite restores the unfilled heart');
 assert.equal(await card.locator('.favorite-float svg').evaluate(x=>getComputedStyle(x).stroke),'rgb(139, 122, 255)',
  'removed favorite keeps the purple outline');
 await heart.click();
 await page.waitForFunction(()=>document.querySelector('.poster-card .favorite-float')?.getAttribute('aria-pressed')==='true');
 await card.locator('.card-menu-float').click();
 await page.locator('#game-actions-popup').waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#game-actions-popup').count(),0,'Escape closes game card menu');
 await card.locator('.cover-play').click();
 await page.waitForFunction(()=>document.querySelector('.poster-card')?.querySelector('.game-meta')?.textContent.includes('Playing now'));
 assert.equal(await page.locator('[role=dialog]').count(),0,'Play does not open the details dialog');
 await card.focus();await page.keyboard.press('Enter');
 await page.locator('[role=dialog]').waitFor();
 const modalFavorite=page.locator('.showcase-favorite');
 assert.equal(await modalFavorite.getAttribute('aria-pressed'),'true');
 assert.equal(await modalFavorite.locator('svg').evaluate(x=>getComputedStyle(x).fill),'rgb(139, 122, 255)',
  'favorited game details show a solid purple heart');
 await page.keyboard.press('Escape');
 assert(await page.locator('.poster-card').first().evaluate(node=>document.activeElement===node),'Escape restores card focus');
 await page.locator('[data-action=view][data-view=list]').click();
 const listFavorite=page.locator('.game-row').first().locator('[data-action=favorite]');
 await listFavorite.waitFor();
 assert.equal(await listFavorite.getAttribute('aria-pressed'),'true');
 assert.equal(await listFavorite.locator('svg').evaluate(x=>getComputedStyle(x).fill),'rgb(139, 122, 255)',
  'favorited list row also shows a fully purple heart');
 await listFavorite.click();
 await page.waitForFunction(()=>document.querySelector('.game-row [data-action=favorite]')?.getAttribute('aria-pressed')==='false');
 assert.equal(await listFavorite.locator('svg').evaluate(x=>getComputedStyle(x).fill),'none',
  'unfavorited list row restores the outline');
 assert.equal(await listFavorite.locator('svg').evaluate(x=>getComputedStyle(x).stroke),'rgb(139, 122, 255)',
  'unfavorited list row retains purple outline');
 await page.locator('[data-action=view][data-view=grid]').click();
 await card.waitFor();
 await page.setViewportSize({width:390,height:780});await page.locator('.poster-card').first().hover();
 await assertContinuousCaption(card);
 const narrow=await page.locator('.poster-card').first().evaluate(node=>{
  const cover=node.querySelector('.cover').getBoundingClientRect();
  const heart=node.querySelector('.favorite-float').getBoundingClientRect();
  const menu=node.querySelector('.card-menu-float').getBoundingClientRect();
  const play=node.querySelector('.cover-play').getBoundingClientRect();
  return {coverWidth:cover.width,playWidth:play.width,heartLeft:heart.left,
   heartRight:heart.right,heartTop:heart.top,menuLeft:menu.left,menuRight:menu.right,
   menuTop:menu.top,buttonHeight:play.height};
 });
 assert(narrow.heartRight<narrow.menuLeft,'corner controls do not overlap on narrow screens');
 assert(Math.abs(narrow.heartTop-narrow.menuTop)<=1,'narrow controls share an aligned top edge');
 assert(narrow.playWidth>narrow.coverWidth*.7,'narrow Play button remains wide');
 assert(narrow.buttonHeight>=38,'Play action stays consistent with other primary controls on narrow layouts');
 assert(await page.locator('.poster-card').first().evaluate(node=>{
  const favorite=node.querySelector('.favorite-float').getBoundingClientRect();
  const menu=node.querySelector('.card-menu-float').getBoundingClientRect();
  return favorite.width>=36&&favorite.height>=36&&menu.width>=36&&menu.height>=36;
 }), 'compact poster corner actions have comfortable touch targets');
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'orbit-posters-narrow.png')});
 await page.evaluate(()=>window.orbit.saveSettings({reduceMotion:true}));
 assert.equal(await page.locator('.poster-card .cover').first().evaluate(node=>getComputedStyle(node).transitionDuration),'0s','reduced-motion disables card animation');
 assert.deepEqual(errors,[]);
});

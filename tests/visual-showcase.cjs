'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.ORBIT_PLAYWRIGHT_PATH||'playwright');
const {installFixture}=require('./fixtures/renderer.cjs');

const root=path.resolve(__dirname,'..');
const screenshotDir=process.env.ORBIT_SHOWCASE_SCREENSHOT_DIR;

test('cinematic showcase preserves launch, favorite, focus and responsive artwork',async t=>{
 const browser=await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
  ?{headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}
  :{headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL||'chrome'});
 t.after(()=>browser.close());
 const errors=[];
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',error=>errors.push(error.message));
 const html=fs.readFileSync(path.join(root,'src/ui/index.html'),'utf8')
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/,'')
  .replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g,'')
  .replace('<link rel="stylesheet" href="./styles.css" />',`<style>${fs.readFileSync(path.join(root,'src/ui/styles.css'),'utf8')}</style>`);
 await page.setContent(html);
 await page.evaluate(installFixture,{count:5000});
 await page.evaluate(()=>{
  const createArtwork=(width,height,dark,bright)=>{
   const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
   const context=canvas.getContext('2d'),gradient=context.createLinearGradient(0,0,width,height);
   gradient.addColorStop(0,dark);gradient.addColorStop(.54,bright);gradient.addColorStop(1,'#090917');
   context.fillStyle=gradient;context.fillRect(0,0,width,height);
   context.fillStyle='rgba(240,220,255,.19)';
   for(let i=0;i<7;i++){context.beginPath();context.ellipse(width*(.58+i*.052),height*(.34+i*.052),width*.17,height*.26,-.28,0,Math.PI*2);context.fill();}
   context.strokeStyle='rgba(255,255,255,.16)';context.lineWidth=Math.max(3,width*.005);
   for(let i=0;i<4;i++){context.beginPath();context.moveTo(width*(.08+i*.14),height*.93);context.lineTo(width*(.35+i*.13),height*.18);context.stroke();}
   return canvas.toDataURL('image/png');
  };
  const banner=createArtwork(1200,500,'#131528','#765ec1');
  const cover=createArtwork(400,600,'#181332','#6545a5');
  const portraitBanner=createArtwork(360,620,'#261835','#99529f');
  window.OrbitArtworkUrl=token=>token.startsWith('11111111')?banner:token.startsWith('33333333')?portraitBanner:cover;
  window.fixture.patch(window.fixture.id(1),{
   name:'Aether: The Ascendant',
   banner:'11111111-1111-4111-8111-111111111111.jpg',
   cover:'22222222-2222-4222-8222-222222222222.jpg',
   cover_fit:'contain',cover_position:'top',
   total_play_seconds:10800,last_played_at:'2026-10-22T12:30:00Z',
   tags:['Open world','Atmospheric'],
   genre:'Adventure',
  });
 });
 for(const file of ['library-updates.js','app.js']){
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'src/ui',file),'utf8')});
 }
 await page.locator('.home-games .game-card').first().waitFor();
 await page.locator('.home-games .game-card').first().click();
 const showcase=page.locator('.detail-showcase');
 await showcase.waitFor();
 assert.match(await showcase.locator('#dialog-title').textContent(),/Aether/);
 assert.equal(await showcase.locator('.showcase-play').count(),1);
 assert.equal(await showcase.locator('.showcase-favorite').getAttribute('aria-pressed'),'false');
 const showcaseHeart=showcase.locator('.showcase-favorite svg');
 assert.equal(await showcaseHeart.evaluate(x=>getComputedStyle(x).fill),'none','unsaved details heart has transparent center');
 assert.equal(await showcaseHeart.evaluate(x=>getComputedStyle(x).stroke),'rgb(139, 122, 255)',
  'unsaved details heart outline is purple, not the modal text color');
 await showcase.locator('.showcase-favorite').hover();
 assert.equal(await showcaseHeart.evaluate(x=>getComputedStyle(x).stroke),'rgb(139, 122, 255)',
  'unsaved details outline remains purple on hover');
 await page.evaluate(()=>window.orbit.saveSettings({accent:'#fc8ca8'}));
 assert.equal(await showcaseHeart.evaluate(x=>getComputedStyle(x).stroke),'rgb(252, 140, 168)',
  'unsaved details outline follows the selected accent in the modal root');
 await page.evaluate(()=>window.orbit.saveSettings({accent:'#8b7aff'}));
 assert.match(await showcase.locator('.detail-playtime-value').textContent(),/3h 0m played/);
 assert.match(await showcase.locator('.showcase-last-played strong').textContent(),/2026/);
 assert.equal(await showcase.locator('[data-action=edit],[data-action=remove-confirm]').count(),0,'management stays in the game-card dropdown');
 assert.equal(await showcase.locator('.showcase-poster .cover-image.fit-contain.position-top').count(),1,'cover layout flags remain intact');
 const overlay=await showcase.evaluate(dialog=>{
  const hero=dialog.querySelector('.showcase-hero').getBoundingClientRect();
  const poster=dialog.querySelector('.showcase-poster').getBoundingClientRect();
  return {heroBottom:hero.bottom,posterTop:poster.top,posterBottom:poster.bottom};
 });
 assert(overlay.posterTop<overlay.heroBottom&&overlay.posterBottom>overlay.heroBottom,'cover floats across hero and content');
 const placement=()=>page.evaluate(()=>{
  const title=document.querySelector('.showcase-hero-copy h2').getBoundingClientRect();
  const poster=document.querySelector('.showcase-poster .cover').getBoundingClientRect();
  const play=document.querySelector('.showcase-play').getBoundingClientRect();
  const info=document.querySelector('.showcase-information').getBoundingClientRect();
  const x=Math.max(0,Math.min(title.right,poster.right)-Math.max(title.left,poster.left));
  const y=Math.max(0,Math.min(title.bottom,poster.bottom)-Math.max(title.top,poster.top));
  return {titlePosterIntersection:x*y,playWidth:play.width,infoWidth:info.width};
 });
 assert.equal((await placement()).titlePosterIntersection,0,'hero heading does not overlap the floating poster at 1440px');
 await showcase.locator('.showcase-favorite').click();
 await page.waitForFunction(()=>document.querySelector('.showcase-favorite')?.getAttribute('aria-pressed')==='true');
 assert.equal(await showcase.locator('.showcase-favorite').getAttribute('aria-pressed'),'true');
 assert.equal(await showcaseHeart.evaluate(x=>getComputedStyle(x).fill),'rgb(139, 122, 255)',
  'selected details heart has a fully purple fill');
 assert.equal(await showcaseHeart.evaluate(x=>getComputedStyle(x).stroke),'rgb(139, 122, 255)',
  'selected details outline matches the fill');
 assert(await showcase.locator('.showcase-favorite').evaluate(node=>document.activeElement===node),'favorite update retains focused control');
 await page.keyboard.press('Escape');
 assert.equal(await showcase.count(),0);
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.action),'detail','Escape restores a card action after a live favorite update');
 assert(await page.evaluate(()=>document.activeElement?.classList?.contains('game-card')),'Escape restores focus to the originating card after a library re-render');

 await page.locator('.home-games .game-card').first().click();
 await showcase.waitFor();
 if(screenshotDir){
  fs.mkdirSync(screenshotDir,{recursive:true});
  await page.screenshot({path:path.join(screenshotDir,'showcase-1440-dark.png')});
 }
 await page.setViewportSize({width:910,height:610});
 const bounds=await showcase.boundingBox();
 assert(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=910&&bounds.y+bounds.height<=610,'showcase fits 910x610');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'910px layout does not overflow');
 assert.equal((await placement()).titlePosterIntersection,0,'hero heading and floating poster remain separated at 910px');
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'showcase-910-dark.png')});
 await page.evaluate(()=>window.orbit.saveSettings({theme:'light'}));
 assert.equal(await page.locator('body').getAttribute('data-theme'),'light');
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'showcase-910-light.png')});
 await page.evaluate(()=>window.orbit.saveSettings({theme:'dark'}));
 await page.setViewportSize({width:390,height:568});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'small viewport does not overflow');
 const narrow=await placement();
 assert.equal(narrow.titlePosterIntersection,0,'mobile heading and poster do not overlap');
 assert(narrow.playWidth>=narrow.infoWidth-4,'mobile primary Play button spans the content width');
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'showcase-390-dark.png')});

 await page.evaluate(()=>{
  window.launchFixture={calls:0};
  window.orbit.launchGame=()=>{window.launchFixture.calls++;return new Promise(resolve=>{window.launchFixture.resolve=resolve;});};
 });
 const play=showcase.locator('.showcase-play');
 await play.click();
 assert.equal(await play.getAttribute('aria-busy'),'true');
 assert(await play.isDisabled(),'Play disables until the pending launch settles');
 await page.evaluate(()=>document.querySelector('.showcase-play').dispatchEvent(new MouseEvent('click',{bubbles:true})));
 assert.equal(await page.evaluate(()=>window.launchFixture.calls),1,'repeated click cannot start a duplicate launch');
 await page.evaluate(()=>window.launchFixture.resolve({message:'Fixture launched'}));
 await page.waitForFunction(()=>!document.querySelector('.showcase-play')?.disabled);

 await page.evaluate(()=>window.fixture.patch(window.fixture.id(1),{banner:'33333333-3333-4333-8333-333333333333.jpg'}));
 await showcase.locator('.showcase-hero-banner.bad-aspect').waitFor({state:'attached'});
 assert.equal(await showcase.locator('.showcase-hero-banner.bad-aspect').evaluate(img=>getComputedStyle(img).display),'none','portrait artwork cannot masquerade as hero banner');
 await page.keyboard.press('Escape');
 await page.locator('nav [data-route=library]').click();
 const menu=page.locator('.game-actions-popup');
 await page.locator('.game-card .game-menu').first().click();
 assert.equal(await menu.locator('[data-action=edit]').count(),1);
 assert.equal(await menu.locator('[data-action=remove-confirm]').count(),1);
 assert.deepEqual(errors,[]);
});

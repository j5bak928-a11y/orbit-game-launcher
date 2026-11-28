'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.ORBIT_PLAYWRIGHT_PATH||'playwright');
const {installFixture}=require('./fixtures/renderer.cjs');

const root=path.resolve(__dirname,'..');
const screenshotDir=process.env.ORBIT_CINEMATIC_V2_SCREENSHOTS;

test('cinematic hero and recorded-session statistics stay truthful, bounded and accessible',async t=>{
 const browser=await chromium.launch(process.env.ORBIT_BROWSER_EXECUTABLE
  ?{headless:true,executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}
  :{headless:true,channel:process.env.ORBIT_BROWSER_CHANNEL||'chrome'});
 t.after(()=>browser.close());
 const errors=[];
 const page=await browser.newPage({viewport:{width:910,height:610}});
 page.on('pageerror',error=>errors.push(error.message));
 const html=fs.readFileSync(path.join(root,'src/ui/index.html'),'utf8')
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/,'')
  .replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g,'')
  .replace('<link rel="stylesheet" href="./styles.css" />','<style>'+fs.readFileSync(path.join(root,'src/ui/styles.css'),'utf8')+'</style>');
 await page.setContent(html);
 await page.evaluate(installFixture,{count:5000});
 await page.evaluate(async()=>{
  await window.orbit.saveSettings({reduceMotion:false});
  const art=(w,h,a,b)=>{
   const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
   const context=canvas.getContext('2d'),gradient=context.createLinearGradient(0,0,w,h);
   gradient.addColorStop(0,a);gradient.addColorStop(.55,b);gradient.addColorStop(1,'#0a0911');
   context.fillStyle=gradient;context.fillRect(0,0,w,h);
   context.fillStyle='rgba(255,255,255,.11)';
   for(let i=0;i<5;i++){context.beginPath();context.ellipse(w*(.55+i*.07),h*(.33+i*.06),w*.13,h*.3,-.2,0,Math.PI*2);context.fill();}
   return canvas.toDataURL('image/png');
  };
  const wide=art(1200,500,'#15162f','#7361c6'),cover=art(400,600,'#1e1535','#775ac7');
  window.OrbitArtworkUrl=token=>token.startsWith('11111111')?wide:cover;
  window.fixture.patch(window.fixture.id(1),{
   name:'Aether: The Ascendant',
   banner:'11111111-1111-4111-8111-111111111111.jpg',
   cover:'22222222-2222-4222-8222-222222222222.jpg',
   total_play_seconds:36000,last_played_at:'2026-11-04T18:00:00Z'
  });
  const day=(offset)=>{
   const value=new Date();value.setHours(12,0,0,0);value.setDate(value.getDate()-offset);
   return [value.getFullYear(),String(value.getMonth()+1).padStart(2,'0'),String(value.getDate()).padStart(2,'0')].join('-');
  };
  window.statisticsFixture={
   days:30,
   daily:Array.from({length:30},(_,i)=>({date:day(29-i),seconds:29-i===0?7200:29-i===5?3600:29-i===10?1800:0})),
   heatmap:Array.from({length:365},(_,i)=>({date:day(364-i),seconds:i%15===0?3600:0,sessions:i%15===0?1:0,level:i%15===0?(i%4)+1:0})),
   streaks:{current:3,longest:7,activeDaysYear:25,totalActiveDays:25},
   sessions:{count:25,averageSeconds:2880,longestSeconds:7200},
   breakdowns:{
    bySource:[{key:'steam',seconds:50000,games:4,share:0.7},{key:'xbox',seconds:22000,games:2,share:0.3}],
    byGenre:[{key:'RPG',seconds:45000,games:3,share:0.625},{key:'Action',seconds:27000,games:3,share:0.375}],
    byStatus:[{key:'playing',seconds:40000,games:2,share:0.556},{key:'completed',seconds:32000,games:4,share:0.444}]
   },
   totals:{week:10800,month:12600,allTime:72000},
   recentGames:[{id:window.fixture.id(1),name:'Aether & <The Ascendant>',source:'xbox',cover:'22222222-2222-4222-8222-222222222222.jpg',icon:null,seconds:7200,lastPlayedAt:'2026-11-04T18:00:00Z'}],
   meta:{openSessions:1,invalidSessions:2,overlapSeconds:1800,adjustedSeconds:300,truncated:false}
  };
  window.statisticsCalls=0;
  window.statisticsExports=[];
  window.orbit.getStatistics=async options=>{window.statisticsCalls++;window.statisticsOptions=options;return window.statisticsFixture;};
  window.orbit.exportStatistics=async format=>{window.statisticsExports.push(format);return {path:`orbit-statistics.${format}`,format};};
 });
 for(const file of ['library-updates.js','app.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'src/ui',file),'utf8')});
 await page.locator('.hero.cinematic-hero').waitFor();
 const hero=page.locator('.hero.cinematic-hero');
 assert.equal(await hero.locator('.hero-art').count(),1,'one background banner');
 assert.equal(await hero.locator('.hero-portrait .cover-image').count(),1,'one floating cover');
 assert.equal(await hero.locator('.hero-art').getAttribute('fetchpriority'),'high');
 assert.equal(await hero.locator('.hero-portrait .cover-image').getAttribute('loading'),'lazy');
 assert.equal(await hero.locator('.hero-ambient').count(),1);
 assert.equal(await page.locator('.home-games .cover-image').first().getAttribute('loading'),'lazy');
 assert(await hero.locator('[data-action=launch]').evaluate(element=>element.getBoundingClientRect().height>=44));
 const bounds=await page.evaluate(()=>{
  const a=document.querySelector('.hero-content h2').getBoundingClientRect();
  const b=document.querySelector('.hero-portrait').getBoundingClientRect();
  const overlap=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  return {overlap,overflow:document.documentElement.scrollWidth>innerWidth};
 });
 assert.equal(bounds.overlap,0,'heading and floating cover should not collide at 910');
 assert.equal(bounds.overflow,false);
 if(screenshotDir){
  fs.mkdirSync(screenshotDir,{recursive:true});
  await page.screenshot({path:path.join(screenshotDir,'home-910-dark.png')});
 }
 await page.setViewportSize({width:390,height:568});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'390px cinematic home does not overflow');
 assert.equal(await hero.locator('.hero-portrait').evaluate(node=>getComputedStyle(node).display),'none','small home viewport hides decorative cover');
 assert(await hero.locator('[data-action=launch]').evaluate(node=>node.getBoundingClientRect().height>=44),'small viewport Play remains accessible');
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'home-390-dark.png')});
 await page.setViewportSize({width:910,height:610});
 await page.evaluate(()=>window.fixture.setRunning([window.fixture.id(1)]));
 await page.waitForFunction(()=>document.body.dataset.gameActive==='true');
 assert.equal(await hero.locator('[data-action=launch]').isDisabled(),true);
 await page.locator('.sidebar [data-route=library]').click();
 await page.locator('.sidebar [data-route=home]').click();
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.page-enter')).animationName),'none','page motion is suppressed while a game is running');
 assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running'&&a.effect.getComputedTiming().iterations===Infinity).length),0,'running games should not cause infinite visual animations');
 await page.evaluate(()=>window.fixture.setRunning([]));

 await page.locator('.sidebar [data-route=statistics]').click();
 await page.locator('.statistics-metrics').waitFor();
 assert.equal(await page.locator('.statistics-page').count(),1);
 assert.equal(await page.locator('.sidebar [data-route=statistics]').getAttribute('aria-current'),'page');
 assert.equal(await page.evaluate(()=>window.statisticsOptions.days),30);
 assert.equal(await page.locator('.statistics-metric').count(),4);
 assert.match(await page.locator('.statistics-metric').nth(1).textContent(),/3h 0m/,'rolling 7-day total comes from API');
 assert.match(await page.locator('.statistics-metric').nth(2).textContent(),/3h 30m/,'rolling 30-day total comes from API');
 assert.match(await page.locator('.statistics-metric').nth(3).textContent(),/20h 0m/,'all-time total from recorded sessions');
 assert.match(await page.locator('.statistics-insight').first().textContent(),/Best day/);
 assert.match(await page.locator('.statistics-insight').last().textContent(),/more than the previous 7 days/);
 assert.equal(await page.locator('.statistics-bar-slot').count(),30,'chart has a strict 30-bar bound');
 assert.equal(await page.locator('.statistics-highlights .statistics-highlight-card').count(),2,'streak and average session cards render');
 assert.equal(await page.locator('.heatmap-grid .heatmap-cell:not(.is-pad)').count(),365,'12-month heatmap renders 365 day cells');
 assert.equal(await page.locator('.statistics-breakdowns-grid .breakdown-group').count(),3,'storefront, genre, and status breakdowns render');
 await page.locator('.statistics-export-summary').click();
 await page.locator('[data-action="export-statistics"][data-format="csv"]').click();
 await page.waitForFunction(()=>window.statisticsExports.includes('csv'));
 assert.equal(await page.locator('.statistics-recent-row').count(),1);
 assert.match(await page.locator('.statistics-recent-row').textContent(),/Aether & <The Ascendant>/);
 assert.match(await page.locator('.statistics-recent-row').textContent(),/Xbox \/ PC Game Pass/);
 assert.equal(await page.locator('.statistics-recent-row img').getAttribute('loading'),'lazy');
 assert.match(await page.locator('.statistics-disclaimer').textContent(),/Based on recorded sessions/);
 assert.match(await page.locator('.statistics-disclaimer').textContent(),/Overlapping same-game session time excluded from charts/);
 assert.match(await page.locator('.statistics-disclaimer').textContent(),/Inconsistent session durations adjusted/);
 assert.match(await page.locator('.statistics-disclaimer').textContent(),/differ from game library lifetime totals/);
 assert.equal(await page.locator('.statistics-visually-hidden li').count(),30,'screen readers can inspect exact daily values');
 await page.locator('[data-action=refresh-statistics]').focus();
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.statisticsCalls===2);
 assert.equal(await page.locator('.statistics-metrics').count(),1);
 assert(await page.locator('[data-action=refresh-statistics]').evaluate(node=>document.activeElement===node),'refresh preserves keyboard focus');
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'statistics-910-dark.png')});
 await page.evaluate(()=>{document.getElementById('main-scroll').scrollTop=document.querySelector('.statistics-panel').offsetTop-90;});
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'statistics-chart-910-dark.png')});
 await page.evaluate(()=>{document.getElementById('main-scroll').scrollTop=0;});

 await page.setViewportSize({width:390,height:568});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'390px statistics layout never overflows horizontally');
 assert((await page.locator('.statistics-metric').first().boundingBox()).width>=95);
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'statistics-390-dark.png')});
 await page.evaluate(()=>window.orbit.saveSettings({theme:'light',reduceMotion:true}));
 assert.equal(await page.locator('body').getAttribute('data-theme'),'light');
 assert.equal(await page.locator('body').getAttribute('data-reduce-motion'),'true');
 if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'statistics-390-light.png')});
 await page.evaluate(()=>{delete window.orbit.getStatistics;});
 await page.locator('[data-action=refresh-statistics]').click();
 await page.locator('.statistics-state-title').waitFor();
 assert.match(await page.locator('.statistics-state').textContent(),/Statistics unavailable/);
 assert.equal(await page.locator('.statistics-metrics').count(),0,'missing API must not fabricate playtime');
 await page.evaluate(()=>{window.orbit.getStatistics=async()=>{throw Error('Session store unavailable.');};});
 await page.locator('[data-action=refresh-statistics]').click();
 assert.match(await page.locator('.statistics-state').textContent(),/Session store unavailable/);
 await page.locator('.sidebar [data-route=home]').click();
 assert.equal(await page.locator('.hero.cinematic-hero').count(),1,'app remains usable after statistics failures');
 await page.evaluate(()=>window.fixture.patch(window.fixture.id(1),{source:'xbox'}));
 await page.locator('.home-games .game-card').first().click();
 assert.match(await page.locator('.detail-showcase .showcase-note').textContent(),/require the Xbox app/);
 await page.keyboard.press('Escape');
 assert.deepEqual(errors,[],'no uncaught browser errors');
});

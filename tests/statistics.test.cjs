'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LibraryDatabase}=require('../src/core/database.cjs');

function fixture(run){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-stats-'));
 const db=new LibraryDatabase(path.join(directory,'library.sqlite'));
 try{return run(db);}finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
}
function record(db,id,game,start,finish,seconds){
 db.db.prepare('INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES (?,?,?,?,?)')
  .run(id,game.id,start instanceof Date?start.toISOString():start,finish instanceof Date?finish.toISOString():finish,seconds);
}
const local=(year,month,day,hour=0,minute=0)=>new Date(year,month-1,day,hour,minute);
const key=(year,month,day)=>`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

test('statistics split overnight sessions over local dates, dedup same-game overlap and preserve other games',()=>fixture(db=>{
 const game=db.upsert({name:'Primary',source:'steam',source_id:'test-stat-main'}).game;
 const bonus=db.upsert({name:'Bonus',source:'manual',executable:'C:\\Test\\bonus.exe'}).game;
 record(db,'a',game,local(2026,11,3,23,50),local(2026,11,4,0,10),1200);
 record(db,'b',game,local(2026,11,3,23,55),local(2026,11,4,0,5),600);
 record(db,'c',bonus,local(2026,11,4,0,0),local(2026,11,4,0,30),1800);
 const before=db.db.prepare('SELECT COUNT(*) AS count,SUM(seconds) AS seconds FROM sessions').get();
 const result=db.getStatistics({days:7},local(2026,11,5,12));
 assert.equal(result.days,7);
 assert.equal(result.daily.length,7);
 assert.equal(result.daily.find(day=>day.date===key(2026,11,3)).seconds,600);
 assert.equal(result.daily.find(day=>day.date===key(2026,11,4)).seconds,2400);
 assert.equal(result.daily.at(-1).date,key(2026,11,5));
 assert.equal(result.daily.at(-1).seconds,0);
 assert.deepEqual(result.totals,{week:3000,month:3000,allTime:3000});
 assert.equal(result.meta.overlapSeconds,600);
 assert.equal(result.meta.adjustedSeconds,0);
 assert.equal(result.recentGames[0].id,bonus.id);
 assert.equal(result.recentGames.find(item=>item.id===game.id).seconds,1200);
 assert.equal(db.get(game.id).total_play_seconds,0,'historical game counters are not rewritten');
 assert.deepEqual(db.db.prepare('SELECT COUNT(*) AS count,SUM(seconds) AS seconds FROM sessions').get(),before);
}));

test('statistics exclude unfinished checkpoints, malformed dates, oversized and future intervals honestly',()=>fixture(db=>{
 const game=db.upsert({name:'Bad history',source:'steam',source_id:'test-bad'}).game;
 record(db,'valid',game,local(2026,11,5,9),local(2026,11,5,9,10),10000);
 record(db,'invalidDate',game,'2026-02-30T10:00:00.000Z','2026-11-04T11:00:00.000Z',120);
 record(db,'oversized',game,'1900-01-01T00:00:00.000Z','2026-11-03T00:00:00.000Z',300);
 record(db,'future',game,'2030-01-01T00:00:00.000Z','2030-01-01T00:05:00.000Z',300);
 db.db.prepare('INSERT INTO sessions(id,game_id,started_at,heartbeat_seconds) VALUES (?,?,?,?)')
  .run('open',game.id,local(2026,11,5,8).toISOString(),7200);
 const result=db.getStatistics({days:30},local(2026,11,5,12));
 assert.equal(result.totals.allTime,600);
 assert.equal(result.meta.openSessions,1);
 assert.equal(result.meta.invalidSessions,3);
 assert.equal(result.meta.adjustedSeconds,9400);
 assert.equal(result.meta.overlapSeconds,0);
 assert.equal(result.recentGames.length,1);
 assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE finished_at IS NULL').get().count,1);
}));

test('statistics validate bounded request and preserve zero-filled response',()=>fixture(db=>{
 const asOf=local(2026,11,5,12);
 const result=db.getStatistics({},asOf);
 assert.equal(result.daily.length,30);
 assert.deepEqual(result.totals,{week:0,month:0,allTime:0});
 assert.deepEqual(result.recentGames,[]);
 assert.deepEqual(result.meta,{openSessions:0,invalidSessions:0,overlapSeconds:0,adjustedSeconds:0,truncated:false});
 for(const options of [{days:0},{days:91},{days:7.5},{days:'30'},[],'30']){
  assert.throws(()=>db.getStatistics(options,asOf),/Statistics/);
 }
 assert.equal(db.getStatistics({days:90},asOf).daily.length,90);
}));

test('sessions with offset timestamps distribute into local dates',()=>fixture(db=>{
 const game=db.upsert({name:'Offset',source:'epic',source_id:'test-offset'}).game;
 const start=local(2026,11,3,23,45),end=local(2026,11,4,0,15);
 record(db,'offset',game,start,end,1800);
 const result=db.getStatistics({days:7},local(2026,11,4,12));
 assert.equal(result.daily.find(day=>day.date===key(2026,11,3)).seconds,900);
 assert.equal(result.daily.find(day=>day.date===key(2026,11,4)).seconds,900);
}));

test('verified Xbox storefront imports are accepted and included in completed-session statistics',()=>fixture(db=>{
 const game=db.upsert({name:'Xbox Local',source:'xbox',source_id:'gdk-product',executable:'C:\\XboxGames\\Example\\Game.exe'}).game;
 assert.equal(game.source,'xbox');
 record(db,'xbox-session',game,local(2026,11,5,8),local(2026,11,5,8,30),1800);
 const stats=db.getStatistics({days:7},local(2026,11,5,12));
 assert.equal(stats.totals.week,1800);
 assert.equal(stats.recentGames[0].source,'xbox');
}));

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WindowsActivityTracker}=require('../src/core/windows-activity.cjs');
test('sleep closes monitored sessions without counting suspended time',async()=>{
 let now=1000,started=0;const finishes=[];
 const tracker=new WindowsActivityTracker({
  listGames:()=>[{id:'game',source:'steam',install_path:'C:\\Games\\One'}],
  isDirectSession:()=>false,start:()=>{started++;return String(started)},
  finish:(id,seconds)=>finishes.push([id,seconds]),now:()=>now,
  enumerate:async()=>['C:\\Games\\One\\Game.exe']
 });
 await tracker.poll();now=16000;tracker.suspend();
 assert.deepEqual(finishes,[['1',15]]);
 now+=3600000;tracker.resume();
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(started>=2);tracker.stop();
});
test('enumeration failures must not mark games as stopped',async()=>{
 let count=0,fail=false,now=1000;const finished=[];
 const tracker=new WindowsActivityTracker({
  listGames:()=>[{id:'game',source:'steam',install_path:'C:\\Games\\One'}],
  isDirectSession:()=>false,start:()=> '1',finish:(id,s)=>finished.push([id,s]),now:()=>now,
  enumerate:async()=>{count++;if(fail)throw Error('CIM unavailable');return ['C:\\Games\\One\\Game.exe'];}
 });
 await tracker.poll();fail=true;now=31000;await tracker.poll();await tracker.poll();
 assert.equal(count,3);assert.deepEqual(finished,[]);tracker.stop();
});
test('enumeration errors are reported to the supplied error handler',async()=>{
 const errors=[];const tracker=new WindowsActivityTracker({listGames:()=>[{id:'game'}],isDirectSession:()=>false,start:()=>'',finish:()=>{},enumerate:async()=>{throw Error('inventory unavailable')},onError:error=>errors.push(error.message)});
 await tracker.poll();tracker.stop();assert.deepEqual(errors,['inventory unavailable']);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {pendingFinishes}=require('../src/core/pending-finishes.cjs');

test('direct game exit keeps its final duration until SQLite finish succeeds exactly once',()=>{
 let busy=true;const calls=[],credited=[],errors=[];
 const queue=pendingFinishes({
  finish:(session,seconds)=>{if(busy)throw Error('SQLITE_BUSY');calls.push([session,seconds]);return true;},
  onSuccess:id=>credited.push(id),onError:(id,error)=>errors.push([id,error.message])
 });
 assert.equal(queue.add('game','session-1',83),true);
 assert.equal(queue.has('game'),true);
 assert.equal(queue.add('game','session-2',900),false,'do not overwrite an uncommitted exit');
 assert.equal(calls.length,0);assert.equal(errors.length,1);
 busy=false;queue.flush();queue.flush();
 assert.deepEqual(calls,[['session-1',83]]);
 assert.deepEqual(credited,['game']);assert.equal(queue.size(),0);
});

test('already-finished session acknowledgement safely clears retry queue',()=>{
 let once=true,count=0;
 const queue=pendingFinishes({finish:()=>{count++;if(once){once=false;throw Error('busy');}return false;}});
 queue.add('game','old',10);queue.flush();queue.flush();
 assert.equal(count,2);assert.equal(queue.has('game'),false);
});

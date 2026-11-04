'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sessionClock}=require('../src/core/session-clock.cjs');
test('playtime excludes sleep and survives multiple resume cycles',()=>{
 let now=1000;const timer=sessionClock(()=>now);now+=10000;timer.pause();
 now+=3600000;assert.equal(timer.seconds(),10);timer.resume();now+=5000;assert.equal(timer.seconds(),15);
 timer.pause();now+=60000;timer.resume();assert.equal(timer.seconds(),15);
});
test('default playtime clock ignores manual wall-clock jumps',()=>{
 const previous=Date.now;
 const timer=sessionClock();
 try{
  Date.now=()=>previous()+86_400_000;
  assert(timer.seconds()<10,'a calendar jump must not create a full day of playtime');
 }finally{Date.now=previous;}
});

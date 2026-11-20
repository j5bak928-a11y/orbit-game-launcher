'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function fixture(){
 const source=fs.readFileSync(path.join(__dirname,'../src/ui/app.js'),'utf8');
 const code=source.slice(source.indexOf('const launchTimers=new Map()'),source.indexOf('async function favorite('));
 const order=[],messages=[],timers=[];let resolve,reject,calls=0;
 const state={games:[{id:'game',name:'Game'}],pendingLaunches:new Set(),runningIds:[]};
 const context=vm.createContext({state,performance:{now:()=>0},window:{orbit:{launchGame:()=>{calls++;order.push('request');return new Promise((r,j)=>{resolve=r;reject=j;});}}},syncActivity:()=>order.push('ui'),toast:(message,error)=>messages.push({message,error}),setTimeout:(fn,ms)=>timers.push({fn,ms}),clearTimeout:id=>{if(timers[id-1])timers[id-1].cancelled=true;},t:value=>value});
 vm.runInContext(code,context);
 return {state,order,messages,timers,launch:()=>context.performLaunch('game'),resolve:v=>resolve(v),reject:e=>reject(e),calls:()=>calls,confirm:()=>{state.runningIds=['game'];context.clearLaunchPending('game');}};
}
test('submits launch request before updating the interface and blocks duplicate clicks',async()=>{
 const f=fixture(),first=f.launch();f.launch();
 assert.deepEqual(f.order,['request','ui']);assert.equal(f.calls(),1);
 f.resolve({message:'Game launched.'});await first;f.timers[0].fn();
 assert.equal(f.state.pendingLaunches.size,0);assert.equal(f.messages[0].message,'Game launched.');
});
test('a rejected launch reports the error and releases the pending state',async()=>{
 const f=fixture(),first=f.launch();f.reject(Error('Launch failed'));await first;
 assert.equal(f.messages[0].message,'Launch failed');assert.equal(f.messages[0].error,true);assert.equal(f.state.pendingLaunches.size,0);
});

test('watchable storefront handoffs stay pending until detected',async()=>{
 const f=fixture(),first=f.launch();
 f.resolve({mode:'external',confirmationTimeoutMs:90000});await first;
 assert.equal(f.state.pendingLaunches.has('game'),true);
 assert.equal(f.timers[0].ms,90000);
 await f.launch();assert.equal(f.calls(),1);
 f.confirm();
 assert.equal(f.state.pendingLaunches.has('game'),false);
 assert.equal(f.timers[0].cancelled,true);
 assert.equal(f.messages.length,0);
});

test('an undetected storefront launch reports a timeout and can retry',async()=>{
 const f=fixture(),first=f.launch();
 f.resolve({mode:'external',confirmationTimeoutMs:90000});await first;
 f.timers[0].fn();
 assert.equal(f.state.pendingLaunches.has('game'),false);
 assert.equal(f.messages[0].error,true);
 const retry=f.launch();assert.equal(f.calls(),2);
 f.reject(Error('Cancelled'));await retry;
});

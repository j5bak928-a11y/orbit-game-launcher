'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function fixture(){
 const source=fs.readFileSync(path.join(__dirname,'../src/ui/app.js'),'utf8');
 const code=source.slice(source.indexOf('async function performLaunch('),source.indexOf('async function favorite('));
 const order=[],messages=[],timers=[];let resolve,reject,calls=0;
 const state={games:[{id:'game',name:'Game'}],pendingLaunches:new Set(),runningIds:[]};
 const context=vm.createContext({state,performance:{now:()=>0},window:{orbit:{launchGame:()=>{calls++;order.push('request');return new Promise((r,j)=>{resolve=r;reject=j;});}}},syncActivity:()=>order.push('ui'),toast:(message,error)=>messages.push({message,error}),setTimeout:fn=>timers.push(fn)});
 vm.runInContext(code,context);
 return {state,order,messages,timers,launch:()=>context.performLaunch('game'),resolve:v=>resolve(v),reject:e=>reject(e),calls:()=>calls};
}
test('submits launch request before updating the interface and blocks duplicate clicks',async()=>{
 const f=fixture(),first=f.launch();f.launch();
 assert.deepEqual(f.order,['request','ui']);assert.equal(f.calls(),1);
 f.resolve({message:'Game launched.'});await first;f.timers[0]();
 assert.equal(f.state.pendingLaunches.size,0);assert.equal(f.messages[0].message,'Game launched.');
});
test('a rejected launch reports the error and releases the pending state',async()=>{
 const f=fixture(),first=f.launch();f.reject(Error('Launch failed'));await first;f.timers[0]();
 assert.equal(f.messages[0].message,'Launch failed');assert.equal(f.messages[0].error,true);assert.equal(f.state.pendingLaunches.size,0);
});

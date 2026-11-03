'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {GamepadInput,directionalTarget}=require('../src/ui/controller-input.js');
const pad=(pressed=[],axes=[0,0],extra={})=>({id:'Standard fixture',index:0,connected:true,mapping:'standard',axes,buttons:Array.from({length:17},(_,index)=>({pressed:pressed.includes(index),value:pressed.includes(index)?1:0,touched:false})),...extra});

test('a held select on entry must be released before it can activate anything',()=>{
 const input=new GamepadInput();
 assert.deepEqual(input.read([pad([0])],0).actions,[]);
 assert.deepEqual(input.read([pad([0])],1000).actions,[]);
 assert.deepEqual(input.read([pad()],1100).actions,[]);
 assert.deepEqual(input.read([pad([0])],1200).actions,['select']);
 assert.deepEqual(input.read([pad([0])],4000).actions,[]);
 input.read([pad()],4100);
 assert.deepEqual(input.read([pad([0])],4200).actions,['select']);
});
test('direction holds repeat at a controlled rate without catch-up floods',()=>{
 const input=new GamepadInput();input.read([pad()],0);
 assert.deepEqual(input.read([pad([15])],10).actions,['right']);
 assert.deepEqual(input.read([pad([15])],200).actions,[]);
 assert.deepEqual(input.read([pad([15])],400).actions,['right']);
 assert.deepEqual(input.read([pad([15])],10000).actions,['right']);
 assert.deepEqual(input.read([pad([15])],10001).actions,[]);
 assert.deepEqual(input.read([pad([12])],10010).actions,['up']);
});
test('small stick drift is ignored and hysteresis avoids repeated threshold edges',()=>{
 const input=new GamepadInput();input.read([pad([], [.2,-.2])],0);
 assert.deepEqual(input.read([pad([], [.3,.25])],10).actions,[]);
 assert.deepEqual(input.read([pad([], [.8,.1])],20).actions,['right']);
 assert.deepEqual(input.read([pad([], [.45,.1])],30).actions,[]);
 assert.deepEqual(input.read([pad([], [.6,.1])],40).actions,[]);
 input.read([pad()],50);
 assert.deepEqual(input.read([pad([], [0,-.8])],60).actions,['up']);
});
test('back takes priority over simultaneous select and directions',()=>{
 const input=new GamepadInput();input.read([pad()],0);
 assert.deepEqual(input.read([pad([0,1,15])],10).actions,['back']);
 assert.deepEqual(input.read([pad([0,1,15])],20).actions,[]);
});
test('favorite, recent and page actions are edges rather than held repeats',()=>{
 const input=new GamepadInput();input.read([pad()],0);
 for(const [button,action] of [[2,'favorite'],[3,'recent'],[4,'previousPage'],[5,'nextPage']]){
  input.read([pad()],0);
  assert.deepEqual(input.read([pad([button])],10).actions,[action]);
  assert.deepEqual(input.read([pad([button])],2000).actions,[]);
 }
});
test('null slots, unknown mappings and malformed axes have a safe fallback',()=>{
 const input=new GamepadInput();
 assert.equal(input.read([null],0).status.kind,'none');
 assert.equal(input.read([pad([0],[],{mapping:''})],10).status.kind,'unsupported');
 input.read([null,pad([], [NaN,Infinity],{index:1})],20);
 assert.deepEqual(input.read([null,pad([0],[NaN,Infinity],{index:1})],30).actions,['select']);
});
test('disconnect and replacement require fresh neutral input without changing controller ownership',()=>{
 const input=new GamepadInput();input.read([pad()],0);
 const other=pad([0],[0,0],{id:'Other',index:1});
 assert.deepEqual(input.read([pad(),other],10).actions,[]);
 assert.deepEqual(input.read([null,other],20).actions,[]);
 assert.deepEqual(input.read([null,other],2000).actions,[]);
 input.read([null,pad([],[0,0],{id:'Other',index:1})],2100);
 assert.deepEqual(input.read([null,other],2200).actions,['select']);
 assert.equal(input.read([],2300).status.kind,'none');
});
test('reset after blur cannot replay held select when focus returns',()=>{
 const input=new GamepadInput();input.read([pad()],0);
 input.reset();
 assert.deepEqual(input.read([pad([0])],100).actions,[]);
 input.read([pad()],110);
 assert.deepEqual(input.read([pad([0])],120).actions,['select']);
});
test('suspending input preserves the active controller while requiring its buttons to return to neutral',()=>{
 const input=new GamepadInput(),other=pad(),active=extra=>pad([],[0,0],{id:'Active controller',index:1,...extra});
 input.read([null,active()],0);
 input.read([null,active({buttons:pad([15]).buttons})],5);
 input.reset({preserveOwner:true});
 assert.deepEqual(input.read([other,active({buttons:pad([0]).buttons})],10).actions,[]);
 input.read([other,active()],20);
 assert.deepEqual(input.read([other,active({buttons:pad([0]).buttons})],30).actions,['select']);
});
test('the first controller actually used owns input, not the first idle gamepad',()=>{
 const input=new GamepadInput();
 const first=(buttons=[])=>pad(buttons,[0,0],{id:'Idle controller',index:0});
 const second=(buttons=[])=>pad(buttons,[0,0],{id:'Player controller',index:1});
 assert.deepEqual(input.read([first(),second()],0).actions,[]);
 assert.deepEqual(input.read([first(),second([0])],50).actions,['select']);
 assert.equal(input.owner,'1:Player controller');
 assert.deepEqual(input.read([first([15]),second()],100).actions,[],'idle controller cannot steal control');
 assert.deepEqual(input.read([first(),second([15])],150).actions,['right']);
});
test('a held button on a second gamepad is ignored until it has returned to neutral',()=>{
 const input=new GamepadInput();
 const first=(buttons=[])=>pad(buttons,[0,0],{id:'Idle controller',index:0});
 const second=(buttons=[])=>pad(buttons,[0,0],{id:'Held controller',index:1});
 assert.deepEqual(input.read([first(),second([0])],0).actions,[]);
 assert.deepEqual(input.read([first(),second([0])],500).actions,[]);
 assert.deepEqual(input.read([first(),second()],600).actions,[]);
 assert.deepEqual(input.read([first(),second([0])],700).actions,['select']);
});
test('an owner disconnect followed by a same-slot reconnect cannot replay held input',()=>{
 const input=new GamepadInput(),active=pad();input.read([active],0);
 input.disconnect(active);
 assert.deepEqual(input.read([pad([0])],10).actions,[]);
 input.read([pad()],20);assert.deepEqual(input.read([pad([0])],30).actions,['select']);
});
test('spatial focus stays on the row horizontally and chooses an aligned next row vertically',()=>{
 const origin={left:100,top:100,right:200,bottom:200};
 const choices=[{left:0,top:100,right:90,bottom:200},{left:210,top:100,right:300,bottom:200},{left:100,top:250,right:200,bottom:350},{left:310,top:0,right:400,bottom:70}];
 assert.equal(directionalTarget(origin,choices,'left'),0);
 assert.equal(directionalTarget(origin,choices,'right'),1);
 assert.equal(directionalTarget(origin,choices,'down'),2);
 assert.equal(directionalTarget(origin,[choices[3]],'right'),-1);
 assert.equal(directionalTarget(origin,[],'up'),-1);
});

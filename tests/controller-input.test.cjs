'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {GamepadInput,directionalTarget}=require('../src/ui/controller-input.js');
const pad=(pressed=[],axes=[0,0],extra={})=>({id:'Standard fixture',index:0,connected:true,mapping:'standard',axes,buttons:Array.from({length:17},(_,index)=>({pressed:pressed.includes(index),value:pressed.includes(index)?1:0,touched:false})),...extra});
const trigger=(index,value)=>{const result=pad([], [0,0,0,0]);result.buttons[index]={pressed:value>.5,value,touched:value>0};return result;};

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
 for(const [button,action] of [[2,'favorite'],[3,'recent'],[4,'previousPage'],[5,'nextPage'],[8,'back'],[9,'recent'],[10,'search'],[11,'drawer'],[16,'exit']]){
  input.read([pad()],0);
  assert.deepEqual(input.read([pad([button])],10).actions,[action]);
  assert.deepEqual(input.read([pad([button])],2000).actions,[]);
 }
});
test('L3 search and R3 drawer buttons yield to Back and block simultaneous stick moves',()=>{
 const input=new GamepadInput();input.read([pad()],0);
 assert.deepEqual(input.read([pad([1,10,11],[0.9,0,0,0.9])],10).actions,['back']);
 input.read([pad()],20);
 assert.deepEqual(input.read([pad([10],[0.9,0,0,0.9])],30).actions,['search']);
 assert.deepEqual(input.read([pad([10],[0.9,0,0,0.9])],1000).actions,[]);
 input.read([pad()],1010);
 assert.deepEqual(input.read([pad([11],[0.9,0,0,0.9])],1020).actions,['drawer']);
 assert.deepEqual(input.read([pad([11],[0.9,0,0,0.9])],2000).actions,[]);
});
test('Xbox and PlayStation use the standard buttons with informative, bounded family labels',()=>{
 const input=new GamepadInput();
 assert.equal(input.read([pad([],[0,0,0,0],{id:'Xbox Wireless Controller'})],0).status.family,'Xbox');
 const selected=input.read([pad([0],[0,0,0,0],{id:'Xbox Wireless Controller'})],30);
 assert.deepEqual(selected.actions,['select']);
 assert.equal(selected.status.family,'Xbox');
 input.disconnect(pad([],[0,0,0,0],{id:'Xbox Wireless Controller'}));
 assert.equal(input.read([pad([],[0,0,0,0],{id:'DualSense Wireless Controller'})],40).status.family,'PlayStation');
 assert.deepEqual(input.read([pad([1],[0,0,0,0],{id:'DualSense Wireless Controller'})],50).actions,['back']);
 input.disconnect(pad([],[0,0,0,0],{id:'DualSense Wireless Controller'}));
 assert.equal(input.read([pad([],[0,0,0,0],{id:'Generic Standard Device'})],60).status.family,'Standard');
 assert.equal(input.read([pad([],[0,0,0,0],{id:'DualShock 4'})],70).status.family,'PlayStation');
});
test('View/Share returns, Menu/Options shows recent, Home exits, and commands never also launch',()=>{
 const input=new GamepadInput();input.read([pad()],0);
 assert.deepEqual(input.read([pad([0,1,8,9,16,15])],10).actions,['exit'],'Home is a single highest-priority command');
 assert.deepEqual(input.read([pad([0,1,8,9,16,15])],2000).actions,[],'held modifiers cannot leak repeat directions');
 input.read([pad()],2010);
 assert.deepEqual(input.read([pad([0,1,8,9])],2020).actions,['back'],'Back wins a simultaneous A and menu press');
 input.read([pad()],2030);
 assert.deepEqual(input.read([pad([0,9,15])],2040).actions,['recent'],'Menu never also selects or moves');
 input.read([pad()],2050);
 assert.deepEqual(input.read([pad([8])],2060).actions,['back']);
});
test('LT/RT analog page aliases trigger once at a firm squeeze with hysteresis',()=>{
 const input=new GamepadInput();input.read([pad()],0);
 assert.deepEqual(input.read([trigger(6,.49)],10).actions,[]);
 assert.deepEqual(input.read([trigger(6,.69)],20).actions,[]);
 assert.deepEqual(input.read([trigger(6,.85)],30).actions,['previousPage']);
 assert.deepEqual(input.read([trigger(6,.52)],300).actions,[],'analog flutter while held cannot rearm');
 assert.deepEqual(input.read([trigger(6,.85)],2000).actions,[],'page commands never repeat');
 assert.deepEqual(input.read([trigger(6,.39)],2100).actions,[]);
 assert.deepEqual(input.read([trigger(6,.85)],2200).actions,['previousPage']);
 input.read([pad()],2210);
 assert.deepEqual(input.read([trigger(7,.91)],2220).actions,['nextPage']);
 assert.deepEqual(input.read([trigger(7,.91)],4000).actions,[]);
});
test('held Menu on entry and resume must return to neutral before an action',()=>{
 const input=new GamepadInput();
 assert.deepEqual(input.read([pad([9])],0).actions,[]);
 assert.deepEqual(input.read([pad([9])],1000).actions,[]);
 input.read([pad()],1010);
 assert.deepEqual(input.read([pad([9])],1020).actions,['recent']);
 input.reset({preserveOwner:true});
 assert.deepEqual(input.read([pad([9,0])],1030).actions,[]);
 input.read([pad()],1040);
 assert.deepEqual(input.read([pad([9])],1050).actions,['recent']);
});
test('right stick scrolls vertically at a bounded rate with drift rejection and hysteresis',()=>{
 const input=new GamepadInput();input.read([pad([], [0,0,0,0])],0);
 assert.deepEqual(input.read([pad([], [0,0,.2,.35])],10).actions,[]);
 assert.deepEqual(input.read([pad([], [0,0,0,.72])],20).actions,['scrollDown']);
 assert.deepEqual(input.read([pad([], [0,0,0,.55])],200).actions,[]);
 assert.deepEqual(input.read([pad([], [0,0,0,.55])],425).actions,['scrollDown']);
 assert.deepEqual(input.read([pad([], [0,0,0,.55])],10000).actions,['scrollDown'],'no catch-up floods after a long sleep');
 assert.deepEqual(input.read([pad([], [0,0,0,.55])],10001).actions,[]);
 assert.deepEqual(input.read([pad([], [0,0,0,.39])],10010).actions,[]);
 assert.deepEqual(input.read([pad([], [0,0,0,.59])],10020).actions,[],'stick must cross full on-threshold again');
 assert.deepEqual(input.read([pad([], [0,0,0,-.82])],10030).actions,['scrollUp']);
 assert.deepEqual(input.read([pad([15],[0,0,0,-.82])],10040).actions,['right'],'D-pad has priority over scrolling');
 assert.deepEqual(input.read([pad([],[0,0,0,-.82])],10050).actions,['scrollUp']);
});
test('held shortcut blocks right stick and direction until released',()=>{
 const input=new GamepadInput();input.read([pad([], [0,0,0,0])],0);
 assert.deepEqual(input.read([pad([1],[.9,0,0,.9])],10).actions,['back']);
 assert.deepEqual(input.read([pad([1],[.9,0,0,.9])],1000).actions,[]);
 assert.deepEqual(input.read([pad([],[.9,0,0,.9])],1010).actions,['right'],'left-stick selection wins after shortcut release');
 assert.deepEqual(input.read([pad([],[0,0,0,.9])],1020).actions,['scrollDown']);
 input.read([pad([],[0,0,0,0])],1030);
 const paging=pad([5],[0,0,0,-.9]);
 assert.deepEqual(input.read([paging],1040).actions,['nextPage']);
 assert.deepEqual(input.read([paging],2000).actions,[],'held shoulder may not cause scrolling');
 assert.deepEqual(input.read([pad([],[0,0,0,-.9])],2010).actions,['scrollUp']);
});
test('right stick can claim a neutral unowned controller but cannot steal another owner',()=>{
 const input=new GamepadInput();
 const first=(axes=[0,0,0,0])=>pad([],axes,{id:'First',index:0});
 const second=(axes=[0,0,0,0])=>pad([],axes,{id:'Second',index:1});
 assert.deepEqual(input.read([first(),second([0,0,0,.9])],0).actions,[],'a pre-held right stick must not claim ownership');
 input.read([first(),second()],10);
 assert.deepEqual(input.read([first(),second([0,0,0,.9])],20).actions,['scrollDown']);
 assert.equal(input.owner,'1:Second');
 assert.deepEqual(input.read([first([0,0,0,-.9]),second()],30).actions,[],'another controller cannot scroll');
 input.reset({preserveOwner:true});
 assert.deepEqual(input.read([first(),second([0,0,0,.9])],40).actions,[],'reconnect starts in neutral');
 input.read([first(),second()],50);
 assert.deepEqual(input.read([first(),second([0,0,0,-.9])],60).actions,['scrollUp']);
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
test('disconnecting an unused idle gamepad never releases the active controller',()=>{
 const input=new GamepadInput();
 const first=(buttons=[])=>pad(buttons,[0,0],{id:'Player',index:0});
 const second=(buttons=[])=>pad(buttons,[0,0],{id:'Unused controller',index:1});
 input.read([first(),second()],0);
 assert.deepEqual(input.read([first([0]),second()],20).actions,['select']);
 input.disconnect(second());
 assert.equal(input.owner,'0:Player');
 input.read([first()],40);
 assert.deepEqual(input.read([first([15])],60).actions,['right']);
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

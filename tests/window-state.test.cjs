'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {FullscreenController}=require('../src/core/window-state.cjs');
class NativeWindow extends EventEmitter{
 constructor(){super();this.fullscreen=false;this.requests=[];this.destroyed=false;}
 isDestroyed(){return this.destroyed;}
 isFullScreen(){return this.fullscreen;}
 setFullScreen(enabled){this.requests.push(enabled);}
 complete(enabled){this.fullscreen=enabled;this.emit(enabled?'enter-full-screen':'leave-full-screen');}
}
test('fullscreen requests wait for asynchronous native events and serialize opposite transitions',async()=>{
 const window=new NativeWindow(),state=new FullscreenController(()=>window);
 let entered=false;const enter=state.set(true).then(()=>{entered=true;});
 const leave=state.set(false);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(entered,false);assert.deepEqual(window.requests,[true]);
 window.complete(true);await enter;await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(window.requests,[true,false]);window.complete(false);await leave;
 assert.deepEqual(state.get(),{fullscreen:false});
 assert.equal(window.listenerCount('enter-full-screen'),0);assert.equal(window.listenerCount('leave-full-screen'),0);assert.equal(window.listenerCount('closed'),0);
});
test('failed native transitions release their listeners and allow later requests',async()=>{
 const window=new NativeWindow(),state=new FullscreenController(()=>window,{timeoutMs:15});
 await assert.rejects(state.set(true),/fullscreen/i);
 assert.equal(window.listenerCount('enter-full-screen'),0);assert.equal(window.listenerCount('closed'),0);
 window.setFullScreen=enabled=>window.complete(enabled);
 assert.deepEqual(await state.set(true),{fullscreen:true});
});
test('a native state flag changing before its completion event does not finish the transition early',async()=>{
 const window=new NativeWindow();window.setFullScreen=enabled=>{window.fullscreen=enabled;};
 const state=new FullscreenController(()=>window);let finished=false;
 const pending=state.set(true).then(()=>{finished=true;});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(finished,false);window.emit('enter-full-screen');await pending;assert.equal(finished,true);
});
test('closed windows reject pending native transitions without hanging',async()=>{
 const window=new NativeWindow(),state=new FullscreenController(()=>window);
 const pending=state.set(true);await new Promise(resolve=>setImmediate(resolve));
 window.destroyed=true;window.emit('closed');await assert.rejects(pending,/window/i);
 await assert.rejects(state.set(false),/window/i);
});

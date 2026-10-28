'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {backgroundWindow}=require('../src/core/background-window.cjs');
test('closing with an available tray releases the window and reopening restores it',()=>{
 let closed=0,shown=0,prevented=0;const c=backgroundWindow({close:()=>closed++,show:()=>shown++});
 c.onClose({preventDefault:()=>prevented++},true);assert.equal(prevented,1);assert.equal(closed,1);c.open();assert.equal(shown,1);
});
test('normal quit and missing tray allow the window to close',()=>{
 let prevented=0;const c=backgroundWindow({close(){},show(){}});c.onClose({preventDefault:()=>prevented++},false);c.quit();c.onClose({preventDefault:()=>prevented++},true);assert.equal(prevented,0);
});

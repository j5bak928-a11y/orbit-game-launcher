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

test('closing the last window keeps the process alive when a tray exists',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events'),{createRequire}=require('node:module');
 const file=path.join(__dirname,'../src/main.cjs'),realRequire=createRequire(file),app=new EventEmitter();let quits=0;
 app.requestSingleInstanceLock=()=>true;app.quit=()=>quits++;app.whenReady=()=>new Promise(()=>{});
 const electron={app,protocol:{registerSchemesAsPrivileged(){}}};
 const context=vm.createContext({require:name=>name==='electron'?electron:realRequire(name),__dirname:path.dirname(file),process,Buffer});
 vm.runInContext(fs.readFileSync(file,'utf8'),context);vm.runInContext('tray={}',context);
 app.emit('window-all-closed');assert.equal(quits,0);
 vm.runInContext('tray=null',context);app.emit('window-all-closed');assert.equal(quits,1);
});

test('second launch while startup is still running does not create an early window',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events'),{createRequire}=require('node:module');
 const file=path.join(__dirname,'../src/main.cjs'),realRequire=createRequire(file),app=new EventEmitter();let created=0;
 app.requestSingleInstanceLock=()=>true;app.quit=()=>{};app.whenReady=()=>new Promise(()=>{});
 const electron={app,BrowserWindow:class {constructor(){created++;}},protocol:{registerSchemesAsPrivileged(){}}};
 const context=vm.createContext({require:name=>name==='electron'?electron:realRequire(name),__dirname:path.dirname(file),process,Buffer});
 vm.runInContext(fs.readFileSync(file,'utf8'),context);app.emit('second-instance');assert.equal(created,0);
});

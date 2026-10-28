'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
test('performance guard hides the existing window without destroying unsaved UI',()=>{
 const file=path.join(__dirname,'../src/main.cjs'),realRequire=createRequire(file),runtime=Object.create(process);
 Object.defineProperty(runtime,'platform',{value:'win32'});
 const app={requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),on(){}};
 let scheduled;const window={isDestroyed:()=>false,hidden:0,closed:0,hide(){this.hidden++},close(){this.closed++}};
 const ctx=vm.createContext({require:name=>name==='electron'?{app,protocol:{registerSchemesAsPrivileged(){}}}:realRequire(name),__dirname:path.dirname(file),process:runtime,Buffer,fixtureWindow:window,fixtureDb:{getSettings:()=>({performanceGuard:true})},setTimeout:fn=>{scheduled=fn;return {unref(){}}},clearTimeout(){}});
 vm.runInContext(fs.readFileSync(file,'utf8'),ctx);vm.runInContext("win=fixtureWindow;db=fixtureDb;tray={};sessions.set('game','session');performanceGuard()",ctx);scheduled();
 assert.equal(window.hidden,1);assert.equal(window.closed,0);
});

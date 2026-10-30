'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveWindowsShortcut}=require('../src/core/windows-shortcut.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-shortcut-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const shortcut=path.join(dir,'Roblox.lnk'),target=path.join(dir,'RobloxPlayerBeta.exe');fs.writeFileSync(shortcut,'fixture');fs.writeFileSync(target,'fixture');return {dir,shortcut,target};}
test('resolves the current executable and working directory each time',t=>{
 const f=fixture(t);let current=f.target;
 const read=()=>({target:current,cwd:f.dir,args:''});
 assert.equal(resolveWindowsShortcut(f.shortcut,read).executable,f.target);
 current=path.join(f.dir,'updated.exe');fs.writeFileSync(current,'fixture');
 assert.equal(resolveWindowsShortcut(f.shortcut,read).executable,current);
 assert.equal(resolveWindowsShortcut(f.shortcut,read).working_dir,f.dir);
});
test('rejects missing, unsafe and argument-bearing shortcuts explicitly',t=>{
 const f=fixture(t);
 assert.throws(()=>resolveWindowsShortcut(f.shortcut,()=>({target:f.target,args:'--flag'})),/arguments/i);
 assert.throws(()=>resolveWindowsShortcut(f.shortcut,()=>({target:'relative.exe',args:''})),/target/i);
 assert.throws(()=>resolveWindowsShortcut(f.shortcut,()=>({target:path.join(f.dir,'cmd.bat'),args:''})),/target/i);
 assert.throws(()=>resolveWindowsShortcut(path.join(f.dir,'missing.lnk'),()=>({target:f.target})),/shortcut/i);
});
test('activity matching follows shortcut targets and survives broken shortcuts',t=>{
 const f=fixture(t);const {trackingShortcutGames}=require('../src/core/windows-shortcut.cjs');
 const games=[{id:'roblox',executable:f.shortcut},{id:'broken',executable:path.join(f.dir,'missing.lnk')},{id:'other',executable:f.target}];
 const resolved=trackingShortcutGames(games,()=>({target:f.target,cwd:f.dir,args:''}));
 assert.equal(resolved[0].executable,f.target);assert.equal(resolved[1].executable,games[1].executable);assert.equal(resolved[2].executable,f.target);
 assert.equal(games[0].executable,f.shortcut);
});
test('a shortcut-backed game started outside Orbit is tracked after restart and target updates',async t=>{
 const f=fixture(t),{trackingShortcutGames}=require('../src/core/windows-shortcut.cjs');
 const {WindowsActivityTracker}=require('../src/core/windows-activity.cjs');
 let target=f.target,started=[];const games=[{id:'roblox',source:'manual',executable:f.shortcut}];
 const read=()=>({target,cwd:f.dir,args:''});
 const makeTracker=()=>new WindowsActivityTracker({listGames:()=>trackingShortcutGames(games,read),isDirectSession:()=>false,start:id=>{started.push(id);return 'session';},finish:()=>{},enumerate:async()=>[target]});
 let tracker=makeTracker();await tracker.poll();assert.equal(tracker.isRunning('roblox'),true);tracker.stop();
 target=path.join(f.dir,'updated.exe');fs.writeFileSync(target,'fixture');
 tracker=makeTracker();await tracker.poll();assert.equal(tracker.isRunning('roblox'),true);tracker.stop();
 assert.deepEqual(started,['roblox','roblox']);
});

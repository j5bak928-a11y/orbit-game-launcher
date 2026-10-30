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

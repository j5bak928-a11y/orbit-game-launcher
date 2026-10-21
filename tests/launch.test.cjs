'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {validateLaunch,launchGame,deferredExit}=require('../src/core/launch.cjs');
test('URI protocols allowed are specific to installed game clients',()=>{
 assert.equal(validateLaunch({launch_uri:'steam://rungameid/321'}).kind,'uri');
 assert.equal(validateLaunch({launch_uri:'com.epicgames.launcher://apps/title?action=launch'}).kind,'uri');
 assert.throws(()=>validateLaunch({launch_uri:'javascript:alert(1)'}),/Unsupported launch URI/);
 assert.throws(()=>validateLaunch({launch_uri:'file:///etc/passwd'}),/Unsupported launch URI/);
 assert.throws(()=>validateLaunch({launch_uri:'https://example.com'}),/Unsupported launch URI/);
});
test('launch path checks reject invalid executables and directories',()=>{
 assert.throws(()=>validateLaunch({executable:'../my-game'}),/absolute/);
 assert.throws(()=>validateLaunch({executable:'/missing/no-such-game'}),/not found/);
 if(process.platform!=='win32')assert.throws(()=>validateLaunch({executable:__filename}),/not marked executable|not executable/);
});
test('external launch invokes the expected URI without opening a shell',async()=>{
 let requested;const launched=await launchGame({name:'App',launch_uri:'steam://rungameid/42'},async uri=>{requested=uri});
 assert.equal(requested,'steam://rungameid/42');assert.equal(launched.tracked,false);
});
test('direct process launching supports argument vectors safely',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-run-'));const file=path.join(temp,'game.js');const target=path.join(temp,'test-output.txt');
 const script=`require('node:fs').writeFileSync(process.argv[2],process.argv[3]);`;
 fs.writeFileSync(file,script);
 try{
  if(process.platform==='win32')return; // Native Windows process path is covered by Windows GUI integration tests.
  await new Promise((resolve,reject)=>{
    const launched=launchGame({name:'Node test game',executable:process.execPath,launch_args:[file,target,'text with spaces; & |'],working_dir:temp},()=>{},()=>resolve());
    launched.then(r=>assert.equal(r.tracked,true)).catch(reject);setTimeout(()=>reject(Error('Spawn timeout')),3500).unref();
  });
  assert.equal(fs.readFileSync(target,'utf8'),'text with spaces; & |');
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});

test('exit callbacks are replayed once when games exit before session setup',()=>{
 let count=0;const exit=deferredExit(()=>count++);
 exit.onExit();exit.onExit();assert.equal(count,0);
 exit.ready();exit.onExit();exit.ready();assert.equal(count,1);
});
test('exit callbacks fire once when session setup happens before game exits',()=>{
 let count=0;const exit=deferredExit(()=>count++);
 exit.ready();exit.onExit();exit.onExit();assert.equal(count,1);
});

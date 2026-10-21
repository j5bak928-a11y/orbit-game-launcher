'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {findGameExecutable,scoreExecutable}=require('../src/core/game-executable.cjs');

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-icon-discovery-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return root;
}
test('Steam games resolve actual game EXE instead of installers and launcher helpers',async t=>{
 const root=await fixture(t);
 await fs.writeFile(path.join(root,'FC27.exe'),'game');
 await fs.writeFile(path.join(root,'FC27Launcher.exe'),'launcher');
 await fs.writeFile(path.join(root,'setup.exe'),'installer');
 await fs.writeFile(path.join(root,'EasyAntiCheat.exe'),'anticheat');
 assert.equal(await findGameExecutable({name:'EA SPORTS FC 27',install_path:root},{platform:'win32'}),path.join(root,'FC27.exe'));
});
test('Steam store title and game install folder can identify a main executable',async t=>{
 const root=await fixture(t),dir=path.join(root,'Binaries','Win64');
 await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'CoasterWorks.exe'),'game');
 await fs.writeFile(path.join(dir,'UnityCrashHandler64.exe'),'crash');
 assert.equal(await findGameExecutable({name:'CoasterWorks',install_path:root},{platform:'win32'}),path.join(dir,'CoasterWorks.exe'));
});
test('explicit executable wins and Steam launch path is never mutated',async t=>{
 const root=await fixture(t),exe=path.join(root,'real.exe');
 await fs.writeFile(exe,'game');
 const game={name:'Custom game',executable:exe,install_path:root,launch_uri:'steam://rungameid/123'};
 assert.equal(await findGameExecutable(game,{platform:'win32'}),exe);
 assert.equal(game.launch_uri,'steam://rungameid/123');
});
test('missing roots and folders with only setup executables return no icon candidate',async t=>{
 const root=await fixture(t);
 await fs.writeFile(path.join(root,'uninstall.exe'),'remove');
 await fs.writeFile(path.join(root,'setup.exe'),'setup');
 await fs.writeFile(path.join(root,'EasyAntiCheat_EOS_Setup.exe'),'setup');
 assert.equal(await findGameExecutable({name:'Game',install_path:root},{platform:'win32'}),'');
 assert.equal(await findGameExecutable({name:'Game',install_path:path.join(root,'missing')},{platform:'win32'}),'');
 assert.equal(await findGameExecutable({name:'Game',install_path:root},{platform:'darwin'}),'');
});
test('folder search stays bounded and ignores symlinked directories',async t=>{
 const root=await fixture(t);
 const outside=await fixture(t);await fs.writeFile(path.join(outside,'Other.exe'),'game');
 try{await fs.symlink(outside,path.join(root,'external'),'dir')}catch{}
 for(let i=0;i<200;i++)await fs.writeFile(path.join(root,'data-'+i+'.dat'),'asset');
 assert.equal(await findGameExecutable({name:'Other',install_path:root},{platform:'win32',limit:80}), '');
});

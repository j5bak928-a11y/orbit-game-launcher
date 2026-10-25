'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const fsp=fs.promises;const os=require('node:os');const path=require('node:path');
const {parseVdf,discoverSteam,discoverEpic,discoverGog,scanFolder,gogRoots,discoverAll}=require('../src/core/discovery.cjs');
async function fixture(fn){const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'orbit-discovery-'));try{return await fn(dir)}finally{await fsp.rm(dir,{recursive:true,force:true})}}
test('VDF parser supports nested Steam library syntax',()=>{
 const parsed=parseVdf('"libraryfolders" { "0" { "path" "C:\\\\Steam" "apps" { "75" "1" } } "1" { "path" "/mnt/Games" } }');
 assert.equal(parsed.libraryfolders['0'].apps['75'],'1');assert.equal(parsed.libraryfolders['1'].path,'/mnt/Games');
});
test('Steam discovery reads appmanifest and follows libraryfolders',()=>fixture(async root=>{
 const lib=path.join(root,'Steam'),secondary=path.join(root,'SteamLibrary');await fsp.mkdir(path.join(lib,'steamapps'),{recursive:true});await fsp.mkdir(path.join(secondary,'steamapps','common','Space Game'),{recursive:true});
 await fsp.writeFile(path.join(lib,'steamapps','libraryfolders.vdf'),`"libraryfolders" { "1" { "path" "${secondary.replace(/\\/g,'\\\\')}" } }`);
 await fsp.writeFile(path.join(secondary,'steamapps','appmanifest_123.acf'),'"AppState" { "appid" "123" "name" "Space Game" "installdir" "Space Game" }');
 const data=await discoverSteam([lib]);assert.equal(data.games.length,1);assert.equal(data.games[0].name,'Space Game');assert.equal(data.games[0].launch_uri,'steam://rungameid/123');
}));
test('Steam invalid/missing directories are ignored',()=>fixture(async root=>{
 const appDir=path.join(root,'steamapps');await fsp.mkdir(appDir,{recursive:true});await fsp.writeFile(path.join(appDir,'appmanifest_30.acf'),'"AppState" { "appid" "30" "name" "Missing" "installdir" "notinstalled" }');
 const data=await discoverSteam([root]);assert.equal(data.games.length,0);
}));
test('Epic manifest uses verified installation path and known launcher protocol',()=>fixture(async root=>{
 const install=path.join(root,'Title');await fsp.mkdir(install);const executable=path.join(install,'Game.exe');await fsp.writeFile(executable,'placeholder');
 const manifests=path.join(root,'Manifests');await fsp.mkdir(manifests);
 await fsp.writeFile(path.join(manifests,'title.item'),JSON.stringify({AppName:'epic-app',DisplayName:'Epic title',InstallLocation:install,LaunchExecutable:'Game.exe'}));
 await fsp.writeFile(path.join(manifests,'broken.item'),'not-json');
 const result=await discoverEpic([manifests]);assert.equal(result.games.length,1);assert.equal(result.games[0].executable,executable);assert.match(result.games[0].launch_uri,/com.epicgames.launcher/);assert.equal(result.warnings.length,1);
}));
test('GOG info metadata identifies installed game with primary executable',()=>fixture(async root=>{
 const install=path.join(root,'Stellar');await fsp.mkdir(install);await fsp.writeFile(path.join(install,'Stellar.exe'),'placeholder');
 await fsp.writeFile(path.join(install,'goggame-99.info'),JSON.stringify({gameId:'99',name:'Stellar',playTasks:[{isPrimary:true,path:'Stellar.exe'}]}));
 const result=await discoverGog([root]);assert.equal(result.games.length,1);assert.equal(result.games[0].source,'gog');assert.equal(result.games[0].source_id,'99');
}));
test('folder scanner handles empty and unavailable folders safely',()=>fixture(async root=>{
 assert.equal((await scanFolder(root)).games.length,0);
 const result=await scanFolder(path.join(root,'missing'));assert.equal(result.games.length,0);assert.equal(result.warnings.length,1);
}));

test('Steam rejects directory traversal in install manifests',()=>fixture(async root=>{
 const folder=path.join(root,'steamapps');await fsp.mkdir(folder,{recursive:true});
 for(const [id,dir] of [['20','../escape'],['21','..\\escape'],['22','nested/subfolder']]){
   await fsp.writeFile(path.join(folder,`appmanifest_${id}.acf`),`"AppState" { "appid" "${id}" "name" "Wrong location" "installdir" "${dir}" }`);
 }
 const result=await discoverSteam([root]);assert.deepEqual(result.games,[]);
}));
test('macOS GOG search paths are independent of Windows environment variables',()=>{
 const roots=gogRoots('darwin');assert.equal(roots.length,1);
 assert.ok(roots[0].endsWith(path.join('Applications')));
 assert.ok(gogRoots('linux').length===0);
});

test('a GOG title discovered through a custom folder only appears once',()=>fixture(async root=>{
 const game=path.join(root,'Example');await fsp.mkdir(game);
 const executable=path.join(game,process.platform==='win32'?'example.exe':'example.sh');await fsp.writeFile(executable,'#!/bin/sh\nexit 0\n');
 if(process.platform!=='win32')await fsp.chmod(executable,0o755);
 await fsp.writeFile(path.join(game,'goggame-154.info'),JSON.stringify({gameId:'154',name:'Example',playTasks:[{isPrimary:true,path:'example.sh'}]}));
 const result=await discoverAll({libraryFolders:[root]});
 assert.equal(result.games.filter(x=>x.executable===executable).length,1);
 assert.equal(result.games.filter(x=>x.name==='Example').length,1);
}));

test('folder scanner bounds traversal and skips symlink cycles',()=>fixture(async root=>{
  const game=path.join(root,'Game Folder');await fsp.mkdir(game);
  const binary=path.join(game,process.platform==='win32'?'Game Folder.exe':'Game Folder.sh');
  await fsp.writeFile(binary,'#!/bin/sh\nexit 0\n');
  if(process.platform!=='win32')await fsp.chmod(binary,0o755);
  try{await fsp.symlink(root,path.join(game,'cycle'),'dir')}catch{} // Windows can restrict link creation.
  const result=await scanFolder(root,{limit:15,maxDepth:3});
  assert.equal(result.games.filter(g=>g.executable===binary).length,1);
  const missing=await scanFolder(path.join(root,'unplugged-drive'));
  assert.equal(missing.games.length,0);
  assert.match(missing.warnings[0],/Folder unavailable/);
}));

test('folder scanner reports its entry limit instead of silently claiming a complete scan',()=>fixture(async root=>{
  for(let i=0;i<18;i++)await fsp.writeFile(path.join(root,`note-${i}.txt`),'not an executable');
  const result=await scanFolder(root,{limit:8,maxDepth:0});
  assert.equal(result.games.length,0);
  assert.ok(result.warnings.some(w=>w.includes('Scan stopped at 8 entries')));
}));

test('custom folder discovery recognizes standalone game executables by filename',async t=>{
 const fs=require('node:fs');
 const os=require('node:os');
 const path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-standalone-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'my game');fs.mkdirSync(dir);
 const exe=path.join(dir,'hoi4.exe');fs.writeFileSync(exe,'fixture',{mode:0o755});
 fs.chmodSync(exe,0o755);
 const found=await scanFolder(root);
 const game=found.games.find(g=>g.executable===exe);
 assert.equal(game?.name,'Hearts of Iron IV');
 assert.equal(game?.source,'folder');
 assert.equal(game?.launch_uri,undefined);
});

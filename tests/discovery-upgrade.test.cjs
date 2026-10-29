'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const discovery=require('../src/core/discovery.cjs');
const posixPermissions={skip:process.platform==='win32'?'Requires POSIX execute permission bits':false};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-discovery-upgrade-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function file(root,relative,contents='fixture'){const target=path.join(root,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,typeof contents==='string'?contents:JSON.stringify(contents));return target;}
const vdf=(id,name)=>`"AppState" { "appid" "${id}" "name" "${name}" "installdir" "${name}" "StateFlags" "4" }`;
test('Steam registry root, legacy index and duplicate libraries find one verified installed title',async t=>{
 const root=await fixture(t),steam=path.join(root,'NonDefaultSteam'),lib=path.join(root,'Library');
 await file(steam,'config/libraryfolders.vdf',`"libraryfolders" { "1" "${lib}" "2" { "path" "${lib}" } }`);
 await file(lib,'steamapps/appmanifest_52.acf',vdf('52','Game'));
 await fs.mkdir(path.join(lib,'steamapps/common/Game'),{recursive:true});
 const result=await discovery.discoverSteam([],{platform:'win32',queryRegistry:async key=>key.startsWith('HKCU')?`HKEY_CURRENT_USER\\Software\\Valve\\Steam\n    SteamPath    REG_SZ    ${steam}\n`:''});
 assert.deepEqual(result.games.map(g=>g.source_id),['52']);
});
test('Steam excludes incomplete state and manifest symlinks escaping the install common directory',async t=>{
 const root=await fixture(t);await file(root,'steamapps/appmanifest_81.acf',vdf('81','Ready').replace('"4"','"1026"'));
 await fs.mkdir(path.join(root,'steamapps/common/Ready'),{recursive:true});
 await file(root,'outside/Game.exe');
 try{await fs.symlink(path.join(root,'outside'),path.join(root,'steamapps/common/Escape'),'dir')}catch{}
 await file(root,'steamapps/appmanifest_82.acf',vdf('82','Escape'));
 assert.deepEqual((await discovery.discoverSteam([root])).games,[]);
});
test('Epic uses catalog launch identity, rejects incomplete/DLC installs and merges duplicate metadata',async t=>{
 const root=await fixture(t),install=path.join(root,'Rocket League');await file(install,'Binaries/Win64/RocketLeague.exe');
 const record={AppName:'Sugar',DisplayName:'Rocket League',InstallLocation:install,LaunchExecutable:'Binaries\\Win64\\RocketLeague.exe',CatalogNamespace:'namespace',CatalogItemId:'catalog',bIsIncompleteInstall:false};
 await file(root,'metadata/a.item',record);await file(root,'metadata/b.item',record);
 await file(root,'metadata/incomplete.item',{...record,AppName:'unfinished',bIsIncompleteInstall:true});
 await file(root,'metadata/dlc.item',{...record,AppName:'addon',MainGameAppName:'Sugar'});
 const result=await discovery.discoverEpic([path.join(root,'metadata')]);
 assert.equal(result.games.length,1);assert.equal(result.games[0].source_id,'Sugar');
 assert.equal(result.games[0].launch_uri,'com.epicgames.launcher://apps/namespace%3Acatalog%3ASugar?action=launch&silent=true');
});
test('manifest executables cannot escape through backslash traversal or symlinks',async t=>{
 const root=await fixture(t),install=path.join(root,'Game');await fs.mkdir(install);const outside=await file(root,'outside.exe');
 try{await fs.symlink(outside,path.join(install,'Linked.exe'))}catch{}
 await file(root,'metadata/a.item',{AppName:'escape',DisplayName:'Escape',InstallLocation:install,LaunchExecutable:'..\\outside.exe'});
 await file(root,'metadata/b.item',{AppName:'link',DisplayName:'Linked',InstallLocation:install,LaunchExecutable:'Linked.exe'});
 const result=await discovery.discoverEpic([path.join(root,'metadata')]);assert.ok(result.games.every(g=>!g.executable));
});
test('GOG primary Windows task paths normalize separators and exclude traversal',async t=>{
 const root=await fixture(t),game=path.join(root,'Game'),exe=await file(game,'bin/Game.exe');
 await file(game,'goggame-123.info',{gameId:'123',name:'Game',playTasks:[{isPrimary:true,path:'bin\\Game.exe'}]});
 assert.equal((await discovery.discoverGog([root])).games[0].executable,exe);
});
test('selected folder finds Binaries/Win64 game once and ignores utilities and engine tools',async t=>{
 const root=await fixture(t),exe=await file(root,'Rocket League/Binaries/Win64/RocketLeague.exe');
 for(const relative of ['Rocket League/Binaries/Win64/UnityCrashHandler64.exe','Rocket League/Binaries/Win64/CrashReportClient.exe','Rocket League/Engine/Binaries/Win64/UnrealEditor.exe','Rocket League/RocketLeagueLauncher.exe','Tools/Editor.exe','Tools/ConfigTool.exe','Tools/Service.exe'])await file(root,relative);
 const result=await discovery.scanFolder(root,{platform:'win32'});assert.equal(result.games.length,1);assert.equal(result.games[0].executable,exe);assert.equal(result.games[0].install_path,path.join(root,'Rocket League'));assert.equal(result.games[0].name,'Rocket League');
});
test('selected folder leaves equally plausible unknown binaries for manual selection',async t=>{
 const root=await fixture(t);await file(root,'Unknown/Alpha.exe');await file(root,'Unknown/Bravo.exe');
 const result=await discovery.scanFolder(root,{platform:'win32'});assert.equal(result.games.length,0);assert.ok(result.warnings.some(w=>/ambiguous/i.test(w)));
});
test('shared Call of Duty folder selects the specifically recognized MW4 executable',async t=>{
 const root=await fixture(t);
 await file(root,'Call of Duty/cod.exe');
 const exe=await file(root,'Call of Duty/cod26-cod.exe');
 const result=await discovery.scanFolder(root,{platform:'win32'});
 assert.equal(result.games.length,1);
 assert.equal(result.games[0].name,'Call of Duty: Modern Warfare 4');
 assert.equal(result.games[0].executable,exe);
});
test('equally plausible different recognized games in one folder remain ambiguous',async t=>{
 const root=await fixture(t);
 await file(root,'Mixed/hoi4.exe');await file(root,'Mixed/eu4.exe');
 const result=await discovery.scanFolder(root,{platform:'win32'});
 assert.equal(result.games.length,0);assert.ok(result.warnings.some(w=>/ambiguous/i.test(w)));
});
test('a weak recognized executable does not override a strong folder title match',async t=>{
 const root=await fixture(t),expected=await file(root,'Outer Wilds/Outer Wilds.exe');
 await file(root,'Outer Wilds/hoi4.exe');
 const result=await discovery.scanFolder(root,{platform:'win32'});
 assert.equal(result.games.length,1);assert.equal(result.games[0].executable,expected);
});
test('Heroic reads its real installed Epic/GOG caches and preserves store identity with Heroic handoff',async t=>{
 const root=await fixture(t),install=path.join(root,'Game');const exe=await file(install,'Game.exe');
 await file(root,'heroic/legendaryConfig/legendary/installed.json',{EpicGame:{app_name:'EpicGame',title:'Epic Game',install_path:install,executable:'Game.exe'},DLC:{app_name:'DLC',title:'DLC',install_path:install,is_dlc:true}});
 await file(root,'heroic/gog_store/installed.json',{installed:[{appName:'1234',title:'GOG Game',install_path:install,executable:'Game.exe'}]});
 const result=await discovery.discoverHeroic([path.join(root,'heroic')],{platform:'linux'});
 assert.deepEqual(result.games.map(g=>[g.source,g.source_id]),[['epic','EpicGame'],['gog','1234']]);
 assert.equal(result.games[0].executable,exe);assert.equal(result.games[0].launch_uri,'heroic://launch?appName=EpicGame&runner=legendary');
 assert.equal(result.games[1].launch_uri,'heroic://launch?appName=1234&runner=gog');
});
test('standalone Legendary skips Wine executables without a verified native launch target',posixPermissions,async t=>{
 const root=await fixture(t),install=path.join(root,'Game');await file(install,'Game.exe');const exe=await file(install,'native.sh','#!/bin/sh\n');await fs.chmod(exe,0o755);
 await file(root,'legendary/installed.json',{Windows:{app_name:'Windows',title:'Windows Game',install_path:install,executable:'Game.exe'},Native:{app_name:'Native',title:'Native Game',install_path:install,executable:'native.sh'}});
 const result=await discovery.discoverLegendary([path.join(root,'legendary')],{platform:'linux'});assert.equal(result.games.length,1);assert.equal(result.games[0].executable,exe);assert.ok(result.warnings.some(w=>/Windows Game.*Heroic|Heroic.*Windows Game/.test(w)));
});
test('vendor registry discovery requires exact trusted publisher and a contained game executable',async t=>{
 const root=await fixture(t),install=path.join(root,'Coaster'),exe=await file(install,'Coaster.exe');const outside=await file(root,'outside.exe');
 const record=(id,name,publisher,icon,location=install)=>`HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}\n    DisplayName    REG_SZ    ${name}\n    Publisher    REG_SZ    ${publisher}\n    InstallLocation    REG_SZ    ${location}\n    DisplayIcon    REG_SZ    "${icon}",0\n`;
 const stdout=record('A','Coaster','Electronic Arts',exe)+record('B','Spoof','Electronic Arts Tools',exe)+record('C','Escape','Ubisoft',outside)+record('D','EA app','Electronic Arts',exe)+record('E','No directory','Ubisoft',exe,path.join(root,'missing'));
 const result=await discovery.discoverWindowsRegistry({platform:'win32',queryRegistry:async key=>key.startsWith('HKLM\\SOFTWARE\\Microsoft')?stdout:''});
 assert.deepEqual(result.games.map(g=>[g.name,g.source,g.executable]),[['Coaster','ea',exe]]);
});
test('provider diagnostics isolate failures, retain games/warnings and bound concurrency',async()=>{
 let active=0,max=0;const providers=Array.from({length:9},(_,i)=>({provider:`fixture${i}`,run:async()=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,4));active--;if(i===1)throw Error('fixture failure');return {games:i===0?[{name:'Game',source:'steam',source_id:'52',launch_uri:'steam://rungameid/52'}]:[],warnings:[]};}}));
 const result=await discovery.discoverAll({libraryFolders:[]},{providers});assert.equal(result.games.length,1);assert.equal(result.diagnostics.length,9);assert.equal(result.diagnostics[1].status,'error');assert.match(result.warnings.join(' '),/fixture failure/);assert.ok(max<=4);assert.ok(result.diagnostics.every(d=>Number.isFinite(d.durationMs)));
});
test('platform roots retain native Steam and Flatpak locations',()=>{
 const roots=discovery.steamRoots('linux');assert.ok(roots.includes(path.join(os.homedir(),'.local/share/Steam')));assert.ok(roots.includes(path.join(os.homedir(),'.var/app/com.valvesoftware.Steam/data/Steam')));
 assert.ok(discovery.heroicRoots('linux').includes(path.join(os.homedir(),'.var/app/com.heroicgameslauncher.hgl/config/heroic')));
});
test('selected-folder traversal budget is global even with many children and a cycle',async t=>{
 const root=await fixture(t);for(let i=0;i<20;i++)await file(root,`Title${i}/Title${i}.exe`);
 try{await fs.symlink(root,path.join(root,'cycle'),'dir')}catch{}
 const result=await discovery.scanFolder(root,{platform:'win32',limit:10});assert.equal(result.games.length,0);assert.ok(result.warnings.some(w=>/Scan stopped at 10 entries/.test(w)));
});
test('GOG manifest tasks reject Windows traversal and external symlink executables',async t=>{
 const root=await fixture(t),game=path.join(root,'Game');await fs.mkdir(game);const outside=await file(root,'outside.exe');
 await file(game,'goggame-45.info',{gameId:'45',name:'Escape',playTasks:[{isPrimary:true,path:'..\\outside.exe'}]});assert.equal((await discovery.discoverGog([root])).games.length,0);
 try{await fs.symlink(outside,path.join(game,'Linked.exe'))}catch{return;}
 await file(game,'goggame-45.info',{gameId:'45',name:'Escape',playTasks:[{isPrimary:true,path:'Linked.exe'}]});assert.equal((await discovery.discoverGog([root])).games.length,0);
});
test('Epic duplicate manifests prefer richer verified executable and catalog metadata',async t=>{
 const root=await fixture(t),install=path.join(root,'Game'),exe=await file(install,'Game.exe');const record={AppName:'Game',DisplayName:'Game',InstallLocation:install};
 await file(root,'manifests/a.item',record);await file(root,'manifests/b.item',{...record,LaunchExecutable:'Game.exe',CatalogNamespace:'ns',CatalogItemId:'item'});
 const result=await discovery.discoverEpic([path.join(root,'manifests')]);assert.equal(result.games.length,1);assert.equal(result.games[0].executable,exe);assert.match(result.games[0].launch_uri,/ns%3Aitem%3AGame/);
});
test('registry errors are visible while absent storefront keys are normal',async()=>{
 const result=await discovery.discoverWindowsRegistry({platform:'win32',queryRegistry:async key=>{const error=Error(key.includes('WOW6432Node')?'Access denied':'No key');error.code=key.includes('WOW6432Node')?'EACCES':1;throw error;}});
 assert.equal(result.games.length,0);assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/Access denied/);
});
test('VDF nesting and prototype keys cannot poison discovery',()=>{
 const doc=discovery.parseVdf('"__proto__" { "polluted" "yes" } "libraryfolders" {}');assert.equal({}.polluted,undefined);assert.deepEqual(doc,{libraryfolders:{}});
 assert.throws(()=>discovery.parseVdf('"a" { '.repeat(40)+'}'.repeat(40)),/nesting limit/);
});
test('Windows standalone Legendary preserves its verified executable without an Epic-client URI',async t=>{
 const root=await fixture(t),install=path.join(root,'Legendary Game'),exe=await file(install,'Game.exe');
 await file(root,'legendary/installed.json',{Independent:{app_name:'Independent',title:'Legendary Game',install_path:install,executable:'Game.exe',platform:'Windows'}});
 const result=await discovery.discoverLegendary([path.join(root,'legendary')],{platform:'win32'});
 assert.equal(result.games.length,1);assert.equal(result.games[0].executable,exe);assert.equal(result.games[0].launch_uri,undefined);
});
test('independent macOS app bundles remain separate reviewable games',async t=>{
 const root=await fixture(t);for(const name of ['Alpha Game','Bravo Game'])await file(root,`${name}.app/Contents/MacOS/${name}`);
 const result=await discovery.scanFolder(root,{platform:'darwin'});
 assert.deepEqual(result.games.map(g=>g.name).sort(),['Alpha Game','Bravo Game']);
 assert.deepEqual(result.games.map(g=>g.install_path).sort(),['Alpha Game.app','Bravo Game.app'].map(name=>path.join(root,name)).sort());assert.equal(result.warnings.length,0);
});
test('GOG task manifests reject uninstaller and non-executable text targets',async t=>{
 const root=await fixture(t);
 for(const [folder,target] of [['Uninstaller','unins000.exe'],['Document','notes.txt']]){
  await file(root,`${folder}/${target}`);await file(root,`${folder}/goggame-42.info`,{gameId:'42',name:folder,playTasks:[{isPrimary:true,type:'FileTask',path:target}]});
 }
 assert.deepEqual((await discovery.discoverGog([root])).games,[]);
 assert.deepEqual((await discovery.scanFolder(root,{platform:'win32'})).games,[]);
});
test('invalid GOG primary tasks fall back to a legitimate Windows game task',async t=>{
 const root=await fixture(t),install=path.join(root,'GOG Game'),exe=await file(install,'Game.exe');await file(install,'unins000.exe');
 await file(install,'goggame-84.info',{gameId:'84',name:'GOG Game',playTasks:[{isPrimary:true,type:'FileTask',path:'unins000.exe'},{type:'FileTask',path:'Game.exe'}]});
 const result=await discovery.discoverGog([root]);assert.equal(result.games.length,1);assert.equal(result.games[0].executable,exe);
});
test('GOG native task requires execute permission and retains valid native targets',posixPermissions,async t=>{
 const root=await fixture(t),valid=await file(root,'Native/native.sh','#!/bin/sh\nexit 0\n');await fs.chmod(valid,0o755);
 await file(root,'Native/goggame-85.info',{gameId:'85',name:'Native',playTasks:[{isPrimary:true,type:'FileTask',path:'native.sh'}]});
 await file(root,'NonExecutable/native.sh','#!/bin/sh\nexit 0\n');await file(root,'NonExecutable/goggame-86.info',{gameId:'86',name:'NonExecutable',playTasks:[{isPrimary:true,type:'FileTask',path:'native.sh'}]});
 const result=await discovery.discoverGog([root]);assert.deepEqual(result.games.map(g=>g.executable),[valid]);
});

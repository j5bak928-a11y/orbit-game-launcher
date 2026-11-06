'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const discovery=require('../src/core/discovery.cjs');

async function sandbox(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-smart-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return root;
}
async function write(root,relative,text='fixture'){
 const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file,text);return file;
}
const xboxConfig=(id,name,exe)=>`<?xml version="1.0" encoding="utf-8"?><Game configVersion="1"><Identity Name="${id}" Publisher="CN=Example" Version="1.0.0.0"/><ExecutableList><Executable Name="${exe}" Id="Game"/></ExecutableList><ShellVisuals DefaultDisplayName="${name}"/></Game>`;

test('different authoritative store IDs sharing a launcher stay separate; folder duplicate loses',async()=>{
 const exe=path.join(os.tmpdir(),'shared-game','client.exe'),install=path.dirname(exe);
 const items=[
  {name:'Game',source:'folder',install_path:install,executable:exe},
  {name:'Base Game',source:'steam',source_id:'100',install_path:install,executable:exe},
  {name:'Standalone DLC',source:'steam',source_id:'101',install_path:install,executable:exe},
  {name:'Epic Version',source:'epic',source_id:'AppOne',install_path:install,executable:exe},
  {name:'Duplicate listing',source:'steam',source_id:'100',install_path:install,executable:exe},
 ];
 const providers=items.map((game,i)=>({provider:`fixture${i}`,run:async()=>({games:[game],warnings:[]})}));
 const result=await discovery.discoverAll({libraryFolders:[]},{providers});
 assert.deepEqual(result.games.map(game=>`${game.source}:${game.source_id}`),['steam:100','steam:101','epic:AppOne']);
 assert.equal(result.diagnostics.length,items.length);
});

test('Epic includes only separately launchable DLC and never invents a missing target',async t=>{
 const root=await sandbox(t),install=path.join(root,'Install'),manifest=path.join(root,'Metadata');
 await write(install,'Game.exe');await write(install,'Addon.exe');
 const common={DisplayName:'Game',InstallLocation:install,LaunchExecutable:'Game.exe'};
 await write(manifest,'base.item',JSON.stringify({...common,AppName:'base'}));
 await write(manifest,'valid-dlc.item',JSON.stringify({...common,AppName:'addon',DisplayName:'Standalone Addon',LaunchExecutable:'Addon.exe',MainGameAppName:'base',bIsDlc:true}));
 await write(manifest,'passive-dlc.item',JSON.stringify({...common,AppName:'passive',MainGameAppName:'base',LaunchExecutable:'',bIsDlc:true}));
 await write(manifest,'missing-dlc.item',JSON.stringify({...common,AppName:'absent',MainGameAppName:'base',LaunchExecutable:'missing.exe',bIsDlc:true}));
 const result=await discovery.discoverEpic([manifest]);
 assert.deepEqual(result.games.map(game=>game.source_id).sort(),['addon','base']);
 assert.ok(result.games.every(game=>game.launch_uri.includes(game.source_id)));
});

test('Xbox PC metadata is bounded, verifies the executable, and does not invent a launch URI',async t=>{
 const root=await sandbox(t),game=path.join(root,'Sunset Racer'),exe=await write(game,'Content/Binaries/Sunset.exe');
 const config=xboxConfig('Contoso.SunsetRacer','Sunset Racer','Binaries\\Sunset.exe');
 await write(game,'Content/MicrosoftGame.config',config);
 const result=await discovery.discoverXbox([root],{platform:'win32'});
 assert.equal(result.games.length,1);
 assert.deepEqual(result.games[0],{
  name:'Sunset Racer',source:'xbox',source_id:'Contoso.SunsetRacer',
  install_path:game,executable:exe,tags:[],
 });
 assert.equal(result.games[0].launch_uri,undefined);
 assert.ok(result.warnings.some(w=>/direct launch may lack Gaming Runtime identity/i.test(w)));
 assert.equal((await fs.readFile(path.join(game,'Content/MicrosoftGame.config'),'utf8')),config);
});

test('Xbox malformed or ambiguous XML fails closed even when the EXE exists',async t=>{
 const root=await sandbox(t);
 const valid=xboxConfig('Contoso.Valid','Valid Game','Game.exe');
 const bad={
  unclosed:'<Game><Identity Name="Contoso.Malformed" Publisher="CN=Example"><ShellVisuals DefaultDisplayName="Malformed Game"><Executable Name="Game.exe">',
  mismatched:'<Game><Identity Name="Contoso.Malformed"/></ExecutableList></Game>',
  duplicateIdentity:valid.replace('<ShellVisuals ', '<Identity Name="Contoso.Forged"/><ShellVisuals '),
  duplicateExecutable:valid.replace('</ExecutableList>','<Executable Name="Game.exe" Id="Duplicate"/></ExecutableList>'),
  duplicateAttribute:valid.replace('Name="Contoso.Valid"','Name="Contoso.Valid" Name="Contoso.Forged"'),
  malformedQuote:valid.replace('Name="Contoso.Valid"','Name="Contoso.Valid'),
  unquotedAttribute:valid.replace('Name="Contoso.Valid"','Name=Contoso.Valid'),
  brokenXmlDeclaration:valid.replace('encoding="utf-8"','encoding=utf-8'),
  unknownEntity:valid.replace('Name="Contoso.Valid"','Name="Contoso.&unknown;"'),
  unclosedComment:valid.replace('</Game>','<!-- never closes</Game>'),
  secondRoot:`${valid}<Game><Identity Name="Contoso.Forged"/></Game>`,
  missingExecutableList:valid.replace('<ExecutableList>','').replace('</ExecutableList>',''),
 };
 for(const [name,manifest] of Object.entries(bad)){
  const dir=path.join(root,name);
  await write(dir,'Game.exe');
  await write(dir,'MicrosoftGame.config',manifest);
 }
 const result=await discovery.discoverXbox([root],{platform:'win32'});
 assert.deepEqual(result.games,[],'Malformed Xbox XML must not be imported');
 assert.ok(result.warnings.some(w=>/Unclosed|Mismatched|Duplicate|Malformed|Misplaced|XML/i.test(w)));
});

test('Xbox manifest only imports executable entries eligible for PC',async t=>{
 const root=await sandbox(t);
 const game=path.join(root,'PC Ready'),consoleGame=path.join(root,'Xbox Only');
 await write(game,'Game.exe');await write(consoleGame,'Game.exe');
 await write(game,'MicrosoftGame.config',xboxConfig('Contoso.PC','PC Ready','Game.exe').replace('Id="Game"','Id="Game" TargetDeviceFamily="PC"'));
 await write(consoleGame,'MicrosoftGame.config',xboxConfig('Contoso.Console','Xbox Only','Game.exe').replace('Id="Game"','Id="Game" TargetDeviceFamily="Scarlett"'));
 const result=await discovery.discoverXbox([root],{platform:'win32'});
 assert.deepEqual(result.games.map(game=>game.source_id),['Contoso.PC']);
 assert.ok(result.warnings.some(w=>/not PC/i.test(w)));
});

test('selected folder detects an Xbox manifest only once without a second generic executable entry',async t=>{
 const root=await sandbox(t),game=path.join(root,'Racer');
 await write(game,'Content/MicrosoftGame.config',xboxConfig('Contoso.Racer','Racer','Racer.exe'));
 const exe=await write(game,'Content/Racer.exe');
 const result=await discovery.scanFolder(root,{platform:'win32',maxDepth:5});
 assert.equal(result.games.length,1);
 assert.equal(result.games[0].executable,exe);
 assert.equal(result.games[0].source,'xbox');
 assert.equal(result.games[0].source_id,'Contoso.Racer');
});

test('Xbox metadata refuses traversal, symlink escapes, unlaunchable packages and oversized manifests',async t=>{
 const root=await sandbox(t);await write(root,'escape.exe');
 for(const [dir,target] of [['Traversal','..\\escape.exe'],['Missing','not-there.exe'],['Document','notes.txt'],['Uninstall','unins000.exe']]){
  await write(root,`${dir}/MicrosoftGame.config`,xboxConfig(`Contoso.${dir}`,dir,target));
  if(dir==='Document'||dir==='Uninstall')await write(root,`${dir}/${target}`);
 }
 await write(root,'Huge/MicrosoftGame.config','x'.repeat(128*1024+1));
 await write(root,'Entities/MicrosoftGame.config',`<!DOCTYPE game [<!ENTITY x "bad">]>${xboxConfig('Contoso.Entities','Entities','Game.exe')}`);
 await write(root,'Entities/Game.exe');
 await write(root,'Linked/MicrosoftGame.config',xboxConfig('Contoso.Linked','Linked','linked.exe'));
 try{await fs.symlink(path.join(root,'escape.exe'),path.join(root,'Linked/linked.exe'))}catch{}
 const result=await discovery.discoverXbox([root],{platform:'win32'});
 assert.deepEqual(result.games,[]);
 assert.ok(result.warnings.some(w=>/too large/i.test(w)));
});

test('Xbox packaged-only metadata is reported but never presented as launchable',async t=>{
 const root=await sandbox(t);
 await write(root,'Package/MicrosoftGame.config','<Game><Identity Name="Contoso.Package"/><ShellVisuals DefaultDisplayName="Package"/></Game>');
 const result=await discovery.discoverXbox([root],{platform:'win32'});
 assert.deepEqual(result.games,[]);
 assert.ok(result.warnings.some(w=>/no verified direct executable/i.test(w)));
});

test('two Steam app IDs in one verified install folder are preserved as separate identities',async t=>{
 const root=await sandbox(t);await fs.mkdir(path.join(root,'steamapps/common/Game'),{recursive:true});
 for(const [id,name] of [['125','Main Game'],['126','Independent Expansion']]){
  await write(root,`steamapps/appmanifest_${id}.acf`,`"AppState" { "appid" "${id}" "name" "${name}" "installdir" "Game" "StateFlags" "4" }`);
 }
 const result=await discovery.discoverSteam([root],{queryRegistry:async()=>''});
 assert.deepEqual(result.games.map(g=>g.source_id).sort(),['125','126']);
});

test('GOG preserves individually launchable expansions sharing a verified install folder',async t=>{
 const root=await sandbox(t),game=path.join(root,'Collection');
 await write(game,'Main.exe');await write(game,'Expansion.exe');
 for(const [id,name,exe] of [['701','Main Game','Main.exe'],['702','Standalone Expansion','Expansion.exe']]){
  await write(game,`goggame-${id}.info`,JSON.stringify({gameId:id,name,playTasks:[{isPrimary:true,type:'FileTask',path:exe}]}));
 }
 const result=await discovery.discoverGog([root]);
 assert.deepEqual(result.games.map(g=>g.source_id).sort(),['701','702']);
 const selected=await discovery.scanFolder(root,{platform:'win32'});
 assert.deepEqual(selected.games.map(g=>g.source_id).sort(),['701','702']);
});

test('mismatched GOG filename and embedded game ID cannot create a false store identity',async t=>{
 const root=await sandbox(t),game=path.join(root,'Game');
 await write(game,'Game.exe');
 await write(game,'goggame-900.info',JSON.stringify({gameId:'901',name:'Forged',playTasks:[{path:'Game.exe',isPrimary:true}]}));
 assert.deepEqual((await discovery.discoverGog([root])).games,[]);
});

test('store source IDs deduplicate case-insensitively like the persistent library',async()=>{
 const records=[{name:'First',source:'epic',source_id:'AppKey'},{name:'Duplicate',source:'epic',source_id:'appkey'}];
 const result=await discovery.discoverAll({libraryFolders:[]},{providers:[{provider:'fixture',run:async()=>({games:records,warnings:[]})}]});
 assert.equal(result.games.length,1);
 assert.equal(result.games[0].name,'First');
});

test('Battle.net registry discovery is limited to publisher-verified games and never executes commands',async t=>{
 const root=await sandbox(t),install=path.join(root,'Hearthstone'),exe=await write(install,'Hearthstone.exe');
 const record=(id,publisher,icon)=>`HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}\n    DisplayName    REG_SZ    Hearthstone\n    Publisher    REG_SZ    ${publisher}\n    InstallLocation    REG_SZ    ${install}\n    DisplayIcon    REG_SZ    "${icon}",0\n    UninstallString    REG_SZ    cmd /c dangerous-command\n`;
 const stdout=record('BlizzardGame','Blizzard Entertainment',exe)+record('Fake','Not Blizzard Entertainment',exe);
 const result=await discovery.discoverWindowsRegistry({platform:'win32',queryRegistry:async key=>key==='HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'?stdout:''});
 assert.deepEqual(result.games.map(g=>[g.source,g.name,g.executable]),[['battlenet','Hearthstone',exe]]);
});

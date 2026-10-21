'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {suggestedName,findNearbyArtwork,inspectGameFile,verifyExecutable} = require('../src/core/game-file.cjs');
const {LibraryDatabase} = require('../src/core/database.cjs');
const png = Buffer.from('89504e470d0a1a0a0000000000000000','hex');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-exe-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,'Starlight Explorer');fs.mkdirSync(dir);const exe=path.join(dir,'Starlight-Explorer.exe');fs.writeFileSync(exe,'fake executable fixture');return {root,dir,exe};}
test('selecting local executable suggests name and picks nearby named cover art',async t=>{
 const {exe,dir}=fixture(t);fs.writeFileSync(path.join(dir,'cover.png'),png);
 fs.writeFileSync(path.join(dir,'random-UI.png'),png);
 const used=[];
 const result=await inspectGameFile(exe,{saveArtwork:async file=>{used.push(file);return 'cover-asset';},extractIcon:async()=> 'icon-asset'});
 assert.equal(result.name,'Starlight Explorer');assert.equal(result.executable,exe);
 assert.equal(result.working_dir,dir);assert.equal(result.cover,'cover-asset');assert.equal(result.icon,'icon-asset');
 assert.deepEqual(used,[path.join(dir,'cover.png')]);
});
test('non-matching screenshots are ignored, icon is used as fallback',async t=>{
 const {exe,dir}=fixture(t);fs.writeFileSync(path.join(dir,'screenshot204.png'),png);
 assert.equal(await findNearbyArtwork(exe),null);
 const found=await inspectGameFile(exe,{saveArtwork:async()=>{throw Error('should not run');},extractIcon:async()=> 'icon-token'});
 assert.equal(found.cover,'');assert.equal(found.icon,'icon-token');
});
test('missing paths, directories and invalid images do not produce fake artwork',async t=>{
 const {exe,dir}=fixture(t);
 await assert.rejects(verifyExecutable(path.join(dir,'missing.exe')),/not found/);
 await assert.rejects(verifyExecutable(dir),/not found/);
 assert.equal(suggestedName(path.join(dir,'Game.exe')),'Starlight Explorer');
 fs.writeFileSync(path.join(dir,'cover.png'),'not an image');
 const found=await inspectGameFile(exe,{saveArtwork:async()=>{throw Error('invalid image');},extractIcon:async()=>{throw Error('icon unavailable');}});
 assert.equal(found.cover,'');assert.equal(found.icon,'');
});
test('icon metadata persists and databases from before icon support migrate without data loss',t=>{
 const {root,exe}=fixture(t),file=path.join(root,'library.sqlite');
 let db=new LibraryDatabase(file);
 const g=db.upsert({name:'Already saved',executable:exe,cover:'oldcover.png'}).game;
 db.db.exec('ALTER TABLE games DROP COLUMN icon');db.close();
 db=new LibraryDatabase(file);
 try{
   assert.equal(db.get(g.id).name,'Already saved');assert.equal(db.get(g.id).cover,'oldcover.png');assert.equal(db.get(g.id).icon,'');
   db.update(g.id,{icon:'native-icon.png'});assert.equal(db.get(g.id).icon,'native-icon.png');
 }finally{db.close();}
});

test('standalone hoi4.exe resolves full name and can use optional public Steam artwork',async t=>{
 const {root}=fixture(t);const exe=path.join(root,'HOI4.exe');fs.writeFileSync(exe,'fixture');
 const lookedUp=[];
 const result=await inspectGameFile(exe,{
   readProductName:async()=>{throw Error('known alias must not trigger metadata read');},
   lookupCover:async ({name,steamId})=>{lookedUp.push([name,steamId]);return 'steam-cover.jpg';},
   extractIcon:async()=> 'icon.png',
 });
 assert.equal(result.name,'Hearts of Iron IV');assert.equal(result.recognized,true);
 assert.equal(result.name_source,'executable');assert.equal(result.suggested_name,'HOI4');
 assert.equal(result.cover,'steam-cover.jpg');assert.equal(result.cover_source,'steam');
 assert.equal(result.icon,'icon.png');
 assert.deepEqual(lookedUp,[['Hearts of Iron IV','394360']]);
});
test('local art wins over online and unknown games remain manually editable',async t=>{
 const {exe,dir}=fixture(t);fs.writeFileSync(path.join(dir,'cover.png'),png);
 const result=await inspectGameFile(exe,{
   saveArtwork:async()=> 'local-cover.png',
   lookupCover:async()=>{throw Error('online should not run');},
   readProductName:async()=> 'Unity Player',
 });
 assert.equal(result.name,'Starlight Explorer');
 assert.equal(result.recognized,false);
 assert.equal(result.cover,'local-cover.png');assert.equal(result.cover_source,'local');
});
test('offline or rejected Steam artwork leaves correctly recognized title and native icon',async t=>{
 const {root}=fixture(t);const exe=path.join(root,'hoi4.exe');fs.writeFileSync(exe,'fixture');
 const result=await inspectGameFile(exe,{
   lookupCover:async()=>{throw Error('network unavailable');},
   extractIcon:async()=> 'fallback.png'
 });
 assert.equal(result.name,'Hearts of Iron IV');assert.equal(result.cover,'');
 assert.equal(result.icon,'fallback.png');
});

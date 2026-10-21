'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {discoverAll}=require('../src/core/discovery.cjs');
const {LibraryDatabase}=require('../src/core/database.cjs');
test('legacy Downloads auto-scanning setting is ignored',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-test-nodl-'));
 try{
  const game=path.join(dir,'Downloads','Game');fs.mkdirSync(game,{recursive:true});
  fs.writeFileSync(path.join(game,'Game.exe'),'fixture');
  const result=await discoverAll({scanDownloads:true,libraryFolders:[]},{downloadsPath:path.dirname(game)});
  assert.ok(!result.games.some(g=>g.executable===path.join(game,'Game.exe')));
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('old Downloads setting is false without deleting saved games',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-db-'));
 const db=new LibraryDatabase(path.join(dir,'db.sqlite'));
 try{
  db.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('scanDownloads','true');
  assert.equal(db.getSettings().scanDownloads,false);
  db.saveSettings({theme:'dark'});assert.equal(db.getSettings().scanDownloads,false);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}
});

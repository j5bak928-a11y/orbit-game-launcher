'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LibraryDatabase}=require('../src/core/database.cjs');
test('crash recovery credits only durable playtime, once',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-session-'));
 const filename=path.join(dir,'library.sqlite');
 try{
  let db=new LibraryDatabase(filename),game=db.upsert({name:'Recovery Fixture',source:'manual',executable:process.execPath}).game;
  const id=db.startSession(game.id);
  db.checkpointSessions([{id,seconds:121}]);db.close();
  db=new LibraryDatabase(filename);
  assert.equal(db.recoverInterruptedSessions(),1);
  assert.equal(db.get(game.id).total_play_seconds,121);
  assert.equal(db.recoverInterruptedSessions(),0);
  db.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('uncheckpointed session is not inflated after crash',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-session-'));
 try{
  const file=path.join(dir,'library.sqlite'),db=new LibraryDatabase(file);
  const game=db.upsert({name:'Uncheckpointed Fixture',source:'manual',executable:process.execPath}).game;
  db.startSession(game.id);db.close();
  const reopened=new LibraryDatabase(file);
  assert.equal(reopened.recoverInterruptedSessions(),1);
  assert.equal(reopened.get(game.id).total_play_seconds,0);
  reopened.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('two SQLite clients cannot register overlapping game sessions or credit a finish twice',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-session-'));
 try{
  const file=path.join(dir,'library.sqlite');
  const first=new LibraryDatabase(file),second=new LibraryDatabase(file);
  try{
   const game=first.upsert({name:'Shared background monitor',source:'steam',executable:'C:\\Games\\Shared\\Game.exe'}).game;
   const session=first.startSession(game.id);
   assert.throws(()=>second.startSession(game.id),/unfinished playtime session/);
   first.checkpointSessions([{id:session,seconds:61}]);
   assert.equal(second.finishSession(session,62),true);
   assert.equal(first.finishSession(session,999),false);
   const next=second.startSession(game.id);
   assert.equal(first.finishSession(next,38),true);
   assert.equal(second.get(game.id).total_play_seconds,100);
   assert.equal(second.recoverInterruptedSessions(),0);
  }finally{second.close();first.close();}
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

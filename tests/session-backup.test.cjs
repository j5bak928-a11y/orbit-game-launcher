'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createRequire} = require('node:module');
const {gzipSync} = require('node:zlib');
const {LibraryDatabase} = require('../src/core/database.cjs');
const {createPortableBackup,decodePortableBackup,validateSessionHistory} = require('../src/core/backup.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'orbit-session-backup-'));
  const opened = [];
  t.after(() => {
    for (const db of opened) db.close();
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {
    root,
    open(name) {
      const db = new LibraryDatabase(path.join(root,`${name}.sqlite`));
      opened.push(db);
      return db;
    }
  };
}
function history(db) {
  return db.db.prepare('SELECT id,game_id,started_at,finished_at,seconds FROM sessions ORDER BY id').all();
}
function createHistory(db) {
  const first = db.upsert({name:'Steam fixture',source:'steam',source_id:'98765'}).game;
  const second = db.upsert({name:'GOG fixture',source:'gog',source_id:'42'}).game;
  for (const [gameId,seconds] of [[first.id,53],[first.id,67],[second.id,34]]) {
    const session = db.startSession(gameId);
    assert.equal(db.finishSession(session,seconds),true);
  }
  db.saveSettings({theme:'light'});
  return {first,second};
}

test('JSON and portable backups preserve full sessions with stable IDs and deduped game mapping',async t=>{
  const f = fixture(t);
  const source = f.open('source');
  const {first,second} = createHistory(source);
  const exported = source.exportBackup();
  assert.equal(exported.format,'orbit.library.v1');
  assert.equal(exported.sessions.length,3);
  assert.equal(exported.sessions.every(row=>row.finished_at!==null),true);
  assert.deepEqual(exported.sessions,history(source));

  const archive = await createPortableBackup(exported,f.root);
  const portable = decodePortableBackup(archive.bytes).library;
  const json = JSON.parse(JSON.stringify(exported));
  assert.deepEqual(portable,json);

  const destination = f.open('portable-destination');
  const existing = destination.upsert({name:'Existing Steam title',source:'steam',source_id:'98765'}).game;
  assert.equal(destination.finishSession(destination.startSession(existing.id),400),true);
  const firstResult = destination.restoreBackupGames(portable);
  assert.deepEqual(firstResult,{imported:1,skipped:1,errors:[],sessionsImported:3,sessionsSkipped:0});
  const steam = destination.get(existing.id);
  const gog = destination.list().find(game=>game.source==='gog');
  assert.equal(steam.total_play_seconds,400,'deduplicated games retain their existing aggregate');
  assert.equal(gog.total_play_seconds,34,'new games restore their source aggregate once');
  assert.equal(gog.id,second.id,'new games retain their original stable backup ID');
  for (const row of portable.sessions) {
    const restored = history(destination).find(item=>item.id===row.id);
    assert.ok(restored);
    assert.equal(restored.game_id,row.game_id===first.id?steam.id:gog.id);
    assert.deepEqual(
      {id:restored.id,started_at:restored.started_at,finished_at:restored.finished_at,seconds:restored.seconds},
      {id:row.id,started_at:row.started_at,finished_at:row.finished_at,seconds:row.seconds}
    );
  }
  const beforeRepeat = history(destination);
  assert.deepEqual(destination.restoreBackupGames(portable),
    {imported:0,skipped:2,errors:[],sessionsImported:0,sessionsSkipped:3});
  assert.deepEqual(history(destination),beforeRepeat);
  assert.equal(destination.get(steam.id).total_play_seconds,400);
  assert.equal(destination.get(gog.id).total_play_seconds,34);

  const jsonDestination = f.open('json-destination');
  assert.deepEqual(jsonDestination.restoreBackupGames(json),
    {imported:2,skipped:0,errors:[],sessionsImported:3,sessionsSkipped:0});
  assert.equal(jsonDestination.list().reduce((sum,game)=>sum+game.total_play_seconds,0),154);
  assert.equal(history(jsonDestination).length,3);
  assert.deepEqual(jsonDestination.restoreBackupGames(json),
    {imported:0,skipped:2,errors:[],sessionsImported:0,sessionsSkipped:3});
  assert.equal(jsonDestination.list().reduce((sum,game)=>sum+game.total_play_seconds,0),154);
});

test('backup refuses unfinished sessions, then includes recovered history after finalization',t=>{
  const f=fixture(t),db=f.open('source');
  const game=db.upsert({name:'Active fixture'}).game;
  const active=db.startSession(game.id);
  assert.throws(()=>db.exportBackup(),/unfinished playtime session/i);
  assert.equal(db.checkpointSessions([{id:active,seconds:8}]),1);
  assert.equal(db.recoverInterruptedSessions(),1);
  const exported=db.exportBackup();
  assert.equal(exported.sessions.length,1);
  assert.equal(exported.sessions[0].id,active);
  assert.equal(exported.sessions[0].seconds,8);
});

test('corrupt and oversized session histories reject before database or portable artwork mutations',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('target');
  createHistory(source);
  const correct=source.exportBackup();
  const example=correct.sessions[0];
  const invalidHistories=[
    [{...example,finished_at:null}],
    [{...example,seconds:'53'}],
    [{...example,seconds:7*86400+1}],
    [{...example,game_id:'unknown-game'}],
    [{...example,started_at:'2025-02-30T00:00:00Z'}],
    [{...example,started_at:'2099-01-01T00:00:00Z'}],
    [{...example,id:7}],
    [{...example,heartbeat_seconds:5}],
    [example,{...example}],
    Array.from({length:100001},()=>example)
  ];
  for(const sessions of invalidHistories){
    const damaged={...correct,sessions};
    assert.throws(()=>validateSessionHistory(damaged),/session|history/i);
    assert.throws(()=>destination.restoreBackupGames(damaged),/session|history/i);
    await assert.rejects(createPortableBackup(damaged,f.root),/session|history/i);
    const bytes=gzipSync(Buffer.from(JSON.stringify({format:'orbit.portable.v1',library:damaged,artwork:{}})));
    assert.throws(()=>decodePortableBackup(bytes),/session|history/i);
    assert.equal(destination.count(),0);
    assert.equal(history(destination).length,0);
  }
  assert.equal(destination.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('conflicting existing session ID causes full transactional rollback',t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const backup=source.exportBackup();
  const conflicting=backup.sessions[0];
  const existing=destination.upsert({name:'Existing fixture'}).game;
  destination.db.prepare('INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES (?,?,?,?,?)')
    .run(conflicting.id,existing.id,conflicting.started_at,conflicting.finished_at,999);
  const before=history(destination);
  assert.throws(()=>destination.restoreBackupGames(backup),/Conflicting existing backup session/i);
  assert.equal(destination.count(),1,'games inserted before a conflict must roll back');
  assert.deepEqual(history(destination),before,'existing session must remain unchanged');
});

test('existing unrelated game ID collision rejects the whole restore',t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const backup=source.exportBackup();
  const collidingId=backup.games[0].id;
  destination.db.prepare('INSERT INTO games(id,name,source,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(collidingId,'Unrelated product','manual',new Date().toISOString(),new Date().toISOString());
  assert.throws(()=>destination.restoreBackupGames(backup),/game ID.*conflicts/i);
  assert.equal(destination.count(),1);
  assert.equal(history(destination).length,0);
});

function ipcFixture(root,database) {
  const handlers=new Map();
  const selection={file:''};
  const entry=path.join(__dirname,'../src/main.cjs'),realRequire=createRequire(entry);
  const electron={
    app:{requestSingleInstanceLock:()=>true,getPath:()=>root,getVersion:()=> '0.2.7',
      whenReady:()=>new Promise(()=>{}),on(){}},
    protocol:{registerSchemesAsPrivileged(){}},
    dialog:{
      showSaveDialog:async()=>({canceled:false,filePath:selection.file}),
      showOpenDialog:async()=>({canceled:false,filePaths:[selection.file]})
    },
    nativeTheme:{themeSource:'dark'},
    ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}
  };
  const window=Object.assign(new EventEmitter(),{
    isDestroyed:()=>false,
    webContents:{send(){}}
  });
  const context=vm.createContext({
    require:name=>name==='electron'?electron:realRequire(name),
    __dirname:path.dirname(entry),process,Buffer,setImmediate,
    fixtureDb:database,fixtureWin:window
  });
  vm.runInContext(fs.readFileSync(entry,'utf8'),context,{filename:entry});
  vm.runInContext('db=fixtureDb;win=fixtureWin;handlers();',context);
  return {selection,invoke:(name)=>handlers.get(`orbit:${name}`)(null)};
}

test('Electron exportLibrary/restoreLibrary IPC roundtrip preserves sessions in .json and .orbit',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const exportIpc=ipcFixture(f.root,source);
  const restoreIpc=ipcFixture(f.root,destination);
  const jsonPath=path.join(f.root,'backup.json'),orbitPath=path.join(f.root,'backup.orbit');
  exportIpc.selection.file=jsonPath;
  assert.equal((await exportIpc.invoke('exportLibrary')).portable,false);
  const json=JSON.parse(fs.readFileSync(jsonPath,'utf8'));
  assert.equal(json.sessions.length,3);
  restoreIpc.selection.file=jsonPath;
  assert.deepEqual(
    JSON.parse(JSON.stringify(await restoreIpc.invoke('restoreLibrary'))),
    {imported:2,skipped:0,errors:[],settingsRestored:true,sessionsImported:3,sessionsSkipped:0}
  );
  exportIpc.selection.file=orbitPath;
  assert.equal((await exportIpc.invoke('exportLibrary')).portable,true);
  assert.deepEqual(decodePortableBackup(fs.readFileSync(orbitPath)).library.sessions,json.sessions);
  restoreIpc.selection.file=orbitPath;
  const again=await restoreIpc.invoke('restoreLibrary');
  assert.equal(again.imported,0);
  assert.equal(again.sessionsImported,0);
  assert.equal(again.sessionsSkipped,3);
  assert.equal(history(destination).length,3);
  assert.equal(destination.list().reduce((total,game)=>total+game.total_play_seconds,0),154);
});

test('legacy v1 JSON and portable backups without sessions still restore games',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const legacy=source.exportBackup();
  delete legacy.sessions;
  const portable=await createPortableBackup(legacy,f.root);
  assert.deepEqual(decodePortableBackup(portable.bytes).library,legacy);
  const file=path.join(f.root,'legacy.json');
  fs.writeFileSync(file,JSON.stringify(legacy));
  const ipc=ipcFixture(f.root,destination);
  ipc.selection.file=file;
  const first=await ipc.invoke('restoreLibrary');
  assert.equal(first.imported,2);
  assert.equal(first.sessionsImported,0);
  assert.equal(destination.count(),2);
  assert.equal(history(destination).length,0);
  assert.equal(destination.list().reduce((sum,game)=>sum+game.total_play_seconds,0),154);
});

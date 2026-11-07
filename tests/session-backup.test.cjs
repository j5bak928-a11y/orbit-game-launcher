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
const {createPortableBackup,decodePortableBackup,validateSessionHistory,installBackupArtwork} = require('../src/core/backup.cjs');
const crypto=require('node:crypto');
const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(28,27)]);
function addArtwork(root,library,index=0,bytes=png) {
  const filename=`${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(root,filename),bytes);
  library.games[index].cover=filename;
  return filename;
}
function installedName(bytes) {
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}.png`;
}

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
    [{...example,id:'\uD800'}],
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
      showOpenDialog:async()=>{if(selection.delay)await selection.delay;return {canceled:false,filePaths:[selection.file]};}
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
  return {selection,invoke:(name,...args)=>handlers.get(`orbit:${name}`)(null,...args)};
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

test('failed portable session-ID collision does not leave newly installed artwork',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const backup=source.exportBackup();
  addArtwork(f.root,backup);
  const conflicting=backup.sessions[0],existing=destination.upsert({name:'Unrelated existing game'}).game;
  destination.db.prepare('INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES (?,?,?,?,?)')
    .run(conflicting.id,existing.id,conflicting.started_at,conflicting.finished_at,999);
  const file=path.join(f.root,'conflict.orbit');
  fs.writeFileSync(file,(await createPortableBackup(backup,f.root)).bytes);
  const ipc=ipcFixture(f.root,destination);
  ipc.selection.file=file;
  const before=history(destination);
  await assert.rejects(ipc.invoke('restoreLibrary'),/Conflicting existing backup session/i);
  assert.equal(destination.count(),1);
  assert.deepEqual(history(destination),before);
  const artworkDir=path.join(f.root,'artwork');
  assert.deepEqual(fs.existsSync(artworkDir)?fs.readdirSync(artworkDir):[],[],'failed restore must not leave orphan artwork');
});

test('failed session restore preserves existing artwork but discards other new files',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const backup=source.exportBackup();
  const existingName=addArtwork(f.root,backup,0,png);
  const newBytes=Buffer.concat([png,Buffer.from([37])]);
  const newName=`${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(f.root,newName),newBytes);
  backup.games[0].banner=newName;
  const artDir=path.join(f.root,'artwork');
  const preexisting=(await installBackupArtwork(new Map([[existingName,png]]),artDir)).get(existingName);
  const colliding=backup.sessions[0],game=destination.upsert({name:'Existing game'}).game;
  destination.db.prepare('INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES (?,?,?,?,?)')
    .run(colliding.id,game.id,colliding.started_at,colliding.finished_at,777);
  const file=path.join(f.root,'with-preexisting-art.orbit');
  fs.writeFileSync(file,(await createPortableBackup(backup,f.root)).bytes);
  const ipc=ipcFixture(f.root,destination);ipc.selection.file=file;
  await assert.rejects(ipc.invoke('restoreLibrary'),/Conflicting existing backup session/i);
  assert.deepEqual(fs.readdirSync(artDir),[preexisting]);
  assert.deepEqual(fs.readFileSync(path.join(artDir,preexisting)),png);
  assert.equal(fs.existsSync(path.join(artDir,installedName(newBytes))),false);
});

test('legacy portable per-game skips discard only orphan artwork while retaining imported art',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const backup=source.exportBackup();
  delete backup.sessions;
  backup.games.sort((a,b)=>a.source==='steam'?-1:b.source==='steam'?1:0);
  const kept=Buffer.concat([png,Buffer.from([1])]);
  const skipped=Buffer.concat([png,Buffer.from([2])]);
  const invalid=Buffer.concat([png,Buffer.from([3])]);
  addArtwork(f.root,backup,0,kept);
  addArtwork(f.root,backup,1,skipped);
  backup.games.push({name:'Invalid source',source:'unsupported',cover:''});
  addArtwork(f.root,backup,2,invalid);
  destination.upsert({name:'Already tracked GOG',source:'gog',source_id:'42'});
  const artDir=path.join(f.root,'artwork');
  const unrelated=Buffer.concat([png,Buffer.from([99])]);
  const unrelatedSource=`${crypto.randomUUID()}.png`;
  const preexisting=(await installBackupArtwork(new Map([[unrelatedSource,unrelated]]),artDir)).get(unrelatedSource);
  const file=path.join(f.root,'legacy-partial.orbit');
  fs.writeFileSync(file,(await createPortableBackup(backup,f.root)).bytes);
  const ipc=ipcFixture(f.root,destination);ipc.selection.file=file;
  const result=await ipc.invoke('restoreLibrary');
  assert.equal(result.imported,1);
  assert.equal(result.skipped,1);
  assert.equal(result.errors.length,1);
  assert.match(result.errors[0],/Unsupported game source/i);
  assert.equal(destination.count(),2);
  assert.equal(destination.list().find(game=>game.source==='steam').cover,installedName(kept));
  assert.deepEqual(fs.readdirSync(artDir).sort(),[installedName(kept),preexisting].sort());
  assert.deepEqual(fs.readFileSync(path.join(artDir,preexisting)),unrelated);
});

test('portable artwork extraction error cleans prior writes without removing a conflicting directory',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const backup=source.exportBackup();
  const first=Buffer.concat([png,Buffer.from([23])]);
  const second=Buffer.concat([png,Buffer.from([24])]);
  addArtwork(f.root,backup,0,first);
  addArtwork(f.root,backup,1,second);
  const artDir=path.join(f.root,'artwork');
  fs.mkdirSync(artDir);
  fs.mkdirSync(path.join(artDir,installedName(second)));
  const file=path.join(f.root,'broken-target.orbit');
  fs.writeFileSync(file,(await createPortableBackup(backup,f.root)).bytes);
  const ipc=ipcFixture(f.root,destination);ipc.selection.file=file;
  const originalLink=fs.promises.link;
  let attempts=0;
  fs.promises.link=async (...args)=>{
    if(++attempts===2)throw Object.assign(new Error('Synthetic link permission error'),{code:'EACCES'});
    return originalLink(...args);
  };
  try{await assert.rejects(ipc.invoke('restoreLibrary'),/Synthetic link permission error/i);}
  finally{fs.promises.link=originalLink;}
  assert.deepEqual(fs.readdirSync(artDir),[installedName(second)]);
  assert.equal(fs.statSync(path.join(artDir,installedName(second))).isDirectory(),true);
  assert.equal(destination.count(),0);
});

test('partial ENOSPC during artwork staging cannot expose truncated final artwork or temp files',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const backup=source.exportBackup();
  const bytes=Buffer.concat([png,Buffer.from([126])]);
  addArtwork(f.root,backup,0,bytes);
  const file=path.join(f.root,'disk-full.orbit');
  fs.writeFileSync(file,(await createPortableBackup(backup,f.root)).bytes);
  const ipc=ipcFixture(f.root,destination);ipc.selection.file=file;
  const originalOpen=fs.promises.open;
  let simulated=false;
  fs.promises.open=async (...args)=>{
    const handle=await originalOpen(...args);
    if(!simulated && path.basename(String(args[0])).startsWith('.orbit-art-import-')){
      simulated=true;
      const originalWrite=handle.writeFile.bind(handle);
      handle.writeFile=async content=>{
        await originalWrite(content.subarray(0,8));
        throw Object.assign(new Error('Synthetic disk full during artwork write'),{code:'ENOSPC'});
      };
    }
    return handle;
  };
  try{await assert.rejects(ipc.invoke('restoreLibrary'),/Synthetic disk full/i);}
  finally{fs.promises.open=originalOpen;}
  assert.equal(simulated,true,'must inject failure after staging file creation');
  assert.equal(destination.count(),0);
  const artDir=path.join(f.root,'artwork');
  assert.deepEqual(fs.existsSync(artDir)?fs.readdirSync(artDir):[],[],'no incomplete final or temporary artwork should remain');
});

test('Electron IPC accepts bounded Unicode backup game IDs and rejects invalid IDs safely',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const backup=source.exportBackup();
  const old=backup.games[0].id,newId='Game_日本語_été_42';
  backup.games[0].id=newId;
  for(const row of backup.sessions)if(row.game_id===old)row.game_id=newId;
  const file=path.join(f.root,'unicode.json');
  fs.writeFileSync(file,JSON.stringify(backup));
  const ipc=ipcFixture(f.root,destination);
  ipc.selection.file=file;
  assert.equal((await ipc.invoke('restoreLibrary')).sessionsImported,3);
  assert.equal((await ipc.invoke('getGame',newId)).id,newId);
  assert.equal((await ipc.invoke('favoriteGame',newId)).favorite,true);
  assert.equal((await ipc.invoke('updateGame',newId,{name:'Renamed via IPC'})).name,'Renamed via IPC');
  assert.equal(await ipc.invoke('getGame','界'.repeat(42)),null,'126-byte Unicode ID is valid input');
  for(const invalid of ['',null,undefined,{},' leading', 'trailing ', '\u0000unsafe', 'bad\nname', '\uD800', '界'.repeat(43)]){
    await assert.rejects(Promise.resolve().then(()=>ipc.invoke('getGame',invalid)),/Invalid game identifier/i);
    await assert.rejects(Promise.resolve().then(()=>ipc.invoke('favoriteGame',invalid)),/Invalid game identifier/i);
  }
  const injection="' OR 1=1 --";
  assert.equal(await ipc.invoke('getGame',injection),null,'SQL remains bound as data');
  assert.equal(destination.count(),2);
  assert.equal((await ipc.invoke('removeGame',newId)),true);
  assert.equal(await ipc.invoke('getGame',newId),null);
  assert.equal(destination.count(),1);
});

test('concurrent portable restore IPC calls are serialized without losing committed history',async t=>{
  const f=fixture(t),source=f.open('source'),destination=f.open('destination');
  createHistory(source);
  const library=source.exportBackup();
  addArtwork(f.root,library);
  const file=path.join(f.root,'concurrent.orbit');
  fs.writeFileSync(file,(await createPortableBackup(library,f.root)).bytes);
  const ipc=ipcFixture(f.root,destination);ipc.selection.file=file;
  let release;
  ipc.selection.delay=new Promise(resolve=>{release=resolve;});
  const first=ipc.invoke('restoreLibrary');
  await assert.rejects(ipc.invoke('restoreLibrary'),/restore is already in progress/i);
  release();
  assert.equal((await first).sessionsImported,3);
  ipc.selection.delay=null;
  assert.equal((await ipc.invoke('restoreLibrary')).sessionsSkipped,3,
    'a later independent restore should remain idempotent');
  assert.equal(history(destination).length,3);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { LibraryDatabase } = require('../src/core/database.cjs');

// Exercise the real IPC handlers and SQLite storage without native startup,
// process enumeration, user data, artwork downloads or actual game launches.
function fixture(t) {
  const temporary = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'orbit-library-ipc-'));
  const database = new LibraryDatabase(path.join(root, 'library.sqlite'));
  t.after(() => {
    database.close();
    assert.equal(path.dirname(root), temporary);
    fs.rmSync(root, {recursive:true, force:true});
  });
  database.saveSettings({useSteamArtwork:false});
  let listReads = 0;
  const list = database.list.bind(database);
  database.list = (...args) => { listReads++; return list(...args); };
  const handlers = new Map(), events = [];
  const main = path.join(__dirname, '../src/main.cjs'), realRequire = createRequire(main);
  const electron = {
    app:{
      requestSingleInstanceLock:()=>true, getPath:()=>root, getVersion:()=> 'fixture',
      whenReady:()=>new Promise(()=>{}), on() {},
    },
    protocol:{registerSchemesAsPrivileged() {}},
    ipcMain:{handle:(name, handler)=>handlers.set(name, handler)},
  };
  const context = vm.createContext({
    require:name=>name==='electron' ? electron : realRequire(name),
    __dirname:path.dirname(main), process, Buffer, setImmediate,
    fixtureDb:database,
    fixtureWin:{isDestroyed:()=>false, webContents:{send:(channel, event)=>{
      assert.equal(channel, 'orbit:event');
      events.push(structuredClone(event));
    }}},
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, {filename:main});
  vm.runInContext('db=fixtureDb; win=fixtureWin; handlers();', context);
  return {
    database, context, events, listReads:()=>listReads,
    invoke:(name,...args)=>handlers.get('orbit:'+name)(null,...args),
  };
}
const manual = name => ({name,source:'manual',launch_uri:'steam://rungameid/'+name.length});

test('single-game IPC mutations publish records and removals without reading the collection', async t => {
  const f=fixture(t);
  const added=await f.invoke('addGame',manual('Fixture game'));
  const id=added.game.id;
  await f.invoke('favoriteGame',id);
  await f.invoke('updateGame',id,{name:'Renamed game',tags:['Reviewed']});
  assert.equal(await f.invoke('removeGame',id),true);
  assert.equal(f.listReads(),0);
  assert.deepEqual(f.events.map(e=>e.revision),[1,2,3,4]);
  assert.deepEqual(f.events.map(e=>e.reason),['add','favorite','edit','remove']);
  assert(f.events.slice(0,3).every(e=>e.games.length===1 && e.games[0].id===id));
  assert.equal(f.events[1].games[0].favorite,true);
  assert.equal(f.events[2].games[0].name,'Renamed game');
  assert.deepEqual(f.events[2].games[0].tags,['Reviewed']);
  assert.deepEqual(f.events[3].games,[]);
  assert.deepEqual(f.events[3].removedIds,[id]);
  assert(f.events.every(e=>Array.isArray(e.runningIds)));
  assert.equal(await f.invoke('removeGame',id),false);
  assert.equal(f.events.length,4);
  const snapshot=await f.invoke('librarySnapshot');
  assert.equal(f.listReads(),1);
  assert.equal(snapshot.revision,4);
  assert.equal(snapshot.games.length,0);
});

test('snapshot and change packets share the complete deduplicated running state', async t => {
  const f=fixture(t);
  const {game}=f.database.upsert(manual('Running fixture'));
  f.context.fixtureId=game.id;
  vm.runInContext('sessions.set(fixtureId,"session"); activityTracker={runningIds:()=>[fixtureId,"store-only"]};',f.context);
  await f.invoke('favoriteGame',game.id);
  const snapshot=await f.invoke('librarySnapshot');
  assert.deepEqual(structuredClone(snapshot.runningIds),[game.id,'store-only']);
  assert.deepEqual(f.events[0].runningIds,structuredClone(snapshot.runningIds));
  assert.equal(snapshot.revision,f.events[0].revision);
  assert.equal(snapshot.games[0].favorite,true);
});

test('bulk import publishes one versioned invalidation for a shared snapshot', async t => {
  const f=fixture(t);
  const imported=await f.invoke('importGames',[manual('Bulk import fixture')]);
  assert.equal(imported.imported,1);
  assert.equal(f.listReads(),0);
  assert.equal(f.events.length,1);
  assert.equal(f.events[0].reason,'import');
  assert.equal(f.events[0].revision,1);
  assert.equal(Object.hasOwn(f.events[0],'games'),false);
  const snapshot=await f.invoke('librarySnapshot');
  assert.equal(snapshot.revision,1);
  assert.equal(snapshot.games.length,1);
});

test('additional detected storefronts import as real library games',async t=>{
 const f=fixture(t);
 const games=['ea','ubisoft','battlenet'].map((source,i)=>({name:`Detected ${source}`,source,source_id:String(800+i),executable:path.join(os.tmpdir(),`game-${source}.exe`),install_path:os.tmpdir()}));
 const result=await f.invoke('importGames',games);
 assert.equal(result.imported,3);assert.equal(result.errors.length,0);
 const snapshot=await f.invoke('librarySnapshot');
 assert.deepEqual(snapshot.games.map(game=>game.source).sort(),['battlenet','ea','ubisoft']);
});

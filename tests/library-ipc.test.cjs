'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter}=require('node:events');
const { createRequire } = require('node:module');
const { LibraryDatabase } = require('../src/core/database.cjs');

// Exercise the real IPC handlers and SQLite storage without native startup,
// process enumeration, user data, artwork downloads or actual game launches.
function fixture(t, {discoverAll, platform, getFileIcon} = {}) {
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
    BrowserWindow:class extends EventEmitter {
      constructor(){super();this.webContents=new EventEmitter();this.webContents.send=(_channel,event)=>events.push(structuredClone(event));this.webContents.setWindowOpenHandler=()=>{};}
      isDestroyed(){return false;}
      loadFile(){}
      show(){}
    },
    app:{
      requestSingleInstanceLock:()=>true, getPath:()=>root, getVersion:()=> 'fixture', getFileIcon,
      whenReady:()=>new Promise(()=>{}), on() {},
    },
    protocol:{registerSchemesAsPrivileged() {}},
    ipcMain:{handle:(name, handler)=>handlers.set(name, handler)},
  };
  const runtime = platform ? Object.create(process) : process;
  if (platform) Object.defineProperty(runtime, 'platform', {value:platform});
  const context = vm.createContext({
    require:name=>name==='electron' ? electron : name==='./core/discovery.cjs' && discoverAll
      ? {...realRequire(name), discoverAll} : realRequire(name),
    __dirname:path.dirname(main), process:runtime, Buffer, setImmediate,
    fixtureDb:database,
    fixtureWin:Object.assign(new EventEmitter(),{fullscreen:false,isFullScreen(){return this.fullscreen;},setFullScreen(value){this.fullscreen=value;this.emit(value?'enter-full-screen':'leave-full-screen');},isDestroyed:()=>false, webContents:{send:(channel, event)=>{
      assert.equal(channel, 'orbit:event');
      events.push(structuredClone(event));
    }}}),
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, {filename:main});
  vm.runInContext('db=fixtureDb; win=fixtureWin; handlers();', context);
  return {
    root, database, context, events, listReads:()=>listReads,
    invoke:(name,...args)=>handlers.get('orbit:'+name)(null,...args),
  };
}
const manual = name => ({name,source:'manual',launch_uri:'steam://rungameid/'+name.length});

test('fullscreen IPC accepts booleans, reports state and rejects malformed requests',async t=>{
 const f=fixture(t);
 assert.deepEqual(structuredClone(await f.invoke('getWindowState')),{fullscreen:false});
 await f.invoke('setFullscreen',true);
 assert.deepEqual(structuredClone(await f.invoke('getWindowState')),{fullscreen:true});
 for(const invalid of ['true',1,null,{},undefined])await assert.rejects(f.invoke('setFullscreen',invalid),/boolean/i);
 assert.equal((await f.invoke('getWindowState')).fullscreen,true);
 await f.invoke('setFullscreen',false);
 assert.equal((await f.invoke('getWindowState')).fullscreen,false);
 assert.equal(f.listReads(),0);
});

test('fullscreen IPC fails cleanly if the window has closed',async t=>{
 const f=fixture(t);vm.runInContext('win.isDestroyed=()=>true;',f.context);
 await assert.rejects(f.invoke('setFullscreen',true),/window/i);
 await assert.rejects(f.invoke('getWindowState'),/window/i);
});

test('native F11 overrides the menu accelerator once and ignores held repeats and modifiers',t=>{
 const f=fixture(t);vm.runInContext('createWindow();',f.context);
 const prevented=vm.runInContext(`(()=>{let prevented=0;const event={preventDefault(){prevented++;}};
 win.webContents.emit('before-input-event',event,{type:'keyDown',key:'F11',isAutoRepeat:false});
 win.webContents.emit('before-input-event',event,{type:'keyDown',key:'F11',isAutoRepeat:true});
 win.webContents.emit('before-input-event',event,{type:'keyDown',key:'F11',control:true});
 win.webContents.emit('before-input-event',event,{type:'keyUp',key:'F11'});
 return prevented;})()`,f.context);
 assert.equal(prevented,2);assert.deepEqual(f.events.map(event=>event.type),['toggleControllerMode']);
});

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

test('scan keeps distinct executables on a case-sensitive filesystem', {skip:process.platform==='win32'}, async t=>{
 const discovery=require('../src/core/discovery.cjs');
 const f=fixture(t,{discoverAll:settings=>discovery.discoverAll(settings,{providers:[]})});
 const library=path.join(f.root,'games'),upper=path.join(library,'SpaceGame','Game.exe'),lower=path.join(library,'spacegame','game.exe');
 fs.mkdirSync(path.dirname(upper),{recursive:true});fs.mkdirSync(path.dirname(lower),{recursive:true});
 fs.writeFileSync(upper,'fixture');fs.writeFileSync(lower,'fixture');fs.chmodSync(upper,0o755);fs.chmodSync(lower,0o755);
 if(fs.statSync(upper).ino===fs.statSync(lower).ino){t.skip('The filesystem is case-insensitive');return;}
 f.database.saveSettings({libraryFolders:[library]});
 f.database.upsert({name:'Existing',source:'manual',executable:upper});
 const result=await f.invoke('discoverGames');
 assert.equal(result.games.length,2);
 assert.equal(result.games.find(game=>game.executable===upper).alreadyAdded,true);
 const different=result.games.find(game=>game.executable===lower);
 assert.equal(different.alreadyAdded,false,'A distinct executable must remain selectable for import');
 const imported=await f.invoke('importGames',[different]);
 assert.equal(imported.imported,1);
});

test('scan identifies case-insensitive storefront IDs already in the library',async t=>{
 const candidate={name:'Epic game',source:'epic',source_id:'game-abc',launch_uri:'com.epicgames.launcher://apps/game-abc?action=launch'};
 const f=fixture(t,{discoverAll:async()=>({games:[candidate],warnings:[],diagnostics:[]})});
 f.database.upsert({name:'Existing Epic game',source:'epic',source_id:'Game-AbC',launch_uri:'heroic://launch?appName=Game-AbC'});
 const result=await f.invoke('discoverGames');
 assert.equal(result.games[0].alreadyAdded,true,'The scan should agree with the database duplicate key');
});

test('scan compares executable paths case-insensitively on Windows',async t=>{
 const candidates=[];
 const f=fixture(t,{platform:'win32',discoverAll:async()=>({games:candidates,warnings:[],diagnostics:[]})});
 const file=path.join(f.root,'Example','Game.exe');
 f.database.upsert({name:'Existing game',source:'manual',executable:file});
 candidates.push({name:'Same game',source:'folder',executable:file.toLowerCase()});
 const result=await f.invoke('discoverGames');
 assert.equal(result.games[0].alreadyAdded,true);
});

test('a slow cover lookup does not prevent later imported games from showing local icons',async t=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
 const f=fixture(t,{getFileIcon:async()=>({isEmpty:()=>false,toPNG:()=>png})});
 let release;const blocked=new Promise(resolve=>{release=resolve;});
 f.context.downloadSteamCover=async()=>{await blocked;return '';};
 const games=Array.from({length:4},(_,index)=>{
  const executable=path.join(f.root,`fixture-${index}.exe`);fs.writeFileSync(executable,'fixture');
  return {name:`Fixture ${index}`,source:'steam',source_id:String(201+index),install_path:f.root,executable};
 });
 const imported=await f.invoke('importGames',games);assert.equal(imported.imported,4);
 const waitFor=async(predicate,timeout=2000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,10));}return false;};
 let fourthReady;
 try{fourthReady=await waitFor(()=>!!f.database.list().find(game=>game.source_id==='204')?.icon);}
 finally{release();await waitFor(()=>f.database.list().filter(game=>game.icon).length===4);await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(fourthReady,true,'A blocked cover request must not delay another game\'s local icon');
});

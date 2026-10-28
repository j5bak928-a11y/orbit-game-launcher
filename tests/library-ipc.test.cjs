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
function fixture(t, {discoverAll, platform, getFileIcon, findSteamCover, findSteamBanner, findExactSteamApp, setImmediateFn} = {}) {
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
    shell:{openExternal:async()=>{}},
    ipcMain:{handle:(name, handler)=>handlers.set(name, handler)},
  };
  const runtime = platform ? Object.create(process) : process;
  if (platform) Object.defineProperty(runtime, 'platform', {value:platform});
  const context = vm.createContext({
    require:name=>{
      if(name==='electron')return electron;
      if(name==='./core/discovery.cjs'&&discoverAll)return {...realRequire(name),discoverAll};
      if(name==='./core/steam-cover.cjs'&&(findSteamCover||findSteamBanner))return {
        ...realRequire(name),...(findSteamCover?{findSteamCover}:{}),...(findSteamBanner?{findSteamBanner}:{}),
      };
      if(name==='./core/steam-search.cjs'&&findExactSteamApp)return {...realRequire(name),findExactSteamApp};
      return realRequire(name);
    },
    __dirname:path.dirname(main), process:runtime, Buffer, setImmediate:setImmediateFn||setImmediate,
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
const portrait=Buffer.from([255,216,255,192,0,11,8,3,132,2,88,1,1,17,0,255,217]);
const landscape=Buffer.from([255,216,255,192,0,11,8,1,97,2,104,1,1,17,0,255,217]);
const waitUntil=async(predicate,timeout=4000)=>{
 const end=Date.now()+timeout;
 while(Date.now()<end){if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,10));}
 return false;
};

test('linked launch checks for a game process after releasing the pending launch',async t=>{
 const f=fixture(t,{platform:'win32'});
 const game=f.database.upsert({name:'Linked game',source:'steam',source_id:'123',install_path:'C:\\Games\\Game',launch_uri:'steam://rungameid/123'}).game;
 f.context.fixtureTracker={poll:async()=>{f.context.pendingWhenPolled=vm.runInContext('pendingLaunches.has(fixtureId)',f.context);},isRunning:()=>false,runningIds:()=>[]};
 f.context.fixtureId=game.id;vm.runInContext('activityTracker=fixtureTracker',f.context);
 const result=await f.invoke('launchGame',game.id);
 assert.match(result.message,/detects the game process/);assert.equal(f.context.pendingWhenPolled,false);
});

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
 // Exercise case-sensitive regular-file paths on macOS, where native folder
 // discovery only looks for app bundles.
 const scanPlatform=process.platform==='darwin'?'linux':process.platform;
 const f=fixture(t,{discoverAll:settings=>discovery.discoverAll(settings,{providers:[],platform:scanPlatform})});
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

async function delayedArtworkFixture(t){
 let release,started=0,finished=false;
 const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{findSteamCover:async id=>{
  if(Number(id)<304){started++;await gate;return null;}
  if(id==='304')return portrait;
  if(id==='307')finished=true;
  return null;
 }});
 const games=Array.from({length:7},(_,i)=>({name:`Queued ${i}`,source:'steam',source_id:String(301+i)}));
 const imported=await f.invoke('importGames',games);assert.equal(imported.imported,7);
 assert(await waitUntil(()=>started===3),'The first lookups must reach the controlled delay');
 return {f,release,finished:()=>finished,victim:f.database.list().find(game=>game.source_id==='304')};
}

test('a queued lookup does not restore artwork the user deliberately cleared',async t=>{
 const queued=await delayedArtworkFixture(t),custom='22222222-2222-4222-8222-222222222222.jpg';
 try{
  await queued.f.invoke('updateGame',queued.victim.id,{cover:custom});
  await queued.f.invoke('updateGame',queued.victim.id,{cover:''});
 }finally{queued.release();}
 assert(await waitUntil(queued.finished),'Later artwork jobs must complete');
 assert.equal(queued.f.database.get(queued.victim.id).cover,'');
});

test('deleting a queued game prevents its deferred artwork from being saved',async t=>{
 const queued=await delayedArtworkFixture(t);
 try{assert.equal(await queued.f.invoke('removeGame',queued.victim.id),true);}
 finally{queued.release();}
 assert(await waitUntil(queued.finished),'Later artwork jobs must complete');
 const artDir=path.join(queued.f.root,'artwork');
 assert.deepEqual(fs.existsSync(artDir)?fs.readdirSync(artDir):[],[],'Deleted games must not create orphaned artwork');
});

test('a delayed icon lookup respects an icon the user cleared',async t=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
 let release,started=0;
 const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{getFileIcon:async file=>{
  const index=Number(path.basename(file).match(/\d+/)[0]);
  if(index<3){started++;await gate;}
  return {isEmpty:()=>false,toPNG:()=>png};
 }});
 const games=Array.from({length:7},(_,index)=>{
  const executable=path.join(f.root,`game-${index}.exe`);fs.writeFileSync(executable,'fixture');
  return {name:`Icon ${index}`,source:'folder',executable};
 });
 assert.equal((await f.invoke('importGames',games)).imported,7);
 assert(await waitUntil(()=>started===2),'The first icon lookups must be delayed');
 const game=f.database.list().find(item=>item.name==='Icon 3');
 try{
  await f.invoke('updateGame',game.id,{icon:'55555555-5555-4555-8555-555555555555.png'});
  await f.invoke('updateGame',game.id,{icon:''});
 }finally{release();}
 assert(await waitUntil(()=>!!f.database.list().find(item=>item.name==='Icon 6')?.icon),'Later icon jobs must complete');
 assert.equal(f.database.get(game.id).icon,'');
});

test('an edit made during an earlier import batch is not overwritten by later artwork',async t=>{
 let releaseBatch,held=false,finished=false;
 const immediate=callback=>{if(!held){held=true;releaseBatch=callback;}else setImmediate(callback);};
 const f=fixture(t,{setImmediateFn:immediate,findSteamCover:async id=>{
  if(id==='504')return portrait;
  if(id==='551')finished=true;
  return null;
 }});
 const importing=f.invoke('importGames',Array.from({length:51},(_,i)=>({name:`Batch ${i}`,source:'steam',source_id:String(501+i)})));
 assert(await waitUntil(()=>typeof releaseBatch==='function'),'The first batch should pause before artwork starts');
 const game=f.database.list().find(item=>item.source_id==='504');
 try{
  await f.invoke('updateGame',game.id,{cover:'33333333-3333-4333-8333-333333333333.jpg'});
  await f.invoke('updateGame',game.id,{cover:''});
 }finally{releaseBatch();}
 assert.equal((await importing).imported,51);
 assert(await waitUntil(()=>finished),'The final artwork batch should complete');
 assert.equal(f.database.get(game.id).cover,'');
});

test('clearing a banner while its cover is loading prevents a stale banner lookup',async t=>{
 let release,started=false,pending;
 const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{findSteamCover:async()=>{started=true;await gate;return null;},findSteamBanner:async()=>landscape});
 const enrich=f.context.enrichGameArtwork;
 f.context.enrichGameArtwork=game=>{pending=enrich(game);return pending;};
 const {game}=await f.invoke('addGame',{name:'Edited game',source:'steam',source_id:'901'});
 assert(await waitUntil(()=>started),'The cover lookup should be in flight');
 try{
  await f.invoke('updateGame',game.id,{banner:'44444444-4444-4444-8444-444444444444.jpg'});
  await f.invoke('updateGame',game.id,{banner:''});
 }finally{release();}
 await pending;
 assert.equal(f.database.get(game.id).banner,'');
});

test('macOS game bundles can receive a native icon using a supported size',async t=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
 const f=fixture(t,{platform:'darwin',getFileIcon:async(_file,options)=>{
  if(options.size!=='normal')throw Error('Unsupported macOS icon size');
  return {isEmpty:()=>false,toPNG:()=>png};
 }});
 const bundle=path.join(f.root,'Sample.app');fs.mkdirSync(bundle);
 const game=f.database.upsert({name:'Sample',source:'folder',executable:bundle,install_path:bundle}).game;
 assert.equal(await f.context.cacheGameIcon(game),true);
 assert.match(f.database.get(game.id).icon,/^[a-f0-9-]{36}\.png$/);
});

test('startup repair does not replace artwork cleared while another batch is running',async t=>{
 let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{findSteamCover:async id=>{
  if(Number(id)<604){started++;await gate;return null;}
  return id==='604'?portrait:null;
 }});
 for(let i=0;i<7;i++)f.database.upsert({name:`Repair ${i}`,source:'steam',source_id:String(601+i)});
 const game=f.database.list().find(item=>item.source_id==='604');
 const repairing=f.context.repairMissingSteamCovers({limit:7});
 assert(await waitUntil(()=>started===3),'The first repair batch should be in progress');
 try{
  await f.invoke('updateGame',game.id,{cover:'66666666-6666-4666-8666-666666666666.jpg'});
  await f.invoke('updateGame',game.id,{cover:''});
 }finally{release();}
 await repairing;
 assert.equal(f.database.get(game.id).cover,'');
});

test('a repair scan preserves edits made while an earlier cover is being inspected',async t=>{
 let release,started=false;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t);
 f.database.upsert({name:'A first',source:'steam',source_id:'810',cover:'77777777-7777-4777-8777-777777777777.jpg'});
 const victim=f.database.upsert({name:'Z later',source:'steam',source_id:'811'}).game;
 f.context.coverNeedsPortrait=async()=>{started=true;await gate;return true;};
 f.context.downloadSteamCover=async()=> '88888888-8888-4888-8888-888888888888.jpg';
 const repairing=f.context.repairMissingSteamCovers({limit:10,replaceLandscape:true});
 assert(await waitUntil(()=>started),'The first existing cover should be under inspection');
 try{
  await f.invoke('updateGame',victim.id,{cover:'99999999-9999-4999-8999-999999999999.jpg'});
  await f.invoke('updateGame',victim.id,{cover:''});
 }finally{release();}
 await repairing;
 assert.equal(f.database.get(victim.id).cover,'');
});

test('deleting a game waiting inside the icon worker does not save an orphan icon',async t=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
 let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{getFileIcon:async file=>{
  const index=Number(path.basename(file).match(/\d+/)[0]);
  if(index<2){started++;await gate;}
  return {isEmpty:()=>false,toPNG:()=>Buffer.concat([png,Buffer.from([index])])};
 }});
 const games=Array.from({length:4},(_,index)=>{
  const executable=path.join(f.root,`pool-${index}.exe`);fs.writeFileSync(executable,'fixture');
  return {name:`Pool ${index}`,source:'folder',executable};
 });
 assert.equal((await f.invoke('importGames',games)).imported,4);
 assert(await waitUntil(()=>started===2),'Both native-icon workers should be busy');
 const removed=f.database.list().find(game=>game.name==='Pool 2');
 try{assert.equal(await f.invoke('removeGame',removed.id),true);}
 finally{release();}
 assert(await waitUntil(()=>!!f.database.list().find(game=>game.name==='Pool 3')?.icon),'Later icon work should finish');
 assert.equal(fs.readdirSync(path.join(f.root,'artwork')).length,3,'Only the three remaining games should save icons');
});

for(const kind of ['cover','banner'])test(`deleting a game during title lookup prevents a later ${kind} download`,async t=>{
 let release,started=false;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{
  findExactSteamApp:async()=>{started=true;await gate;return {steamId:'9300'};},
  findSteamCover:async()=>portrait,findSteamBanner:async()=>landscape,
 });
 f.database.saveSettings({useSteamArtwork:true});
 const game=f.database.upsert({name:'Unusual fixture game',source:'manual'}).game;
 const lookup=kind==='cover'?f.context.cachedSteamCover(game):f.context.cachedSteamBanner(game);
 assert(await waitUntil(()=>started),'The title lookup should be in flight');
 try{assert.equal(await f.invoke('removeGame',game.id),true);}
 finally{release();}
 await lookup;
 const artDir=path.join(f.root,'artwork');
 assert.deepEqual(fs.existsSync(artDir)?fs.readdirSync(artDir):[],[],'No artwork should be saved for the removed game');
});

test('deleting a game waiting inside the cover worker prevents an orphaned download',async t=>{
 let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{findSteamCover:async id=>{
  if(Number(id)<704){started++;await gate;return null;}
  return portrait;
 },findSteamBanner:async()=>null});
 const pending=[],enrich=f.context.enrichGameArtwork;
 f.context.enrichGameArtwork=game=>{const task=enrich(game);pending.push(task);return task;};
 let victim;
 for(let i=0;i<4;i++){
  const {game}=await f.invoke('addGame',{name:`Pool cover ${i}`,source:'steam',source_id:String(701+i)});
  if(i===3)victim=game;
 }
 assert(await waitUntil(()=>started===3),'The first cover workers should be busy');
 try{assert.equal(await f.invoke('removeGame',victim.id),true);}
 finally{release();}
 await Promise.allSettled(pending);
 const artDir=path.join(f.root,'artwork');
 assert.deepEqual(fs.existsSync(artDir)?fs.readdirSync(artDir):[],[]);
});

test('shared artwork remains available to another game when one subscriber is deleted',async t=>{
 let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{findExactSteamApp:async()=>{started++;await gate;return {steamId:'9300'};},findSteamCover:async()=>portrait});
 f.database.saveSettings({useSteamArtwork:true});
 const first=f.database.upsert({name:'Unusual shared game',source:'manual'}).game;
 const second=f.database.upsert({name:'Unusual shared game',source:'manual'}).game;
 const left=f.context.cachedSteamCover(first),right=f.context.cachedSteamCover(second);
 assert(await waitUntil(()=>started===1),'The title search should be shared');
 try{assert.equal(await f.invoke('removeGame',first.id),true);}
 finally{release();}
 await Promise.all([left,right]);
 assert.match(f.database.get(second.id).cover,/^[a-f0-9-]{36}\.jpg$/);
 assert.equal(started,1);
});

test('toggling online artwork while a search is queued does not block a later retry',async t=>{
 let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{findExactSteamApp:async name=>{
  if(name.startsWith('Waiting')){started++;await gate;return null;}
  return {steamId:'9300'};
 },findSteamCover:async()=>portrait});
 f.database.saveSettings({useSteamArtwork:true});
 const games=['Waiting one','Waiting two','Waiting three','Unusual queued title'].map(name=>f.database.upsert({name,source:'manual'}).game);
 const pending=games.map(game=>f.context.cachedSteamCover(game));
 assert(await waitUntil(()=>started===3),'The first title searches should be in flight');
 try{f.database.saveSettings({useSteamArtwork:false});}
 finally{release();}
 await Promise.all(pending);
 f.database.saveSettings({useSteamArtwork:true});
 await f.context.cachedSteamCover(games[3]);
 assert.match(f.database.get(games[3].id).cover,/^[a-f0-9-]{36}\.jpg$/);
});

test('a cover lookup interrupted by disabling online artwork can be retried',async t=>{
 let release,started=false;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{findSteamCover:async(_id,{online})=>{
  started=true;await gate;return online()?portrait:null;
 }});
 f.database.saveSettings({useSteamArtwork:true});
 const game=f.database.upsert({name:'Fixture game',source:'steam',source_id:'9400'}).game;
 const lookup=f.context.cachedSteamCover(game);
 assert(await waitUntil(()=>started),'The first cover lookup should be in flight');
 try{f.database.saveSettings({useSteamArtwork:false});}
 finally{release();}
 await lookup;
 assert.equal(f.database.get(game.id).cover,'');
 f.database.saveSettings({useSteamArtwork:true});
 await f.context.cachedSteamCover(game);
 assert.match(f.database.get(game.id).cover,/^[a-f0-9-]{36}\.jpg$/);
});

test('renaming a game while an icon search is queued uses the new title',async t=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
 let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{platform:'win32',getFileIcon:async file=>{
  const name=path.basename(file);if(name.startsWith('hold-')){started++;await gate;}
  return {isEmpty:()=>false,toPNG:()=>Buffer.concat([png,Buffer.from(name)])};
 }});
 for(const name of ['hold-0.exe','hold-1.exe','OldGame.exe','NewGame.exe'])fs.writeFileSync(path.join(f.root,name),'fixture');
 const holders=[0,1].map(i=>f.database.upsert({name:`Holder ${i}`,source:'manual',executable:path.join(f.root,`hold-${i}.exe`)}).game);
 const busy=holders.map(game=>f.context.cacheGameIcon(game));
 assert(await waitUntil(()=>started===2),'The icon workers should be occupied');
 const original=f.database.upsert({name:'Old Game',source:'steam',source_id:'8300',install_path:f.root}).game;
 const oldLookup=f.context.cacheGameIcon(original);
 const renamed=await f.invoke('updateGame',original.id,{name:'New Game'});
 const newLookup=f.context.cacheGameIcon(renamed);
 release();await Promise.all([...busy,oldLookup,newLookup]);
 const game=f.database.get(original.id);
 assert(game.icon);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'artwork',game.icon)),Buffer.concat([png,Buffer.from('NewGame.exe')]));
});

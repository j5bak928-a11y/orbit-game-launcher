'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the real main-process repair functions with local image metadata.
// Native Electron setup, online downloads and process enumeration stay inactive.
function fixture(t, width, height, { missing = false, cover = crypto.randomUUID() + '.png', epicLookup, steamSearch } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-repair-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const art = path.join(root, 'artwork');
  fs.mkdirSync(art);
  if (!missing) {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    fs.writeFileSync(path.join(art, cover), bytes);
  }
  const game = {
    id: crypto.randomUUID(), name: 'Fixture game', source: 'steam', source_id: '123',
    cover, icon: crypto.randomUUID() + '.png', executable: '', install_path: '',
  };
  const database = {
    list: () => [{ ...game }], get: () => ({ ...game }),
    getSettings: () => ({ useSteamArtwork: true }),
    update: (_, patch) => Object.assign(game, patch),
  };
  const main = path.join(__dirname, '../src/main.cjs');
  const realRequire = createRequire(main);
  const handlers = new Map();
  const electron = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    app: {
      requestSingleInstanceLock: () => true,
      getPath: () => root,
      whenReady: () => new Promise(() => {}),
      on() {},
    },
    protocol: { registerSchemesAsPrivileged() {} },
  };
  const context = vm.createContext({
    require: name => {
      if (name === 'electron') return electron;
      if (name === './core/nonsteam-artwork.cjs' && epicLookup) return {...realRequire(name), findEpicPortrait:epicLookup};
      if (name === './core/steam-search.cjs' && steamSearch) return {...realRequire(name), findExactSteamApp:steamSearch};
      return realRequire(name);
    },
    __dirname: path.dirname(main), process, Buffer, fixtureDb: database,
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, { filename: main });
  vm.runInContext('db = fixtureDb;', context);
  let downloads = 0;
  const replacement = crypto.randomUUID() + '.jpg';
  context.downloadSteamCover = async () => { downloads++; return replacement; };
  return { context, game, replacement, handlers, downloads: () => downloads };
}

test('repair identifies a previously added local game from its specific executable',async t=>{
 const f=fixture(t,600,900,{missing:true});
 f.game.source='folder';f.game.source_id='';f.game.name='My game';f.game.cover='';
 f.game.executable=path.join(os.tmpdir(),'Call of Duty','cod26-cod.exe');
 let appId='';f.context.downloadSteamCover=async id=>{appId=id;return f.replacement;};
 await f.context.cachedSteamCover({...f.game});
 assert.equal(appId,'4435490');assert.equal(f.game.cover,f.replacement);
});

test('manual online cover search can find Fortnite on Epic when Steam has no match',async t=>{
 const bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(600,16);bytes.writeUInt32BE(900,20);
 const f=fixture(t,600,900,{missing:true,steamSearch:async()=>null,epicLookup:async game=>game.name==='Fortnite'?{bytes,ext:'.png'}:null});
 f.context.handlers();
 const result=await f.handlers.get('orbit:findOnlineCover')({},'Fortnite');
 assert.match(result.cover,/\.png$/);assert.match(result.message,/Epic/i);
});

test('manual cover search uses the known Modern Warfare 4 ID without depending on title search',async t=>{
 const f=fixture(t,600,900,{missing:true,steamSearch:async()=>null});
 let appId='';f.context.downloadSteamCover=async id=>{appId=id;return f.replacement;};
 f.context.handlers();
 const result=await f.handlers.get('orbit:findOnlineCover')({},'Modern Warfare 4');
 assert.equal(appId,'4435490');assert.equal(result.cover,f.replacement);
});

test('repair reports that online searches are paused during a guarded game session',async t=>{
 const f=fixture(t,600,900,{missing:true});
 f.game.cover='';f.context.fixtureDb.getSettings=()=>({useSteamArtwork:true,performanceGuard:true});
 vm.runInContext("sessions.set('running-game','session');",f.context);
 const result=await f.context.repairMissingSteamCovers({replaceLandscape:true});
 assert.equal(result.onlineEnabled,true);assert.equal(result.paused,true);
 f.context.handlers();
 await assert.rejects(f.handlers.get('orbit:findOnlineCover')({},'Fortnite'),/paused by Performance Guard/);
});

test('an edited cover wins over a pending Epic lookup',async t=>{
 let start,finish;
 const started=new Promise(resolve=>{start=resolve});
 const gate=new Promise(resolve=>{finish=resolve});
 const f=fixture(t,600,900,{missing:true,epicLookup:async()=>{start();await gate;return {bytes:Buffer.alloc(24),ext:'.png'};}});
 f.game.source='epic';f.game.source_id='Fortnite';f.game.name='Fortnite';f.game.cover='';
 const pending=f.context.cachedSteamCover({...f.game});
 await started;
 const chosen='33333333-3333-4333-8333-333333333333.png';
 f.context.fixtureDb.update(f.game.id,{cover:chosen});
 vm.runInContext('artworkEditRevisions.set(fixtureDb.get().id,1);',f.context);
 finish();await pending;
 assert.equal(f.game.cover,chosen);
});

test('a user-initiated cover search retries a previous Epic miss',async t=>{
 const bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(600,16);bytes.writeUInt32BE(900,20);
 let attempts=0;
 const f=fixture(t,600,900,{missing:true,steamSearch:async()=>null,epicLookup:async()=>++attempts===1?null:{bytes,ext:'.png'}});
 f.context.handlers();
 const search=f.handlers.get('orbit:findOnlineCover');
 assert.equal((await search({},'Fortnite')).cover,'');
 assert.match((await search({},'Fortnite')).cover,/\.png$/);
});

test('repair replaces an existing landscape cover with a portrait candidate', async t => {
  const f = fixture(t, 1280, 720);
  const result = await f.context.repairMissingSteamCovers({ replaceLandscape: true });
  assert.equal(result.found, 1);
  assert.equal(f.downloads(), 1);
  assert.equal(f.game.cover, f.replacement);
});

test('repair restores an artwork token whose file is missing', async t => {
  const f = fixture(t, 600, 900, { missing: true });
  const result = await f.context.repairMissingSteamCovers({ replaceLandscape: true });
  assert.equal(result.found, 1);
  assert.equal(f.downloads(), 1);
  assert.equal(f.game.cover, f.replacement);
});

test('repair preserves an existing valid portrait without downloading a replacement', async t => {
  const f = fixture(t, 600, 900);
  const original = f.game.cover;
  const result = await f.context.repairMissingSteamCovers({ replaceLandscape: true });
  assert.equal(result.attempted, 0);
  assert.equal(f.downloads(), 0);
  assert.equal(f.game.cover, original);
});

test('portrait validation rejects artwork paths outside the cache', async t => {
  const f = fixture(t, 600, 900, { missing: true, cover: '../outside.png' });
  assert.equal(await f.context.coverNeedsPortrait(f.game), false);
  assert.equal(f.downloads(), 0);
});

test('an edited title cannot receive artwork from a stale lookup',async t=>{
 const f=fixture(t,600,900,{missing:true});
 f.game.cover='';
 let resolve;const gate=new Promise(r=>{resolve=r});
 f.context.downloadSteamCover=async()=>{await gate;return f.replacement;};
 const lookup=f.context.cachedSteamCover({...f.game});
 f.game.name='Different game';resolve();await lookup;
 assert.notEqual(f.game.cover,f.replacement);
});

test('a cover saved during portrait validation wins over pending artwork',async t=>{
 const f=fixture(t,1280,720);
 let resume,started;
 const gate=new Promise(resolve=>{resume=resolve});
 const validating=new Promise(resolve=>{started=resolve});
 const validate=f.context.coverNeedsPortrait;
 f.context.coverNeedsPortrait=async game=>{started();await gate;return validate(game);};
 const lookup=f.context.cachedSteamCover({...f.game},{replaceLandscape:true});
 await validating;
 const customCover='33333333-3333-4333-8333-333333333333.jpg';
 f.context.fixtureDb.update(f.game.id,{cover:customCover});
 vm.runInContext('artworkEditRevisions.set(fixtureDb.get().id,1);',f.context);
 resume();await lookup;
 assert.equal(f.game.cover,customCover);
});

test('offline artwork settings still allow the local Steam cache',async t=>{
 const f=fixture(t,600,900,{missing:true});
 f.game.cover='';
 f.context.fixtureDb.getSettings=()=>({useSteamArtwork:false});
 await f.context.cachedSteamCover({...f.game});
 assert.equal(f.downloads(),1,'local artwork lookup must run with online disabled');
});

test('offline repair uses a portrait in an Epic game folder before online lookup',async t=>{
 const f=fixture(t,600,900,{missing:true});
 f.game.source='epic';f.game.source_id='game';f.game.cover='';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-game-art-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(600,16);bytes.writeUInt32BE(900,20);
 fs.writeFileSync(path.join(dir,'cover.png'),bytes);f.game.install_path=dir;
 f.context.fixtureDb.getSettings=()=>({useSteamArtwork:false});
 await f.context.cachedSteamCover({...f.game});
 assert.match(f.game.cover,/\.png$/);assert.equal(f.downloads(),0);
});

test('artwork looks in the actual Steam installation root for non-default libraries',async t=>{
 const f=fixture(t,600,900,{missing:true});f.game.cover='';
 const library=path.join(os.tmpdir(),'Orbit-Steam-Custom');
 f.game.install_path=path.join(library,'steamapps','common','Fixture');
 let roots=[];f.context.downloadSteamCover=async(_id,options)=>{roots=options?.roots||[];return f.replacement;};
 await f.context.cachedSteamCover({...f.game});
 assert(roots.includes(library),'the Steam library root must be checked before standard locations');
});

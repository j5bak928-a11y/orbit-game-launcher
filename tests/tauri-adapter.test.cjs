'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ui = path.resolve(__dirname, '../src/ui');
const script = fs.readFileSync(path.join(ui, 'tauri-adapter.js'), 'utf8');

function load(window) {
  vm.runInNewContext(script, {window, console, Promise, Set, Error});
  return window.orbit;
}

test('Tauri adapter exposes every desktop IPC command supported by Rust backend', async () => {
  const rust = fs.readFileSync(path.join(ui, '../../src-tauri/src/lib.rs'), 'utf8');
  const commandBlock = rust.slice(
    rust.indexOf('fn handle_command('),
    rust.indexOf('_ => Err(format!("Unknown Orbit command', rust.indexOf('fn handle_command(')),
  );
  const backendCommands = new Set(
    [...commandBlock.matchAll(/^\s*"([A-Za-z]+)"\s*=>/gm)].map(match => match[1]),
  );

  const calls = [];
  let handler;
  const orbit = load({__TAURI__: {
    core:{invoke:async (command, args) => {calls.push({command, args});return {ok:true};}},
    event:{listen:async (name, callback) => {assert.equal(name, 'orbit:event');handler=callback;return ()=>{};}}
  }});
  await orbit.ready;
  const exposedMethods = Object.keys(orbit).filter(key => key !== 'onEvent' && key !== 'ready');
  assert.ok(exposedMethods.includes('bootstrap'));
  for (const method of exposedMethods) {
    assert.equal(typeof orbit[method], 'function', method);
    assert.ok(backendCommands.has(method), `Rust backend handles window.orbit.${method}`);
  }
  assert.deepEqual([...backendCommands].sort(), [...exposedMethods].sort());
  assert.ok(Object.isFrozen(orbit));
  assert.equal(typeof handler, 'function');

  const patch = {name:'New title',tags:['one','two']};
  assert.equal((await orbit.updateGame('game-id',patch)).ok, true);
  assert.equal((await orbit.bootstrap()).ok, true);
  assert.equal(JSON.stringify(calls), JSON.stringify([
    {command:'orbit_invoke',args:{method:'updateGame',args:['game-id',patch]}},
    {command:'orbit_invoke',args:{method:'bootstrap',args:[]}}
  ]));
});

test('Tauri event registration completes before bootstrap and unsubscribing stops callbacks', async () => {
  let confirmListener;
  let handler;
  let listening = false;
  const orbit = load({__TAURI__: {
    core:{invoke:async (_method, args) => {
      if(args.method === 'bootstrap')assert.equal(listening, true, 'subscribe before bootstrap');
      return args.method;
    }},
    event:{listen:async (_name, callback) => {
      handler = callback;
      await new Promise(resolve => {confirmListener = resolve;});
      listening = true;
      return ()=>{};
    }}
  }});
  const received = [];
  const unsubscribe = orbit.onEvent(event => received.push(event));
  // Yield to the asynchronous call to listen.
  await Promise.resolve();
  assert.equal(typeof confirmListener, 'function');
  let finished = false;
  const startup = (async () => {await orbit.ready;await orbit.bootstrap();finished = true;})();
  await Promise.resolve();
  assert.equal(finished, false);
  confirmListener();
  await startup;
  handler({payload:{type:'gamesChanged',revision:12}});
  assert.equal(received.length, 1);
  assert.equal(received[0].revision, 12);
  unsubscribe();
  handler({payload:{type:'gamesChanged',revision:13}});
  assert.equal(received.length, 1);
  assert.equal(typeof orbit.onEvent(null), 'function');
});

test('Tauri errors are Error objects; listener failures are visible through ready', async () => {
  const orbit = load({__TAURI__: {
    core:{invoke:async () => {throw 'Game not found';}},
    event:{listen:async () => {throw Error('Event channel blocked');}}
  }});
  await assert.rejects(orbit.getGame('missing'), /Game not found/);
  await assert.rejects(orbit.ready, /Event channel blocked/);
});

test('Existing window.orbit is preserved and the adapter loads before app startup', () => {
  const original = {bootstrap:()=>1};
  let listenCalls = 0;
  const current = load({orbit:original, __TAURI__:{
    core:{invoke:async()=>1},
    event:{listen:()=>{listenCalls++;}}
  }});
  assert.equal(current,original);
  assert.equal(listenCalls,0);
  assert.equal(load({}),undefined);

  const html = fs.readFileSync(path.join(ui, 'index.html'),'utf8');
  assert.ok(html.indexOf('src="./tauri-adapter.js"') < html.indexOf('src="./app.js"'));
});

test('renderer boot waits for the event bridge but does not wait for optional update status', async () => {
  const app = fs.readFileSync(path.join(ui, 'app.js'), 'utf8');
  const begin = app.indexOf('async function boot(){try{');
  const end = app.indexOf('\nboot();', begin);
  assert.ok(begin >= 0 && end > begin, 'boot function is present');
  const boot = app.slice(begin, end);

  let finishListening;
  const listenerReady = new Promise(resolve => {finishListening = resolve;});
  let finishUpdate;
  const updateStatus = new Promise(resolve => {finishUpdate = resolve;});
  let received;
  let rendered = false;
  let bootstrapCalls = 0;
  const errors = [];
  const uiRoot = {innerHTML:''};
  const state = {games:[],runningIds:[],settings:null};
  const context = {
    Promise, Error, console,
    state, libraryUpdates:null,
    window:{
      orbit:{
        onEvent(callback) {received = callback;return ()=>{};},
        ready:listenerReady,
        bootstrap:async()=>{
          bootstrapCalls++;
          received({type:'gamesChanged',revision:1});
          return {games:[],runningIds:[],settings:{sort:'name',view:'grid'},platform:'win32',version:'1.0'};
        },
        getUpdateStatus:()=>updateStatus
      },
      OrbitLibraryUpdates:{LibraryUpdates:class {
        constructor(options){this.data=options.snapshot;}
        snapshot(){return this.data;}
      }}
    },
    loadLibrarySnapshot:async()=>({games:[],runningIds:[]}),
    applyLibraryUpdate:()=>{},
    handleOrbitEvent:event=>errors.push(event),
    applyLanguage:()=>{},
    localeRenderKey:()=>null,
    lastRenderedLocale:null,
    setupTheme:()=>{},
    renderShell:()=>{rendered=true;},
    el:id=>id==='app'?uiRoot:{textContent:''},
    esc:value=>String(value)
  };

  vm.runInNewContext(boot+'\nboot();', context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(bootstrapCalls,0,'native listener has not registered');
  assert.equal(rendered,false);
  finishListening();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(bootstrapCalls,1);
  assert.equal(rendered,true,'library UI renders before update status resolves');
  assert.equal(errors.length,1,'event emitted during bootstrap was replayed');
  assert.equal(errors[0].revision,1);
  assert.equal(state.updateStatus,undefined);
  finishUpdate({state:'ready',message:'Update available'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.updateStatus.message,'Update available');
});

test('Windows WebView2 art uses the local protocol origin; Electron URLs stay unchanged', async () => {
  const token = '01234567-89ab-cdef-0123-456789abcdef.png';
  const makeWindow = (platform, protocol) => ({
    __TAURI__: {
      core: {invoke:async()=>null},
      event: {listen:async()=>()=>{}}
    },
    navigator: {platform, userAgent:platform},
    location: {protocol}
  });
  const windows = makeWindow('Win32', 'http:');
  load(windows);
  assert.equal(windows.OrbitArtworkUrl(token), `http://orbit-art.localhost/file/${token}`);
  assert.equal(windows.OrbitArtworkUrl('../outside.png'), null);
  const secure = makeWindow('Win32', 'https:');
  load(secure);
  assert.equal(secure.OrbitArtworkUrl(token), `https://orbit-art.localhost/file/${token}`);
  const mac = makeWindow('MacIntel', 'tauri:');
  load(mac);
  assert.equal(mac.OrbitArtworkUrl(token), `orbit-art://file/${token}`);
  assert.equal(load({}), undefined);

  // Both renderer views must use the Tauri helper rather than raw orbit-art:
  // so the artwork scheme remains correct when switching to controller mode.
  for (const source of ['app.js', 'controller-mode.js']) {
    assert.match(fs.readFileSync(path.join(ui, source),'utf8'), /window\.OrbitArtworkUrl\?\.\(token\)/);
  }
  await Promise.all([windows.orbit.ready,secure.orbit.ready,mac.orbit.ready]);
});

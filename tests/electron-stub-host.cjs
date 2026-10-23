'use strict';
// Runs Orbit's real Electron main process and IPC handlers against small Electron
// stand-ins. Used only by workflow-integration.py; never shipped as a desktop runtime.
const EventEmitter = require('node:events');
const Module = require('node:module');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
// Never make external calls from the integration fixture. Serve a tiny valid
// JPEG to exercise the standalone-game Steam cover path deterministically.
global.fetch = async url => {
  if(String(url).includes('/steam/apps/394360/library_600x900.jpg') || String(url).includes('/steam/apps/504230/library_600x900.jpg')){
    return new Response(fs.readFileSync(path.join(__dirname,'fixtures/test-steam-cover.jpg')),{status:200,headers:{'Content-Type':'image/jpeg'}});
  }
  if(String(url).includes('/api/storesearch/') && String(url).includes('term=Celeste')){
    return new Response(JSON.stringify({items:[{id:504230,type:'app',name:'Celeste'}]}),{status:200,headers:{'Content-Type':'application/json'}});
  }
  return new Response('',{status:404});
};
const appData = process.env.ORBIT_E2E_DATA;
if (!appData) throw Error('ORBIT_E2E_DATA required');
const emit = packet => process.stdout.write(JSON.stringify(packet) + '\n');
class FakeWindow extends EventEmitter {
  static windows = [];
  constructor() {
    super(); FakeWindow.windows.push(this);
    this.webContents = new EventEmitter();
    this.webContents.send = (_, payload) => emit({event: payload});
    this.webContents.setWindowOpenHandler = () => {};
    this.loadFile = () => {};
  }
  isDestroyed() {return false;}
  show() {}
  focus() {}
  isMinimized() {return false;}
  static getAllWindows() {return FakeWindow.windows;}
}
const app = new EventEmitter();
app.getPath = name => name === 'userData' ? appData : appData;
app.getVersion = () => '1.0.0-test';
app.whenReady = () => Promise.resolve();
app.requestSingleInstanceLock = () => true;
app.quit = () => {};
app.getFileIcon = async () => ({isEmpty:()=>false, toPNG:()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64')});
const actions = new Map();
const queuedDialogs = [];
const shellActions = [];
const electron = {
  app, BrowserWindow: FakeWindow,
  dialog: {
    showErrorBox: (...args) => emit({nativeError: args}),
    showOpenDialog: async () => {
      const chosen = queuedDialogs.shift();
      return chosen ? {canceled:false,filePaths:[chosen]} : {canceled:true,filePaths:[]};
    },
    showSaveDialog: async () => {
      const chosen = queuedDialogs.shift();
      return chosen ? {canceled:false,filePath:chosen} : {canceled:true};
    }
  },
  ipcMain: {handle: (name, callback) => actions.set(name, callback)},
  shell: {
    openExternal: async url => {shellActions.push({kind:'uri',url});},
    openPath: async file => {shellActions.push({kind:'path',file});return '';}
  },
  protocol: {registerSchemesAsPrivileged: () => {},handle: () => {}},
  net: {fetch: async () => new Response('Not available', {status:404})},
  nativeTheme: {themeSource:'dark'}
};
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'electron') return electron;
  return originalLoad.call(this,request,...args);
};
require('../src/main.cjs');
const run = async request => {
  if (request.method === '__dialog') {queuedDialogs.push(request.args[0]);return true;}
  if (request.method === '__shellActions') return shellActions;
  if (request.method === '__parallelLaunch') {
    const handler = actions.get('orbit:launchGame');
    const results = await Promise.allSettled([handler({}, request.args[0]), handler({}, request.args[0])]);
    return results.map(result => result.status === 'fulfilled' ? {ok:true,result:result.value} : {ok:false,error:result.reason.message});
  }
  if (request.method === '__quit') {app.emit('before-quit');return true;}
  const handler = actions.get('orbit:' + request.method);
  if (!handler) throw Error('Unknown IPC action: ' + request.method);
  return handler({}, ...(request.args || []));
};
(async () => {
  while (!actions.has('orbit:bootstrap')) await new Promise(r => setTimeout(r, 1));
  emit({ready:true});
  for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
    let req;
    try {req = JSON.parse(line);emit({id:req.id,ok:true,result:await run(req)});}
    catch(error) {emit({id:req?.id,ok:false,error:error.message});}
  }
  app.emit('before-quit');
})().catch(error => {console.error(error);process.exitCode=1});

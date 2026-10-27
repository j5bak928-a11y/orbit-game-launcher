'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createRequire}=require('node:module');
const {LibraryDatabase}=require('../src/core/database.cjs');

const icon=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
async function waitFor(predicate,timeoutMs=6000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,10));}
 return false;
}

test('startup scan gives every newly imported game an icon without replacing existing artwork',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-startup-scan-'));
 let database=new LibraryDatabase(path.join(root,'library.sqlite')),context;
 t.after(()=>{
  const active=database||(context&&vm.runInContext('db',context));
  if(active)active.close();
  fs.rmSync(root,{recursive:true,force:true});
 });
 const library=path.join(root,'games');fs.mkdirSync(library);
 const executables=[];
 for(let index=0;index<53;index++){
  const dir=path.join(library,`Game ${String(index).padStart(2,'0')}`);
  fs.mkdirSync(dir);
  const file=path.join(dir,`game-${index}.exe`);fs.writeFileSync(file,'fixture');fs.chmodSync(file,0o755);
  executables.push(file);
 }
 const customIcon='11111111-1111-4111-8111-111111111111.png';
 const existing=database.upsert({name:'Existing',source:'manual',executable:executables[0],icon:customIcon}).game;
 database.saveSettings({autoScan:true,useSteamArtwork:false,libraryFolders:[library]});
 database.close();database=null;
 const timers=[],events=[];
 class FakeWindow extends EventEmitter{
  constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.webContents.send=(_channel,event)=>events.push(structuredClone(event));}
  isDestroyed(){return false;}
  loadFile(){}
  show(){}
  static getAllWindows(){return [];}
 }
 const app={requestSingleInstanceLock:()=>true,getPath:()=>root,getVersion:()=> 'fixture',whenReady:()=>Promise.resolve(),on(){},getFileIcon:async()=>({isEmpty:()=>false,toPNG:()=>icon})};
 const electron={app,BrowserWindow:FakeWindow,dialog:{showErrorBox(){throw Error('Database startup failed');}},
  ipcMain:{handle(){}},protocol:{registerSchemesAsPrivileged(){},handle(){}},nativeTheme:{themeSource:'dark'}};
 const main=path.join(__dirname,'../src/main.cjs'),realRequire=createRequire(main);
 context=vm.createContext({
  require:name=>{
   if(name==='electron')return electron;
   if(name==='./core/discovery.cjs'){
    const real=realRequire(name);
    // Keep these regular-file fixtures portable on macOS, whose native
    // folder scanner discovers app bundles instead.
    const platform=process.platform==='darwin'?'linux':process.platform;
    return {...real,discoverAll:settings=>real.discoverAll(settings,{providers:[],platform})};
   }
   if(name==='./core/windows-activity.cjs')return {WindowsActivityTracker:class{start(){} stop(){} runningIds(){return [];} isRunning(){return false;}}};
   return realRequire(name);
  },
  __dirname:path.dirname(main),process,Buffer,setImmediate,
  setTimeout:(callback,delay)=>{timers.push({callback,delay});return timers.length;},
 });
 vm.runInContext(fs.readFileSync(main,'utf8'),context,{filename:main});
 assert(await waitFor(()=>timers.some(timer=>timer.delay===1000)),'Startup scan should be scheduled');
 database=vm.runInContext('db',context);
 await timers.find(timer=>timer.delay===1000).callback();
 assert.equal(database.count(),53,'Only new games should be imported');
 await waitFor(()=>events.filter(event=>event.reason==='artwork').length===52);
 const games=database.list(),newGames=games.filter(game=>game.id!==existing.id);
 const missing=newGames.filter(game=>!game.icon).map(game=>game.name);
 assert.deepEqual(missing,[],'Every new game should receive its local icon, including games after the first import batch');
 assert.equal(database.get(existing.id).icon,customIcon);
 assert(newGames.every(game=>fs.existsSync(path.join(root,'artwork',game.icon))));
 assert(events.some(event=>event.reason==='autoScan'));
});

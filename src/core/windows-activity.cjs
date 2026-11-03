'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {performance}=require('node:perf_hooks');
const execFileAsync=promisify(execFile);
const ACTIVE_POLL_MS=15000,IDLE_POLL_MS=60000,LAUNCH_POLL_MS=6000;
const SKIP_EXECUTABLE=/^(?:unins\w*|uninstall\w*|setup\w*|install\w*|launcher\w*|\w+launcher(?:64|32)?|launchgame|updater|update\w*|patcher\w*|bootstrap\w*|crash(?:reporter|handler)?\w*|easyanticheat\w*|eac\w*|eanticheat\w*|easteam\w*|ue4prereq\w*|vcredist\w*|dxsetup\w*|epicgameslauncher\w*)\.exe$/i;
function normalizeWindowsPath(input){return typeof input==='string'?path.win32.normalize(input).toLowerCase().replace(/[\\/]+$/,''):'';}
function titleKey(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function storeAndManualAlias(store,alias){
 if(!store||!alias||!['steam','epic'].includes(store.source)||!['manual','folder'].includes(alias.source))return false;
 const folder=normalizeWindowsPath(store.install_path),exe=normalizeWindowsPath(alias.executable);
 const title=titleKey(store.name);
 return !!folder&&!!exe&&!!title&&title===titleKey(alias.name)&&path.win32.isAbsolute(folder)&&exe.startsWith(`${folder}\\`);
}
function samePhysicalInstallation(first,second){return storeAndManualAlias(first,second)||storeAndManualAlias(second,first);}
function matchRunningGames(games, executables) {
 const processes = new Set(executables.map(normalizeWindowsPath).filter(Boolean));
 const folders=new Map(),exact=new Map(),found=new Set();
 const add=(map,key,id)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(id);};
 for(const game of games){
  if(!game)continue;
  const executable=normalizeWindowsPath(game.executable);
  // An explicitly linked local executable is authoritative even if its file
  // name contains 'Launcher'. Generic folder detection must ignore helpers.
  if(executable&&path.win32.isAbsolute(executable)&&(!SKIP_EXECUTABLE.test(path.win32.basename(executable))||['manual','folder'].includes(game.source)))add(exact,executable,game.id);
  const folder=normalizeWindowsPath(game.install_path);
  if(!folder||!path.win32.isAbsolute(folder)||!['steam','epic'].includes(game.source))continue;
  if(path.win32.dirname(folder)===folder||/^(?:games|program files(?: \(x86\))?|users|downloads|steamapps|common|epic games)$/i.test(path.win32.basename(folder)))continue;
  add(folders,folder,game.id);
 }
 for (const exe of processes) {
  if (!path.win32.isAbsolute(exe) || !exe.endsWith('.exe')) continue;
  const direct=exact.get(exe);
  if(direct){if(direct.size===1)found.add([...direct][0]);continue;}
  if(SKIP_EXECUTABLE.test(path.win32.basename(exe)))continue;
  let directory = path.win32.dirname(exe);
  while (true) {
   const folder = directory.replace(/[\\/]+$/, '');
   const candidates=folders.get(folder);
   if(candidates){if(candidates.size===1)found.add([...candidates][0]);break;}
   const parent = path.win32.dirname(directory);
   if (parent === directory) break;
   directory = parent;
  }
 }
 // Coalesce only confidently identical titles. Containment alone is not
 // enough: independent games/DLC can legitimately reside under one folder.
 for(const store of games){
  if(!store||!found.has(store.id)||!['steam','epic'].includes(store.source))continue;
  for(const alias of games){
   if(alias&&found.has(alias.id)&&storeAndManualAlias(store,alias))found.delete(alias.id);
  }
 }
 return [...new Set(games.filter(game=>game&&found.has(game.id)).map(game=>game.id))];
}
function nativeInventoryPath(resourcesPath=process.resourcesPath){
 return typeof resourcesPath==='string'&&path.isAbsolute(resourcesPath)?path.join(resourcesPath,'bin','orbit-process-list.exe'):null;
}
function parseNativeInventory(stdout){
 if(typeof stdout!=='string')return [];
 return stdout.split(/\r?\n/).map(s=>s.trim()).filter(s=>path.win32.isAbsolute(s)&&/\.exe$/i.test(s)).slice(0,10000);
}
async function listWindowsExecutables({run=execFileAsync,helperPath=nativeInventoryPath(),exists=fs.existsSync}={}){
 if(helperPath&&exists(helperPath)){
  try{
   const {stdout}=await run(helperPath,[],{timeout:4500,maxBuffer:1024*1024,windowsHide:true});
   const paths=parseNativeInventory(stdout);
   if(paths.length)return paths;
  }catch{} // Native helper may be unavailable after manual installs; retain safe fallback.
 }
 const script='Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith(".exe") } | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress';
 const encoded=Buffer.from(script,'utf16le').toString('base64');
 const {stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{timeout:9000,maxBuffer:512*1024,windowsHide:true});
 const data=JSON.parse(stdout.trim()||'[]');
 return (Array.isArray(data)?data:[data]).filter(x=>typeof x==='string').slice(0,10000);
}
class WindowsActivityTracker{
 constructor({listGames,isDirectSession,start,finish,onChange,onError,enumerate=listWindowsExecutables,now=()=>performance.now()}){
  Object.assign(this,{listGames,isDirectSession,startSession:start,finishSession:finish,onChange,onError,enumerate,now});
  this.active=new Map();this.pendingFinishes=new Map();this.timer=null;this.polling=false;this.stopped=false;this.suspended=false;
  this.launchUntil=0;this.consecutiveFailures=0;
 }
 isRunning(id){
  if(this.active.has(id)||this.pendingFinishes.has(id))return true;
  const games=this.listGames(),candidate=games.find(game=>game.id===id);
  return !!candidate&&games.some(game=>(this.active.has(game.id)||this.pendingFinishes.has(game.id))&&samePhysicalInstallation(candidate,game));
 }
 runningIds(){return [...new Set([...this.active.keys(),...this.pendingFinishes.keys()])]}
 start(){if(this.timer||this.stopped)return;this.poll().catch(error=>this.onError?.(error));}
 schedule(){
  if(this.timer||this.stopped||this.suspended)return;
  const delay=this.now()<this.launchUntil?LAUNCH_POLL_MS:this.active.size||this.pendingFinishes.size?ACTIVE_POLL_MS:IDLE_POLL_MS;
  this.timer=setTimeout(()=>{this.timer=null;this.poll().catch(error=>this.onError?.(error));},delay);
  this.timer.unref?.();
 }
 noteLaunch(){this.launchUntil=Math.max(this.launchUntil,this.now()+90000);if(this.timer){clearTimeout(this.timer);this.timer=null;}this.poll().catch(error=>this.onError?.(error));}
 checkpoints(){return [...this.active.values()].map(info=>({id:info.sessionId,seconds:Math.floor((this.now()-info.startedAt)/1000)}));}
 suspend(){
  this.suspended=true;if(this.timer){clearTimeout(this.timer);this.timer=null;}
  const changed=[...this.active.keys()];for(const [id,info] of this.active)this.finalize(id,info);
  if(changed.length)this.onChange?.(changed);
 }
 resume(){if(this.stopped)return;this.suspended=false;this.launchUntil=this.now()+90000;this.poll().catch(error=>this.onError?.(error));}
 async poll(){
  if(this.polling||this.stopped||this.suspended)return;
  this.polling=true;
  try{
   this.retryFinishes();
   if(!this.active.size&&!this.listGames().length)return;
   const processes=await this.enumerate();
   if(this.stopped||this.suspended)return;
   this.consecutiveFailures=0;
   const games=this.listGames(),running=new Set(matchRunningGames(games,processes));
   // A manually linked direct launch outranks the store's automatic fallback.
   // Without this, one direct session plus one background session is possible.
   for(const store of games){
    if(!running.has(store.id)||!['steam','epic'].includes(store.source))continue;
    if(games.some(alias=>this.isDirectSession(alias.id)&&storeAndManualAlias(store,alias)))running.delete(store.id);
   }
   const ids=new Set(games.map(g=>g.id)),changed=new Set();
   for(const id of running){
    if(!ids.has(id)||this.isDirectSession(id)||this.pendingFinishes.has(id))continue;
    const existing=this.active.get(id);
    if(existing){existing.misses=0;continue;}
    try{const sessionId=this.startSession(id);this.active.set(id,{sessionId,startedAt:this.now(),misses:0});changed.add(id);}catch{}
   }
   for(const [id,info] of this.active){
   if(running.has(id)&&ids.has(id)){info.misses=0;info.firstMissAt=null;continue;}
   if(!info.misses)info.firstMissAt=this.now();
    if(++info.misses<2&&ids.has(id))continue;
    this.finalize(id,info);changed.add(id);
   }
   if(changed.size)this.onChange?.([...changed]);
  }catch(error){
   // A failed query must never be treated as proof that every game exited.
   this.consecutiveFailures++;
   if(this.consecutiveFailures===1||this.consecutiveFailures%10===0)this.onError?.(error);
  }finally{this.polling=false;this.schedule();}
 }
 finalize(id,info){
  const seconds=Math.max(0,Math.floor(((info.firstMissAt??this.now())-info.startedAt)/1000));
  // Never lose a failed SQLite finish: a new session would otherwise start
  // before the old one is closed, and recovery could credit both records.
  this.pendingFinishes.set(id,{sessionId:info.sessionId,seconds});
  this.active.delete(id);
  this.retryFinishes();
 }
 retryFinishes(){
  for(const [id,info] of this.pendingFinishes){
   try{
    this.finishSession(info.sessionId,info.seconds);
    this.pendingFinishes.delete(id); // false also means already finished once.
   }catch(error){this.onError?.(new Error(`Could not save play time for ${id}; retrying: ${error.message}`));}
  }
 }
 stop(){
  this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;
  for(const [id,info] of this.active)this.finalize(id,info);
  this.active.clear();
  this.retryFinishes();
 }
}
module.exports={WindowsActivityTracker,matchRunningGames,listWindowsExecutables,parseNativeInventory,nativeInventoryPath};

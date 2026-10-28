'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execFileAsync=promisify(execFile);
const ACTIVE_POLL_MS=15000,IDLE_POLL_MS=60000,LAUNCH_POLL_MS=6000;
const SKIP_EXECUTABLE=/^(?:unins\w*|uninstall\w*|setup\w*|install\w*|launcher|updater|update|crash(?:reporter|handler)?\w*|easyanticheat\w*|eac\w*|eanticheat\w*|easteam\w*|ue4prereq\w*|vcredist\w*|dxsetup\w*|epicgameslauncher\w*)\.exe$/i;
function normalizeWindowsPath(input){return typeof input==='string'?path.win32.normalize(input).toLowerCase().replace(/[\\/]+$/,''):'';}
function matchRunningGames(games, executables) {
 const processes = new Set(executables.map(normalizeWindowsPath).filter(Boolean));
 const folders=new Map(),exact=new Map(),found=new Set();
 const add=(map,key,id)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(id);};
 for(const game of games){
  if(!game)continue;
  const executable=normalizeWindowsPath(game.executable);
  if(executable&&path.win32.isAbsolute(executable)&&!SKIP_EXECUTABLE.test(path.win32.basename(executable)))add(exact,executable,game.id);
  const folder=normalizeWindowsPath(game.install_path);
  if(!folder||!path.win32.isAbsolute(folder)||!['steam','epic'].includes(game.source))continue;
  if(path.win32.dirname(folder)===folder||/^(?:games|program files(?: \(x86\))?|users|downloads|steamapps|common|epic games)$/i.test(path.win32.basename(folder)))continue;
  add(folders,folder,game.id);
 }
 for (const exe of processes) {
  if (!path.win32.isAbsolute(exe) || !exe.endsWith('.exe') ||
      SKIP_EXECUTABLE.test(path.win32.basename(exe))) continue;
  const direct=exact.get(exe);
  if(direct){if(direct.size===1)found.add([...direct][0]);continue;}
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
 constructor({listGames,isDirectSession,start,finish,onChange,onError,enumerate=listWindowsExecutables,now=Date.now}){
  Object.assign(this,{listGames,isDirectSession,startSession:start,finishSession:finish,onChange,onError,enumerate,now});
  this.active=new Map();this.timer=null;this.polling=false;this.stopped=false;this.suspended=false;
  this.launchUntil=0;this.consecutiveFailures=0;
 }
 isRunning(id){return this.active.has(id)}
 runningIds(){return [...this.active.keys()]}
 start(){if(this.timer||this.stopped)return;this.poll().catch(error=>this.onError?.(error));}
 schedule(){
  if(this.timer||this.stopped||this.suspended)return;
  const delay=this.now()<this.launchUntil?LAUNCH_POLL_MS:this.active.size?ACTIVE_POLL_MS:IDLE_POLL_MS;
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
   if(!this.active.size&&!this.listGames().length)return;
   const processes=await this.enumerate();
   if(this.stopped||this.suspended)return;
   this.consecutiveFailures=0;
   const games=this.listGames(),running=new Set(matchRunningGames(games,processes));
   const ids=new Set(games.map(g=>g.id)),changed=new Set();
   for(const id of running){
    if(!ids.has(id)||this.isDirectSession(id))continue;
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
  try{this.finishSession(info.sessionId,Math.max(0,Math.floor(((info.firstMissAt??this.now())-info.startedAt)/1000)));}catch{}
  this.active.delete(id);
 }
 stop(){
  this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;
  for(const [id,info] of this.active)this.finalize(id,info);
  this.active.clear();
 }
}
module.exports={WindowsActivityTracker,matchRunningGames,listWindowsExecutables,parseNativeInventory,nativeInventoryPath};

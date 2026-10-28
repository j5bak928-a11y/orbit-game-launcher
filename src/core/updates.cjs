'use strict';
const CHECK_INTERVAL_MS=6*60*60*1000;
const GITHUB_FEED={provider:'github',owner:'j5bak928-a11y',repo:'orbit-game-launcher'};
function configureFeed(updater,env=process.env){
 const explicit=env.ORBIT_UPDATE_FEED_URL;
 if(!explicit){updater.setFeedURL(GITHUB_FEED);return 'GitHub Releases';}
 const url=new URL(explicit);
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw Error('Update feed must be a plain HTTPS URL.');
 updater.setFeedURL({provider:'generic',url:url.href});
 return url.host;
}
function createUpdateService({app,emit=()=>{},getSettings=()=>({autoUpdates:true}),hasRunningGames=()=>false,platform=process.platform,loadUpdater=()=>require('electron-updater').autoUpdater,env=process.env}={}){
 let updater=null,timer=null,checking=null,initialized=false;
 let status={state:'idle',message:'Update checks have not started.',version:null,percent:null};
 const set=(patch)=>{status={...status,...patch};emit({type:'updateStatus',status:{...status}});return {...status};};
 const getStatus=()=>({...status});
 function initialize(){
  if(initialized)return;initialized=true;
  if(platform!=='win32'||!app?.isPackaged){set({state:'unsupported',message:'Automatic installation is available in packaged Windows installer builds.'});return;}
  try{
   updater=loadUpdater();
   const source=configureFeed(updater,env);
   updater.autoDownload=true;
   updater.autoInstallOnAppQuit=false; // Never silently replace a build while a game is in progress.
   updater.allowPrerelease=false;
   updater.on('checking-for-update',()=>set({state:'checking',message:'Checking for updates…'}));
   updater.on('update-available',info=>set({state:'downloading',version:info.version,message:'Downloading an Orbit update…'}));
   updater.on('update-not-available',()=>set({state:'current',message:'Orbit is up to date.',version:null,percent:null}));
   updater.on('download-progress',progress=>set({state:'downloading',percent:Math.round(progress.percent||0)}));
   updater.on('update-downloaded',info=>set({state:'ready',version:info.version,percent:100,message:'Update downloaded. Install when no game is running.'}));
   updater.on('error',error=>set({state:'error',message:'Update check failed: '+String(error?.message||error).slice(0,180)}));
   set({state:'idle',message:'Checking signed releases from '+source+'.'});
   timer=setInterval(()=>{if(getSettings().autoUpdates)check().catch(()=>{});},CHECK_INTERVAL_MS);
   timer.unref?.();
  }catch(error){updater=null;set({state:'unavailable',message:'Update service unavailable: '+error.message});}
 }
 async function check({manual=false}={}){
  initialize();
  if(!updater)return getStatus();
  if(!manual&&!getSettings().autoUpdates)return set({state:'disabled',message:'Automatic updates are disabled.'});
  if(checking)return checking;
  checking=(async()=>{
   try{
    set({state:'checking',message:'Checking for updates…',percent:null});
    await updater.checkForUpdates();
    return getStatus();
   }catch(error){return set({state:'error',message:'Could not check updates: '+String(error?.message||error).slice(0,180)});}
   finally{checking=null;}
  })();
  return checking;
 }
 function install(){
  if(!updater||status.state!=='ready')throw Error('No downloaded update is ready.');
  if(hasRunningGames())throw Error('Exit running games before installing the update.');
  updater.quitAndInstall(false,true);
  return {requested:true};
 }
 function dispose(){if(timer)clearInterval(timer);timer=null;}
 return {initialize,check,install,dispose,getStatus};
}
module.exports={createUpdateService,configureFeed};

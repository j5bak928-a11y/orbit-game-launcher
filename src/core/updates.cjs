'use strict';
const GITHUB_FEED={provider:'github',owner:'j5bak928-a11y',repo:'orbit-game-launcher'};
function configureFeed(updater,env=process.env){
 const explicit=env.ORBIT_UPDATE_FEED_URL;
 if(!explicit){updater.setFeedURL(GITHUB_FEED);return 'GitHub Releases';}
 const url=new URL(explicit);
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw Error('Update feed must be a plain HTTPS URL.');
 updater.setFeedURL({provider:'generic',url:url.href});
 return url.host;
}
// Fail closed until signed releases and a pinned publisher are configured.
function createUpdateService({app,emit=()=>{},platform=process.platform,env=process.env}={}){
 let status={state:'idle',message:'Update checks have not started.',version:null,percent:null};
 function initialize(){
  const unsupported=platform!=='win32'||!app?.isPackaged||!!env.PORTABLE_EXECUTABLE_FILE;
  status=unsupported?{state:'unsupported',message:'Automatic installation is unavailable for source and portable builds.',version:null,percent:null}:{state:'unavailable',message:'Automatic updates are unavailable until signed releases are configured.',version:null,percent:null};
  emit({type:'updateStatus',status:{...status}});
 }
 return {initialize,check:async()=>{initialize();return {...status};},install:()=>{throw Error('Automatic updates are unavailable until signed releases are configured.');},dispose:()=>{},getStatus:()=>({...status})};
}
module.exports={createUpdateService,configureFeed};

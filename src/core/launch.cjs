'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const ALLOWED_SCHEMES = new Set(['steam:','com.epicgames.launcher:','goggalaxy:','heroic:','uplay:','ubisoftconnect:','origin:','ea:','battlenet:']);
function validateLaunch(game) {
  if(!game || typeof game !== 'object')throw Error('Game not found.');
  if(game.launch_uri){
    let url;try{url=new URL(game.launch_uri)}catch{throw Error('Invalid launch URI. Use a supported game-launcher link.');}
    if(!ALLOWED_SCHEMES.has(url.protocol))throw Error('Unsupported launch URI scheme.');
    if(/\s/.test(game.launch_uri)||game.launch_uri.length>2048)throw Error('Invalid launch URI.');
    return {kind:'uri', uri:game.launch_uri};
  }
  if(!game.executable)throw Error('Select a game executable in Edit Game before launching.');
  if(!path.isAbsolute(game.executable))throw Error('Executable path must be absolute.');
  let stat;try{stat=fs.statSync(game.executable)}catch{throw Error('The game executable was not found. Check whether the drive is connected.');}
  if(process.platform==='darwin'&&game.executable.toLowerCase().endsWith('.app')&&stat.isDirectory())return {kind:'app',executable:game.executable,args:game.launch_args||[]};
  if(!stat.isFile())throw Error('The selected executable is not a file.');
  if(process.platform==='win32'&&!/\.(exe|com)$/i.test(game.executable))throw Error('Choose a Windows executable (.exe or .com).');
  if(process.platform==='darwin'&&!/\.(command|sh|app|bin)$/i.test(game.executable)&& !(stat.mode&0o111))throw Error('Selected file is not executable.');
  if(process.platform==='linux'&& !(stat.mode&0o111))throw Error('Selected file is not marked executable.');
  const cwd=game.working_dir||path.dirname(game.executable);
  if(!path.isAbsolute(cwd)||!fs.existsSync(cwd)||!fs.statSync(cwd).isDirectory())throw Error('Working directory is missing or invalid.');
  const args=game.launch_args||[];
  if(!Array.isArray(args)||args.length>80||args.some(a=>typeof a!=='string'||a.length>1024))throw Error('Launch arguments are invalid.');
  return {kind:'process',executable:game.executable,cwd,args};
}
async function launchGame(game, openExternal, onExit){
  const info=validateLaunch(game);
  if(info.kind==='uri'){
    await openExternal(info.uri);
    return {mode:'external',tracked:false,message:'Opened in the linked game launcher. Play-time tracking is unavailable for launch links.'};
  }
  if(info.kind==='app'){
    return await new Promise((resolve,reject)=>{
      const child=spawn('/usr/bin/open',['-a',info.executable,...info.args],{windowsHide:true,stdio:'ignore',shell:false});
      child.once('error',error=>reject(Error(`Could not open macOS app: ${error.message}`)));
      child.once('exit',code=>code===0?resolve({mode:'external',tracked:false,message:'Opened macOS app. Play-time tracking is unavailable for app bundles.'}):reject(Error(`macOS could not open the app (exit ${code}).`)));
    });
  }
  const exe=info.executable;
  const args=info.args;
  const cwd=info.cwd;
  return await new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd,windowsHide:false,detached:false,stdio:'ignore',shell:false});
    let started=false;
    child.once('error',error=>{if(!started)reject(Error(`Could not launch ${game.name}: ${error.message}`));else onExit?.(0,error)});
    child.once('spawn',()=>{started=true;resolve({mode:'process',pid:child.pid,tracked:true,message:'Game launched.'})});
    child.once('exit',(code,signal)=>{if(started)onExit?.(code,signal)});
  });
}
function deferredExit(callback){
  let ready=false,queued=false,finished=false;
  const run=()=>{
    if(finished)return;
    if(!ready){queued=true;return;}
    finished=true;
    callback();
  };
  return {onExit:run,ready:()=>{ready=true;if(queued)run();}};
}
module.exports={validateLaunch,launchGame,ALLOWED_SCHEMES,deferredExit};

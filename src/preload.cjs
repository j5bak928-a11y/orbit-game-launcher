'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const METHODS=['bootstrap','listGames','getGame','addGame','updateGame','removeGame','favoriteGame','saveSettings','chooseExecutable','inspectGameFile','findOnlineCover','chooseArtwork','chooseFolder','discoverGames','importGames','launchGame','openGameFolder','openAppData','getAppInfo','exportLibrary','restoreLibrary'];
const api={};
for(const method of METHODS)api[method]=(...args)=>ipcRenderer.invoke(`orbit:${method}`,...args);
api.onEvent=callback=>{if(typeof callback!=='function')return()=>{};const fn=(_event,payload)=>callback(payload);ipcRenderer.on('orbit:event',fn);return()=>ipcRenderer.removeListener('orbit:event',fn)};
contextBridge.exposeInMainWorld('orbit',Object.freeze(api));

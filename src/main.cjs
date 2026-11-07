'use strict';
const {app,BrowserWindow,dialog,ipcMain,shell,protocol,net,nativeTheme,nativeImage,Tray,Menu,powerMonitor}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const fsp=fs.promises;
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {LibraryDatabase,cleanGame,reconcileDiscoveredGames}=require('./core/database.cjs');
const {discoverAll,steamRoots}=require('./core/discovery.cjs');
const {launchGame:executeGame,deferredExit}=require('./core/launch.cjs');
const {findSteamCover,findSteamBanner,localSteamIcon}=require('./core/steam-cover.cjs');
const {ArtworkWork}=require('./core/artwork-work.cjs');
const {FullscreenController}=require('./core/window-state.cjs');
const {isPortraitArtwork,imageDimensions}=require('./core/cover-shape.cjs');
const {inspectGameFile}=require('./core/game-file.cjs');
const {findGameExecutable}=require('./core/game-executable.cjs');
const {findExactSteamApp}=require('./core/steam-search.cjs');
const {findLocalPortrait,findEpicPortrait}=require('./core/nonsteam-artwork.cjs');
const {WindowsActivityTracker}=require('./core/windows-activity.cjs');
const {backgroundWindow}=require('./core/background-window.cjs');
const {sessionClock}=require('./core/session-clock.cjs');
const {pendingFinishes}=require('./core/pending-finishes.cjs');
const {createUpdateService}=require('./core/updates.cjs');
const {catalogMatch,identifyGame}=require('./core/game-identity.cjs');
const {createPortableBackup,decodePortableBackup,installBackupArtwork,cleanupUnusedBackupArtwork,writeAtomic,validateSessionHistory,validHistoryId,MAX_ARCHIVE}=require('./core/backup.cjs');

protocol.registerSchemesAsPrivileged([{scheme:'orbit-art',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
if(!app.requestSingleInstanceLock())app.quit();
let win,db,scanning=false,activityTracker=null,libraryRevision=0,tray=null,initialized=false,updateService=null,restoringLibrary=false;
const background=backgroundWindow({close:()=>win?.destroy(),show:()=>{if(!win||win.isDestroyed())createWindow();else {if(win.isMinimized())win.restore();win.show();win.focus();}}});
const fullscreenController=new FullscreenController(()=>win);
const sessions=new Map(),sessionClocks=new Map();
const directFinishes=pendingFinishes({
 finish:(session,seconds)=>{if(!db)throw Error('Game library is unavailable.');return db.finishSession(session,seconds);},
 onSuccess:id=>{if(db)gamesChanged({games:[db.get(id)],reason:'playtime'});},
 onError:(_id,error)=>broadcast({type:'error',message:`Could not save play time; retrying: ${error.message}`})
});
let checkpointTimer=null,guardTimer=null;
const pendingLaunches=new Set();
const artworkWork=new ArtworkWork();
const iconWork=new ArtworkWork({concurrency:2});
const artworkEditRevisions=new Map();
const onlineArtwork=()=>{const settings=db?.getSettings();return !!settings?.useSteamArtwork&&!(settings.performanceGuard&&runningGameIds().length>0);};
function requireOnlineArtwork(){
  const settings=db?.getSettings();
  if(!settings?.useSteamArtwork)throw Error('Enable online artwork in Settings first.');
  if(settings.performanceGuard&&runningGameIds().length>0)throw Error('Online artwork is paused by Performance Guard while a game is running.');
}
const artIdentity=game=>JSON.stringify([game.name,game.source,game.source_id,game.executable,game.install_path,game.launch_uri]);
const artworkRevision=game=>artworkEditRevisions.get(game.id)||0;
function currentArtworkGame(game,revision){
  if(!db||artworkRevision(game)!==revision)return null;
  const current=db.get(game.id);
  return current&&artIdentity(current)===artIdentity(game)?current:null;
}
const artworkRequests=games=>games.map(game=>({game,revision:artworkRevision(game)}));
const displayVersion=()=>app.getVersion().replace(/\+(\d+)$/,'.$1');
const artworkDir=()=>path.join(app.getPath('userData'),'artwork');
function decodableArtwork(bytes){
  const dims=imageDimensions(bytes);
  if(!dims||dims.width>4096||dims.height>4096)return false;
  try{return !!nativeImage&&!nativeImage.createFromBuffer(bytes).isEmpty();}catch{return false;}
}
const broadcast=payload=>{if(win&&!win.isDestroyed())win.webContents.send('orbit:event',payload)};
const runningGameIds=()=>[...new Set([...sessions.keys(),...(activityTracker?.runningIds()||[])])];
function checkpointPlaytime(){
 if(!db)return;
 directFinishes.flush();
 const records=[...sessions].map(([id,sessionId])=>({id:sessionId,seconds:sessionClocks.get(id)?.seconds()||0}));
 records.push(...(activityTracker?.checkpoints()||[]));
 if(records.length)try{db.checkpointSessions(records);}catch(error){broadcast({type:'error',message:'Playtime checkpoint could not be saved: '+error.message});}
}
function performanceGuard(){
 if(process.platform!=='win32'||!tray||!db?.getSettings().performanceGuard||!win||win.isDestroyed())return;
 if(guardTimer)clearTimeout(guardTimer);
 guardTimer=setTimeout(()=>{
  guardTimer=null;
  if(runningGameIds().length&&db?.getSettings().performanceGuard&&tray&&win&&!win.isDestroyed())win.hide();
 },1200);
 guardTimer.unref?.();
}
function authorizedSender(event){
 // Real Electron IPC always includes a sender and frame. Stand-in harnesses
 // omit them; never permit their omission in a packaged build.
 if(!event?.sender)return !app.isPackaged;
 if(!win||win.isDestroyed()||event.sender!==win.webContents)return false;
 if(!event.senderFrame)return !app.isPackaged;
 return event.senderFrame===win.webContents.mainFrame;
}
const librarySnapshot=()=>({games:db.list(),runningIds:runningGameIds(),revision:libraryRevision});
function gamesChanged({games=[],removedIds=[],reason='',reset=false}={}){
  const event={type:'gamesChanged',reason,revision:++libraryRevision,runningIds:runningGameIds()};
  if(!reset){event.games=games.filter(Boolean);event.removedIds=removedIds;}
  broadcast(event);
}
const okId=validHistoryId;
function createWindow(){
  win=new BrowserWindow({width:1440,height:920,minWidth:910,minHeight:610,backgroundColor:'#101016',title:'Orbit Launcher',icon:path.join(__dirname,'../assets/icon.png'),show:false,
    titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',
    autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:process.argv.includes('--dev')}
  });
  win.on('close',event=>background.onClose(event,!!tray));
  win.on('closed',()=>{win=null;});
  win.once('ready-to-show',()=>win.show());
  win.loadFile(path.join(__dirname,'ui/index.html'));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event)=>event.preventDefault());
  win.webContents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown'||input.key!=='F11'||input.control||input.meta||input.alt||input.shift)return;
    event.preventDefault();
    if(!input.isAutoRepeat)broadcast({type:'toggleControllerMode'});
  });
  win.on('enter-full-screen',()=>broadcast({type:'windowState',fullscreen:true}));
  win.on('leave-full-screen',()=>broadcast({type:'windowState',fullscreen:false}));
}
async function imageFromDialog(){
  const result=await dialog.showOpenDialog(win,{title:'Choose game artwork',properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp']}]});
  if(result.canceled||!result.filePaths[0])return null;
  return saveArtwork(result.filePaths[0]);
}
async function saveArtwork(file){
  const stat=await fsp.stat(file);if(!stat.isFile()||stat.size>15*1024*1024)throw Error('Choose an image smaller than 15 MB.');
  const ext=path.extname(file).toLowerCase();if(!['.png','.jpg','.jpeg','.webp'].includes(ext))throw Error('Choose PNG, JPEG or WebP artwork.');
  const fh=await fsp.open(file,'r');let buf;try{buf=Buffer.alloc(12);await fh.read(buf,0,12,0)}finally{await fh.close()}
  const valid=ext==='.png'?buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):
    ext==='.webp'?buf.subarray(0,4).toString()==='RIFF'&&buf.subarray(8,12).toString()==='WEBP':buf.subarray(0,3).equals(Buffer.from('ffd8ff','hex'));
  if(!valid)throw Error('Image format does not match the file extension.');
  // Nearby artwork may be detected every time the user opens the editor.
  // Stable, content-derived names keep repeated detections from leaking files.
  const bytes=await fsp.readFile(file);
  if(bytes.length!==stat.size)throw Error('Artwork changed while it was being read. Try again.');
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const target=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}${ext}`;
  await fsp.mkdir(artworkDir(),{recursive:true});
  try{await fsp.writeFile(path.join(artworkDir(),target),bytes,{flag:'wx'});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  return target;
}
async function extractNativeIcon(executable,isRelevant=()=>true){
  if(typeof app.getFileIcon!=='function')return '';
  const image=await app.getFileIcon(executable,{size:process.platform==='darwin'?'normal':'large'});
  if(!isRelevant()||!image||image.isEmpty())return '';
  const bytes=image.toPNG();
  if(bytes.length<8||bytes.length>2*1024*1024||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return '';
  // Deterministic asset name prevents repeated picks from filling disk with
  // copies of the same icon and stays compatible with the existing art URL.
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const file=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}.png`;
  await fsp.mkdir(artworkDir(),{recursive:true});
  if(!isRelevant())return '';
  try{await fsp.writeFile(path.join(artworkDir(),file),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  return file;
}
function steamArtworkRoots(game){
  const roots=steamRoots();
  if(game?.source==='steam'&&game.install_path&&path.isAbsolute(game.install_path)){
    const common=path.dirname(path.resolve(game.install_path)),apps=path.dirname(common);
    if(path.basename(common).toLowerCase()==='common'&&path.basename(apps).toLowerCase()==='steamapps')roots.unshift(path.dirname(apps));
  }
  return [...new Set(roots)].slice(0,12);
}
async function downloadSteamArtwork(appId,kind,{roots=steamRoots(),isRelevant=()=>true}={}){
  const online=onlineArtwork();
  return artworkWork.run(`${kind}:${appId}:${online?'online':'local'}:${JSON.stringify(roots)}`,async needed=>{
    if(!db||!needed())return ArtworkWork.CANCELLED;
    const lookup=kind==='banner'?findSteamBanner:findSteamCover;
    let interrupted=false;
    const networkAllowed=()=>{
      const enabled=onlineArtwork();
      if(online&&!enabled)interrupted=true;
      return online&&enabled&&needed();
    };
    const bytes=await lookup(appId,{roots,online:networkAllowed});
    if(!needed())return ArtworkWork.CANCELLED;
    if(!bytes&&(interrupted||(online&&!onlineArtwork())))return ArtworkWork.CANCELLED;
    if(!bytes)return '';
    const digest=crypto.createHash('sha256').update(bytes).digest('hex');
    const filename=`${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}.jpg`;
    await fsp.mkdir(artworkDir(),{recursive:true});
    if(!needed())return ArtworkWork.CANCELLED;
    try{await fsp.writeFile(path.join(artworkDir(),filename),bytes,{flag:'wx'});}
    catch(e){if(e.code!=='EEXIST')throw e;}
    return needed()?filename:ArtworkWork.CANCELLED;
  },{isRelevant:()=>!!db&&isRelevant()});
}
async function downloadSteamCover(appId,options){return downloadSteamArtwork(appId,'cover',options);}
async function downloadEpicCover(game,{isRelevant=()=>true}={}){
  return artworkWork.run(`epic-cover:${JSON.stringify([game.source_id,game.launch_uri,game.name])}`,async needed=>{
    if(!onlineArtwork())return ArtworkWork.CANCELLED;
    let interrupted=false;
    const online=()=>{if(!onlineArtwork())interrupted=true;return onlineArtwork()&&needed();};
    const result=await findEpicPortrait(game,{online,validate:decodableArtwork});
    if(!needed()||interrupted||!onlineArtwork())return ArtworkWork.CANCELLED;
    if(!result)return '';
    const hash=crypto.createHash('sha256').update(result.bytes).digest('hex');
    const name=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}${result.ext}`;
    await fsp.mkdir(artworkDir(),{recursive:true});
    if(!needed())return ArtworkWork.CANCELLED;
    try{await fsp.writeFile(path.join(artworkDir(),name),result.bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
    return needed()?name:ArtworkWork.CANCELLED;
  },{isRelevant:()=>onlineArtwork()&&isRelevant()});
}
async function steamIdFor(game,revision=artworkRevision(game)){
  if(game.source==='steam')return game.source_id;
  const known=catalogMatch(game.name)?.steamId;
  if(known)return known;
  // Existing library entries can still be named after a generic launcher or
  // a user label. Only recognized standalone executables/folders contribute.
  if(game.executable){const identity=identifyGame(game.executable);if(identity.steamId)return identity.steamId;}
  if(!onlineArtwork())return '';
  const match=await artworkWork.run(`title:${String(game.name).trim().toLocaleLowerCase()}`,async needed=>{
    if(!onlineArtwork())return ArtworkWork.CANCELLED;
    const result=await findExactSteamApp(game.name);
    return needed()?result:ArtworkWork.CANCELLED;
  },{isRelevant:()=>onlineArtwork()&&!!currentArtworkGame(game,revision)});
  return match?.steamId||'';
}
async function coverNeedsPortrait(game){
  if(!game.cover)return true;
  if(!/^[a-f0-9-]{36}\.(?:jpg|jpeg|png|webp)$/i.test(game.cover))return false;
  try {
    const file=path.join(artworkDir(),game.cover);
    const info=await fsp.stat(file);
    if(!info.isFile()||info.size>15*1024*1024)return false;
    return !isPortraitArtwork(await fsp.readFile(file));
  }catch{return true;} // Image deleted on disk: restore it when possible.
}
async function cacheGameIcon(game,revision=artworkRevision(game)){
  if(game.icon||(!game.executable&&!game.install_path))return false;
  if(!currentArtworkGame(game,revision))return false;
  const key=JSON.stringify(['icon',game.source,game.source_id,game.executable,game.install_path,game.name]);
  const icon=await iconWork.run(key,async needed=>{
    const executable=await findGameExecutable(game,{platform:process.platform});
    if(!needed())return ArtworkWork.CANCELLED;
    let token='';
    if(executable)try{token=await extractNativeIcon(executable,needed)}catch{}
    if(!needed())return ArtworkWork.CANCELLED;
    if(!token&&game.source==='steam'){
      const cached=await localSteamIcon(game.source_id,{roots:steamArtworkRoots(game)});
      if(!needed())return ArtworkWork.CANCELLED;
      if(cached)try{token=await saveArtwork(cached)}catch{}
    }
    return needed()?token:ArtworkWork.CANCELLED;
  },{isRelevant:()=>!!currentArtworkGame(game,revision)});
  if(!icon||!db)return false;
  const current=db.get(game.id);
  if(!current||current.icon||artIdentity(current)!==artIdentity(game)||(artworkEditRevisions.get(game.id)||0)!==revision)return false;
  const updated=db.update(game.id,{icon});
  gamesChanged({games:[updated],reason:'artwork'});
  return true;
}
async function repairMissingSteamCovers({limit=100,replaceLandscape=false}={}){
  const online=db.getSettings().useSteamArtwork;let paused=!!online&&!onlineArtwork();
  const candidates=[],snapshot=artworkRequests(db.list());
  for(const {game,revision} of snapshot){
    if(candidates.length>=limit)break;
    const needCover=!game.cover||(replaceLandscape&&await coverNeedsPortrait(game));
    const needIcon=!game.icon&&!!(game.executable||game.install_path);
    if((needCover||needIcon)&&currentArtworkGame(game,revision))candidates.push({game,needCover,needIcon,revision});
  }
  let found=0,icons=0;
  for(let i=0;i<candidates.length;i+=3){
    const results=await Promise.allSettled(candidates.slice(i,i+3).map(async ({game,needCover,needIcon,revision})=>{
      let updatedCover=false,updatedIcon=false;
      if(!currentArtworkGame(game,revision))return {updatedCover,updatedIcon};
      if(needCover){
        try{await cachedSteamCover(game,{replaceLandscape,revision})}catch{}
        const current=currentArtworkGame(game,revision);
        updatedCover=!!current?.cover&&current.cover!==game.cover;
      }
      if(needIcon&&currentArtworkGame(game,revision)){
        try{updatedIcon=await cacheGameIcon(game,revision)}catch{}
      }
      return {updatedCover,updatedIcon};
    }));
    for(const result of results)if(result.status==='fulfilled'){
      if(result.value.updatedCover)found++;
      if(result.value.updatedIcon)icons++;
    }
    if(db?.getSettings().useSteamArtwork&&!onlineArtwork())paused=true;
  }
  return {found,icons,attempted:candidates.length,disabled:false,onlineEnabled:!!db?.getSettings().useSteamArtwork,paused};
}
async function cachedSteamCover(game,{replaceLandscape=false,revision=artworkRevision(game)}={}){
  if(game.cover&&!replaceLandscape)return;
  if(!currentArtworkGame(game,revision))return;
  let filename='';
  if(game.source!=='steam'){
    const local=await findLocalPortrait(game,{validate:decodableArtwork});
    if(local&&currentArtworkGame(game,revision))try{filename=await saveArtwork(local)}catch{}
    if(!filename&&game.source==='epic'&&onlineArtwork()&&currentArtworkGame(game,revision)){
      filename=await downloadEpicCover(game,{isRelevant:()=>!!currentArtworkGame(game,revision)});
    }
  }
  if(!filename&&currentArtworkGame(game,revision)){
    const appId=await steamIdFor(game,revision);
    if(appId&&currentArtworkGame(game,revision))filename=await downloadSteamCover(appId,{roots:steamArtworkRoots(game),isRelevant:()=>!!currentArtworkGame(game,revision)});
  }
  if(!filename||!db)return;
  const needsCover=!game.cover||(replaceLandscape&&await coverNeedsPortrait(game));
  const current=db.get(game.id);
  // User edits always win over artwork work already waiting on disk/network.
  if(needsCover&&current&&artIdentity(current)===artIdentity(game)&&(artworkEditRevisions.get(game.id)||0)===revision&&current.cover===game.cover){
    const updated=db.update(game.id,{cover:filename});
    gamesChanged({games:[updated],reason:'artwork'});
  }
}
async function cachedSteamBanner(game,revision=artworkRevision(game)){
  if(game.banner)return;
  if(!currentArtworkGame(game,revision))return;
  const appId=await steamIdFor(game,revision);if(!appId||!currentArtworkGame(game,revision))return;
  const banner=await downloadSteamArtwork(appId,'banner',{roots:steamArtworkRoots(game),isRelevant:()=>!!currentArtworkGame(game,revision)});
  if(!banner||!db)return;
  const current=db.get(game.id);
  if(current&&!current.banner&&artIdentity(current)===artIdentity(game)&&(artworkEditRevisions.get(game.id)||0)===revision){
    const updated=db.update(game.id,{banner});gamesChanged({games:[updated],reason:'artwork'});
  }
}
async function cacheCoverAndBanner(game,revision=artworkRevision(game)){
  if(!currentArtworkGame(game,revision))return;
  await cachedSteamCover(game,{revision}).catch(()=>{});
  // Banners support the hero without ever reusing a wide image as a cover.
  const current=currentArtworkGame(game,revision);
  if(current&&(current.last_played_at||db.count()<=3))await cachedSteamBanner(current,revision).catch(()=>{});
}
async function enrichGameArtwork(game){
  await Promise.allSettled([cacheCoverAndBanner(game),cacheGameIcon(game)]);
}
function queueArtwork(requests){
  const run=async work=>{
    for(let i=0;db&&i<requests.length;i+=3){
      await Promise.allSettled(requests.slice(i,i+3).map(({game,revision})=>{
        return currentArtworkGame(game,revision)?work(game,revision):null;
      }));
    }
  };
  // Local icons stay responsive even when online cover requests are slow.
  run(cacheGameIcon).catch(()=>{});
  run(cacheCoverAndBanner).catch(()=>{});
}

async function discover(){
  if(scanning)throw Error('A library scan is already running.');
  scanning=true;broadcast({type:'scanStarted'});
  try{
    const result=await discoverAll(db.getSettings(),{downloadsPath:app.getPath('downloads')});
    const library=db.list();
    const games=reconcileDiscoveredGames(library,result.games,process.platform);
    broadcast({type:'scanFinished',count:games.length});return {games,warnings:result.warnings,diagnostics:result.diagnostics||[]};
  }finally{scanning=false;}
}
function handlers(){
  const bind=(name,fn)=>ipcMain.handle('orbit:'+name,async(event, ...args)=>{try{if(!authorizedSender(event))throw Error('Untrusted IPC sender.');return await fn(...args)}catch(e){throw new Error(e?.message||'Unexpected error.')}});
  bind('getWindowState',()=>fullscreenController.get());
  bind('getUpdateStatus',()=>updateService?.getStatus()||{state:'idle'});
  bind('checkForUpdates',()=>updateService?.check({manual:true})||{state:'unsupported'});
  bind('installUpdate',()=>updateService?.install());
  bind('setFullscreen',enabled=>fullscreenController.set(enabled));
  bind('bootstrap',()=>({...librarySnapshot(),settings:db.getSettings(),platform:process.platform,version:displayVersion()}));
  bind('librarySnapshot',librarySnapshot);
  bind('listGames',()=>db.list());
  bind('getStatistics',options=>db.getStatistics(options));
  bind('runningGames',runningGameIds);
  bind('getGame',id=>{if(!okId(id))throw Error('Invalid game identifier.');return db.get(id)});
  bind('addGame',data=>{const result=db.upsert(data);gamesChanged({games:[result.game],reason:'add'});if(result.added)enrichGameArtwork(result.game).catch(()=>{});return result});
  bind('updateGame',(id,patch)=>{if(!okId(id))throw Error('Invalid game identifier.');const result=db.update(id,patch);artworkEditRevisions.set(id,(artworkEditRevisions.get(id)||0)+1);gamesChanged({games:[result],reason:'edit'});return result});
  bind('removeGame',id=>{if(!okId(id))throw Error('Invalid game identifier.');const found=db.remove(id);if(found){artworkEditRevisions.delete(id);gamesChanged({removedIds:[id],reason:'remove'});}return found});
  bind('favoriteGame',id=>{if(!okId(id))throw Error('Invalid game identifier.');const result=db.toggleFavorite(id);gamesChanged({games:[result],reason:'favorite'});return result});
  bind('saveSettings',patch=>{const settings=db.saveSettings(patch||{});nativeTheme.themeSource=settings.theme;broadcast({type:'settingsChanged',settings});return settings});
  bind('chooseExecutable',async()=>{const result=await dialog.showOpenDialog(win,{title:'Choose game executable',properties:['openFile'],filters:process.platform==='win32'?[{name:'Programs',extensions:['exe','com']},{name:'All files',extensions:['*']}]:[{name:'All files',extensions:['*']}]});return result.canceled?null:result.filePaths[0]});
  bind('inspectGameFile',executable=>inspectGameFile(executable,{
    saveArtwork,extractIcon:extractNativeIcon,
    lookupCover:async ({name,steamId})=>{
      const id=steamId||(onlineArtwork()?(await findExactSteamApp(name))?.steamId:'');
      return id?downloadSteamCover(id):'';
    }
  }));
  bind('findOnlineCover',async title=>{
    requireOnlineArtwork();
    if(typeof title!=='string'||!title.trim()||title.length>140||Array.from(title).some(c=>c.charCodeAt(0)<32))throw Error('Enter a valid game title.');
    artworkWork.clearMisses();
    const name=title.trim(),known=catalogMatch(name);
    const match=known?.steamId?{name:known.name,steamId:known.steamId}:await findExactSteamApp(name);
    if(match){const cover=await downloadSteamCover(match.steamId);if(cover)return {cover,matchedName:match.name,message:'Cover found on Steam.'};}
    requireOnlineArtwork();
    const cover=await downloadEpicCover({source:'epic',source_id:'',launch_uri:'',name});
    if(!cover)requireOnlineArtwork();
    return cover?{cover,matchedName:name,message:'Cover found on Epic Games.'}:
      {cover:'',message:'No exact cover found on Steam or Epic Games. Check the title or choose an image manually.'};
  });
  bind('chooseArtwork',imageFromDialog);
  bind('chooseFolder',async()=>{const result=await dialog.showOpenDialog(win,{title:'Choose game library folder',properties:['openDirectory']});return result.canceled?null:result.filePaths[0]});
  bind('discoverGames',discover);
  bind('repairSteamArtwork',async()=>{artworkWork.clear();iconWork.clear();const result=await repairMissingSteamCovers({limit:300,replaceLandscape:true});if(db){const featured=db.list('recent').slice(0,6);for(const game of featured)await cachedSteamBanner(game).catch(()=>{});}return result;});
  bind('importGames',async games=>{
    if(!Array.isArray(games)||games.length>10000)throw Error('Invalid import batch.');
    let imported=0,skipped=0;const artwork=[];const errors=[];
    // Local icons are useful even when Steam downloads are turned off.
    for(let i=0;i<games.length;i+=50){
      const batch=db.upsertBatch(games.slice(i,i+50));
      imported+=batch.imported;skipped+=batch.skipped;errors.push(...batch.errors);
      artwork.push(...artworkRequests(batch.addedGames));
      await new Promise(resolve=>setImmediate(resolve));
    }
    gamesChanged({reset:true,reason:'import'});
    queueArtwork(artwork);
    return {imported,skipped,errors};
  });
  bind('launchGame',async id=>{
    if(!okId(id))throw Error('Invalid game identifier.');const game=db.get(id);if(!game)throw Error('Game was removed.');
    // A process can take time to emit "spawn". Reserve the game ID before
    // awaiting it so double-clicks cannot launch two copies concurrently.
    if(sessions.has(id)||pendingLaunches.has(id)||directFinishes.has(id)||activityTracker?.isRunning(id))throw Error('This game is already launching, running, or saving a tracked session.');
    pendingLaunches.add(id);
    try{
      let sessionId=null;
      const exit=deferredExit(()=>{
        if(!sessionId||!db)return;
        const seconds=sessionClocks.get(id)?.seconds()||0;
        sessions.delete(id);sessionClocks.delete(id);
        directFinishes.add(id,sessionId,seconds);
      });
      const result=await executeGame(game,url=>shell.openExternal(url),exit.onExit);
      if(result.tracked){
        try{sessionId=db.startSession(id);sessions.set(id,sessionId);sessionClocks.set(id,sessionClock());exit.ready();performanceGuard();}
        catch(e){
          // Launch succeeded; never report it as a failed launch if recording
          // play time fails after the process has already started.
          broadcast({type:'error',message:`Game launched, but play time could not be tracked: ${e.message}`});
          return {...result,tracked:false,message:'Game launched. Play-time tracking could not start.'};
        }
      }else{
        db.db.prepare('UPDATE games SET last_played_at=?,updated_at=? WHERE id=?').run(new Date().toISOString(),new Date().toISOString(),id);
        if(result.mode==='external'&&activityTracker){
          const watchable=!!(game.executable||(['steam','epic'].includes(game.source)&&game.install_path));
          result.message=watchable?'Opened in the launcher. Orbit will track play time when it detects the game process.':'Opened in the launcher. Add the actual game executable to track play time.';
        }else if(result.mode==='external')result.message='Opened in the launcher. Play-time tracking is unavailable for this launch on this platform.';
      }
      gamesChanged({games:[db.get(id)],reason:'launch'});
      cachedSteamBanner(db.get(id)).catch(()=>{});
      return result;
    }finally{pendingLaunches.delete(id);if(activityTracker?.noteLaunch)activityTracker.noteLaunch();else activityTracker?.poll?.().catch(()=>{});}
  });
  bind('openGameFolder',async id=>{if(!okId(id))throw Error('Invalid game identifier.');const game=db.get(id);if(!game)throw Error('Game not found.');const dir=game.install_path|| (game.executable?path.dirname(game.executable):'');if(!dir||!path.isAbsolute(dir)||!fs.existsSync(dir)||!fs.statSync(dir).isDirectory())throw Error('Installation folder is unavailable.');const error=await shell.openPath(dir);if(error)throw Error(error);return true});
  bind('openAppData',async()=>{const error=await shell.openPath(app.getPath('userData'));if(error)throw Error(error);return true});
  bind('exportLibrary',async()=>{
    const result=await dialog.showSaveDialog(win,{title:'Export Orbit library',defaultPath:`Orbit-Library-${new Date().toISOString().slice(0,10)}.orbit`,filters:[{name:'Portable Orbit backup (includes artwork)',extensions:['orbit']},{name:'Metadata only (JSON)',extensions:['json']} ]});
    if(result.canceled||!result.filePath)return null;
    const payload=db.exportBackup();
    if(path.extname(result.filePath).toLowerCase()==='.json'){
      const encoded=JSON.stringify(payload,null,2);
      if(Buffer.byteLength(encoded,'utf8')>MAX_ARCHIVE)throw Error('JSON backup exceeds the 128 MB restore limit; no incomplete export was saved.');
      await writeAtomic(result.filePath,encoded);
      return {path:result.filePath,count:payload.games.length,portable:false};
    }
    const archive=await createPortableBackup(payload,artworkDir());
    await writeAtomic(result.filePath,archive.bytes);
    return {path:result.filePath,count:payload.games.length,portable:true,artworkCount:archive.artworkCount,missingArtwork:archive.missingArtwork};
  });
  bind('restoreLibrary',async()=>{
    if(restoringLibrary)throw Error('An Orbit backup restore is already in progress.');
    restoringLibrary=true;
    try {
    const selected=await dialog.showOpenDialog(win,{title:'Restore Orbit library',properties:['openFile'],filters:[{name:'Orbit backups',extensions:['orbit','json']} ]});
    if(selected.canceled||!selected.filePaths[0])return null;
    const file=selected.filePaths[0],stat=await fsp.stat(file);
    if(!stat.isFile()||stat.size>MAX_ARCHIVE)throw Error('Backup exceeds the 128 MB limit.');
    let data,portableArtwork=new Map();
    if(path.extname(file).toLowerCase()==='.orbit'){
      const archive=decodePortableBackup(await fsp.readFile(file));
      data=archive.library;
      portableArtwork=archive.assets;
    }else{
      try{data=JSON.parse(await fsp.readFile(file,'utf8'))}catch{throw Error('Backup is not valid JSON.');}
    }
    if(data?.format!=='orbit.library.v1'||!Array.isArray(data.games)||data.games.length>100000)throw Error('Unrecognized Orbit backup format.');
    const withSessions=Object.hasOwn(data,'sessions');
    validateSessionHistory(data);
    if(withSessions)for(const game of data.games)cleanGame(game);
    const createdArtwork=new Map();
    let restoreFailure;
    const cleanupRestoreArtwork=async()=>{
      if(!createdArtwork.size)return;
      try{await cleanupUnusedBackupArtwork(createdArtwork,artworkDir(),db.list());}
      catch(error){
        if(!restoreFailure)throw error;
        // Preserve the original restore failure while reporting cleanup errors.
        restoreFailure.message+=` (Artwork cleanup also failed: ${error.message})`;
      }
    };
    try {
      const artworkMap=await installBackupArtwork(portableArtwork,artworkDir(),{created:createdArtwork});
      let imported=0,skipped=0;const errors=[];
      const preparedGames=[];
      for(let i=0;i<data.games.length;i++){
        const g=data.games[i];
        try{
          const artworkName=async name=>{
            if(artworkMap.has(name))return artworkMap.get(name);
            return typeof name==='string'&&/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp)$/.test(name)&&await fsp.stat(path.join(artworkDir(),name)).catch(()=>null)?name:'';
          };
          const clean={...g,cover:await artworkName(g?.cover),banner:await artworkName(g?.banner),icon:await artworkName(g?.icon)};
          if(withSessions)preparedGames.push(clean);
          else{const res=db.restoreGame(clean);if(res.added)imported++;else skipped++;}
        }catch(e){if(withSessions)throw e;errors.push(`${String(g?.name||'Entry').slice(0,80)}: ${e.message}`)}
        if(i%50===49)await new Promise(resolve=>setImmediate(resolve));
      }
      let sessionsImported=0,sessionsSkipped=0;
      if(withSessions){
        const result=db.restoreBackupGames({...data,games:preparedGames});
        ({imported,skipped,sessionsImported,sessionsSkipped}=result);
      }
      let settingsRestored=false;
      if(data.settings&&typeof data.settings==='object'&&!Array.isArray(data.settings)){
        try{const settings=db.saveSettings(data.settings);nativeTheme.themeSource=settings.theme;settingsRestored=true;broadcast({type:'settingsChanged',settings});}
        catch(e){errors.push(`Settings: ${e.message}`)}
      }
      gamesChanged({reset:true,reason:'restore'});return {imported,skipped,errors,settingsRestored,sessionsImported,sessionsSkipped};
    } catch(error) {
      restoreFailure=error;
      throw error;
    } finally {
      // The database restore can fail after artwork extraction, and legacy
      // imports may skip invalid games. Keep only art referenced by a
      // successfully restored game, without touching files that pre-existed.
      await cleanupRestoreArtwork();
    }
    } finally {restoringLibrary=false;}
  });
  bind('getAppInfo',()=>({platform:process.platform,version:displayVersion(),dataPath:app.getPath('userData')}));
}
app.on('second-instance',()=>{if(initialized)background.open();});
app.whenReady().then(async()=>{
  try{db=new LibraryDatabase(path.join(app.getPath('userData'),'library.sqlite'));}
  catch(error){dialog.showErrorBox('Cannot open game library',`The database could not be opened: ${error.message}\n\nYour existing data has not been deleted. Location: ${app.getPath('userData')}`);app.quit();return}
  try{db.recoverInterruptedSessions();}catch(error){dialog.showErrorBox('Playtime recovery warning',`Orbit could not finish interrupted playtime records: ${error.message}`);}
  await fsp.mkdir(artworkDir(),{recursive:true});
  protocol.handle('orbit-art',request=>{
    try{const url=new URL(request.url);const filename=decodeURIComponent(url.pathname).replace(/^\//,'');
      if(url.hostname!=='file'||! /^[a-f0-9-]{36}\.(png|jpg|jpeg|webp)$/.test(filename))return new Response('Not found',{status:404});
      return net.fetch(pathToFileURL(path.join(artworkDir(),filename)).href);
    }catch{return new Response('Not found',{status:404})}
  });
  handlers();nativeTheme.themeSource=db.getSettings().theme;
  updateService=createUpdateService({app,emit:broadcast,getSettings:()=>db.getSettings(),hasRunningGames:()=>runningGameIds().length>0});
  updateService.initialize();
  if(process.platform==='win32'&&typeof Tray==='function'&&Menu){
    try{tray=new Tray(path.join(__dirname,'../assets/icon.ico'));tray.setToolTip('Orbit — tracking playtime');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Orbit',click:()=>background.open()},{label:'Quit Orbit',click:()=>{background.quit();app.quit();}}]));tray.on('click',()=>background.open());}
    catch{tray=null;}
  }
  initialized=true;
  createWindow();
  if(process.platform==='win32'){
    activityTracker=new WindowsActivityTracker({
      listGames:()=>db.listActivityGames(),isDirectSession:id=>sessions.has(id)||pendingLaunches.has(id)||directFinishes.has(id),
      start:id=>db.startSession(id),finish:(sessionId,seconds)=>db.finishSession(sessionId,seconds),
      onChange:ids=>{gamesChanged({games:ids.map(id=>db.get(id)),reason:'playtime'});if(ids.some(id=>activityTracker?.isRunning(id)))performanceGuard();},
      onError:error=>broadcast({type:'error',message:'Windows playtime detection is temporarily unavailable: '+error.message})
    });
    activityTracker.start();
  }
  setTimeout(()=>{if(db?.getSettings().autoUpdates)updateService?.check().catch(()=>{});},20000).unref?.();
  if(typeof setInterval==='function'){checkpointTimer=setInterval(checkpointPlaytime,60000);checkpointTimer.unref?.();}
  powerMonitor?.on?.('suspend',()=>{checkpointPlaytime();for(const clock of sessionClocks.values())clock.pause();activityTracker?.suspend();});
  powerMonitor?.on?.('resume',()=>{for(const clock of sessionClocks.values())clock.resume();activityTracker?.resume();});
  setTimeout(async()=>{if(!db||runningGameIds().length&&db.getSettings().performanceGuard)return;await repairMissingSteamCovers({limit:30}).catch(()=>{});if(db)for(const game of db.list('recent').slice(0,3))await cachedSteamBanner(game).catch(()=>{});},2500);
  if(db.getSettings().autoScan)setTimeout(async()=>{
    try{
      if(!db)return;
      const result=await discover();
      const imported=result.games.filter(game=>!game.alreadyAdded&&!game.downloadCandidate),added=[];
      if(!imported.length)return;
      for(let i=0;i<imported.length;i+=50){
        if(!db)return;
        added.push(...artworkRequests(db.upsertBatch(imported.slice(i,i+50)).addedGames));
        await new Promise(resolve=>setImmediate(resolve));
      }
      if(!db)return;
      gamesChanged({reset:true,reason:'autoScan'});
      queueArtwork(added);
    }catch(e){broadcast({type:'error',message:`Background scan failed: ${e.message}`})}
  },1000);
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});
});
app.on('before-quit',()=>{
  background.quit();
  updateService?.dispose();
  if(checkpointTimer)clearInterval(checkpointTimer);
  if(guardTimer)clearTimeout(guardTimer);
  checkpointPlaytime();
  activityTracker?.stop();activityTracker=null;
  if(db){
    for(const [id,session] of sessions)directFinishes.add(id,session,sessionClocks.get(id)?.seconds()||0);
    sessions.clear();sessionClocks.clear();directFinishes.flush();
    db.close();db=null;
  }
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin'&&!tray)app.quit()});

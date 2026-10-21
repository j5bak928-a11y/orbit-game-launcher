'use strict';
const {app,BrowserWindow,dialog,ipcMain,shell,protocol,net,nativeTheme}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const fsp=fs.promises;
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {LibraryDatabase}=require('./core/database.cjs');
const {discoverAll}=require('./core/discovery.cjs');
const {launchGame:executeGame,deferredExit}=require('./core/launch.cjs');
const {findSteamCover}=require('./core/steam-cover.cjs');
const {isPortraitArtwork}=require('./core/cover-shape.cjs');
const {inspectGameFile}=require('./core/game-file.cjs');
const {findExactSteamApp}=require('./core/steam-search.cjs');
const {WindowsActivityTracker}=require('./core/windows-activity.cjs');
const {catalogMatch}=require('./core/game-identity.cjs');
const {createPortableBackup,decodePortableBackup,installBackupArtwork,writeAtomic,MAX_ARCHIVE}=require('./core/backup.cjs');

protocol.registerSchemesAsPrivileged([{scheme:'orbit-art',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
if(!app.requestSingleInstanceLock())app.quit();
let win,db,scanning=false,activityTracker=null;
const sessions=new Map();
const pendingLaunches=new Set();
const artworkDir=()=>path.join(app.getPath('userData'),'artwork');
const broadcast=payload=>{if(win&&!win.isDestroyed())win.webContents.send('orbit:event',payload)};
const okId=id=>typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id);
function createWindow(){
  win=new BrowserWindow({width:1440,height:920,minWidth:910,minHeight:610,backgroundColor:'#101016',title:'Orbit Launcher',icon:path.join(__dirname,'../assets/icon.png'),show:false,
    titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',
    autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:process.argv.includes('--dev')}
  });
  win.once('ready-to-show',()=>win.show());
  win.loadFile(path.join(__dirname,'ui/index.html'));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event)=>event.preventDefault());
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
async function extractNativeIcon(executable){
  if(typeof app.getFileIcon!=='function')return '';
  const image=await app.getFileIcon(executable,{size:'large'});
  if(!image||image.isEmpty())return '';
  const bytes=image.toPNG();
  if(bytes.length<8||bytes.length>2*1024*1024||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return '';
  // Deterministic asset name prevents repeated picks from filling disk with
  // copies of the same icon and stays compatible with the existing art URL.
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const file=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}.png`;
  await fsp.mkdir(artworkDir(),{recursive:true});
  try{await fsp.writeFile(path.join(artworkDir(),file),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  return file;
}
async function downloadSteamCover(appId){
  const bytes=await findSteamCover(appId);
  if(!bytes)return '';
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  const filename=`${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}.jpg`;
  await fsp.mkdir(artworkDir(),{recursive:true});
  try{await fsp.writeFile(path.join(artworkDir(),filename),bytes,{flag:'wx'});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  return filename;
}
async function coverNeedsPortrait(game){
  if(!game.cover)return true;
  if(!/^[a-f0-9-]{36}\\.(?:jpg|jpeg|png|webp)$/i.test(game.cover))return false;
  try {
    const file=path.join(artworkDir(),game.cover);
    const info=await fsp.stat(file);
    if(!info.isFile()||info.size>15*1024*1024)return false;
    return !isPortraitArtwork(await fsp.readFile(file));
  }catch{return true;} // Image deleted on disk: restore it when possible.
}
async function repairMissingSteamCovers({limit=100,replaceLandscape=false}={}){
  if(!db.getSettings().useSteamArtwork)return {found:0,attempted:0,disabled:true};
  const candidates=[];
  for(const game of db.list()){
    if(candidates.length>=limit)break;
    if(!game.cover||(replaceLandscape&&await coverNeedsPortrait(game)))candidates.push(game);
  }
  let found=0;
  for(let i=0;i<candidates.length;i+=3){
    const results=await Promise.allSettled(candidates.slice(i,i+3).map(async game=>{
      await cachedSteamCover(game,{replaceLandscape});
      const current=db.get(game.id);
      return !!current?.cover && current.cover!==game.cover;
    }));
    found+=results.filter(r=>r.status==='fulfilled'&&r.value).length;
  }
  return {found,attempted:candidates.length,disabled:false};
}
async function cachedSteamCover(game,{replaceLandscape=false}={}){
  if(!db.getSettings().useSteamArtwork || (game.cover&&!replaceLandscape))return;
  const appId=game.source==='steam'?game.source_id:(catalogMatch(game.name)?.steamId||(await findExactSteamApp(game.name))?.steamId);
  if(!appId)return;
  const filename=await downloadSteamCover(appId);
  if(!filename)return;
  const current=db.get(game.id);
  // Never replace a cover that changed while the network request was pending.
  if(current&&current.cover===game.cover&&(!current.cover||(replaceLandscape&&await coverNeedsPortrait(current)))){
    db.update(game.id,{cover:filename});
    broadcast({type:'gamesChanged',reason:'artwork'});
  }
}

async function discover(){
  if(scanning)throw Error('A library scan is already running.');
  scanning=true;broadcast({type:'scanStarted'});
  try{
    const result=await discoverAll(db.getSettings(),{downloadsPath:app.getPath('downloads')});
    const library=db.list();
    const knownSources=new Set(library.filter(g=>g.source_id).map(g=>`${g.source}:${g.source_id}`));
    const knownFiles=new Set(library.filter(g=>g.executable).map(g=>path.normalize(g.executable).toLowerCase()));
    const knownUris=new Set(library.filter(g=>g.launch_uri).map(g=>g.launch_uri.toLowerCase()));
    const games=result.games.map(g=>({...g,alreadyAdded:!!(
      (g.source_id&&knownSources.has(`${g.source}:${g.source_id}`)) ||
      (g.executable&&knownFiles.has(path.normalize(g.executable).toLowerCase())) ||
      (g.launch_uri&&knownUris.has(g.launch_uri.toLowerCase())))}));
    broadcast({type:'scanFinished',count:games.length});return {games,warnings:result.warnings};
  }finally{scanning=false;}
}
function handlers(){
  const bind=(name,fn)=>ipcMain.handle('orbit:'+name,async(_, ...args)=>{try{return await fn(...args)}catch(e){throw new Error(e?.message||'Unexpected error.')}});
  bind('bootstrap',()=>({games:db.list(),runningIds:activityTracker?.runningIds()||[],settings:db.getSettings(),platform:process.platform,version:app.getVersion()}));
  bind('listGames',()=>db.list());
  bind('runningGames',()=>activityTracker?.runningIds()||[]);
  bind('getGame',id=>{if(!okId(id))throw Error('Invalid game identifier.');return db.get(id)});
  bind('addGame',data=>{const result=db.upsert(data);broadcast({type:'gamesChanged'});if(result.added)cachedSteamCover(result.game);return result});
  bind('updateGame',(id,patch)=>{if(!okId(id))throw Error('Invalid game identifier.');const result=db.update(id,patch);broadcast({type:'gamesChanged'});return result});
  bind('removeGame',id=>{if(!okId(id))throw Error('Invalid game identifier.');const found=db.remove(id);broadcast({type:'gamesChanged'});return found});
  bind('favoriteGame',id=>{if(!okId(id))throw Error('Invalid game identifier.');const result=db.toggleFavorite(id);broadcast({type:'gamesChanged'});return result});
  bind('saveSettings',patch=>{const settings=db.saveSettings(patch||{});nativeTheme.themeSource=settings.theme;broadcast({type:'settingsChanged',settings});return settings});
  bind('chooseExecutable',async()=>{const result=await dialog.showOpenDialog(win,{title:'Choose game executable',properties:['openFile'],filters:process.platform==='win32'?[{name:'Programs',extensions:['exe','com']},{name:'All files',extensions:['*']}]:[{name:'All files',extensions:['*']}]});return result.canceled?null:result.filePaths[0]});
  bind('inspectGameFile',executable=>inspectGameFile(executable,{
    saveArtwork,extractIcon:extractNativeIcon,
    lookupCover:async ({name,steamId})=>{
      if(!db.getSettings().useSteamArtwork)return '';
      const id=steamId||(await findExactSteamApp(name))?.steamId;
      return id?downloadSteamCover(id):'';
    }
  }));
  bind('findOnlineCover',async title=>{
    if(!db.getSettings().useSteamArtwork)throw Error('Enable Steam artwork downloads in Settings first.');
    const match=await findExactSteamApp(title);
    if(!match)return {cover:'',message:'No exact title match was found on Steam. Try editing the game title or choosing artwork manually.'};
    const cover=await downloadSteamCover(match.steamId);
    return {cover,matchedName:match.name,message:cover?'Cover found on Steam.':'No cover available right now. Your game can still be added.'};
  });
  bind('chooseArtwork',imageFromDialog);
  bind('chooseFolder',async()=>{const result=await dialog.showOpenDialog(win,{title:'Choose game library folder',properties:['openDirectory']});return result.canceled?null:result.filePaths[0]});
  bind('discoverGames',discover);
  bind('repairSteamArtwork',()=>repairMissingSteamCovers({limit:300,replaceLandscape:true}));
  bind('importGames',async games=>{
    if(!Array.isArray(games)||games.length>10000)throw Error('Invalid import batch.');
    let imported=0,skipped=0;const artwork=[];const errors=[];
    const fetchArtwork=db.getSettings().useSteamArtwork;
    for(let i=0;i<games.length;i+=50){
      const batch=db.upsertBatch(games.slice(i,i+50));
      imported+=batch.imported;skipped+=batch.skipped;errors.push(...batch.errors);
      if(fetchArtwork)artwork.push(...batch.addedGames);
      await new Promise(resolve=>setImmediate(resolve));
    }
    broadcast({type:'gamesChanged',reason:'import'});
    (async()=>{for(let i=0;i<artwork.length;i+=3)await Promise.allSettled(artwork.slice(i,i+3).map(cachedSteamCover))})().catch(()=>{});
    return {imported,skipped,errors};
  });
  bind('launchGame',async id=>{
    if(!okId(id))throw Error('Invalid game identifier.');const game=db.get(id);if(!game)throw Error('Game was removed.');
    // A process can take time to emit "spawn". Reserve the game ID before
    // awaiting it so double-clicks cannot launch two copies concurrently.
    if(sessions.has(id)||pendingLaunches.has(id)||activityTracker?.isRunning(id))throw Error('This game is already launching or has a tracked session running.');
    pendingLaunches.add(id);
    try{
      let sessionId=null,startTime=0;
      const exit=deferredExit(()=>{
        if(!sessionId||!db)return;
        try{db.finishSession(sessionId,Math.floor((Date.now()-startTime)/1000));}
        catch(e){broadcast({type:'error',message:`Could not save play time: ${e.message}`})}
        sessions.delete(id);broadcast({type:'gamesChanged',reason:'playtime'});
      });
      const result=await executeGame(game,url=>shell.openExternal(url),exit.onExit);
      if(result.tracked){
        startTime=Date.now();
        try{sessionId=db.startSession(id);sessions.set(id,sessionId);exit.ready();}
        catch(e){
          // Launch succeeded; never report it as a failed launch if recording
          // play time fails after the process has already started.
          broadcast({type:'error',message:`Game launched, but play time could not be tracked: ${e.message}`});
          return {...result,tracked:false,message:'Game launched. Play-time tracking could not start.'};
        }
      }else db.db.prepare('UPDATE games SET last_played_at=?,updated_at=? WHERE id=?').run(new Date().toISOString(),new Date().toISOString(),id);
      broadcast({type:'gamesChanged',reason:'launch'});
      return result;
    }finally{pendingLaunches.delete(id);}
  });
  bind('openGameFolder',async id=>{if(!okId(id))throw Error('Invalid game identifier.');const game=db.get(id);if(!game)throw Error('Game not found.');const dir=game.install_path|| (game.executable?path.dirname(game.executable):'');if(!dir||!path.isAbsolute(dir)||!fs.existsSync(dir)||!fs.statSync(dir).isDirectory())throw Error('Installation folder is unavailable.');const error=await shell.openPath(dir);if(error)throw Error(error);return true});
  bind('openAppData',async()=>{const error=await shell.openPath(app.getPath('userData'));if(error)throw Error(error);return true});
  bind('exportLibrary',async()=>{
    const result=await dialog.showSaveDialog(win,{title:'Export Orbit library',defaultPath:`Orbit-Library-${new Date().toISOString().slice(0,10)}.orbit`,filters:[{name:'Portable Orbit backup (includes artwork)',extensions:['orbit']},{name:'Metadata only (JSON)',extensions:['json']} ]});
    if(result.canceled||!result.filePath)return null;
    const payload={format:'orbit.library.v1',exported_at:new Date().toISOString(),settings:db.getSettings(),games:db.list()};
    if(path.extname(result.filePath).toLowerCase()==='.json'){
      await writeAtomic(result.filePath,JSON.stringify(payload,null,2));
      return {path:result.filePath,count:payload.games.length,portable:false};
    }
    const archive=await createPortableBackup(payload,artworkDir());
    await writeAtomic(result.filePath,archive.bytes);
    return {path:result.filePath,count:payload.games.length,portable:true,artworkCount:archive.artworkCount,missingArtwork:archive.missingArtwork};
  });
  bind('restoreLibrary',async()=>{
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
    const artworkMap=await installBackupArtwork(portableArtwork,artworkDir());
    let imported=0,skipped=0;const errors=[];
    for(let i=0;i<data.games.length;i++){
      const g=data.games[i];
      try{
        const artworkName=async name=>{
          if(artworkMap.has(name))return artworkMap.get(name);
          return typeof name==='string'&&/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp)$/.test(name)&&await fsp.stat(path.join(artworkDir(),name)).catch(()=>null)?name:'';
        };
        const clean={...g,cover:await artworkName(g?.cover),banner:await artworkName(g?.banner),icon:await artworkName(g?.icon)};
        const res=db.restoreGame(clean);if(res.added)imported++;else skipped++;
      }catch(e){errors.push(`${String(g?.name||'Entry').slice(0,80)}: ${e.message}`)}
      if(i%50===49)await new Promise(resolve=>setImmediate(resolve));
    }
    let settingsRestored=false;
    if(data.settings&&typeof data.settings==='object'&&!Array.isArray(data.settings)){
      try{const settings=db.saveSettings(data.settings);nativeTheme.themeSource=settings.theme;settingsRestored=true;broadcast({type:'settingsChanged',settings});}
      catch(e){errors.push(`Settings: ${e.message}`)}
    }
    broadcast({type:'gamesChanged',reason:'restore'});return {imported,skipped,errors,settingsRestored};
  });
  bind('getAppInfo',()=>({platform:process.platform,version:app.getVersion(),dataPath:app.getPath('userData')}));
}
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus()}});
app.whenReady().then(async()=>{
  try{db=new LibraryDatabase(path.join(app.getPath('userData'),'library.sqlite'));}
  catch(error){dialog.showErrorBox('Cannot open game library',`The database could not be opened: ${error.message}\n\nYour existing data has not been deleted. Location: ${app.getPath('userData')}`);app.quit();return}
  await fsp.mkdir(artworkDir(),{recursive:true});
  protocol.handle('orbit-art',request=>{
    try{const url=new URL(request.url);const filename=decodeURIComponent(url.pathname).replace(/^\//,'');
      if(url.hostname!=='file'||! /^[a-f0-9-]{36}\.(png|jpg|jpeg|webp)$/.test(filename))return new Response('Not found',{status:404});
      return net.fetch(pathToFileURL(path.join(artworkDir(),filename)).href);
    }catch{return new Response('Not found',{status:404})}
  });
  handlers();nativeTheme.themeSource=db.getSettings().theme;
  createWindow();
  if(process.platform==='win32'){
    activityTracker=new WindowsActivityTracker({
      listGames:()=>db.list(),isDirectSession:id=>sessions.has(id),
      start:id=>db.startSession(id),finish:(sessionId,seconds)=>db.finishSession(sessionId,seconds),
      onChange:()=>broadcast({type:'gamesChanged',reason:'playtime'})
    });
    activityTracker.start();
  }
  if(db.getSettings().useSteamArtwork)setTimeout(()=>repairMissingSteamCovers({limit:30}).catch(()=>{}),2500);
  if(db.getSettings().autoScan)setTimeout(async()=>{try{const result=await discover();const imported=[];for(const g of result.games)if(!g.alreadyAdded&&!g.downloadCandidate)imported.push(g);if(imported.length){for(let i=0;i<imported.length;i+=50){db.upsertBatch(imported.slice(i,i+50));await new Promise(resolve=>setImmediate(resolve));}broadcast({type:'gamesChanged',reason:'autoScan'});}}catch(e){broadcast({type:'error',message:`Background scan failed: ${e.message}`})}},1000);
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});
});
app.on('before-quit',()=>{
  activityTracker?.stop();activityTracker=null;
  if(db){for(const [id,session] of sessions){try{const started=db.db.prepare('SELECT started_at FROM sessions WHERE id=?').get(session);if(started)db.finishSession(session,Math.floor((Date.now()-Date.parse(started.started_at))/1000))}catch{}}db.close();db=null;}
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});

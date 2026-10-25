'use strict';
const fs=require('node:fs');
const fsp=fs.promises;
const os=require('node:os');
const path=require('node:path');
const {identifyGame}=require('./game-identity.cjs');
const {scoreExecutable}=require('./game-executable.cjs');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execFileAsync=promisify(execFile);
const MAX_ENTRIES=6000,MAX_ROOTS=64;
const clean=value=>typeof value==='string'&&Array.from(value).every(char=>char.charCodeAt(0)>=32&&char.charCodeAt(0)!==127)?value.trim():'';
const title=value=>{const name=clean(value);return name&&name.length<=140?name:'';};
const appId=value=>{const id=clean(value);return /^[a-z0-9][a-z0-9_.-]{0,199}$/i.test(id)?id:'';};
const unique=values=>[...new Set(values.filter(p=>clean(p)&&path.isAbsolute(p)).map(p=>path.resolve(p)))].slice(0,MAX_ROOTS);
const pathKey=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
async function isDir(p){try{return typeof p==='string'&&(await fsp.stat(p)).isDirectory();}catch{return false;}}
async function isFile(p){try{return (await fsp.stat(p)).isFile();}catch{return false;}}
function within(root,candidate){const rel=path.relative(root,candidate);return !!rel&&!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel);}
async function contained(root,candidate){
 if(!within(path.resolve(root),path.resolve(candidate)))return false;
 try{return within(await fsp.realpath(root),await fsp.realpath(candidate));}catch{return false;}
}
async function executableWithin(root,value,{absolute=false}={}){
 const raw=clean(value);if(!raw)return '';
 const normalized=raw.replace(/[\\/]/g,path.sep);
 if(!absolute&&(path.isAbsolute(normalized)||/^[a-z]:/i.test(normalized)))return '';
 const candidate=path.resolve(root,normalized);
 return await contained(root,candidate)&&await isFile(candidate)?candidate:'';
}
// Stream directory entries so even an unexpectedly huge folder has bounded work.
async function entriesAt(dir,limit=MAX_ENTRIES){
 const entries=[];const handle=await fsp.opendir(dir);
 try{for await(const entry of handle){if(entries.length>=limit){entries.truncated=true;break;}entries.push(entry);}}finally{await handle.close().catch(()=>{});}
 return entries;
}
async function readText(file,max=3*1024*1024){
 const handle=await fsp.open(file,'r');
 try{const st=await handle.stat();if(!st.isFile()||st.size>max)throw Error('Manifest too large or not a regular file');
  // Read at most the cap, even if a metadata file grows after stat().
  const buffer=Buffer.alloc(Math.min(st.size+1,max+1));const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
  if(bytesRead>max)throw Error('Manifest too large');return buffer.subarray(0,bytesRead).toString('utf8');
 }finally{await handle.close();}
}
function parseVdf(source){
 const tokens=[];const re=/\/\/[^\r\n]*|"((?:\\.|[^"\\])*)"|\{|\}|([^\s{}"]+)/g;
 for(let match=re.exec(source);match!==null;match=re.exec(source)){if(match[0].startsWith('//'))continue;tokens.push(match[1]!==undefined?match[1].replace(/\\"/g,'"').replace(/\\\\/g,'\\'):match[0]==='{'||match[0]==='}'?match[0]:match[2]);}
 let i=0;
 function object(depth=0){if(depth>32)throw Error('VDF nesting limit exceeded');const out={};while(i<tokens.length){const key=tokens[i++];if(key==='}')break;if(key==='{')continue;const next=tokens[i++];const value=next==='{'?object(depth+1):next;if(next==='}')break;if(value!==undefined&&!['__proto__','constructor','prototype'].includes(key))out[key]=value;}return out;}
 return object();
}
function steamRoots(platform=process.platform){
 const home=os.homedir(),roots=[process.env.STEAM_COMPAT_CLIENT_INSTALL_PATH];
 if(platform==='win32'){
  for(const prefix of [process.env['ProgramFiles(x86)'],process.env.ProgramFiles,'C:\\Program Files (x86)','C:\\Program Files'])if(prefix)roots.push(path.join(prefix,'Steam'));
 }
 else if(platform==='darwin')roots.push(path.join(home,'Library/Application Support/Steam'));
 else roots.push(path.join(home,'.steam/steam'),path.join(home,'.steam/root'),path.join(home,'.local/share/Steam'),path.join(home,'.var/app/com.valvesoftware.Steam/data/Steam'));
 return unique(roots);
}
function epicManifestRoots(){return process.platform==='win32'?unique([path.join(process.env.ProgramData||'C:\\ProgramData','Epic/EpicGamesLauncher/Data/Manifests')]):[];}
function gogRoots(platform=process.platform){
 const roots=[];
 if(platform==='win32')for(const prefix of [process.env['ProgramFiles(x86)'],process.env.ProgramFiles]){if(prefix)roots.push(path.join(prefix,'GOG Galaxy/Games'));}
 else if(platform==='darwin')roots.push(path.join(os.homedir(),'Applications'));
 return unique(roots);
}
async function queryRegistry(key){return (await execFileAsync('reg.exe',['query',key,'/s'],{timeout:4500,maxBuffer:1024*1024,windowsHide:true})).stdout;}
function registryRecords(stdout){
 const records=[];let current=null;
 for(const line of String(stdout||'').slice(0,1024*1024).split(/\r?\n/)){
  if(/^HKEY_/i.test(line.trim())){current={key:line.trim(),fields:{}};records.push(current);if(records.length>=MAX_ENTRIES)break;continue;}
  const match=line.match(/^\s+(.+?)\s{2,}REG_(?:SZ|EXPAND_SZ|DWORD)\s{2,}(.+)$/i);
  if(current&&match)current.fields[match[1].toLowerCase().trim()]=match[2].trim();
 }
 return records;
}
async function registryRead(key,query,warnings){
 try{return registryRecords(await query(key));}catch(error){
  // Missing keys are normal on machines without the storefront. Surface real failures.
  if(error.code!==1&&error.code!=='ENOENT')warnings.push(`Registry ${key}: ${error.message}`);
  return [];
 }
}
async function discoverSteam(roots,{platform=process.platform,queryRegistry:query=queryRegistry}={}){
 const games=[],warnings=[],libs=new Map();let budget=MAX_ENTRIES;
 const add=p=>{if(clean(p)&&path.isAbsolute(p)&&libs.size<MAX_ROOTS)libs.set(pathKey(p),path.resolve(p));};
 for(const root of unique(roots===undefined?steamRoots(platform):roots))add(root);
 if(platform==='win32')for(const key of ['HKCU\\Software\\Valve\\Steam','HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam','HKLM\\SOFTWARE\\Valve\\Steam']){
  for(const {fields} of await registryRead(key,query,warnings))add(fields.steampath||fields.installpath);
 }
 // Follow only Steam's declared library roots, including the older config index.
 for(const root of [...libs.values()]){
  if(!(await isDir(root)))continue;
  for(const relative of ['steamapps/libraryfolders.vdf','config/libraryfolders.vdf']){
   try{const doc=parseVdf(await readText(path.join(root,relative))).libraryfolders||{};
    for(const [key,value] of Object.entries(doc))if(/^\d+$/.test(key))add(typeof value==='string'?value:value?.path);
   }catch(error){if(error.code!=='ENOENT')warnings.push(`Steam library index: ${error.message}`);}
  }
 }
 const seen=new Set();
 for(const root of libs.values()){
  if(budget<=0)break;const appDir=path.join(root,'steamapps');let entries;
  try{entries=await entriesAt(appDir,budget);}catch{continue;}
  budget-=entries.length;if(entries.truncated)warnings.push('Steam scan reached its metadata entry limit.');
  for(const item of entries){
   const match=item.name.match(/^appmanifest_(\d+)\.acf$/i);if(!item.isFile()||!match)continue;
   try{
    const doc=parseVdf(await readText(path.join(appDir,item.name))).AppState;
    const id=String(doc?.appid||match[1]),name=title(doc?.name),install=clean(doc?.installdir);
    if(!/^\d{1,15}$/.test(id)||id!==match[1]||!name||!install||install==='.'||install==='..'||/[\\/]/.test(install)||path.isAbsolute(install)||seen.has(id))continue;
    if(doc.StateFlags!==undefined&&(!/^\d+$/.test(doc.StateFlags)||(Number(doc.StateFlags)&4)===0))continue;
    const common=path.join(appDir,'common'),directory=path.join(common,install);
    if(!(await isDir(directory))||!(await contained(common,directory)))continue;
    seen.add(id);games.push({name,source:'steam',source_id:id,install_path:directory,launch_uri:`steam://rungameid/${id}`,genre:'',tags:[]});
   }catch(error){warnings.push(`Steam ${item.name}: ${error.message}`);}
  }
 }
 return {games,warnings};
}
function epicUri(id,namespace,item){const launchId=appId(namespace)&&appId(item)?`${namespace}:${item}:${id}`:id;return `com.epicgames.launcher://apps/${encodeURIComponent(launchId)}?action=launch&silent=true`;}
function mergeGame(map,game){
 const key=`${game.source}:${game.source_id}`;const previous=map.get(key);
 if(!previous){map.set(key,game);return;}
 if(!previous.executable&&game.executable)previous.executable=game.executable;
 if(previous.source==='epic'&&game.launch_uri?.includes('%3A')&&!previous.launch_uri?.includes('%3A'))previous.launch_uri=game.launch_uri;
}
async function discoverEpic(roots=epicManifestRoots()){
 const map=new Map(),warnings=[];let budget=MAX_ENTRIES;
 for(const root of unique(roots)){
  if(budget<=0)break;let entries;try{entries=await entriesAt(root,budget);}catch{continue;}
  budget-=entries.length;if(entries.truncated)warnings.push('Epic scan reached its metadata entry limit.');
  for(const item of entries){if(!item.isFile()||!item.name.toLowerCase().endsWith('.item'))continue;
   try{
    const data=JSON.parse(await readText(path.join(root,item.name))),id=appId(data.AppName),name=title(data.DisplayName),install=clean(data.InstallLocation);
    if(!id||!name||!path.isAbsolute(install)||!(await isDir(install)))continue;
    if(data.bIsIncompleteInstall===true||data.bNeedsValidation===true||data.bIsDlc===true||(clean(data.MainGameAppName)&&data.MainGameAppName!==id))continue;
    const executable=await executableWithin(install,data.LaunchExecutable);
    mergeGame(map,{name,source:'epic',source_id:id,install_path:install,executable,launch_uri:epicUri(id,data.CatalogNamespace,data.CatalogItemId),tags:[]});
   }catch(error){warnings.push(`Epic ${item.name}: ${error.message}`);}
  }
 }
 return {games:[...map.values()],warnings};
}
const ignored=/^(?:unins\d*|uninstall|setup|install|installer|crashreport|unitycrash|vc_redist|vcredist|dxsetup|update|updater|bootstrapper|launcher\s*setup|eac|easyanticheat|eos|redist|redistributable|configuration|repair)(?:[_.\d-]|$)/i;
const ignoredDirectory=/^(?:node_modules|\.git|__pycache__|redist|redistributables|_commonredist|engine|plugins|content|data|assets|support|prerequisites|windows|system32|tools|installers|directx|easyanticheat|crashreporter|documentation)$/i;
const binaryDirectory=/^(?:bin|binaries|win64|win32|x64|x86|game|gamefiles|retail|release|shipping|client)$/i;
function likelyGameExecutable(name,platform=process.platform){
 const stem=path.basename(name,path.extname(name));
 if(ignored.test(stem)||/uninstall|crashreport|crashhandler|anticheat|(?:^|[_.-])(?:helper|service|editor|configtool|dedicatedserver|benchmark)(?:[_.-]|$)/i.test(stem)||/^(?:discord|chrome|firefox|steam|epicgameslauncher|7z|winrar|obs|vlc|node|python|java)$/i.test(stem))return false;
 if(/launcher|helper|service|config|editor|benchmark/i.test(stem)&&identifyGame(name).kind==='filename')return false;
 return platform==='win32'?/\.exe$/i.test(name):platform==='darwin'?/\.app$/i.test(name):!name.startsWith('.');
}
async function gogFromDirectory(location,entries,warnings){
 const manifest=entries.find(entry=>entry.isFile()&&/^goggame-\d+\.info$/i.test(entry.name));if(!manifest)return null;
 try{
  const doc=JSON.parse(await readText(path.join(location,manifest.name))),id=String(doc.gameId||manifest.name.match(/\d+/)[0]);
  if(!/^\d{1,20}$/.test(id))return null;
  const tasks=Array.isArray(doc.playTasks)?doc.playTasks.slice(0,80).filter(task=>task&&(!task.type||task.type==='FileTask')).sort((a,b)=>Number(!!b.isPrimary)-Number(!!a.isPrimary)):[];
  let executable='';
  for(const task of tasks){
   const candidate=await executableWithin(location,task.path);if(!candidate)continue;
   // Recognize Windows game targets from their executable format.
   // Native targets additionally need the OS executable bit; a FileTask label
   // alone must never turn a document or installer into a launchable game.
   const windows=/\.exe$/i.test(candidate);
   if(!likelyGameExecutable(path.basename(candidate),windows?'win32':'linux'))continue;
   if(!Number.isFinite(scoreExecutable(candidate,{name:title(doc.name)||path.basename(location),install_path:location})))continue;
   if(!windows){try{if(!((await fsp.stat(candidate)).mode&0o111))continue;}catch{continue;}}
   executable=candidate;break;
  }
  if(!executable)return null;
  return {name:title(doc.name)||path.basename(location).slice(0,140),source:'gog',source_id:id,install_path:location,executable,tags:[]};
 }catch(error){warnings.push(`GOG ${manifest.name}: ${error.message}`);return null;}
}
async function discoverGog(roots=gogRoots()){
 const map=new Map(),warnings=[];let budget=MAX_ENTRIES;
 for(const root of unique(roots)){
  if(budget<=0)break;let entries;try{entries=await entriesAt(root,budget);}catch{continue;}
  budget-=entries.length;if(entries.truncated)warnings.push('GOG scan reached its metadata entry limit.');
  const direct=await gogFromDirectory(root,entries,warnings);if(direct){mergeGame(map,direct);continue;}
  for(const dir of entries){if(!dir.isDirectory()||budget<=0)continue;const location=path.join(root,dir.name);let files;
   try{files=await entriesAt(location,budget);}catch{continue;}
   budget-=files.length;if(files.truncated)warnings.push(`GOG metadata scan reached its entry limit in ${location}.`);
   const game=await gogFromDirectory(location,files,warnings);if(game)mergeGame(map,game);
  }
 }
 return {games:[...map.values()],warnings};
}
async function discoverGogRegistry({platform=process.platform,queryRegistry:query=queryRegistry}={}){
 if(platform!=='win32')return {games:[],warnings:[]};const map=new Map(),warnings=[];
 for(const key of ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games','HKLM\\SOFTWARE\\GOG.com\\Games','HKCU\\SOFTWARE\\GOG.com\\Games']){
  for(const {key:recordKey,fields} of await registryRead(key,query,warnings)){
   const install=clean(fields.path||fields.gamepath),name=title(fields.gamename||fields.name),id=recordKey.match(/\\(\d+)$/)?.[1];
   if(!install||!path.isAbsolute(install)||!name||!id||!(await isDir(install)))continue;
   const executable=await executableWithin(install,fields.exe,{absolute:true});
   if(executable&&likelyGameExecutable(path.basename(executable),'win32'))mergeGame(map,{name,source:'gog',source_id:id,install_path:install,executable,tags:[]});
  }
 }
 return {games:[...map.values()],warnings};
}
const VENDOR_PUBLISHERS=new Map([
 ['electronic arts','ea'],['electronic arts inc','ea'],['electronic arts inc.','ea'],['ea games','ea'],
 ['ubisoft','ubisoft'],['ubisoft entertainment','ubisoft'],['ubisoft entertainment sa','ubisoft'],['ubisoft entertainment s.a.','ubisoft'],
 ['blizzard entertainment','battlenet'],['blizzard entertainment inc','battlenet'],['blizzard entertainment, inc.','battlenet'],['blizzard entertainment inc.','battlenet']
]);
async function discoverWindowsRegistry({platform=process.platform,queryRegistry:query=queryRegistry}={}){
 const map=new Map(),warnings=[];if(platform!=='win32')return {games:[],warnings};
 for(const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall']){
  for(const {key:recordKey,fields} of await registryRead(key,query,warnings)){
   const source=VENDOR_PUBLISHERS.get(clean(fields.publisher).toLowerCase()),name=title(fields.displayname),install=clean(fields.installlocation);
   if(!source||!name||!install||!path.isAbsolute(install)||path.resolve(install)===path.parse(path.resolve(install)).root||fields.systemcomponent==='0x1')continue;
   if(/^(?:EA app|EA Desktop|Origin|Ubisoft(?: Connect| Game Launcher)?|Uplay|Battle[. ]net(?: Launcher)?|Blizzard Battle[. ]net|Blizzard App)$/i.test(name)||/dedicated server|redistributable|uninstaller|software development kit/i.test(name))continue;
   // DisplayIcon can be a quoted EXE plus a resource index. Never execute an
   // uninstall command, parse arguments, search PATH or guess store product IDs.
   const icon=clean(fields.displayicon).match(/^(?:"([^"\r\n]+\.exe)"|([^"\r\n]+\.exe))(?:,\s*-?\d+)?$/i);
   if(!icon||!(await isDir(install)))continue;
   const executable=await executableWithin(install,icon[1]||icon[2],{absolute:true});
   if(!executable||!likelyGameExecutable(path.basename(executable),'win32')||scoreExecutable(executable,{name,install_path:install})<20)continue;
   mergeGame(map,{name,source,source_id:recordKey.split('\\').pop().slice(0,200),install_path:install,executable,tags:[]});
  }
 }
 return {games:[...map.values()],warnings};
}
function heroicRoots(platform=process.platform){
 const home=os.homedir(),config=process.env.XDG_CONFIG_HOME||path.join(home,'.config');
 const roots=[path.join(config,'heroic'),path.join(home,'.config/heroic')];
 if(platform==='win32'&&process.env.APPDATA)roots.unshift(path.join(process.env.APPDATA,'heroic'));
 if(platform==='darwin')roots.unshift(path.join(home,'Library/Application Support/heroic'));
 if(platform==='linux')roots.push(path.join(home,'.var/app/com.heroicgameslauncher.hgl/config/heroic'));
 return unique(roots);
}
function legendaryRoots(){return unique([process.env.LEGENDARY_CONFIG_PATH,path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'legendary'),process.env.APPDATA&&path.join(process.env.APPDATA,'legendary')]);}
async function installedRecords(file,warnings,label){
 try{const data=JSON.parse(await readText(file));if(!data||typeof data!=='object')throw Error('Invalid installed-game metadata');return data;}
 catch(error){if(error.code!=='ENOENT')warnings.push(`${label}: ${error.message}`);return null;}
}
async function installedGame(record,id,{source,heroic,platform,warnings}){
 if(!record||typeof record!=='object'||record.is_dlc||record.needs_verification||record.is_preloaded)return null;
 const sourceId=source==='gog'?String(record.appName||id||''):appId(record.app_name||id);
 const install=clean(record.install_path);if(!sourceId||(source==='gog'&&!/^\d{1,20}$/.test(sourceId))||!install||!path.isAbsolute(install)||!(await isDir(install)))return null;
 let name=title(record.title||record.name),executable=await executableWithin(install,record.executable,{absolute:true});
 if(source==='gog'&&!name){try{const info=JSON.parse(await readText(path.join(install,`goggame-${sourceId}.info`)));name=title(info.name);}catch{}}
 // Heroic's GOG installed cache usually stores no title. Its installation folder
 // is a last-resort display label only; identity always comes from installed.json.
 if(!name&&source==='gog')name=title(path.basename(install));
 if(!name)return null;
 if(!heroic){
  const native=executable&&(platform==='win32'?/\.exe$/i.test(executable):!/\.(exe|bat|cmd|dll|msi)$/i.test(executable)&&(await fsp.stat(executable)).mode&0o111);
  if(!native){warnings.push(`Legendary ${name}: open or import through Heroic to preserve the game's runtime and authentication settings.`);return null;}
 }
 const game={name,source,source_id:sourceId,install_path:install,executable,tags:[]};
 if(heroic)game.launch_uri=`heroic://launch?appName=${encodeURIComponent(sourceId)}&runner=${source==='gog'?'gog':'legendary'}`;
 return game;
}
async function discoverHeroic(roots=heroicRoots(),{platform=process.platform}={}){
 const map=new Map(),warnings=[];let budget=MAX_ENTRIES;
 for(const root of unique(roots)){
  if(budget<=0)break;
  let legendary=await installedRecords(path.join(root,'legendaryConfig/legendary/installed.json'),warnings,'Heroic Epic metadata');
  // Older Heroic versions used the sibling Legendary config. Only associate
  // that metadata with Heroic when the Heroic directory actually exists.
  if(!legendary&&await isDir(root))legendary=await installedRecords(path.join(path.dirname(root),'legendary/installed.json'),warnings,'Heroic legacy Epic metadata');
  if(legendary&&!Array.isArray(legendary))for(const [id,record] of Object.entries(legendary).slice(0,budget)){
   budget--;
   const game=await installedGame(record,id,{source:'epic',heroic:true,platform,warnings});if(game)mergeGame(map,game);
  }
  const gog=await installedRecords(path.join(root,'gog_store/installed.json'),warnings,'Heroic GOG metadata');
  if(Array.isArray(gog?.installed))for(const record of gog.installed.slice(0,budget)){
   budget--;
   const game=await installedGame(record,record?.appName,{source:'gog',heroic:true,platform,warnings});if(game)mergeGame(map,game);
  }
 }
 if(budget<=0)warnings.push('Heroic scan reached its metadata entry limit.');
 return {games:[...map.values()],warnings};
}
async function discoverLegendary(roots=legendaryRoots(),{platform=process.platform}={}){
 const map=new Map(),warnings=[];let budget=MAX_ENTRIES;
 for(const root of unique(roots)){
  if(budget<=0)break;
  const records=await installedRecords(path.join(root,'installed.json'),warnings,'Legendary metadata');if(!records||Array.isArray(records))continue;
  for(const [id,record] of Object.entries(records).slice(0,budget)){
   budget--;
   const game=await installedGame(record,id,{source:'epic',heroic:false,platform,warnings});if(game)mergeGame(map,game);
  }
 }
 if(budget<=0)warnings.push('Legendary scan reached its metadata entry limit.');
 return {games:[...map.values()],warnings};
}
function ownerDirectory(dir,root){let owner=dir;while(owner!==root&&binaryDirectory.test(path.basename(owner)))owner=path.dirname(owner);return owner;}
async function scanFolder(root,{limit=6000,maxDepth=5,platform=process.platform}={}){
 const games=[],warnings=[];if(!clean(root)||!path.isAbsolute(root)||!(await isDir(root)))return {games,warnings:[`Folder unavailable: ${root}`]};
 limit=Number.isFinite(limit)?Math.max(1,Math.min(12000,Math.floor(limit))):6000;maxDepth=Number.isFinite(maxDepth)?Math.max(0,Math.min(8,Math.floor(maxDepth))):5;
 root=path.resolve(root);const queue=[{dir:root,depth:0}],groups=new Map(),storeDirectories=new Set();let seen=0,truncated=false;
 for(let cursor=0;cursor<queue.length&&seen<limit;cursor++){
  const {dir,depth}=queue[cursor];let entries;
  try{entries=await entriesAt(dir,limit-seen);}catch(error){warnings.push(`Cannot read ${dir}: ${error.code||error.message}`);continue;}
  seen+=entries.length;truncated ||= !!entries.truncated;
  const gog=await gogFromDirectory(dir,entries,warnings);
  if(gog){games.push(gog);storeDirectories.add(dir);continue;}
  for(const entry of entries){
   const full=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;
   if(entry.isDirectory()){
    if(platform==='darwin'&&/\.app$/i.test(entry.name)){if(likelyGameExecutable(entry.name,platform))addCandidate(full,dir,depth);continue;}
    if(depth<maxDepth&&!ignoredDirectory.test(entry.name)&&(depth<2||binaryDirectory.test(entry.name)))queue.push({dir:full,depth:depth+1});
   }else if(entry.isFile()&&likelyGameExecutable(entry.name,platform)){
    if(platform==='win32'||/\.(AppImage|sh|x86_64|bin)$/i.test(entry.name))addCandidate(full,dir,depth);
    else {try{if((await fsp.stat(full)).mode&0o111)addCandidate(full,dir,depth);}catch{}}
   }
  }
 }
 function addCandidate(file,dir,depth){
  const bundle=platform==='darwin'&&/\.app$/i.test(file);
  const owner=bundle?file:ownerDirectory(dir,root),identity=identifyGame(file),fallbackName=bundle||owner===root?path.basename(file,path.extname(file)):path.basename(owner);
  const score=scoreExecutable(file,{name:identity.kind==='filename'?fallbackName:identity.name,install_path:owner},Math.max(0,depth-1));
  if(!Number.isFinite(score)||score<0)return;
  const candidates=groups.get(owner)||[];candidates.push({file,owner,score,identity,fallbackName});groups.set(owner,candidates);
 }
 for(const [owner,candidates] of groups){
  if(storeDirectories.has(owner))continue;
  candidates.sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file));
  // Multiple known standalone titles in a selected flat folder remain separate.
  const known=candidates.filter(candidate=>candidate.identity.kind==='executable');
  const choices=owner===root&&known.length?known:candidates.slice(0,1);
  if(choices.length===1&&!known.length&&candidates[1]&&candidates[0].score-candidates[1].score<20){warnings.push(`Ambiguous executables in ${owner}; select the game's executable manually.`);continue;}
  for(const best of choices)games.push({name:identifyGame(best.file,{fallbackName:best.fallbackName}).name,source:'folder',install_path:owner,executable:best.file,tags:[]});
 }
 if(truncated||seen>=limit)warnings.push(`Scan stopped at ${limit} entries for ${root}; choose smaller folders for complete results.`);
 return {games,warnings};
}
async function scanDownloadsFolder(downloadsPath,{platform=process.platform}={}){
 if(!clean(downloadsPath)||!path.isAbsolute(downloadsPath)||!(await isDir(downloadsPath)))return {games:[],warnings:[]};
 const result=await scanFolder(downloadsPath,{limit:2400,maxDepth:2,platform});
 result.games=result.games.filter(game=>{
  const file=path.basename(game.executable||'');if(!likelyGameExecutable(file,platform))return false;
  return path.relative(downloadsPath,game.executable||'').includes(path.sep)||identifyGame(game.executable).kind!=='filename';
 }).map(game=>({...game,downloadCandidate:true}));return result;
}
async function discoverAll(settings={},options={}){
 const platform=options.platform||process.platform;
 const providers=options.providers||[
  {provider:'steam',run:()=>discoverSteam(undefined,{platform})},{provider:'epic',run:()=>discoverEpic()},
  {provider:'gog',run:()=>discoverGog()},{provider:'gog-registry',run:()=>discoverGogRegistry({platform})},
  {provider:'heroic',run:()=>discoverHeroic(undefined,{platform})},{provider:'legendary',run:()=>discoverLegendary(undefined,{platform})},
  {provider:'windows-stores',run:()=>discoverWindowsRegistry({platform})}
 ];
 // Downloads is intentionally absent. Only explicitly selected library folders
 // and bounded, known storefront metadata locations are searched.
 const folders=Array.isArray(settings.libraryFolders)?unique(settings.libraryFolders).slice(0,60):[];
 const jobs=[...providers.slice(0,64),...folders.map(dir=>({provider:'folder',path:dir,run:()=>scanFolder(dir,{platform})}))];
 const results=new Array(jobs.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{
  while(cursor<jobs.length){const i=cursor++,job=jobs[i],start=performance.now();
   try{const value=await job.run();results[i]={...value,diagnostic:{provider:job.provider,status:value.warnings.length?'warning':'ok',games:value.games.length,warnings:value.warnings.length,durationMs:Math.round(performance.now()-start),...(job.path?{path:job.path}:{})}};}
   catch(error){results[i]={games:[],warnings:[`${job.provider}: ${error.message}`],diagnostic:{provider:job.provider,status:'error',games:0,warnings:1,durationMs:Math.round(performance.now()-start)}};}
  }
 }));
 const games=[],warnings=[],diagnostics=[],seen=new Set(),seenExecutables=new Set(),seenStorePaths=new Set();
 for(const result of results){warnings.push(...result.warnings);diagnostics.push(result.diagnostic);
  for(const game of result.games){
   const key=game.source_id&&game.source!=='folder'&&game.source!=='manual'?`${game.source}:${game.source_id}`:`file:${game.executable||game.launch_uri}`;
   const executable=game.executable?pathKey(game.executable):'',folder=game.install_path?pathKey(game.install_path):'';
   if(seen.has(key)||(executable&&seenExecutables.has(executable))||(game.source==='folder'&&folder&&seenStorePaths.has(folder)))continue;
   seen.add(key);if(executable)seenExecutables.add(executable);if(game.source!=='folder'&&game.source!=='manual'&&folder)seenStorePaths.add(folder);games.push(game);
  }
 }
 return {games,warnings,diagnostics};
}
module.exports={parseVdf,discoverSteam,discoverEpic,discoverGog,discoverGogRegistry,scanFolder,scanDownloadsFolder,discoverAll,steamRoots,epicManifestRoots,gogRoots,discoverHeroic,discoverLegendary,discoverWindowsRegistry,heroicRoots,legendaryRoots};

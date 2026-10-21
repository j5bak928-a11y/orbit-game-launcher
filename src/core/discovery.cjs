'use strict';
const fs = require('node:fs');
const fsp=fs.promises;
const os=require('node:os');
const path=require('node:path');
const {identifyGame}=require('./game-identity.cjs');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execFileAsync=promisify(execFile);
const unique = a=>[...new Set(a.filter(Boolean).map(p=>path.resolve(p)))];
async function isDir(p){try{return (await fsp.stat(p)).isDirectory()}catch{return false}}
async function isFile(p){try{return (await fsp.stat(p)).isFile()}catch{return false}}
function tokenizeVdf(source){
  const tokens=[];const re=/\/\/[^\r\n]*|"((?:\\.|[^"\\])*)"|\{|\}|([^\s{}"]+)/g;let match;
  while((match=re.exec(source))!==null){if(match[0].startsWith('//'))continue;tokens.push(match[1]!==undefined?match[1].replace(/\\"/g,'"').replace(/\\\\/g,'\\'):match[0]==='{'||match[0]==='}'?match[0]:match[2]);}
  return tokens;
}
function parseVdf(source){
  const tokens=tokenizeVdf(source);let i=0;
  function object(nested=false){const out={};while(i<tokens.length){const key=tokens[i++];if(key==='}')break;if(key==='{')continue;const next=tokens[i++];if(next==='{')out[key]=object(true);else if(next!==undefined&&next!=='}')out[key]=next;else if(next==='}')break;}return out;}
  return object();
}
function steamRoots(){
  const home=os.homedir(); const paths=[];
  if(process.platform==='win32'){
    for(const prefix of [process.env['ProgramFiles(x86)'],process.env.ProgramFiles,'C:\\Program Files (x86)','C:\\Program Files'])if(prefix)paths.push(path.join(prefix,'Steam'));
  }else if(process.platform==='darwin')paths.push(path.join(home,'Library/Application Support/Steam'));
  else paths.push(path.join(home,'.steam/steam'),path.join(home,'.local/share/Steam'));
  return unique(paths);
}
function epicManifestRoots(){
  if(process.platform==='win32')return unique([path.join(process.env.ProgramData||'C:\\ProgramData','Epic/EpicGamesLauncher/Data/Manifests')]);
  return [];
}
function gogRoots(platform=process.platform){
  const roots=[];
  if(platform==='win32'){
    for(const folder of [process.env['ProgramFiles(x86)'],process.env.ProgramFiles]){
      if(folder)roots.push(path.join(folder,'GOG Galaxy/Games'));
    }
  }else if(platform==='darwin'){
    roots.push(path.join(os.homedir(),'Applications'));
  }
  return unique(roots);
}
async function readText(file,max=3*1024*1024){const st=await fsp.stat(file);if(st.size>max)throw Error('Manifest too large');return fsp.readFile(file,'utf8');}
async function discoverSteam(roots=steamRoots()){
  const games=[],warnings=[];const libs=new Set();
  for(const root of roots){if(!(await isDir(root)))continue;
    libs.add(root);
    const vdf=path.join(root,'steamapps/libraryfolders.vdf');
    try{const obj=parseVdf(await readText(vdf)).libraryfolders||{};
      for(const [key,value] of Object.entries(obj))if(/^\d+$/.test(key)){
        const p=typeof value==='string'?value:value?.path;
        if(p&&path.isAbsolute(p))libs.add(p);
      }
    }catch(e){if(e.code!=='ENOENT')warnings.push(`Steam library index: ${e.message}`)}
  }
  for(const root of libs){const appDir=path.join(root,'steamapps');let entries=[];
    try{entries=await fsp.readdir(appDir,{withFileTypes:true})}catch{continue}
    for(const item of entries){if(!item.isFile()||!/^appmanifest_\d+\.acf$/i.test(item.name))continue;
      try{
        const doc=parseVdf(await readText(path.join(appDir,item.name))).AppState;
        const appid=String(doc?.appid||item.name.match(/\d+/)[0]);
        const name=String(doc?.name||'').trim();const installDir=String(doc?.installdir||'').trim();
        if(!/^\d{1,15}$/.test(appid)||!name||name.length>140||!installDir||installDir==='.'||installDir==='..'||/[\\/]/.test(installDir)||path.isAbsolute(installDir))continue;
        const directory=path.join(appDir,'common',installDir);
        if(!(await isDir(directory)))continue;
        games.push({name,source:'steam',source_id:appid,install_path:directory,launch_uri:`steam://rungameid/${appid}`,genre:'',tags:[]});
      }catch(e){warnings.push(`Steam ${item.name}: ${e.message}`)}
    }
  }
  return {games,warnings};
}
async function discoverEpic(roots=epicManifestRoots()){
  const games=[],warnings=[];
  for(const root of roots){let entries=[];try{entries=await fsp.readdir(root,{withFileTypes:true})}catch{continue}
    for(const item of entries){if(!item.isFile()||!item.name.toLowerCase().endsWith('.item'))continue;
      try{
        const data=JSON.parse(await readText(path.join(root,item.name)));
        const id=String(data.AppName||'').trim(),name=String(data.DisplayName||'').trim(),install=String(data.InstallLocation||'');
        if(!id||!name||name.length>140||!path.isAbsolute(install)||!(await isDir(install)))continue;
        const rel=String(data.LaunchExecutable||'').replaceAll('\\',path.sep);
        const candidate=path.resolve(install,rel);
        const exe=rel&&candidate.startsWith(path.resolve(install)+path.sep)&&await isFile(candidate)?candidate:'';
        games.push({name,source:'epic',source_id:id,install_path:install,executable:exe,
          launch_uri:`com.epicgames.launcher://apps/${encodeURIComponent(id)}?action=launch&silent=true`,tags:[]});
      }catch(e){warnings.push(`Epic ${item.name}: ${e.message}`)}
    }
  }
  return {games,warnings};
}
const ignored=/^(unins\d*|uninstall|setup|install|crashreport|unitycrash|vc_redist|vcredist|dxsetup|update|updater|bootstrapper|launcher\s*setup|eac|easyanticheat|redist|redistributable|configuration|repair)([_.-]|$)/i;
function likelyGameExecutable(name){
  if(ignored.test(name)||name.toLowerCase().includes('uninstall'))return false;
  if(process.platform==='win32')return /\.exe$/i.test(name);
  if(process.platform==='darwin')return /\.app$/i.test(name);
  return !name.startsWith('.');
}
async function discoverGog(roots=gogRoots()){
  const games=[],warnings=[];
  for(const root of roots){let dirs=[];try{dirs=await fsp.readdir(root,{withFileTypes:true})}catch{continue}
    for(const dir of dirs){if(!dir.isDirectory())continue;const location=path.join(root,dir.name);
      let files=[];try{files=await fsp.readdir(location,{withFileTypes:true})}catch{continue}
      const manifest=files.find(f=>f.isFile()&&/^goggame-\d+\.info$/i.test(f.name));
      if(!manifest)continue;
      try{
        const doc=JSON.parse(await readText(path.join(location,manifest.name)));
        const id=String(doc.gameId||manifest.name.match(/\d+/)[0]);
        const play=Array.isArray(doc.playTasks)?doc.playTasks.find(t=>t.isPrimary) || doc.playTasks[0]:null;
        const executable=play?.path?path.resolve(location,play.path):'';
        const valid=executable.startsWith(path.resolve(location)+path.sep)&&await isFile(executable)?executable:'';
        games.push({name:String(doc.name||dir.name).slice(0,140),source:'gog',source_id:id,install_path:location,executable:valid,tags:[]});
      }catch(e){warnings.push(`GOG ${manifest.name}: ${e.message}`)}
    }
  }
  return {games,warnings};
}
async function discoverGogRegistry(){
  if(process.platform!=='win32')return {games:[],warnings:[]};
  const games=[],warnings=[];
  for(const key of ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games','HKLM\\SOFTWARE\\GOG.com\\Games','HKCU\\SOFTWARE\\GOG.com\\Games']){
    let output;try{output=(await execFileAsync('reg.exe',['query',key,'/s'],{timeout:4500,maxBuffer:1024*1024,windowsHide:true})).stdout}catch{continue}
    const blocks=output.split(/\r?\n(?=HKEY_)/i);
    for(const block of blocks){const field={};for(const line of block.split(/\r?\n/)){
      const m=line.match(/^\s*([^\s]+)\s+REG_\w+\s+(.+)$/i);if(m)field[m[1].toLowerCase()]=m[2].trim();
    }
    const loc=field.path||field.gamepath;const name=field.gamename||field.name;const id=block.match(/\\(\d+)\s*\r?\n/);
    if(!loc||!name||!id||!(await isDir(loc)))continue;
    const exe=field.exe&&path.isAbsolute(field.exe)&&await isFile(field.exe)?field.exe:'';
    games.push({name:name.slice(0,140),source:'gog',source_id:id[1],install_path:loc,executable:exe,tags:[]});
    }
  }
  return {games,warnings};
}
async function scanFolder(root,{limit=6000,maxDepth=3}={}){
  const games=[],warnings=[];if(!path.isAbsolute(root)||!(await isDir(root)))return {games,warnings:[`Folder unavailable: ${root}`]};
  let seen=0;const queue=[{dir:root,depth:0}];let cursor=0;
  while(cursor<queue.length&&seen<limit){const {dir,depth}=queue[cursor++];let entries;
    try{entries=await fsp.readdir(dir,{withFileTypes:true})}catch(e){warnings.push(`Cannot read ${dir}: ${e.code||e.message}`);continue}
    const gog=entries.find(e=>e.isFile()&&/^goggame-\d+\.info$/i.test(e.name));
    if(gog){try{const doc=JSON.parse(await readText(path.join(dir,gog.name)));const task=doc.playTasks?.find(t=>t.isPrimary)||doc.playTasks?.[0];const candidate=task?.path?path.resolve(dir,task.path):'';
      const exe=candidate.startsWith(dir+path.sep)&&await isFile(candidate)?candidate:'';
      if(exe)games.push({name:String(doc.name||path.basename(dir)).slice(0,140),source:'gog',source_id:String(doc.gameId||''),executable:exe,install_path:dir,tags:[]});
    }catch(e){warnings.push(`GOG info ${dir}: ${e.message}`)}}
    const candidates=[];
    for(const entry of entries){seen++;if(seen>limit)break;
      const full=path.join(dir,entry.name);
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){
        if(process.platform==='darwin'&&entry.name.endsWith('.app')){candidates.push(full);continue;}
        if(depth<maxDepth&&!/^(node_modules|\.git|__pycache__|redist|redistributables|_commonredist|engine|binaries|support|prerequisites|windows|system32)$/i.test(entry.name))queue.push({dir:full,depth:depth+1});
      }else if(entry.isFile()&&likelyGameExecutable(entry.name)){
        if(process.platform==='win32'||/\.(AppImage|sh|x86_64|bin)$/i.test(entry.name))candidates.push(full);
        else {try{if((await fsp.stat(full)).mode&0o111)candidates.push(full)}catch{}}
      }
    }
    if(candidates.length){
      const preferred=candidates.filter(f=>!ignored.test(path.basename(f)));
      const best=preferred.sort((a,b)=>{
        const n=path.basename(dir).toLowerCase().replace(/\W/g,'');
        const score=p=>path.basename(p).toLowerCase().replace(/\W/g,'').startsWith(n)?-1:0;
        return score(a)-score(b)||a.length-b.length;
      })[0];
      if(best&&!games.some(x=>x.executable===best)){
        const fallbackName=path.basename(dir)===path.basename(root)?path.basename(best,path.extname(best)):path.basename(dir);
        games.push({name:identifyGame(best,{fallbackName}).name,source:'folder',install_path:dir,executable:best,tags:[]});
      }
    }
  }
  if(seen>=limit)warnings.push(`Scan stopped at ${limit} entries for ${root}; choose smaller folders for complete results.`);
  return {games,warnings};
}
async function discoverAll(settings){
  const results=await Promise.allSettled([discoverSteam(),discoverEpic(),discoverGog(),discoverGogRegistry()]);
  const folders=(settings.libraryFolders||[]).slice(0,60);
  for(let i=0;i<folders.length;i+=4){
    results.push(...await Promise.allSettled(folders.slice(i,i+4).map(dir=>scanFolder(dir))));
  }
  const games=[],warnings=[];const seen=new Set(),seenExecutables=new Set(),seenStorePaths=new Set();
  for(const result of results){if(result.status==='rejected'){warnings.push(result.reason.message);continue}
    warnings.push(...result.value.warnings);
    for(const game of result.value.games){
      const key=game.source_id&&['steam','epic','gog'].includes(game.source)?`${game.source}:${game.source_id}`:`file:${game.executable||game.launch_uri}`;
      const executable=game.executable?path.normalize(game.executable).toLowerCase():'';
      const folder=game.install_path?path.normalize(game.install_path).toLowerCase():'';
      if(seen.has(key)||(executable&&seenExecutables.has(executable))||(game.source==='folder'&&folder&&seenStorePaths.has(folder)))continue;
      seen.add(key);if(executable)seenExecutables.add(executable);
      if(game.source!=='folder'&&game.source!=='manual'&&folder)seenStorePaths.add(folder);
      games.push(game);
    }
  }
  return {games,warnings};
}
module.exports={parseVdf,discoverSteam,discoverEpic,discoverGog,discoverGogRegistry,scanFolder,discoverAll,steamRoots,epicManifestRoots,gogRoots};

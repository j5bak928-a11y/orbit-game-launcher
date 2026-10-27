'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');

const REJECT=/^(?:unins\d*|uninstall|setup|install|installer|crashreporter|unitycrashhandler|crashhandler|reportcrash|ue4prereq|vc_redist|vcredist|dxsetup|update|updater|bootstrapper|easyanticheat|eac|eos|prerequisite|repair|redist|launcherinstaller)(?:[_\-.\d]|$)/i;
const REJECT_DIR=/^(?:_commonredist|redist|redistributables|redistributable|node_modules|__pycache__|\.git|support|installer|installers|prerequisites|directx|crashreporter|easyanticheat|eac|engine|plugins|content|data|assets|movies|videos|documentation)$/i;
const GAME_DIR=/^(?:bin|binaries|win64|win32|x64|x86|game|gamefiles|retail|release|shipping|client)$/i;
const normalize=str=>String(str||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'');
const suffix=/^(?:launcher|game|win64|win32|shipping|client|x64|x86|64|32)$/i;
function scoreExecutable(file,game,depth=0){
 const stem=path.basename(file,path.extname(file)),name=normalize(stem);
 const title=normalize(game.name);
 const folder=normalize(path.basename(game.install_path||''));
 if(!name||REJECT.test(stem)||/crash|uninstall|setup|redist|updater|anticheat|eac|bootstrap|configtool|dedicatedserver/i.test(name))return -Infinity;
 let score=20-depth*8;
 if(name===title)score+=150;
 if(name===folder)score+=120;
 if(title&&name.length>=3&&title.includes(name))score+=80;
 if(folder&&name.length>=3&&folder.includes(name))score+=60;
 if(title&&name.length>=3&&name.includes(title))score+=95;
 if(/^(?:fm\d{0,2}|fc\d{2}|hoi\d|eu\d|ck\d|gta\d)$/i.test(stem))score+=65;
 if(/(?:game|shipping|win64|win32)$/i.test(name))score-=12;
 if(/launcher|start|helper|service|config|editor|benchmark/i.test(name))score-=45;
 if(suffix.test(stem))score-=35;
 return score;
}
async function findGameExecutable(game,{readDir=fs.readdir,stat=fs.stat,platform=process.platform,limit=1800,maxDepth=4}={}){
 const file=game?.executable;
 if(file&&path.isAbsolute(file)&&(/\.exe$/i.test(file)||platform!=='win32')){
   try{
     const info=await stat(file);
     if(info.isFile()||(platform==='darwin'&&/\.app$/i.test(file)&&info.isDirectory()))return file;
   }catch{}
 }
 const root=game?.install_path;
 if(platform!=='win32'||typeof root!=='string'||!path.isAbsolute(root))return '';
 try{if(!(await stat(root)).isDirectory())return '';}catch{return ''}
 const queue=[{dir:root,depth:0}],files=[];let checked=0;
 for(let i=0;i<queue.length&&checked<limit;i++){
   const {dir,depth}=queue[i];
   let entries;
   try{entries=await readDir(dir,{withFileTypes:true});}catch{continue}
   for(const item of entries){
     if(++checked>limit)break;
     if(item.isSymbolicLink())continue;
     const full=path.join(dir,item.name);
     if(item.isFile()&&/\.exe$/i.test(item.name)){
       const score=scoreExecutable(full,game,depth);
       if(Number.isFinite(score))files.push({file:full,score});
     }else if(item.isDirectory()&&depth<maxDepth&&!REJECT_DIR.test(item.name)){
       // Allow a shallow search, prioritizing game/bin directories.
       if(depth<=1||GAME_DIR.test(item.name))queue.push({dir:full,depth:depth+1});
     }
   }
 }
 files.sort((a,b)=>b.score-a.score||a.file.length-b.file.length||a.file.localeCompare(b.file));
 for(const candidate of files.slice(0,8)){
   try{const info=await stat(candidate.file);if(info.isFile()&&info.size<2*1024*1024*1024)return candidate.file;}catch{}
 }
 return '';
}
module.exports={findGameExecutable,scoreExecutable};

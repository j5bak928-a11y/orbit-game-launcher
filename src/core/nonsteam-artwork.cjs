'use strict';
const fs=require('node:fs/promises');
const {constants:fsConstants}=require('node:fs');
const path=require('node:path');
const {isPortraitArtwork}=require('./cover-shape.cjs');
const {readSmallJson}=require('./steam-search.cjs');
const {cleanKey}=require('./game-identity.cjs');
const MAX=5*1024*1024;
const LOCAL_SOURCES=new Set(['manual','folder','epic','gog','battlenet','ea','ubisoft']);
const ART_DIRS=['','artwork','art','images','assets'];
const ART_EXTS=new Set(['.jpg','.jpeg','.png','.webp']);
const ART_RANK=new Map([
 ['cover',100],['poster',99],['boxart',98],['keyart',97],['library600x900',96],
 ['verticalcover',95],['folder',90],['artwork',85]
]);
const MAX_DIR_ENTRIES=160;
const MAX_IMAGE_READS=12;
// Last-resort official asset for the installed Fortnite app. Store metadata is
// preferred so it can follow newer artwork; this image may eventually expire.
const FORTNITE_PORTRAIT='https://cdn1.epicgames.com/item/fn/FNBR_42-30_Fortnitemares_KeyArt_Fortnitemares_EGS_Launcher_Blade_1200x1600_1200x1600-af4593ae7f114b21aa0dc08449063141';
async function findLocalPortrait(game,{validate=()=>true}={}){
 if(!game||!LOCAL_SOURCES.has(game.source))return null;
 const install=typeof game.install_path==='string'&&path.isAbsolute(game.install_path)?path.resolve(game.install_path):'';
 const executable=typeof game.executable==='string'&&path.isAbsolute(game.executable)?path.resolve(game.executable):'';
 const executableDir=executable?path.dirname(executable):'';
 if(install){
  try{
   const stat=await fs.lstat(install);
   if(!stat.isDirectory()||stat.isSymbolicLink())return null;
  }catch{return null;}
 }
 const withinInstall=dir=>{
  if(!install)return true;
  const relative=path.relative(install,dir);
  return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`));
 };
 // Never search a separately configured executable outside a known install root.
 const roots=[install,executableDir&&withinInstall(executableDir)?executableDir:''].filter(Boolean);
 const candidates=[];
 const gameKey=typeof game.name==='string'&&game.name.length<=140?cleanKey(game.name):'';
 for(const root of [...new Set(roots)].slice(0,2)){
  if(root===path.parse(root).root)continue;
  for(const subdir of ART_DIRS){
   const dir=path.join(root,subdir);
   try{
    // The game directory itself and every path below it must be real directories.
    // Junctions and symlinks must not escape the install chosen by the user.
    const rootStat=await fs.lstat(root);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink())continue;
    if(install&&root!==install){
     const relative=path.relative(install,root);
     let part=install,unsafe=false;
     for(const segment of relative.split(path.sep).filter(Boolean)){
      part=path.join(part,segment);
      const stat=await fs.lstat(part);
      if(!stat.isDirectory()||stat.isSymbolicLink()){unsafe=true;break;}
     }
     if(unsafe)continue;
    }
    const dirStat=subdir?await fs.lstat(dir):rootStat;
    if(!dirStat.isDirectory()||dirStat.isSymbolicLink())continue;
    const names=[];
    // Iterating only the first 161 entries bounds time and memory even if a
    // game ships with thousands of textures in an assets directory.
    const handle=await fs.opendir(dir);
    try{for await(const entry of handle){
     names.push(entry);
     if(names.length>MAX_DIR_ENTRIES)break;
    }}finally{await handle.close().catch(()=>{});}
    if(names.length>MAX_DIR_ENTRIES)continue;
    for(const entry of names){
     if(!entry.isFile())continue;
     const ext=path.extname(entry.name).toLowerCase();
     if(!ART_EXTS.has(ext))continue;
     const stem=cleanKey(entry.name.slice(0,-path.extname(entry.name).length));
     let score=ART_RANK.get(stem)||0;
     if(gameKey.length>=4&&[gameKey,`${gameKey}cover`,`${gameKey}poster`,`${gameKey}boxart`,`${gameKey}keyart`].includes(stem))score=105;
     if(!score)continue;
     candidates.push({file:path.join(dir,entry.name),score:score-(subdir?2:0)-(root===executableDir&&root!==install?1:0)});
    }
   }catch{/* Unavailable directory or malformed image cannot block discovery. */}
  }
 }
 candidates.sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file));
 let checked=0;
 for(const {file} of candidates){
  if(checked++>=MAX_IMAGE_READS)break;
  try{
   const stat=await fs.lstat(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size<24||stat.size>MAX)continue;
   const handle=await fs.open(file,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));
   try{
    const current=await handle.stat();
    if(!current.isFile()||current.size!==stat.size||current.size>MAX)continue;
    const bytes=await handle.readFile();
    if(bytes.length===current.size&&isPortraitArtwork(bytes)&&await validate(bytes))return file;
   }finally{await handle.close();}
  }catch{}
 }
 return null;
}
function epicIdentity(game){
 if(game.source!=='epic'||typeof game.launch_uri!=='string')return null;
 try{const u=new URL(game.launch_uri);if(u.protocol!=='com.epicgames.launcher:'||u.hostname!=='apps')return null;
  const parts=decodeURIComponent(u.pathname.slice(1)).split(':');
  if(parts.length!==3||parts[2]!==game.source_id||parts.some(s=>!/^[a-z0-9_-]{1,128}$/i.test(s)))return null;
  return {namespace:parts[0],id:parts[1]};
 }catch{return null;}
}
function trustedImage(url){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^(?:(?:cdn1|cdn2)\.epicgames\.com|cdn2\.unrealengine\.com)$/i.test(u.hostname);}catch{return false;}}
async function imageBytes(response,validate){
 if(!response?.ok||!response.body||Number(response.headers.get('content-length')||0)>MAX)return null;
 const type=(response.headers.get('content-type')||'').split(';')[0].toLowerCase();
 const ext={'image/png':'.png','image/jpeg':'.jpg'}[type];if(!ext)return null;
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX)return null;chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const bytes=Buffer.concat(chunks,size);
 const magic=ext==='.png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):ext==='.jpg'?bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
 return magic&&isPortraitArtwork(bytes)&&validate(bytes)?{bytes,ext}:null;
}
async function findEpicPortrait(game,{fetchImpl=globalThis.fetch,online=()=>true,validate=()=>true}={}){
 if(game?.source!=='epic')return null;
 const identity=epicIdentity(game),title=typeof game.name==='string'?game.name.trim():'';
 const key=cleanKey(title.replace(/[™℠®©]/g,''));
 if(!online())return null;
 const tryImages=async images=>{
  if(!Array.isArray(images))return null;
  // Prefer true store portraits over generic thumbnails; never scan an
  // unbounded list or download the same URL more than once.
  const priority={DieselGameBoxTall:0,OfferImageTall:1,Thumbnail:2};
  const seen=new Set();
  const trusted=images.filter(image=>Object.hasOwn(priority,image?.type)&&trustedImage(image?.url))
   .sort((a,b)=>priority[a.type]-priority[b.type])
   .filter(image=>{if(seen.has(image.url))return false;seen.add(image.url);return true;})
   .slice(0,8);
  for(const image of trusted){
   if(!online())return null;
   try{
    const result=await imageBytes(await fetchImpl(image.url,{signal:AbortSignal.timeout(3500),redirect:'error'}),validate);
    if(!online())return null;
    if(result)return result;
   }catch{}
  }
  return null;
 };
 if(identity){
  try{
   const query='query OrbitItem($namespace:String!,$id:String!){Catalog{catalogItem(namespace:$namespace,id:$id,locale:"en-US"){id namespace keyImages{type url}}}}';
   const url='https://www.epicgames.com/graphql?'+new URLSearchParams({query,variables:JSON.stringify(identity)});
   const data=await readSmallJson(await fetchImpl(url,{signal:AbortSignal.timeout(3500),redirect:'error'}));
   const item=data?.data?.Catalog?.catalogItem;
   // Never trust images from a mismatched identity. A separate exact-title
   // search can still find the correct storefront offer.
   if(item&&item.id===identity.id&&item.namespace===identity.namespace){
    const result=await tryImages(item.keyImages);if(result)return result;
   }
  }catch{}
 }
 const usableTitle=key.length>=4&&title.length<=140&&!Array.from(title).some(c=>c.charCodeAt(0)<32);
 if(online()&&usableTitle)try{
  const query='query OrbitSearch($keywords:String!){Catalog{searchStore(keywords:$keywords,country:"US",locale:"en-US",count:20,start:0){elements{title id namespace keyImages{type url}}}}}';
  const url='https://store.epicgames.com/graphql?'+new URLSearchParams({query,variables:JSON.stringify({keywords:title})});
  const data=await readSmallJson(await fetchImpl(url,{signal:AbortSignal.timeout(3500),redirect:'error'}));
  const elements=data?.data?.Catalog?.searchStore?.elements;
  if(Array.isArray(elements)){
   const matches=elements.slice(0,20).filter(item=>typeof item?.title==='string'&&cleanKey(item.title.replace(/[™℠®©]/g,''))===key);
   if(matches.length===1){const result=await tryImages(matches[0].keyImages);if(result)return result;}
  }
 }catch{}
 if(game.source==='epic'&&(key==='fortnite'||String(game.source_id||'').toLowerCase()==='fortnite')){
  return tryImages([{type:'DieselGameBoxTall',url:FORTNITE_PORTRAIT}]);
 }
 return null;
}
module.exports={findLocalPortrait,findEpicPortrait};

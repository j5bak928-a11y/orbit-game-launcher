'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {isPortraitArtwork}=require('./cover-shape.cjs');
const {readSmallJson}=require('./steam-search.cjs');
const {cleanKey}=require('./game-identity.cjs');
const MAX=5*1024*1024;
// Last-resort official asset for the installed Fortnite app. Store metadata is
// preferred so it can follow newer artwork; this image may eventually expire.
const FORTNITE_PORTRAIT='https://cdn1.epicgames.com/item/fn/FNBR_42-30_Fortnitemares_KeyArt_Fortnitemares_EGS_Launcher_Blade_1200x1600_1200x1600-af4593ae7f114b21aa0dc08449063141';
async function findLocalPortrait(game,{validate=()=>true}={}){
 if(game.source==='steam')return null;
 const dirs=[];
 if(typeof game.install_path==='string'&&path.isAbsolute(game.install_path))dirs.push(game.install_path);
 if(typeof game.executable==='string'&&path.isAbsolute(game.executable))dirs.push(path.dirname(game.executable));
 for(const dir of [...new Set(dirs)].slice(0,2))for(const name of ['cover.jpg','cover.png','folder.jpg','folder.png','poster.jpg','poster.png']){
  const file=path.join(dir,name);
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.size<24||stat.size>MAX)continue;
   const bytes=await fs.readFile(file);if(bytes.length===stat.size&&isPortraitArtwork(bytes)&&validate(bytes))return file;
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
 const identity=epicIdentity(game),title=typeof game.name==='string'?game.name.trim():'';
 const key=cleanKey(title.replace(/[™℠®©]/g,''));
 if(!online())return null;
 const tryImages=async images=>{
  if(!Array.isArray(images))return null;
  for(const image of images.slice(0,30)){
   if(!online())return null;
   if(!['DieselGameBoxTall','OfferImageTall','Thumbnail'].includes(image?.type)||!trustedImage(image.url))continue;
   try{const result=await imageBytes(await fetchImpl(image.url,{signal:AbortSignal.timeout(3500),redirect:'error'}),validate);if(result)return result;}catch{}
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

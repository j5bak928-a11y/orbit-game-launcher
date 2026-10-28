'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {isPortraitArtwork}=require('./cover-shape.cjs');
const {readSmallJson}=require('./steam-search.cjs');
const MAX=5*1024*1024;
async function findLocalPortrait(game){
 if(game.source==='steam')return null;
 const dirs=[];
 if(typeof game.install_path==='string'&&path.isAbsolute(game.install_path))dirs.push(game.install_path);
 if(typeof game.executable==='string'&&path.isAbsolute(game.executable))dirs.push(path.dirname(game.executable));
 for(const dir of [...new Set(dirs)].slice(0,2))for(const name of ['cover.jpg','cover.png','cover.webp','folder.jpg','folder.png','folder.webp','poster.jpg','poster.png','poster.webp']){
  const file=path.join(dir,name);
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.size<24||stat.size>MAX)continue;
   const bytes=await fs.readFile(file);if(bytes.length===stat.size&&isPortraitArtwork(bytes))return file;
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
function trustedImage(url){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^(?:cdn1|cdn2)\.epicgames\.com$/i.test(u.hostname);}catch{return false;}}
async function imageBytes(response){
 if(!response?.ok||!response.body||Number(response.headers.get('content-length')||0)>MAX)return null;
 const type=(response.headers.get('content-type')||'').split(';')[0].toLowerCase();
 const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}[type];if(!ext)return null;
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX)return null;chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const bytes=Buffer.concat(chunks,size);
 const magic=ext==='.png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):ext==='.jpg'?bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
 return magic&&isPortraitArtwork(bytes)?{bytes,ext}:null;
}
async function findEpicPortrait(game,{fetchImpl=globalThis.fetch,online=()=>true}={}){
 const identity=epicIdentity(game);if(!identity||!online())return null;
 const query='query OrbitItem($namespace:String!,$id:String!){Catalog{catalogItem(namespace:$namespace,id:$id,locale:"en-US"){id namespace keyImages{type url}}}}';
 const url='https://www.epicgames.com/graphql?'+new URLSearchParams({query,variables:JSON.stringify(identity)});
 try{
  const response=await fetchImpl(url,{signal:AbortSignal.timeout(3500),redirect:'error'});
  const data=await readSmallJson(response),item=data?.data?.Catalog?.catalogItem;
  if(item?.id!==identity.id||item?.namespace!==identity.namespace||!Array.isArray(item.keyImages))return null;
  for(const image of item.keyImages.slice(0,30)){
   if(!online())return null;
   if(!['DieselGameBoxTall','OfferImageTall','Thumbnail'].includes(image?.type)||!trustedImage(image.url))continue;
   try{const bytes=await imageBytes(await fetchImpl(image.url,{signal:AbortSignal.timeout(3500),redirect:'error'}));if(bytes)return bytes;}catch{}
  }
 }catch{}
 return null;
}
module.exports={findLocalPortrait,findEpicPortrait};

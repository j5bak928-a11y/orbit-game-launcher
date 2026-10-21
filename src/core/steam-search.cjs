'use strict';
const {cleanKey}=require('./game-identity.cjs');

const MAX_SEARCH_BYTES=256*1024;
// Trademark characters can expand into literal TM/SM under Unicode NFKD.
// Remove them before comparing exact catalog titles.
const titleKey=name=>cleanKey(String(name||'').replace(/[™℠®©]/g,''));
const isUsableName=name=>typeof name==='string' && name.length>=3 && name.length<=140 && /^[^\u0000-\u001f]+$/.test(name) && cleanKey(name).length>=4;
async function readSmallJson(response){
  if(!response?.ok||!response.body)return null;
  const length=Number(response.headers.get('content-length')||0);
  if(length>MAX_SEARCH_BYTES){await response.body.cancel().catch(()=>{});return null;}
  const reader=response.body.getReader(),parts=[];let size=0;
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>MAX_SEARCH_BYTES)return null;
      parts.push(value);
    }
  }finally{await reader.cancel().catch(()=>{});}
  try{return JSON.parse(Buffer.concat(parts,size).toString('utf8'));}catch{return null;}
}
// Steam Store's public search response is advisory. Only accept exact
// normalized title matches; similar sequels/DLC must never be auto-selected.
async function findExactSteamApp(name,{fetchImpl=globalThis.fetch}={}){
  const title=typeof name==='string'?name.trim():'';
  if(!isUsableName(title))return null;
  const url=`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=US`;
  try{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(3500)});
    const data=await readSmallJson(response);
    const key=titleKey(title);
    if(!Array.isArray(data?.items))return null;
    for(const item of data.items.slice(0,20)){
      if(item?.type!=='app'||!Number.isSafeInteger(item.id)||item.id<1)continue;
      if(titleKey(item.name)!==key)continue;
      return {name:item.name,steamId:String(item.id)};
    }
  }catch{/* Steam search is optional; local games work offline. */}
  return null;
}
module.exports={findExactSteamApp,readSmallJson};

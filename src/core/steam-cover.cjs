'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {readJpegWithLimit}=require('./artwork.cjs');
const {isPortraitArtwork}=require('./cover-shape.cjs');
const {steamRoots}=require('./discovery.cjs');

const CDN='https://shared.fastly.steamstatic.com/store_item_assets/';
const MAX_JSON_BYTES=1024*1024;
const LEGACY_GAME_PORTRAITS=Object.freeze({'252950':'cc030d5cf1de6d485d41685bf2aac8ae4ca8ab8e/library_capsule_2x.jpg'});
// Steam uses both historical library_600x900 and newer library_capsule filenames.
// Only portrait library assets are accepted; headers and store capsules stay excluded.
const VALID_ASSET=/^(?:[a-f0-9]{40}\/)?(?:library_600x900|library_capsule)(?:_2x)?\.jpg$/i;
const validId=id=>/^\d{1,15}$/.test(String(id??''));

function officialAssetUrls(appId,assets){
  if(!validId(appId)||!assets||typeof assets!=='object')return [];
  const template=String(assets.asset_url_format||'');
  if(!new RegExp(`^steam/apps/${appId}/(?:[a-f0-9]{40}/)?\\$\\{FILENAME\\}(?:\\?t=\\d+)?$`,'i').test(template))return [];
  const urls=[];
  for(const key of ['library_capsule_2x','library_capsule']){
    const filename=assets[key];
    if(typeof filename!=='string'||!VALID_ASSET.test(filename))continue;
    urls.push(CDN+template.replace(`\${FILENAME}`,filename));
  }
  return [...new Set(urls)];
}

async function readSmallJson(response){
  if(!response?.ok||!response.body)return null;
  const length=Number(response.headers.get('content-length')||0);
  if(length>MAX_JSON_BYTES)return null;
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_JSON_BYTES)return null;chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{return null;}
}

async function steamMetadataUrls(appId,{fetchImpl=globalThis.fetch}={}){
  if(!validId(appId))return [];
  const input={ids:[{appid:Number(appId)}],context:{country_code:'US',language:'english'},data_request:{include_assets:true}};
  const url=`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
  try{
    const data=await readSmallJson(await fetchImpl(url,{signal:AbortSignal.timeout(3200)}));
    const item=data?.response?.store_items?.find(x=>String(x?.appid)===String(appId));
    return officialAssetUrls(appId,item?.assets);
  }catch{return [];}
}

async function localSteamCover(appId,{roots=steamRoots(),readFile=fs.readFile,readdir=fs.readdir,stat=fs.stat}={}){
  if(!validId(appId))return null;
  for(const root of roots.slice(0,12)){
    const cache=path.join(root,'appcache','librarycache');
    const portraitNames=['library_capsule_2x.jpg','library_capsule.jpg','library_600x900_2x.jpg','library_600x900.jpg'];
    const direct=[path.join(cache,`${appId}_library_600x900.jpg`),path.join(cache,`${appId}_library_capsule.jpg`),...portraitNames.map(name=>path.join(cache,String(appId),name))];
    let children=[];try{children=await readdir(path.join(cache,String(appId)),{withFileTypes:true});}catch{}
    for(const item of children.slice(0,150))if(item.isDirectory()&&/^[a-f0-9]{40}$/i.test(item.name)){
      for(const name of portraitNames)direct.push(path.join(cache,String(appId),item.name,name));
    }
    for(const file of direct){
      try{const info=await stat(file);if(!info.isFile()||info.size>5*1024*1024||info.size<3)continue;
        const bytes=await readFile(file);if(!isPortraitArtwork(bytes))continue;
        return bytes;
      }catch{}
    }
  }
  return null;
}

// Steam stores small game icons independently of portrait library artwork.
// They are useful when a game executable cannot be located or has no PE icon.
async function localSteamIcon(appId,{roots=steamRoots(),stat=fs.stat,readdir=fs.readdir}={}){
  if(!validId(appId))return '';
  for(const root of roots.slice(0,12)){
    const base=path.join(root,'appcache','librarycache');
    const candidates=[
      path.join(base,`${appId}_icon.jpg`),
      path.join(base,`${appId}_icon.png`),
      path.join(base,String(appId),'icon.jpg'),
      path.join(base,String(appId),'library_icon.jpg'),
      path.join(base,String(appId),'library_icon.png')
    ];
    let children=[];
    try{children=await readdir(path.join(base,String(appId)),{withFileTypes:true})}catch{}
    for(const item of children.slice(0,120))
      if(item.isDirectory()&&/^[a-f0-9]{40}$/i.test(item.name)){
        candidates.push(path.join(base,String(appId),item.name,'library_icon.jpg'));
        candidates.push(path.join(base,String(appId),item.name,'library_icon.png'));
      }
    for(const file of candidates){
      try{const meta=await stat(file);if(meta.isFile()&&meta.size>=16&&meta.size<=2*1024*1024)return file;}catch{}
    }
  }
  return '';
}

async function findSteamCover(appId,{fetchImpl=globalThis.fetch,roots=steamRoots(),local=localSteamCover}={}){
  if(!validId(appId))return null;
  const fromCache=await local(appId,{roots});if(fromCache&&isPortraitArtwork(fromCache))return fromCache;
  const metadata=await steamMetadataUrls(appId,{fetchImpl});
  const fallbacks=['library_capsule_2x.jpg','library_capsule.jpg','library_600x900_2x.jpg','library_600x900.jpg'].map(name=>`${CDN}steam/apps/${appId}/${name}`);
  const extra=LEGACY_GAME_PORTRAITS[String(appId)]?CDN+'steam/apps/'+appId+'/'+LEGACY_GAME_PORTRAITS[String(appId)]:'';
  const urls=[...new Set([...metadata,...fallbacks,extra].filter(Boolean))].slice(0,12);
  for(const url of urls){
    try{const response=await fetchImpl(url,{signal:AbortSignal.timeout(2800)});const bytes=await readJpegWithLimit(response);if(bytes&&isPortraitArtwork(bytes))return bytes;}catch{}
  }
  return null;
}
module.exports={officialAssetUrls,steamMetadataUrls,localSteamCover,localSteamIcon,findSteamCover};

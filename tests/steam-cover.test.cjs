'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {officialAssetUrls,steamMetadataUrls,localSteamCover,localSteamIcon,findSteamCover}=require('../src/core/steam-cover.cjs');
const jpeg=Buffer.from([255,216,255,192,0,11,8,3,132,2,88,1,1,17,0,255,217]);
const landscape=Buffer.from([255,216,255,192,0,11,8,1,97,2,104,1,1,17,0,255,217]);
const hash='a'.repeat(40);
const meta={appid:8765,assets:{asset_url_format:`steam/apps/8765/\${FILENAME}?t=123`,library_capsule_2x:`${hash}/library_600x900_2x.jpg`}};
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const image=()=>new Response(jpeg,{headers:{'content-type':'image/jpeg'}});

test('Modern Warfare 4 still gets its official portrait when Steam metadata is unavailable',async()=>{
 const cover=await findSteamCover('4435490',{local:async()=>null,fetchImpl:async url=>
  url==='https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/4435490/c71bc2cb60e440d1a0d2435d0c06c4d4a4050edf/library_capsule_2x.jpg'
   ?image():new Response('unavailable',{status:503})});
 assert.deepEqual(cover,jpeg);
});

test('Steam GetItems metadata resolves content-hashed portrait',async()=>{
 const requests=[];
 const mock=async url=>{requests.push(url);return url.includes('GetItems')?json({response:{store_items:[meta]}}):image()};
 assert.deepEqual(await findSteamCover('8765',{fetchImpl:mock,local:async()=>null}),jpeg);
 assert.match(requests[1],/steam\/apps\/8765\/a{40}\/library_600x900_2x.jpg\?t=123/);
 assert.equal(requests.length,2);
});
test('remote Steam asset metadata cannot inject URL',()=>{
 assert.deepEqual(officialAssetUrls('8765',{asset_url_format:`https://evil.example/\${FILENAME}`,library_capsule:'library_600x900.jpg'}),[]);
 assert.deepEqual(officialAssetUrls('8765',{asset_url_format:`steam/apps/8765/\${FILENAME}`,library_capsule:'../../secret.jpg'}),[]);
});
test('old artwork falls back to legacy paths',async()=>{
 const requests=[];
 const mock=async url=>{requests.push(url);return url.includes('GetItems')?json({response:{store_items:[]}}):url.endsWith('library_600x900.jpg')?image():new Response('missing',{status:404})};
 assert.deepEqual(await findSteamCover('123',{fetchImpl:mock,local:async()=>null}),jpeg);
 assert.ok(requests.some(url=>url.endsWith('library_600x900.jpg')));
 assert.equal(requests.some(url=>url.endsWith('header.jpg')),false,'wide banners must never become library covers');
});
test('Steam cached library cover supports offline hashed directories',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-steam-cover-'));
 try{
  const folder=path.join(root,'appcache','librarycache','8765',hash);
  await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'library_600x900.jpg'),jpeg);
  assert.deepEqual(await localSteamCover('8765',{roots:[root]}),jpeg);
  assert.deepEqual(await findSteamCover('8765',{roots:[root],fetchImpl:async()=>{throw Error('offline')}}),jpeg);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('invalid Steam IDs never access network',async()=>{
 assert.deepEqual(await steamMetadataUrls('bad',{fetchImpl:async()=>{throw Error('network')}}),[]);
 assert.equal(await findSteamCover('bad',{fetchImpl:async()=>{throw Error('network')}}),null);
});

test('Delisted Rocket League uses an available published portrait fallback',async()=>{
 const requests=[];
 const cover=await findSteamCover('252950',{local:async()=>null,fetchImpl:async url=>{
  requests.push(url);
  if(url.includes('GetItems'))return json({response:{store_items:[]}});
  return url.includes('cc030d5cf1de6d485d41685bf2aac8ae4ca8ab8e/library_capsule_2x.jpg')?image():new Response('missing',{status:404});
 }});
 assert.deepEqual(cover,jpeg);assert.ok(requests.at(-1).includes('library_capsule_2x.jpg'));
});

test('Steam cover lookup skips wide artwork even when metadata advertises it',async()=>{
 const urls=[];
 const result=await findSteamCover('8765',{local:async()=>null,fetchImpl:async url=>{
  urls.push(url);
  if(url.includes('GetItems'))return json({response:{store_items:[{appid:8765,assets:{asset_url_format:`steam/apps/8765/\${FILENAME}`,library_capsule:'header.jpg',header:'header.jpg'}}]}});
  if(url.endsWith('library_600x900_2x.jpg'))return new Response(landscape,{headers:{'content-type':'image/jpeg'}});
  if(url.endsWith('library_600x900.jpg'))return image();
  return new Response('missing',{status:404});
 }});
 assert.deepEqual(result,jpeg);
 assert.ok(!urls.includes('https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/8765/header.jpg'));
});
test('never promotes wide-only Steam banners into portrait library covers',async()=>{
 const result=await findSteamCover('98765',{local:async()=>landscape,fetchImpl:async url=>{
  if(url.includes('GetItems'))return json({response:{store_items:[]}});
  return new Response(landscape,{headers:{'content-type':'image/jpeg'}});
 }});
 assert.equal(result,null);
});

test('Steam cached icon is usable when no portrait is available',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-steam-icon-'));
 try{
  const dir=path.join(root,'appcache','librarycache');await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,'8765_icon.jpg');await fs.writeFile(file,Buffer.alloc(60,17));
  assert.equal(await localSteamIcon('8765',{roots:[root]}),file);
  assert.equal(await localSteamIcon('other',{roots:[root]}),'');
  assert.equal(await localSteamIcon('9901',{roots:[root]}),'');
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('newer Steam library_capsule assets are accepted without accidentally fetching wide headers',async()=>{
 const modern={appid:5043180,assets:{asset_url_format:`steam/apps/5043180/\${FILENAME}?t=20261009`,
   library_capsule_2x:'89f835791c1daa04f54fc43aa35da99a62683925/library_capsule_2x.jpg',
   library_capsule:'89f835791c1daa04f54fc43aa35da99a62683925/library_capsule.jpg',
   header:'dbc92ea85a96bf4d26352de723f9bc5362e140a5/header.jpg'}};
 const urls=officialAssetUrls('5043180',modern.assets);
 assert.equal(urls.length,2);
 assert.match(urls[0],/5043180\/89f835791c1daa04f54fc43aa35da99a62683925\/library_capsule_2x.jpg/);
 assert.ok(urls.every(u=>!u.includes('header.jpg')));
 const requested=[];
 const cover=await findSteamCover('5043180',{local:async()=>null,fetchImpl:async url=>{
   requested.push(url);
   if(url.includes('GetItems'))return json({response:{store_items:[modern]}});
   if(url.includes('library_capsule_2x.jpg'))return image();
   return new Response('Not found',{status:404});
 }});
 assert.deepEqual(cover,jpeg);
 assert.equal(requested.length,2);
});
test('Football, sports and other recent Steam cover names are supported, but unsafe files are rejected',()=>{
 const hash40='81210d536b70c14e4cf9725f3f03d82bf64e5e25';
 const assets={asset_url_format:`steam/apps/4080220/\${FILENAME}`,library_capsule_2x:hash40+'/library_capsule_2x.jpg'};
 assert.match(officialAssetUrls('4080220',assets)[0],/library_capsule_2x.jpg$/);
 assert.deepEqual(officialAssetUrls('4080220',{...assets,library_capsule_2x:hash40+'/header.jpg'}),[]);
 assert.deepEqual(officialAssetUrls('4080220',{...assets,library_capsule_2x:'https://attacker.example/art.jpg'}),[]);
 assert.deepEqual(officialAssetUrls('4080220',{...assets,asset_url_format:`https://attacker.example/\${FILENAME}`}),[]);
});
test('Steam can load a newer portrait capsule from the disk cache without the internet',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-capsule-modern-'));
 try{
   const dir=path.join(root,'appcache','librarycache','4080220',hash);
   await fs.mkdir(dir,{recursive:true});
   await fs.writeFile(path.join(dir,'library_capsule_2x.jpg'),jpeg);
   assert.deepEqual(await localSteamCover('4080220',{roots:[root]}),jpeg);
   assert.deepEqual(await findSteamCover('4080220',{roots:[root],fetchImpl:async()=>{throw Error('offline')}}),jpeg);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('offline-only cover lookups use disk without making any network request',async()=>{
 let calls=0;
 const result=await findSteamCover('123',{online:false,local:async()=>null,fetchImpl:async()=>{calls++;return image()}});
 assert.equal(result,null);assert.equal(calls,0);
 assert.deepEqual(await findSteamCover('123',{online:false,local:async()=>jpeg,fetchImpl:async()=>{throw Error('network')}}),jpeg);
});

test('Steam hero lookup accepts only landscape art and works offline',async()=>{
 const {findSteamBanner}=require('../src/core/steam-cover.cjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-steam-banner-'));
 try{
  const folder=path.join(root,'appcache','librarycache');await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'123_library_hero.jpg'),landscape);
  let calls=0;assert.deepEqual(await findSteamBanner('123',{roots:[root],online:false,fetchImpl:async()=>{calls++;throw Error('network')}}),landscape);
  assert.equal(calls,0);
  await fs.writeFile(path.join(folder,'123_library_hero.jpg'),jpeg);
  assert.equal(await findSteamBanner('123',{roots:[root],online:false}),null);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

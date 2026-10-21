'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {officialAssetUrls,steamMetadataUrls,localSteamCover,findSteamCover}=require('../src/core/steam-cover.cjs');
const jpeg=Buffer.from([255,216,255,0,14,34,9]);
const hash='a'.repeat(40);
const meta={appid:8765,assets:{asset_url_format:'steam/apps/8765/${FILENAME}?t=123',library_capsule_2x:`${hash}/library_600x900_2x.jpg`}};
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const image=()=>new Response(jpeg,{headers:{'content-type':'image/jpeg'}});

test('Steam GetItems metadata resolves content-hashed portrait',async()=>{
 const requests=[];
 const mock=async url=>{requests.push(url);return url.includes('GetItems')?json({response:{store_items:[meta]}}):image()};
 assert.deepEqual(await findSteamCover('8765',{fetchImpl:mock,local:async()=>null}),jpeg);
 assert.match(requests[1],/steam\/apps\/8765\/a{40}\/library_600x900_2x.jpg\?t=123/);
 assert.equal(requests.length,2);
});
test('remote Steam asset metadata cannot inject URL',()=>{
 assert.deepEqual(officialAssetUrls('8765',{asset_url_format:'https://evil.example/${FILENAME}',library_capsule:'library_600x900.jpg'}),[]);
 assert.deepEqual(officialAssetUrls('8765',{asset_url_format:'steam/apps/8765/${FILENAME}',library_capsule:'../../secret.jpg'}),[]);
});
test('old artwork falls back to legacy paths',async()=>{
 const requests=[];
 const mock=async url=>{requests.push(url);return url.includes('GetItems')?json({response:{store_items:[]}}):url.endsWith('header.jpg')?image():new Response('missing',{status:404})};
 assert.deepEqual(await findSteamCover('123',{fetchImpl:mock,local:async()=>null}),jpeg);
 assert.ok(requests.some(url=>url.endsWith('library_600x900.jpg')));
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

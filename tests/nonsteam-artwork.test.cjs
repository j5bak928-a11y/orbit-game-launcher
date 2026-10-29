'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {findLocalPortrait,findEpicPortrait}=require('../src/core/nonsteam-artwork.cjs');
function png(w,h){const b=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;}
test('Fortnite uses a known official portrait when both Epic metadata lookups fail',async()=>{
 const game={source:'epic',name:'Fortnite',source_id:'Fortnite'};
 const result=await findEpicPortrait(game,{fetchImpl:async url=>
  url==='https://cdn1.epicgames.com/item/fn/FNBR_42-30_Fortnitemares_KeyArt_Fortnitemares_EGS_Launcher_Blade_1200x1600_1200x1600-af4593ae7f114b21aa0dc08449063141'
   ?new Response(png(600,900),{headers:{'content-type':'image/png'}}):new Response('unavailable',{status:503})});
 assert.deepEqual(result?.bytes,png(600,900));
});
test('finds portrait artwork in the installed game folder while rejecting landscape and links',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-local-art-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'cover.jpg'),png(1280,720));
 await fs.writeFile(path.join(root,'folder.png'),png(600,900));
 const found=await findLocalPortrait({source:'epic',install_path:root});
 assert.equal(found,path.join(root,'folder.png'));
});
test('Epic catalog item identity retrieves portrait artwork from a trusted host',async()=>{
 const game={source:'epic',source_id:'game1',launch_uri:'com.epicgames.launcher://apps/namespace1%3Aitem1%3Agame1?action=launch'};
 const calls=[];
 const fetchImpl=async url=>{calls.push(url);return calls.length===1?new Response(JSON.stringify({data:{Catalog:{catalogItem:{id:'item1',namespace:'namespace1',keyImages:[{type:'DieselGameBoxTall',url:'https://cdn1.epicgames.com/game/cover.png'}]}}}})) : new Response(png(600,900),{headers:{'content-type':'image/png'}});};
 const result=await findEpicPortrait(game,{fetchImpl});
 assert.equal(result.ext,'.png');assert.deepEqual(result.bytes,png(600,900));assert.equal(calls.length,2);
});
test('Epic lookup rejects mismatched identity and untrusted image hosts',async()=>{
 const game={source:'epic',source_id:'game1',launch_uri:'com.epicgames.launcher://apps/ns%3Aitem%3Agame1?action=launch'};
 for(const item of [{id:'wrong',namespace:'ns',keyImages:[]},{id:'item',namespace:'ns',keyImages:[{type:'DieselGameBoxTall',url:'https://evil.example/image.jpg'}]}]){
  let count=0;const out=await findEpicPortrait(game,{fetchImpl:async()=>{count++;return new Response(JSON.stringify({data:{Catalog:{catalogItem:item}}}));}});
  assert.equal(out,null);assert.equal(count,1);
 }
});
test('local finder skips a corrupt candidate when image decoding fails',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-broken-art-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const bad=png(600,900),good=Buffer.concat([png(600,900),Buffer.from('valid')]);
 await fs.writeFile(path.join(root,'cover.png'),bad);await fs.writeFile(path.join(root,'folder.png'),good);
 const found=await findLocalPortrait({source:'manual',install_path:root},{validate:bytes=>bytes.length>32});
 assert.equal(found,path.join(root,'folder.png'));
});

test('finds Fortnite by exact store title if no catalog identity exists',async()=>{
 const game={source:'epic',name:'Fortnite',source_id:'Fortnite',launch_uri:'com.epicgames.launcher://apps/Fortnite?action=launch'};
 const calls=[];const fetchImpl=async url=>{calls.push(url);return calls.length===1?new Response(JSON.stringify({data:{Catalog:{searchStore:{elements:[{title:'Fortnite Save the World',keyImages:[]},{title:'Fortnite',keyImages:[{type:'OfferImageTall',url:'https://cdn1.epicgames.com/offer/fn/image'}]}]}}}})):new Response(png(600,900),{headers:{'content-type':'image/png'}});};
 const result=await findEpicPortrait(game,{fetchImpl});assert.deepEqual(result.bytes,png(600,900));assert.equal(calls.length,2);
});
test('does not select a similar Epic title',async()=>{
 const game={source:'epic',name:'Outer Wilds',source_id:'outerwilds'};let count=0;
 const result=await findEpicPortrait(game,{fetchImpl:async()=>{count++;return new Response(JSON.stringify({data:{Catalog:{searchStore:{elements:[{title:'Outer Wilds Soundtrack',keyImages:[{type:'OfferImageTall',url:'https://cdn1.epicgames.com/wrong'}]}]}}}}));}});
 assert.equal(result,null);assert.equal(count,1);
});
test('falls back to exact title when Epic item has no portrait image',async()=>{
 const game={source:'epic',name:'Fortnite',source_id:'game1',launch_uri:'com.epicgames.launcher://apps/namespace1%3Aitem1%3Agame1?action=launch'};let calls=0;
 const fetchImpl=async()=>{calls++;if(calls===1)return new Response(JSON.stringify({data:{Catalog:{catalogItem:{id:'item1',namespace:'namespace1',keyImages:[]}}}}));if(calls===2)return new Response(JSON.stringify({data:{Catalog:{searchStore:{elements:[{title:'Fortnite',keyImages:[{type:'OfferImageTall',url:'https://cdn2.unrealengine.com/fn.jpg'}]}]}}}}));return new Response(png(600,900),{headers:{'content-type':'image/png'}});};
 assert.deepEqual((await findEpicPortrait(game,{fetchImpl})).bytes,png(600,900));assert.equal(calls,3);
});

test('a mismatched catalog item cannot prevent an independent exact-title match',async()=>{
 const game={source:'epic',name:'Outer Wilds',source_id:'game1',launch_uri:'com.epicgames.launcher://apps/ns%3Aitem%3Agame1?action=launch'};
 const requests=[];
 const result=await findEpicPortrait(game,{fetchImpl:async url=>{
  requests.push(url);
  if(url.includes('www.epicgames.com/graphql'))return new Response(JSON.stringify({data:{Catalog:{catalogItem:{id:'wrong',namespace:'ns',keyImages:[{type:'OfferImageTall',url:'https://cdn1.epicgames.com/wrong'}]}}}}));
  if(url.includes('store.epicgames.com/graphql'))return new Response(JSON.stringify({data:{Catalog:{searchStore:{elements:[{title:'Outer Wilds',keyImages:[{type:'OfferImageTall',url:'https://cdn1.epicgames.com/right'}]}]}}}}));
  return new Response(png(600,900),{headers:{'content-type':'image/png'}});
 }});
 assert.deepEqual(result?.bytes,png(600,900));assert(!requests.includes('https://cdn1.epicgames.com/wrong'));
});

test('Fortnite fallback never requests the network when artwork is disabled',async()=>{
 let requests=0;
 const result=await findEpicPortrait({source:'epic',name:'Fortnite',source_id:'Fortnite'},{online:()=>false,fetchImpl:async()=>{requests++;throw Error('offline');}});
 assert.equal(result,null);assert.equal(requests,0);
});

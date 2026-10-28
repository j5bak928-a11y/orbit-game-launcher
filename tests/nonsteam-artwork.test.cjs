'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {findLocalPortrait,findEpicPortrait}=require('../src/core/nonsteam-artwork.cjs');
function png(w,h){const b=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;}
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

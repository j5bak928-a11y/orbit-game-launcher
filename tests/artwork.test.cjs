'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readJpegWithLimit}=require('../src/core/artwork.cjs');
const jpeg=Uint8Array.from([255,216,255,5,7,9]);

test('artwork stream accepts valid small JPEG without a length header',async()=>{
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(jpeg);controller.close()}}),{headers:{'content-type':'image/jpeg'}});
  const result=await readJpegWithLimit(response,10);
  assert.deepEqual(result,Buffer.from(jpeg));
});
test('artwork refuses invalid content type and JPEG magic bytes',async()=>{
  assert.equal(await readJpegWithLimit(new Response(jpeg,{headers:{'content-type':'text/plain'}})),null);
  assert.equal(await readJpegWithLimit(new Response(Uint8Array.from([0,1,2]),{headers:{'content-type':'image/jpeg'}})),null);
});
test('artwork rejects oversized bodies even with no content-length',async()=>{
  let cancelled=false;
  const body=new ReadableStream({start(controller){controller.enqueue(jpeg);controller.enqueue(new Uint8Array(20));},cancel(){cancelled=true;}});
  const response=new Response(body,{headers:{'content-type':'image/jpeg'}});
  const result=await readJpegWithLimit(response,10);
  assert.equal(result,null);
  assert.equal(cancelled,true,'oversize must cancel the network stream');
});
test('artwork rejects oversized declared lengths',async()=>{
  const response=new Response(jpeg,{headers:{'content-type':'image/jpeg','content-length':'1000'}});
  assert.equal(await readJpegWithLimit(response,10),null);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createUpdateService}=require('../src/core/updates.cjs');
test('unsigned builds reject programmatic installer execution',async()=>{
 const service=createUpdateService({
  app:{isPackaged:true,getVersion:()=>'0.2.9'},platform:'win32',
  fetchRelease:async()=>new Response(JSON.stringify({tag_name:'v0.2.11',draft:false,prerelease:false})),
  openExternal:()=>assert.fail('install must never hand off a browser or installer')
 });
 assert.equal((await service.check()).state,'available');
 assert.throws(()=>service.install(),/unavailable/i);
});

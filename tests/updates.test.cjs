'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createUpdateService,configureFeed}=require('../src/core/updates.cjs');
test('update feed rejects insecure or credential-bearing URLs',()=>{
 const updater={setFeedURL(){}};
 for(const url of ['http://example.org/updates','https://user:secret@example.org/','https://example.org/#fragment'])
  assert.throws(()=>configureFeed(updater,{ORBIT_UPDATE_FEED_URL:url}));
 assert.equal(configureFeed(updater,{ORBIT_UPDATE_FEED_URL:'https://updates.example.org/stable/'}),'updates.example.org');
});
test('source builds do not contact release servers',async()=>{
 let loaded=false;const service=createUpdateService({app:{isPackaged:false},platform:'win32',loadUpdater:()=>{loaded=true;}});
 assert.equal((await service.check()).state,'unsupported');
 assert.equal(loaded,false);service.dispose();
});

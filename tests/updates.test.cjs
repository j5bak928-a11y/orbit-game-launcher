'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createUpdateService,configureFeed}=require('../src/core/updates.cjs');
test('update feed rejects insecure or credential-bearing URLs',()=>{
 const updater={setFeedURL(){}};
 for(const url of ['http://example.org/updates','https://user:secret@example.org/','https://example.org/#fragment'])
  assert.throws(()=>configureFeed(updater,{ORBIT_UPDATE_FEED_URL:url}));
 assert.equal(configureFeed(updater,{ORBIT_UPDATE_FEED_URL:'https://updates.example.org/stable/'}),'updates.example.org');
});
test('updates download automatically but cannot install over running games',async()=>{
 const updater=new EventEmitter();let configured=null,installed=0;
 updater.setFeedURL=value=>configured=value;
 updater.checkForUpdates=async()=>{updater.emit('update-available',{version:'0.3.0'});updater.emit('update-downloaded',{version:'0.3.0'});};
 updater.quitAndInstall=()=>installed++;
 let running=true;
 const service=createUpdateService({app:{isPackaged:true},platform:'win32',loadUpdater:()=>updater,hasRunningGames:()=>running,env:{}});
 service.initialize();
 await service.check();
 assert.equal(configured.provider,'github');
 assert.equal(service.getStatus().state,'ready');
 assert.throws(()=>service.install(),/Exit running games/);
 running=false;assert.deepEqual(service.install(),{requested:true});assert.equal(installed,1);
 service.dispose();
});
test('source builds do not contact release servers',async()=>{
 let loaded=false;const service=createUpdateService({app:{isPackaged:false},platform:'win32',loadUpdater:()=>{loaded=true;}});
 assert.equal((await service.check()).state,'unsupported');
 assert.equal(loaded,false);service.dispose();
});

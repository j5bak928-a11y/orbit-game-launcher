'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createUpdateService}=require('../src/core/updates.cjs');
test('unsigned builds never initialize an updater or download installers',async()=>{
 let loaded=0;const service=createUpdateService({app:{isPackaged:true},platform:'win32',env:{},loadUpdater:()=>{loaded++;throw Error('must not load')}});
 const status=await service.check({manual:true});assert.equal(status.state,'unavailable');assert.match(status.message,/signed/i);assert.equal(loaded,0);assert.throws(()=>service.install(),/unavailable/i);
});
test('portable builds do not use an installer updater',async()=>{
 let loaded=0;const service=createUpdateService({app:{isPackaged:true},platform:'win32',env:{PORTABLE_EXECUTABLE_FILE:'C:\\Orbit.exe'},loadUpdater:()=>{loaded++;}});
 const status=await service.check({manual:true});assert.equal(status.state,'unsupported');assert.equal(loaded,0);
});

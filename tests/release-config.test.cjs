'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateReleaseConfig}=require('../scripts/release-config.cjs');
const pkg=require('../package.json');
const lock=require('../package-lock.json');
test('release version and installer identity are consistent',()=>{
 assert.deepEqual(validateReleaseConfig(pkg,lock),[]);
});
test('rejects stale installer names and mismatched lockfile versions',()=>{
 const changed=structuredClone(pkg);changed.version='999.0.0';
 const problems=validateReleaseConfig(changed,lock);
 assert(problems.some(x=>x.includes('lockfile')));
 assert(problems.some(x=>x.includes('buildVersion')));
 assert(problems.some(x=>x.includes('artifactName')));
});
test('rejects accidental installer identity and user-data removal changes',()=>{
 const changed=structuredClone(pkg);changed.build.appId='different.app';changed.build.nsis.deleteAppDataOnUninstall=true;changed.name='renamed';changed.build.productName='Renamed';changed.build.nsis.perMachine=true;
 const problems=validateReleaseConfig(changed,lock);
 assert(problems.some(x=>x.includes('appId')));
 assert(problems.some(x=>x.includes('package name')));
 assert(problems.some(x=>x.includes('productName')));
 assert(problems.some(x=>x.includes('perMachine')));
 assert(problems.some(x=>x.includes('deleteAppDataOnUninstall')));
});

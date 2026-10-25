'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ArtworkWork}=require('../src/core/artwork-work.cjs');
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};

test('artwork requests share an in-flight lookup and keep the worker limit',async()=>{
 const work=new ArtworkWork({concurrency:2});
 const a=defer(),b=defer();let started=0,active=0,maximum=0;
 const run=gate=>async()=>{started++;active++;maximum=Math.max(maximum,active);await gate.promise;active--;return 'token'};
 const first=work.run('a',run(a));const same=work.run('a',async()=>{throw Error('duplicate lookup')});
 const second=work.run('b',run(b));const third=work.run('c',run({promise:Promise.resolve()}));
 await Promise.resolve();assert.equal(started,2);
 a.resolve();b.resolve();assert.deepEqual(await Promise.all([first,same,second,third]),['token','token','token','token']);
 assert.equal(started,3);assert.equal(maximum,2);
});

test('misses are cached briefly and explicit retry clears only misses',async()=>{
 let now=0,hits=0;const work=new ArtworkWork({clock:()=>now,missTtl:10,successTtl:100});
 const missing=()=>{hits++;return ''};const found=()=>{hits++;return 'file.jpg'};
 assert.equal(await work.run('missing',missing),'');assert.equal(await work.run('missing',missing),'');assert.equal(hits,1);
 assert.equal(await work.run('found',found),'file.jpg');
 work.clearMisses();await work.run('missing',missing);await work.run('found',found);assert.equal(hits,3);
 now=12;await work.run('missing',missing);assert.equal(hits,4);
});

test('a failed artwork operation releases capacity without caching an exception',async()=>{
 const work=new ArtworkWork({concurrency:1});
 await assert.rejects(work.run('failed',()=>{throw Error('disk full')}),/disk full/);
 assert.equal(await work.run('failed',()=> 'recovered.jpg'),'recovered.jpg');
 assert.equal(await work.run('next',()=> 'next.jpg'),'next.jpg');
});

test('artwork cache evicts old entries to stay bounded',async()=>{
 const work=new ArtworkWork({maxEntries:2});let calls=0;
 for(const key of ['a','b','c'])await work.run(key,()=>{calls++;return key});
 await work.run('b',()=>{calls++;return 'b'});assert.equal(calls,3);
 await work.run('a',()=>{calls++;return 'a'});assert.equal(calls,4);
});

test('an immediate retry after a rejected operation gets a fresh worker',async()=>{
 const work=new ArtworkWork({concurrency:1});let calls=0;
 const result=await work.run('retry',()=>{calls++;throw Error('temporary write failure');})
  .catch(()=>work.run('retry',()=>{calls++;return 'recovered.jpg'}));
 assert.equal(result,'recovered.jpg');assert.equal(calls,2);
});

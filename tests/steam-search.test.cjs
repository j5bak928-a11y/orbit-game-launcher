'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {findExactSteamApp}=require('../src/core/steam-search.cjs');
function result(items){return new Response(JSON.stringify({total:items.length,items}),{status:200,headers:{'Content-Type':'application/json'}});}
test('online cover lookup accepts exact Steam game title without installed Steam',async()=>{
 let requested='';
 const match=await findExactSteamApp('Celeste',{fetchImpl:async url=>{
  requested=url;
  return result([{id:123,type:'app',name:'Celeste Soundtrack'}, {id:504230,type:'app',name:'Celeste'}]);
 }});
 assert.equal(match.name,'Celeste');assert.equal(match.steamId,'504230');
 assert(requested.startsWith('https://store.steampowered.com/api/storesearch/'));
 assert(requested.includes('term=Celeste'));
});
test('Steam search rejects similar games and DLC instead of silently choosing the wrong art',async()=>{
 const response=()=>result([{id:40,name:'Hearts of Iron III',type:'app'},{id:56,name:'Hearts of Iron IV - DLC',type:'app'},{id:394360,name:'Hearts of Iron IV',type:'sub'}]);
 assert.equal(await findExactSteamApp('Hearts of Iron IV',{fetchImpl:response}),null);
});
test('Steam search validates inputs, network failures and oversized JSON response',async()=>{
 let requests=0;
 const fetchImpl=async()=>{requests++;throw Error('offline');};
 assert.equal(await findExactSteamApp('..',{fetchImpl}),null);
 assert.equal(await findExactSteamApp('\0invalid',{fetchImpl}),null);
 assert.equal(requests,0);
 assert.equal(await findExactSteamApp('Celeste',{fetchImpl}),null);
 assert.equal(requests,1);
 const huge='x'.repeat(270000);
 assert.equal(await findExactSteamApp('Celeste',{fetchImpl:async()=>new Response(huge,{status:200,headers:{'Content-Type':'application/json'}})}),null);
});

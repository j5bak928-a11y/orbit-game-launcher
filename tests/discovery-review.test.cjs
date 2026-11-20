'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const renderer=fs.readFileSync(path.join(__dirname,'../src/ui/app.js'),'utf8');
const between=(start,end)=>renderer.slice(renderer.indexOf(start),renderer.indexOf(end,renderer.indexOf(start)));
function fixture(){
 const stored={discoveryIgnored:[]};
 const state={imports:[],settings:stored,selectedImports:new Set(),scanWarnings:[],scanDiagnostics:[]};
 const alpha={name:'Alpha',discoveryKey:'a'.repeat(64),source:'steam'};
 const beta={name:'Beta',discoveryKey:'b'.repeat(64),source:'steam'};
 const owned={name:'Owned',alreadyAdded:true,discoveryKey:'c'.repeat(64),source:'steam'};
 let discovered=[alpha,beta,owned],imported;
 const context=vm.createContext({
  state,saveSettings:async patch=>Object.assign(stored,patch),syncActivity(){},renderModal(){},
  openModal:type=>{state.modal={type}},closeModal:()=>{state.modal=null},
  toast(){},t:value=>value,formatNumber:String,el:()=>({querySelector:()=>({disabled:false})}),
  window:{orbit:{
   discoverGames:async()=>({games:discovered}),
   importGames:async games=>{imported=games;return {imported:games.length,skipped:0,errors:[]}}
  }}
 });
 vm.runInContext([
  between('const IMPORT_PAGE_SIZE','function renderModal'),
  between('async function performScan','function scanDiagnostics'),
  between('async function handleAction',"document.addEventListener('click'"),
  "globalThis.review={performScan,performImport,handleAction,importableDiscoveryIndices};"
 ].join('\n'),context);
 return {stored,state,alpha,beta,owned,review:context.review,setResults:results=>{discovered=results},imported:()=>imported};
}
const indices=review=>Array.from(review.importableDiscoveryIndices());
const action=(review,kind,index)=>review.handleAction({dataset:{action:kind,id:String(index)}});

test('hide omits a discovery from import and a later scan can review it again',async()=>{
 const {state,review,imported}=fixture();
 await review.performScan();
 assert.deepEqual(indices(review),[0,1]);
 await action(review,'hide-discovery',1);
 assert.deepEqual(indices(review),[0]);
 await review.performImport();
 assert.equal(imported()[0].name,'Alpha');
 assert.equal(imported()[0].discoveryKey,undefined);
 assert.equal(imported().length,1);
 assert.equal(state.imports[0].alreadyAdded,true);
 await review.performScan();
 assert.deepEqual(indices(review),[0,1]);
});

test('ignore follows the stable key across reordered scans and can be undone',async()=>{
 const {state,stored,alpha,beta,owned,review,setResults}=fixture();
 await review.performScan(true);
 assert.equal(state.modal,undefined,'background scan awaits deliberate review');
 await action(review,'ignore-discovery',0);
 assert.deepEqual(Array.from(stored.discoveryIgnored),[alpha.discoveryKey]);
 setResults([beta,owned,alpha]);
 await review.performScan();
 assert.deepEqual(indices(review),[0]);
 assert.deepEqual([...state.selectedImports],[0]);
 await action(review,'ignore-discovery',2);
 assert.deepEqual(Array.from(stored.discoveryIgnored),[]);
 assert.deepEqual(indices(review),[0,2]);
});

'use strict';
// Reproducible, informational benchmark. Run with: node tests/performance.cjs
// Values vary by hardware and should not be used as production SLAs.
const {performance}=require('node:perf_hooks');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {mkdtempSync,rmSync,mkdirSync,writeFileSync}=require('node:fs');
const {scanFolder}=require('../src/core/discovery.cjs');
const {LibraryDatabase}=require('../src/core/database.cjs');
const N=5000;
function sample(){
  const folder=mkdtempSync(join(tmpdir(),'orbit-perf-'));const db=new LibraryDatabase(join(folder,'games.sqlite'));
  try{
    const games=Array.from({length:N},(_,i)=>({name:`Game ${String(i).padStart(5,'0')}`,source:'steam',source_id:String(100000+i),launch_uri:`steam://rungameid/${100000+i}`,tags:['sample']}));
    const before=performance.now();
    for(let i=0;i<games.length;i+=50)db.upsertBatch(games.slice(i,i+50));
    const insert=performance.now()-before;
    const readBegin=performance.now();const all=db.list();const list=performance.now()-readBegin;
    const memoryMiB=+(process.memoryUsage().rss/1024/1024).toFixed(1);
    const queryBegin=performance.now();
    const picks=Array.from({length:100},(_,i)=>db.get(all[i*50].id));
    const lookup=performance.now()-queryBegin;
    if(picks.length!==100||all.length!==N||db.count()!==N)throw Error('Benchmark integrity check failed');
    return {insertMs:+insert.toFixed(1),listMs:+list.toFixed(1),lookup100Ms:+lookup.toFixed(1),rssMiB:memoryMiB,games:N};
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
}
const samples=Array.from({length:3},sample);
const median=key=>samples.map(s=>s[key]).sort((a,b)=>a-b)[1];
async function scanSample(){
  const root=mkdtempSync(join(tmpdir(),'orbit-scan-perf-'));
  try{
    for(let i=0;i<20;i++){
      const dir=join(root,`Game ${i}`);mkdirSync(dir);
      writeFileSync(join(dir,`Game ${i}${process.platform==='win32'?'.exe':'.sh'}`),'#!/bin/sh\nexit 0\n',{mode:0o755});
      for(let j=0;j<50;j++)writeFileSync(join(dir,`data-${j}.txt`),'resource');
    }
    const start=performance.now(),result=await scanFolder(root,{limit:2000,maxDepth:2});
    if(result.games.length!==20)throw Error(`Expected 20 discovered games, found ${result.games.length}`);
    return {scanMs:+(performance.now()-start).toFixed(1),files:1020,discovered:result.games.length};
  }finally{rmSync(root,{recursive:true,force:true})}
}
scanSample().then(scan=>console.log(JSON.stringify({environment:{node:process.version,platform:process.platform},samples,median:{insertMs:median('insertMs'),listMs:median('listMs'),lookup100Ms:median('lookup100Ms'),rssMiB:median('rssMiB')},scan},null,2))).catch(e=>{console.error(e);process.exitCode=1});

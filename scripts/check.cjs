'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function scripts(directory){
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())return scripts(file);
    return entry.isFile()&&/\.(?:cjs|js)$/.test(entry.name)?[file]:[];
  });
}
const files=['src','scripts','tests'].flatMap(directory=>scripts(path.join(root,directory))).sort();
for(const file of files){
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(result.status!==0){console.error(result.stderr||result.error?.message||`Syntax check failed: ${file}`);process.exitCode=1;break;}
}
if(!process.exitCode)console.log(`Syntax checked ${files.length} JavaScript files.`);

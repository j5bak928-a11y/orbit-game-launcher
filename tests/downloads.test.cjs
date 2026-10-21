'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {scanDownloadsFolder,discoverAll}=require('../src/core/discovery.cjs');
async function fixture(fn){const d=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-downloads-'));try{return await fn(d)}finally{await fs.rm(d,{recursive:true,force:true})}}
test('Downloads finds game directories and known standalone exe but skips installers',()=>fixture(async downloads=>{
 const game=path.join(downloads,'Unknown Indie');await fs.mkdir(game);
 await fs.writeFile(path.join(game,'indie.exe'),'fixture');
 for(const name of ['hoi4.exe','setup.exe','chrome_setup.exe','Random.exe'])await fs.writeFile(path.join(downloads,name),'fixture');
 const result=await scanDownloadsFolder(downloads,{platform:'win32'});
 assert.deepEqual(result.games.map(g=>g.name).sort(),['Hearts of Iron IV','Unknown Indie']);
 assert.ok(result.games.every(g=>g.downloadCandidate===true));
}));
test('Downloads is optional and scan ignores symbolic link loops',()=>fixture(async downloads=>{
 const game=path.join(downloads,'Game Folder');await fs.mkdir(game);
 const file=path.join(game,'game.exe');await fs.writeFile(file,'fixture');
 try{await fs.symlink(downloads,path.join(game,'cycle'),'dir')}catch{}
 const off=await discoverAll({scanDownloads:false,libraryFolders:[]},{downloadsPath:downloads,platform:'win32'});
 assert.equal(off.games.some(g=>g.executable===file),false);
 const on=await discoverAll({scanDownloads:true,libraryFolders:[]},{downloadsPath:downloads,platform:'win32'});
 assert.equal(on.games.filter(g=>g.executable===file).length,1);
}));

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createUpdateService}=require('../src/core/updates.cjs');
test('source builds do not contact release servers',async()=>{
 const service=createUpdateService({app:{isPackaged:false},platform:'win32',fetchRelease:()=>assert.fail('unexpected network request')});
 assert.equal((await service.check()).state,'unsupported');
});

test('checks a stable release and opens its GitHub download page without running an installer', async () => {
 const opened=[];
 const service=createUpdateService({
  app:{isPackaged:true,getVersion:()=>'0.2.9'},platform:'win32',
  fetchRelease:async()=>new Response(JSON.stringify({tag_name:'v0.2.11',draft:false,prerelease:false})),
  openExternal:async url=>opened.push(url)
 });
 const result=await service.check();
 assert.equal(result.state,'available');
 assert.equal(result.version,'0.2.11');
 await service.openDownload(result.tag);
 assert.deepEqual(opened,['https://github.com/j5bak928-a11y/orbit-game-launcher/releases/tag/v0.2.11']);
 await assert.rejects(service.openDownload('https://example.com/installer.exe'));
 assert.equal(opened.length,1);
});

test('a private-release access failure still allows opening the official releases page', async () => {
 const opened=[];
 const service=createUpdateService({
  app:{isPackaged:true,getVersion:()=>'0.2.11'},platform:'win32',
  fetchRelease:async()=>new Response(null,{status:404}),
  openExternal:async url=>opened.push(url)
 });
 assert.equal((await service.check()).state,'access');
 await service.openDownload();
 assert.deepEqual(opened,['https://github.com/j5bak928-a11y/orbit-game-launcher/releases/latest']);
});

test('reads the local credential for the official API and disallows redirects', async t => {
 const fs=require('node:fs/promises');
 const dir=await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(),'orbit-updates-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const tokenPath=require('node:path').join(dir,'github-update-token.txt');
 await fs.writeFile(tokenPath,'demo_fixture_token\n');
 const service=createUpdateService({
  app:{isPackaged:true,getVersion:()=>'0.2.11'},platform:'win32',tokenPath,
  fetchRelease:async (url, options)=>{
   assert.equal(url,'https://api.github.com/repos/j5bak928-a11y/orbit-game-launcher/releases/latest');
   assert.equal(options.headers.Authorization,'Bearer demo_fixture_token');
   assert.equal(options.redirect,'error');
   return new Response(JSON.stringify({tag_name:'v0.2.9',draft:false,prerelease:false}));
  }
 });
 assert.deepEqual(await service.check(),{state:'current',message:'Orbit is up to date.'});
});

test('the Settings check exposes the release download and the click only opens that release', async () => {
 const source=require('node:fs').readFileSync(require.resolve('../src/ui/app.js'),'utf8');
 const vm=require('node:vm');
 const check={disabled:false}, download={textContent:'Open Releases'};
 const message={closest:()=>({querySelector:key=>key.includes('check-update')?check:download})};
 const opened=[];
 const state={updateStatus:{state:'idle'}};
 const context=vm.createContext({
  state, el:()=>message, t:(value,{version}={})=>value.replace('{version}',version||''),
  window:{orbit:{
   checkForUpdates:async()=>({state:'available',message:'Orbit {version} is available.',version:'0.2.11',tag:'v0.2.11'}),
   openUpdateDownload:async tag=>opened.push(tag)
  }}
 });
 vm.runInContext(source.slice(source.indexOf('function updateStatusText'),source.indexOf('function handleOrbitEvent')),context);
 const handler=source.indexOf('async function handleAction');
 const end=source.indexOf("  case 'navigate':",handler);
 vm.runInContext(source.slice(handler,end)+'}}',context);
 await vm.runInContext("handleAction({dataset:{action:'check-update'}})",context);
 assert.equal(message.textContent,'Orbit 0.2.11 is available.');
 assert.equal(download.textContent,'Download update');
 assert.equal(check.disabled,false);
 assert.deepEqual(opened,[]);
 await vm.runInContext("handleAction({dataset:{action:'download-update'}})",context);
 assert.deepEqual(opened,['v0.2.11']);
});

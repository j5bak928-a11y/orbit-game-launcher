'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {identifyGame,readWindowsProductName,sensibleProductName}=require('../src/core/game-identity.cjs');

test('standalone abbreviated executables identify full game titles without Steam',()=>{
 for(const [file,name,steamId] of [
  ['hoi4.exe','Hearts of Iron IV','394360'],
  ['EU4.EXE','Europa Universalis IV','236850'],
  ['ck3.exe','Crusader Kings III','1151640'],
  ['victoria3.exe','Victoria 3','529340'],
  ['gta5.exe','Grand Theft Auto V','271590'],
  ['rdr2.exe','Red Dead Redemption 2','1174180'],
 ]){
   const detected=identifyGame(path.join('/my-games',file));
   assert.equal(detected.name,name,file);
   assert.equal(detected.steamId,steamId,file);
   assert.equal(detected.kind,'executable',file);
 }
});
test('generic executables can be identified by parent install folder',()=>{
 const detected=identifyGame(path.join('/my-games','Hearts of Iron IV','Binaries','Game.exe'),{fallbackName:'Binaries'});
 assert.equal(detected.name,'Hearts of Iron IV');
 assert.equal(detected.kind,'folder');
});
test('Windows product metadata can identify titles without exposing or executing executable paths',async()=>{
 const file='C:\\Games\\Untrusted $`(name).exe';
 let received;
 const product=await readWindowsProductName(file,{platform:'win32',run:async(command,args,options)=>{
   assert.equal(command,'powershell.exe');
   assert.equal(args[3],'-EncodedCommand');
   const script=Buffer.from(args[4],'base64').toString('utf16le');
   assert(script.includes(Buffer.from(file,'utf16le').toString('base64')));
   assert(!script.includes(file),'raw untrusted path must not appear in commands');
   assert.equal(options.windowsHide,true);
   received=true;
   return {stdout:'Hearts of Iron IV'};
 }});
 assert(received);assert.equal(product,'Hearts of Iron IV');
 assert.equal(identifyGame(path.join('/games','Unknown.exe'),{productName:product}).name,'Hearts of Iron IV');
});
test('non-game product names are ignored and unknown filenames are not invented',async()=>{
 assert.equal(sensibleProductName('Unity Player'),'');
 assert.equal(sensibleProductName('Game'),'');
 assert.equal((await readWindowsProductName('/games/hoi4.exe',{platform:'linux'})),'');
 const fallback=identifyGame('/games/My Custom Creation.exe',{fallbackName:'My Custom Creation'});
 assert.equal(fallback.kind,'filename');assert.equal(fallback.name,'My Custom Creation');
 assert.equal(fallback.steamId,'');
});

test('product metadata normalizes all C0 controls without losing Unicode text', () => {
 for (let code=0; code<32; code++) {
  assert.equal(sensibleProductName('Orbit'+String.fromCharCode(code)+'Adventure'),'Orbit Adventure');
 }
 assert.equal(sensibleProductName('Café 星空 Adventure'),'Café 星空 Adventure');
});

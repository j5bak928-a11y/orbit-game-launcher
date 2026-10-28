'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WindowsActivityTracker,matchRunningGames}=require('../src/core/windows-activity.cjs');
const games=[{id:'fc27',source:'steam',install_path:'D:\\SteamLibrary\\steamapps\\common\\EA SPORTS FC 27'},
{id:'rocket',source:'epic',install_path:'C:\\Epic Games\\rocketleague'},
{id:'local',source:'manual',install_path:'C:\\Downloads\\game'}];
test('Windows monitoring maps game processes to storefront install folders',()=>{
 assert.deepEqual(matchRunningGames(games,['d:\\STEAMLIBRARY\\steamapps\\common\\EA SPORTS FC 27\\FC27.exe',
 'C:\\Epic Games\\rocketleague\\Binaries\\Win64\\RocketLeague.exe',
 'C:\\Downloads\\game\\game.exe']),['fc27','rocket']);
 assert.deepEqual(matchRunningGames(games,['C:\\Epic Games\\rocketleague\\unins000.exe',
 'C:\\Epic Games\\rocketleague2\\RocketLeague.exe']),[]);
});
test('matches exact executables for linked games without treating shared folders as games',()=>{
 const list=[{id:'manual',source:'manual',executable:'C:\\Games\\My Game.exe',install_path:''},{id:'other',source:'gog',executable:'C:\\Games\\Other.exe',install_path:'C:\\Games'}];
 assert.deepEqual(matchRunningGames(list,['c:\\games\\my game.exe']),['manual']);
});
test('does not count the confirmation delay after a monitored process exits',async()=>{
 let clock=1000,running=true,finish=[];
 const t=new WindowsActivityTracker({listGames:()=>games,isDirectSession:()=>false,start:id=>id,finish:(id,seconds)=>finish.push(seconds),enumerate:async()=>running?['D:\\SteamLibrary\\steamapps\\common\\EA SPORTS FC 27\\FC27.exe']:[],now:()=>clock});
 await t.poll();clock=61000;running=false;await t.poll();clock=76000;await t.poll();assert.deepEqual(finish,[60]);
});
test('a monitored session starts once and finishes after two misses',async()=>{
 let running=true,clock=1000;const starts=[],ends=[];
 const tracker=new WindowsActivityTracker({
  listGames:()=>games,isDirectSession:()=>false,start:id=>{starts.push(id);return id},
  finish:(id,seconds)=>ends.push([id,seconds]),
  enumerate:async()=>running?['D:\\SteamLibrary\\steamapps\\common\\EA SPORTS FC 27\\FC27.exe']:[],
  now:()=>clock
 });
 await tracker.poll();await tracker.poll();assert.deepEqual(starts,['fc27']);
 clock+=3600000;running=false;await tracker.poll();assert.deepEqual(ends,[]);
 await tracker.poll();assert.deepEqual(ends,[['fc27',3600]]);tracker.stop();
});


test('matching retains library order, duplicate IDs and nested installation semantics', () => {
 const nested = [
  {id:'inner',source:'steam',install_path:'D:\\Games\\Outer\\Inner'},
  {id:'outer',source:'epic',install_path:'d:/games/outer/'},
  {id:'inner',source:'steam',install_path:'D:\\Games\\Outer\\Inner'},
  {id:'manual',source:'manual',install_path:'D:\\Games\\Outer'},
 ];
 const processes = ['D:/GAMES/Outer/Inner/Bin/Game.exe', 'd:\\Games\\Outer\\Inner\\Bin\\Game.exe'];
 assert.deepEqual(matchRunningGames(nested, processes), ['inner','outer']);
});

test('matching handles UNC roots while rejecting sibling and relative paths', () => {
 const library = [
  {id:'share',source:'steam',install_path:'\\\\server\\share'},
  {id:'game',source:'epic',install_path:'\\\\server\\share\\Games\\One'},
  {id:'sibling',source:'steam',install_path:'\\\\server\\share\\Games\\On'},
  {id:'relative',source:'steam',install_path:'Games\\One'},
  {id:'drive-root',source:'steam',install_path:'D:\\'},
 ];
 assert.deepEqual(matchRunningGames(library, ['\\\\SERVER\\SHARE\\Games\\One\\Bin\\GAME.exe']), ['share','game']);
 assert.deepEqual(matchRunningGames(library, ['Games\\One\\Game.exe']), []);
});

test('only actual game executables mark containing folders as running', () => {
 const library = [{id:'game',source:'steam',install_path:'C:\\Games\\Test'}];
 const ignored = ['setup.exe','updater.exe','CrashReporter.exe','EasyAntiCheat.exe','notes.txt']
  .map(file => 'C:\\Games\\Test\\Bin\\' + file);
 assert.deepEqual(matchRunningGames(library, ignored), []);
 assert.deepEqual(matchRunningGames(library, [...ignored, 'C:\\Games\\Test2\\Game.exe']), []);
 assert.deepEqual(matchRunningGames(library, [...ignored, 'C:\\Games\\Test\\Bin\\Game.exe']), ['game']);
 assert.deepEqual(matchRunningGames(library, []), []);
});

test('an executable does not count as a child of its own path', () => {
 const library = [{id:'game',source:'steam',install_path:'C:\\Games\\Test.exe'}];
 assert.deepEqual(matchRunningGames(library, ['C:\\Games\\Test.exe']), []);
});

test('tracking reports only IDs whose sessions changed',async()=>{
 let running=true;
 const notifications=[];
 const tracker=new WindowsActivityTracker({
  listGames:()=>games,isDirectSession:()=>false,start:id=>id,finish:()=>{},
  enumerate:async()=>running?['D:\\SteamLibrary\\steamapps\\common\\EA SPORTS FC 27\\FC27.exe']:[],
  onChange:ids=>notifications.push(ids)
 });
 await tracker.poll();await tracker.poll();
 assert.deepEqual(notifications,[['fc27']]);
 running=false;await tracker.poll();await tracker.poll();
 assert.deepEqual(notifications,[['fc27'],['fc27']]);
 tracker.stop();
});

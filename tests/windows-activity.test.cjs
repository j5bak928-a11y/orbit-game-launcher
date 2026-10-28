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
test('matches a linked game launched by a wrapper using its dedicated installation folder',()=>{
 const list=[{id:'epic',source:'epic',launch_uri:'com.epicgames.launcher://apps/1',executable:'D:\\Games\\Example\\Launcher.exe',install_path:'D:\\Games\\Example'}];
 assert.deepEqual(matchRunningGames(list,['D:\\Games\\Example\\Bin\\Game.exe']),['epic']);
});
test('does not attribute a shared installation folder to multiple linked games',()=>{
 const list=[{id:'one',source:'gog',launch_uri:'goggalaxy://openGame/1',install_path:'D:\\Games\\Shared'},{id:'two',source:'manual',launch_uri:'steam://rungameid/2',install_path:'D:\\Games\\Shared'}];
 assert.deepEqual(matchRunningGames(list,['D:\\Games\\Shared\\Game.exe']),[]);
});
test('does not infer a non-storefront game from a broad folder alone',()=>{
 const list=[{id:'one',source:'gog',launch_uri:'goggalaxy://openGame/1',install_path:'D:\\GOG Games'}];
 assert.deepEqual(matchRunningGames(list,['D:\\GOG Games\\Other\\Game.exe']),[]);
});
test('does not count the confirmation delay after a monitored process exits',async()=>{
 let clock=1000,running=true,finish=[];
 const t=new WindowsActivityTracker({listGames:()=>games,isDirectSession:()=>false,start:id=>id,finish:(_id,seconds)=>finish.push(seconds),enumerate:async()=>running?['D:\\SteamLibrary\\steamapps\\common\\EA SPORTS FC 27\\FC27.exe']:[],now:()=>clock});
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
 assert.deepEqual(matchRunningGames(nested, processes), ['inner']);
});

test('matching handles UNC roots while rejecting sibling and relative paths', () => {
 const library = [
  {id:'share',source:'steam',install_path:'\\\\server\\share'},
  {id:'game',source:'epic',install_path:'\\\\server\\share\\Games\\One'},
  {id:'sibling',source:'steam',install_path:'\\\\server\\share\\Games\\On'},
  {id:'relative',source:'steam',install_path:'Games\\One'},
  {id:'drive-root',source:'steam',install_path:'D:\\'},
 ];
 assert.deepEqual(matchRunningGames(library, ['\\\\SERVER\\SHARE\\Games\\One\\Bin\\GAME.exe']), ['game']);
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

test('empty libraries skip process enumeration',async()=>{
 let count=0;const t=new WindowsActivityTracker({listGames:()=>[],isDirectSession:()=>false,start:()=>'',finish:()=>{},enumerate:async()=>{count++;return [];}});
 await t.poll();assert.equal(count,0);
});

test('native inventory parses absolute Windows process paths',async()=>{
 const {listWindowsExecutables,parseNativeInventory}=require('../src/core/windows-activity.cjs');
 assert.deepEqual(parseNativeInventory('C:\\Games\\One\\Game.exe\nnot-a-path\nD:\\Steam\\Bin\\Player.EXE\n'),
  ['C:\\Games\\One\\Game.exe','D:\\Steam\\Bin\\Player.EXE']);
 const calls=[];
 const data=await listWindowsExecutables({helperPath:'C:\\Orbit\\bin\\orbit-process-list.exe',exists:()=>true,run:async(command)=>{
  calls.push(command);return {stdout:'C:\\Games\\One\\Game.exe\n'};
 }});
 assert.deepEqual(data,['C:\\Games\\One\\Game.exe']);assert.equal(calls.length,1);
});
test('failed native inventory falls back to bounded PowerShell',async()=>{
 const {listWindowsExecutables}=require('../src/core/windows-activity.cjs');
 const commands=[];
 const data=await listWindowsExecutables({helperPath:'C:\\Orbit\\bin\\orbit-process-list.exe',exists:()=>true,run:async command=>{
  commands.push(command);if(command.endsWith('orbit-process-list.exe'))throw Error('helper unavailable');
  return {stdout:JSON.stringify(['C:\\Games\\One\\Game.exe'])};
 }});
 assert.deepEqual(data,['C:\\Games\\One\\Game.exe']);assert.deepEqual(commands,['C:\\Orbit\\bin\\orbit-process-list.exe','powershell.exe']);
});

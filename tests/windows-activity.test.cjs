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

'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {LibraryDatabase,cleanGame,duplicateKey,reconcileDiscoveredGames}=require('../src/core/database.cjs');
function withDb(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-test-'));const db=new LibraryDatabase(path.join(dir,'data','library.sqlite'));try{return fn(db,dir)}finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}}
test('creates usable SQLite database and persists games and settings across reopen',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reopen-'));const file=path.join(dir,'library.db');try{
  let db=new LibraryDatabase(file);const g=db.upsert({name:'Galactic Quest',executable:'/games/galactic',tags:['Space','Adventure']}).game;
  db.saveSettings({theme:'light',accent:'#5bafef',view:'list',libraryFolders:['/games']});db.close();
  db=new LibraryDatabase(file);assert.equal(db.list().length,1);assert.equal(db.get(g.id).name,'Galactic Quest');assert.deepEqual(db.get(g.id).tags,['Space','Adventure']);assert.equal(db.getSettings().theme,'light');assert.equal(db.getSettings().view,'list');db.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('detects duplicate storefront ids and direct executables',()=>withDb(db=>{
 const game={name:'A Game',source:'steam',source_id:'123',launch_uri:'steam://rungameid/123'};
 assert.equal(db.upsert(game).added,true);assert.equal(db.upsert({...game,name:'New title'}).added,false);assert.equal(db.count(),1);
 assert.equal(db.upsert({name:'Local',executable:'/games/local/game'}).added,true);
 assert.equal(db.upsert({name:'Local Copy',executable:'/games/local/game'}).added,false);assert.equal(db.count(),2);
}));
test('distinct authoritative storefront products coexist across the same executable and URI without losing metadata',()=>withDb(db=>{
 const executable=path.join(os.tmpdir(),'Orbit DLC','Shared.exe'),launch_uri='com.epicgames.launcher://apps/shared?action=launch';
 const first=db.upsert({name:'Epic edition 125',source:'epic',source_id:'125',executable,launch_uri,install_path:path.dirname(executable)}).game;
 assert.equal(db.update(first.id,{favorite:true}).favorite,true);
 const session=db.startSession(first.id);assert.equal(db.finishSession(session,59),true);
 const second=db.upsert({name:'Epic edition 126',source:'epic',source_id:'126',executable,launch_uri,install_path:path.dirname(executable)});
 const third=db.upsert({name:'GOG separate product',source:'gog',source_id:'126',executable,launch_uri});
 assert.equal(second.added,true);assert.equal(third.added,true);
 assert.notEqual(first.id,second.game.id);assert.notEqual(second.game.id,third.game.id);
 assert.equal(db.count(),3);assert.equal(db.get(first.id).total_play_seconds,59);assert.equal(db.get(first.id).favorite,true);
 assert.equal(db.upsert({name:'Epic repeat ID ignoring case',source:'epic',source_id:'126',executable}).game.id,second.game.id);
 assert.equal(db.upsert({name:'Manual alias',source:'manual',executable}).added,false);
 assert.equal(db.upsert({name:'Folder alias',source:'folder',executable}).added,false);
 assert.equal(db.upsertBatch([
  {name:'Fourth verified edition',source:'epic',source_id:'127',executable},
  {name:'Repeated edition',source:'epic',source_id:'126',executable}
 ]).imported,1);
 assert.equal(db.count(),4);
}));
test('authoritative source IDs compare case-insensitively without collapsing different products',()=>withDb(db=>{
 const executable=path.join(os.tmpdir(),'Orbit DLC','CaseSensitive.exe');
 const first=db.upsert({name:'Epic DLC',source:'epic',source_id:'DLC-AbC',executable}).game;
 const repeated=db.upsert({name:'Epic DLC lowercased',source:'epic',source_id:'dlc-abc',executable});
 assert.equal(repeated.added,false);assert.equal(repeated.game.id,first.id);
 const distinct=db.upsert({name:'Different Epic DLC',source:'epic',source_id:'dlc-abd',executable});
 assert.equal(distinct.added,true);
 assert.equal(db.count(),2);
 assert.deepEqual(reconcileDiscoveredGames(db.list(),[
  {name:'Same DLC upper',source:'epic',source_id:'DLC-ABC',executable},
  {name:'Next DLC',source:'epic',source_id:'DLC-ABE',executable}
 ]).map(game=>game.alreadyAdded),[true,false]);
}));
test('store product edits accept another trusted product path but reject manual collisions',()=>withDb(db=>{
 const executable=path.join(os.tmpdir(),'Orbit DLC','Shared.exe');
 const first=db.upsert({name:'Edition A',source:'epic',source_id:'125',executable}).game;
 const other=db.upsert({name:'Edition B',source:'epic',source_id:'126',executable:path.join(os.tmpdir(),'edition-b.exe')}).game;
 assert.equal(db.update(other.id,{executable}).executable,executable);
 assert.equal(db.count(),2);
 const manual=db.upsert({name:'Different manual',source:'manual',executable:path.join(os.tmpdir(),'manual-unique.exe')}).game;
 assert.throws(()=>db.update(manual.id,{executable}),/already in your library/);
 assert.equal(db.get(manual.id).name,'Different manual');
 assert.throws(()=>db.update(other.id,{source_id:'125'}),/already in your library/);
 assert.equal(db.get(first.id).source_id,'125');assert.equal(db.get(other.id).source_id,'126');
}));
test('discovery alreadyAdded honors verified storefront ID before shared executable and URI',()=>withDb(db=>{
 const executable=path.join(os.tmpdir(),'Orbit DLC','Shared.exe'),launch_uri='steam://rungameid/000';
 const one=db.upsert({name:'Epic 125',source:'epic',source_id:'125',executable,launch_uri}).game;
 const discovered=[
  {name:'Epic 126',source:'epic',source_id:'126',executable,launch_uri},
  {name:'Epic 125 again',source:'epic',source_id:'125',executable,launch_uri},
  {name:'Manual alias',source:'manual',executable},
 ];
 const result=reconcileDiscoveredGames(db.list(),discovered);
 assert.deepEqual(result.map(g=>g.alreadyAdded),[false,true,true]);
 const imported=db.upsertBatch(result.filter(g=>!g.alreadyAdded));
 assert.equal(imported.imported,1);assert.equal(db.count(),2);assert.equal(db.get(one.id).source_id,'125');
 const manualFirst=path.join(os.tmpdir(),'Orbit DLC','ManualFirst.exe');
 db.upsert({name:'Local alias first',source:'manual',executable:manualFirst});
 const candidate={name:'Store linked to local',source:'gog',source_id:'product-new',executable:manualFirst};
 assert.equal(reconcileDiscoveredGames(db.list(),[candidate])[0].alreadyAdded,true);
 assert.equal(db.upsert(candidate).added,false);
}));
test('favorites, editing, sessions and removal preserve game data',()=>withDb(db=>{
 const g=db.upsert({name:'Adventure',executable:'/games/a',tags:['RPG']}).game;
 assert.equal(db.toggleFavorite(g.id).favorite,true);
 assert.equal(db.update(g.id,{name:'Adventure II',tags:['RPG','Open world']}).name,'Adventure II');
 const session=db.startSession(g.id);assert.equal(db.finishSession(session,3725),true);assert.equal(db.finishSession(session,1000),false);
 assert.equal(db.get(g.id).total_play_seconds,3725);assert.ok(db.get(g.id).last_played_at);
 assert.equal(db.remove(g.id),true);assert.equal(db.count(),0);
}));
test('rejects unsupported settings and invalid fields',()=>withDb(db=>{
 assert.throws(()=>db.saveSettings({theme:'neon'}),/Invalid theme/);
 assert.throws(()=>db.saveSettings({accent:'red'}),/Invalid accent/);
 assert.throws(()=>db.saveSettings({sort:'toString'}),/Invalid library preferences/);
 assert.throws(()=>db.saveSettings({sort:'__proto__'}),/Invalid library preferences/);
 assert.throws(()=>db.upsert({name:' '}),/Game name/);
 assert.throws(()=>cleanGame({name:'Good',launch_args:'not JSON'}),/Launch arguments/);
 assert.throws(()=>cleanGame({name:'Good',source:'secret'}),/Unsupported game source/);
 assert.throws(()=>cleanGame({name:'Good',tags:Array(41).fill('a')}),/Invalid tags/);
}));
test('differentiates sources with identical IDs',()=>{
 assert.notEqual(duplicateKey({source:'steam',source_id:'100'}),duplicateKey({source:'gog',source_id:'100'}));
});

test('cross-source imports of one executable do not create duplicate games',()=>withDb(db=>{
 const file=path.join(os.tmpdir(),'Orbit Test','Example.exe');
 const imported=db.upsert({name:'A store game',source:'epic',source_id:'store-1',executable:file}).game;
 const duplicate=db.upsert({name:'Local copy',source:'manual',executable:file});
 assert.equal(duplicate.added,false);
 assert.equal(duplicate.game.id,imported.id);
 assert.equal(db.count(),1);
 const other=db.upsert({name:'Other',executable:path.join(os.tmpdir(),'other.exe')}).game;
 assert.throws(()=>db.update(other.id,{executable:file}),/already in your library/);
 assert.equal(db.get(other.id).name,'Other');
}));
test('manual launcher link and discovered game with the same URI are deduplicated',()=>withDb(db=>{
 const uri='steam://rungameid/12345';
 const manual=db.upsert({name:'My manual Steam shortcut',source:'manual',launch_uri:uri}).game;
 const store=db.upsert({name:'Store title',source:'steam',source_id:'12345',launch_uri:uri});
 assert.equal(store.added,false);
 assert.equal(store.game.id,manual.id);
 const other=db.upsert({name:'Another title',source:'manual',launch_uri:'steam://rungameid/99999'}).game;
 assert.throws(()=>db.update(other.id,{launch_uri:uri}),/launcher link is already/);
 assert.equal(db.get(other.id).launch_uri,'steam://rungameid/99999');
 assert.equal(db.count(),2);
}));
test('malformed stored settings fall back independently without breaking boot',()=>withDb(db=>{
 db.saveSettings({theme:'light',accent:'#53c5b3',autoScan:true});
 const set=db.db.prepare('UPDATE settings SET value=? WHERE key=?');
 set.run('123','theme');set.run('"not-a-color"','accent');set.run('"whoops"','libraryFolders');set.run('"yes"','autoScan');
 const settings=db.getSettings();
 assert.equal(settings.theme,'dark');assert.equal(settings.accent,'#8b7aff');
 assert.deepEqual(settings.libraryFolders,[]);assert.equal(settings.autoScan,false);
}));

test('JSON backup restore preserves favorites, playtime and date metadata',()=>withDb(db=>{
 const imported=db.restoreGame({name:'Restored favorite',source:'gog',source_id:'700',favorite:true,
  total_play_seconds:12500,last_played_at:'2025-07-20T10:25:00Z',created_at:'2024-01-03T12:00:00Z',tags:['RPG']});
 assert.equal(imported.added,true);
 const game=db.get(imported.game.id);
 assert.equal(game.total_play_seconds,12500);
 assert.equal(game.last_played_at,'2025-07-20T10:25:00.000Z');
 assert.equal(game.created_at,'2024-01-03T12:00:00.000Z');
 assert.equal(game.favorite,true);assert.deepEqual(game.tags,['RPG']);
 assert.equal(db.restoreGame({name:'Duplicate',source:'gog',source_id:'700',total_play_seconds:99999999}).added,false);
 assert.equal(db.get(imported.game.id).total_play_seconds,12500);
}));
test('backup restore sanitizes invalid playtime and timestamps',()=>withDb(db=>{
 const added=db.restoreGame({name:'Untrusted backup',total_play_seconds:-200,last_played_at:'not-a-date',created_at:'broken'}).game;
 assert.equal(added.total_play_seconds,0);
 assert.equal(added.last_played_at,null);
 assert.ok(!Number.isNaN(Date.parse(added.created_at)));
}));

test('batched imports tolerate invalid games while keeping valid entries atomic and unique',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-batch-test-'));
  const db=new LibraryDatabase(path.join(dir,'library.sqlite'));
  try{
    const first={name:'Batched One',source:'steam',source_id:'451',launch_uri:'steam://rungameid/451'};
    const result=db.upsertBatch([first,{name:''},first,{name:'Batched Two',source:'steam',source_id:'452',launch_uri:'steam://rungameid/452'}]);
    assert.equal(result.imported,2);assert.equal(result.skipped,1);assert.equal(result.errors.length,1);
    assert.equal(db.count(),2);
    assert.throws(()=>db.upsertBatch(new Array(101).fill(first)),/at most 100/);
    const reopened=db.db.prepare('PRAGMA integrity_check').get();
    assert.equal(reopened.integrity_check,'ok');
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('tracking projection includes identifiable games and omits unrelated metadata',()=>withDb(db=>{
 const steam=db.upsert({name:'Steam',source:'steam',source_id:'1',install_path:'D:\\Games\\Steam'}).game;
 const epic=db.upsert({name:'Epic',source:'epic',source_id:'2',install_path:'D:\\Games\\Epic'}).game;
 db.upsert({name:'GOG',source:'gog',source_id:'3',install_path:'D:\\Games\\GOG'});
 db.upsert({name:'Manual',install_path:'D:\\Games\\Manual'});
 db.upsert({name:'No installation',source:'steam',source_id:'4'});
 const linked=db.upsert({name:'Linked',source:'manual',executable:'D:\\Games\\Linked\\game.exe',launch_uri:'steam://rungameid/4'}).game;
 const rows=db.listActivityGames();
 assert.deepEqual(rows.map(g=>g.id).sort(),[steam.id,epic.id,linked.id].sort());
 for(const row of rows)assert.deepEqual(Object.keys(row).sort(),['executable','id','install_path','launch_uri','name','source']);
 db.remove(linked.id);
 db.update(epic.id,{install_path:''});
 assert.deepEqual(db.listActivityGames().map(g=>g.id),[steam.id]);
 db.remove(steam.id);
 assert.deepEqual(db.listActivityGames(),[]);
}));

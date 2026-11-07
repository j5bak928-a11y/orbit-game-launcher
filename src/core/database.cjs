'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateSessionHistory} = require('./backup.cjs');

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark', accent: '#8b7aff', reduceMotion: false,
  autoScan: false, useSteamArtwork: true, scanDownloads: false, libraryFolders: [],
  view: 'grid', sort: 'name', onboardingDone: false,
  performanceGuard: true, autoUpdates: true, libraryDensity: 'comfortable',
});
const SORTS = {name: 'name COLLATE NOCASE ASC', recent: 'last_played_at DESC, name COLLATE NOCASE ASC', added: 'created_at DESC', time: 'total_play_seconds DESC, name COLLATE NOCASE ASC'};
const COLUMNS = ['id','name','source','source_id','executable','launch_uri','install_path','cover','banner','icon','genre','tags','favorite','total_play_seconds','last_played_at','created_at','updated_at','launch_args','working_dir','cover_fit','cover_position'];
const STATS_MAX_ROWS=100000,STATS_MAX_SESSION_SECONDS=7*86400;
function statisticsDays(options){
  if(options===undefined||options===null)return 30;
  if(typeof options!=='object'||Array.isArray(options))throw Error('Statistics options must be an object.');
  const days=options.days??30;
  if(!Number.isInteger(days)||days<7||days>90)throw Error('Statistics days must be an integer from 7 to 90.');
  return days;
}
function statisticsDate(value){
  if(typeof value!=='string')return NaN;
  const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!parts)return NaN;
  const [year,month,day,hour,minute,second]=parts.slice(1,7).map(Number);
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(0,0,0,0);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||hour>23||minute>59||second>59)return NaN;
  const offset=/(?:([+-])(\d{2}):(\d{2}))$/.exec(value);
  if(offset&&(Number(offset[2])>23||Number(offset[3])>59))return NaN;
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp)?timestamp:NaN;
}
const localDateKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
function statisticsFromRows(rows,openSessions,days,asOf){
  const now=asOf.getTime();
  if(!Number.isFinite(now))throw Error('Invalid statistics reference date.');
  const byGame=new Map(),daySeconds=new Map();
  let invalidSessions=0,rawSeconds=0,eligibleSeconds=0,creditedSeconds=0;
  for(const row of rows){
    const start=statisticsDate(row.started_at),end=statisticsDate(row.finished_at);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>STATS_MAX_SESSION_SECONDS*1000||end>now+300000||
        !Number.isSafeInteger(row.seconds)||row.seconds<0){
      invalidSessions++;continue;
    }
    const game=byGame.get(row.game_id)||{id:row.game_id,name:row.name,source:row.source,cover:row.cover,icon:row.icon,lastPlayedAt:row.finished_at,lastTime:-Infinity,events:[],seconds:0};
    if(end>game.lastTime){game.lastTime=end;game.lastPlayedAt=row.finished_at;}
    byGame.set(row.game_id,game);
    rawSeconds+=row.seconds;
    const credit=Math.min(row.seconds,STATS_MAX_SESSION_SECONDS,(end-start)/1000);
    eligibleSeconds+=credit;
    if(credit<=0)continue;
    const index=game.events.length/2,rate=credit*1000/(end-start);
    game.events.push({at:start,index,rate,opening:true},{at:end,index,rate,opening:false});
  }
  function assign(from,to,rate,game){
    while(from<to){
      const point=new Date(from),day=localDateKey(point);
      const midnight=new Date(point.getTime());midnight.setHours(0,0,0,0);midnight.setDate(midnight.getDate()+1);
      const until=Math.min(to,midnight.getTime()),seconds=(until-from)*rate/1000;
      if(until<=from)break;
      daySeconds.set(day,(daySeconds.get(day)||0)+seconds);
      creditedSeconds+=seconds;game.seconds+=seconds;from=until;
    }
  }
  // A per-game max-rate sweep merges overlapping historical rows without
  // rewriting any session or counting the same wall-clock second twice.
  for(const game of byGame.values()){
    const events=game.events.sort((a,b)=>a.at-b.at||Number(a.opening)-Number(b.opening));
    const active=new Set(),heap=[];
    const push=entry=>{heap.push(entry);let at=heap.length-1;while(at){const p=(at-1)>>1;if(heap[p].rate>=heap[at].rate)break;[heap[p],heap[at]]=[heap[at],heap[p]];at=p;}};
    const pop=()=>{const last=heap.pop();if(!heap.length)return;if(last)heap[0]=last;let at=0;while(true){const l=at*2+1,r=l+1;let max=at;if(l<heap.length&&heap[l].rate>heap[max].rate)max=l;if(r<heap.length&&heap[r].rate>heap[max].rate)max=r;if(max===at)break;[heap[at],heap[max]]=[heap[max],heap[at]];at=max;}};
    let previous=null;
    for(let index=0;index<events.length;){
      const time=events[index].at;
      while(heap.length&&!active.has(heap[0].index))pop();
      if(previous!==null&&time>previous&&heap.length)assign(previous,time,heap[0].rate,game);
      while(index<events.length&&events[index].at===time){
        const item=events[index++];
        if(item.opening){active.add(item.index);push(item);}else active.delete(item.index);
      }
      previous=time;
    }
  }
  const midnight=new Date(asOf);midnight.setHours(0,0,0,0);
  const makeRange=count=>{
    let total=0;
    for(let i=0;i<count;i++){const date=new Date(midnight);date.setDate(date.getDate()-i);total+=daySeconds.get(localDateKey(date))||0;}
    return Math.round(total);
  };
  const daily=[];
  for(let i=days-1;i>=0;i--){const date=new Date(midnight);date.setDate(date.getDate()-i);const key=localDateKey(date);daily.push({date:key,seconds:Math.round(daySeconds.get(key)||0)});}
  const recentGames=[...byGame.values()].sort((a,b)=>b.lastTime-a.lastTime||a.id.localeCompare(b.id)).slice(0,8).map(g=>({id:g.id,name:g.name,source:g.source,cover:g.cover,icon:g.icon,seconds:Math.round(g.seconds),lastPlayedAt:g.lastPlayedAt}));
  return {days,daily,totals:{week:makeRange(7),month:makeRange(30),allTime:Math.round(creditedSeconds)},recentGames,
    meta:{openSessions,invalidSessions,overlapSeconds:Math.round(Math.max(0,eligibleSeconds-creditedSeconds)),
      adjustedSeconds:Math.round(Math.max(0,rawSeconds-eligibleSeconds)),truncated:false}};
}
const json = (value, fallback) => { try {return JSON.parse(value)} catch {return fallback} };
const encode = x => JSON.stringify(x);
const now = () => new Date().toISOString();
function assertString(v,max=2000){return typeof v==='string' && v.length<=max;}
function cleanGame(raw, previous = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid game data.');
  const name = String(raw.name ?? previous.name ?? '').trim();
  if (!name || name.length > 140) throw new Error('Game name must contain 1–140 characters.');
  const source = String(raw.source ?? previous.source ?? 'manual');
  if (!['manual','steam','epic','gog','ea','ubisoft','battlenet','xbox','folder'].includes(source)) throw new Error('Unsupported game source.');
  const result = {};
  for (const key of ['source_id','executable','launch_uri','install_path','cover','banner','icon','genre','working_dir']) {
    const val = raw[key] !== undefined ? raw[key] : previous[key];
    if (val !== undefined && val !== null && !assertString(val,4000)) throw new Error(`Invalid ${key}.`);
    result[key] = val ?? '';
  }
  if(result.executable&&path.isAbsolute(result.executable))result.executable=path.normalize(result.executable);
  let launchArgs = raw.launch_args ?? previous.launch_args ?? [];
  if (typeof launchArgs === 'string') { try {launchArgs = JSON.parse(launchArgs)} catch {throw new Error('Launch arguments must be a JSON array.')} }
  if (!Array.isArray(launchArgs) || launchArgs.length > 80 || launchArgs.some(a => !assertString(a,1024))) throw new Error('Launch arguments must be an array of short strings.');
  let tags = raw.tags ?? previous.tags ?? [];
  if (typeof tags === 'string') tags = tags.split(',');
  if (!Array.isArray(tags) || tags.length > 40) throw new Error('Invalid tags.');
  tags = [...new Set(tags.map(t => String(t).trim()).filter(Boolean))];
  if (tags.some(t => t.length>36)) throw new Error('Tags must be 36 characters or shorter.');
  const coverFit=raw.cover_fit??previous.cover_fit??'cover';
  const coverPosition=raw.cover_position??previous.cover_position??'center';
  if(!['cover','contain'].includes(coverFit)||!['top','center','bottom'].includes(coverPosition))throw Error('Invalid cover presentation.');
  return {...result,cover_fit:coverFit,cover_position:coverPosition, name, source, tags, launch_args: launchArgs, favorite: raw.favorite !== undefined ? !!raw.favorite : !!previous.favorite};
}
function normalizedPath(value, platform=process.platform) {return platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);}
function duplicateKey(game){
  if (game.source_id && game.source && game.source!=='manual' && game.source!=='folder') return `${game.source}:${game.source_id}`.toLowerCase();
  if (game.executable) return `file:${normalizedPath(game.executable)}`;
  if (game.launch_uri) return `uri:${game.launch_uri.toLowerCase()}`;
  return '';
}
const hasStoreIdentity=game=>!!(game?.source_id&&game?.source&&!['manual','folder'].includes(game.source));
function sameBackupGame(existing,incoming){
  if(hasStoreIdentity(existing)&&hasStoreIdentity(incoming))
    return existing.source.toLowerCase()===incoming.source.toLowerCase()&&existing.source_id.toLowerCase()===incoming.source_id.toLowerCase();
  const oldKey=duplicateKey(existing),incomingKey=duplicateKey(incoming);
  if(oldKey&&incomingKey)return oldKey===incomingKey;
  return existing.source===incoming.source&&existing.name===incoming.name;
}
function reconcileDiscoveredGames(library,candidates,platform=process.platform){
  const knownSources=new Set(library.filter(hasStoreIdentity).map(duplicateKey));
  const knownFiles=new Set(library.filter(g=>g.executable).map(g=>normalizedPath(g.executable,platform)));
  const knownUris=new Set(library.filter(g=>g.launch_uri).map(g=>g.launch_uri.toLowerCase()));
  const aliasFiles=new Set(library.filter(g=>!hasStoreIdentity(g)&&g.executable).map(g=>normalizedPath(g.executable,platform)));
  const aliasUris=new Set(library.filter(g=>!hasStoreIdentity(g)&&g.launch_uri).map(g=>g.launch_uri.toLowerCase()));
  return candidates.map(g=>({...g,alreadyAdded:!!(
    (hasStoreIdentity(g)&&knownSources.has(duplicateKey(g))) ||
    (g.executable&&(hasStoreIdentity(g)?aliasFiles:knownFiles).has(normalizedPath(g.executable,platform))) ||
    (g.launch_uri&&(hasStoreIdentity(g)?aliasUris:knownUris).has(g.launch_uri.toLowerCase())))}));
}
function deserialize(row){if(!row)return null;return {...row, favorite:!!row.favorite, tags:json(row.tags,[]),launch_args:json(row.launch_args,[]) };}
class LibraryDatabase {
  constructor(file){
    this.file=file;
    fs.mkdirSync(path.dirname(file), {recursive:true});
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS games (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '',
 executable TEXT NOT NULL DEFAULT '', launch_uri TEXT NOT NULL DEFAULT '', install_path TEXT NOT NULL DEFAULT '',
 cover TEXT NOT NULL DEFAULT '', banner TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', genre TEXT NOT NULL DEFAULT '',
 tags TEXT NOT NULL DEFAULT '[]', favorite INTEGER NOT NULL DEFAULT 0, total_play_seconds INTEGER NOT NULL DEFAULT 0,
 last_played_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 launch_args TEXT NOT NULL DEFAULT '[]', working_dir TEXT NOT NULL DEFAULT '', cover_fit TEXT NOT NULL DEFAULT 'cover', cover_position TEXT NOT NULL DEFAULT 'center', duplicate_key TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_duplicate ON games(duplicate_key) WHERE duplicate_key != '';
CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);
CREATE INDEX IF NOT EXISTS idx_games_executable ON games(executable) WHERE executable != '';
CREATE INDEX IF NOT EXISTS idx_games_uri ON games(launch_uri COLLATE NOCASE) WHERE launch_uri != '';
CREATE INDEX IF NOT EXISTS idx_games_executable_nocase ON games(executable COLLATE NOCASE) WHERE executable != '';
CREATE INDEX IF NOT EXISTS idx_games_recent ON games(last_played_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, started_at TEXT NOT NULL, finished_at TEXT, seconds INTEGER NOT NULL DEFAULT 0, heartbeat_seconds INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT);`);
    // Existing user libraries predate the optional icon column. Migrate in place.
    if (!this.db.prepare('PRAGMA table_info(games)').all().some(column=>column.name==='icon')) {
      this.db.exec("ALTER TABLE games ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
    }
    const gameColumns=new Set(this.db.prepare('PRAGMA table_info(games)').all().map(c=>c.name));
    if(!gameColumns.has('cover_fit'))this.db.exec("ALTER TABLE games ADD COLUMN cover_fit TEXT NOT NULL DEFAULT 'cover'");
    if(!gameColumns.has('cover_position'))this.db.exec("ALTER TABLE games ADD COLUMN cover_position TEXT NOT NULL DEFAULT 'center'");
    const sessionColumns=new Set(this.db.prepare('PRAGMA table_info(sessions)').all().map(c=>c.name));
    if(!sessionColumns.has('heartbeat_seconds'))this.db.exec('ALTER TABLE sessions ADD COLUMN heartbeat_seconds INTEGER NOT NULL DEFAULT 0');
    if(!sessionColumns.has('last_seen_at'))this.db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
  }
  close(){this.db.close();}
  getSettings(){
    const settings={...DEFAULT_SETTINGS};
    for(const {key,value} of this.db.prepare('SELECT key,value FROM settings').all()){
      if(!Object.hasOwn(DEFAULT_SETTINGS,key))continue;
      const parsed=json(value,DEFAULT_SETTINGS[key]);
      if(key==='theme'&&!['dark','light','system'].includes(parsed))continue;
      if(key==='accent'&&(typeof parsed!=='string'||!/^#[0-9a-fA-F]{6}$/.test(parsed)))continue;
      if(key==='view'&&!['grid','list'].includes(parsed))continue;
      if(key==='sort'&&!Object.hasOwn(SORTS,parsed))continue;
      if(key==='libraryDensity'&&!['comfortable','compact'].includes(parsed))continue;
      if(key==='libraryFolders'&&(!Array.isArray(parsed)||parsed.length>60||parsed.some(p=>!assertString(p,4000))))continue;
      if(['reduceMotion','autoScan','useSteamArtwork','scanDownloads','onboardingDone','performanceGuard','autoUpdates'].includes(key)&&typeof parsed!=='boolean')continue;
      settings[key]=parsed;
    }
    settings.scanDownloads=false; // Legacy opt-in is ignored.
    return settings;
  }
  saveSettings(input){
    const allowed=['theme','accent','reduceMotion','autoScan','useSteamArtwork','libraryFolders','view','sort','onboardingDone','performanceGuard','autoUpdates','libraryDensity'];
    const current=this.getSettings();const next={...current};
    for(const key of allowed)if(Object.hasOwn(input,key))next[key]=input[key];
    if(!['dark','light','system'].includes(next.theme))throw Error('Invalid theme.');
    if(!/^#[0-9a-fA-F]{6}$/.test(next.accent))throw Error('Invalid accent color.');
    if(!['grid','list'].includes(next.view)||!Object.hasOwn(SORTS,next.sort)||!['comfortable','compact'].includes(next.libraryDensity))throw Error('Invalid library preferences.');
    if(!Array.isArray(next.libraryFolders)||next.libraryFolders.length>60||next.libraryFolders.some(x=>!assertString(x,4000)))throw Error('Invalid library folders.');
    for(const key of ['reduceMotion','autoScan','useSteamArtwork','onboardingDone','performanceGuard','autoUpdates'])next[key]=!!next[key];
    const changes=allowed.filter(key=>encode(current[key])!==encode(next[key]));
    if(!changes.length)return current;
    const set=this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.db.exec('BEGIN');try{for(const key of changes)set.run(key,encode(next[key]));this.db.exec('COMMIT')}catch(e){this.db.exec('ROLLBACK');throw e}
    return next;
  }
  list(sort='name'){const order=Object.hasOwn(SORTS,sort)?SORTS[sort]:SORTS.name;return this.db.prepare(`SELECT ${COLUMNS.join(',')} FROM games ORDER BY ${order}`).all().map(deserialize);}
  listActivityGames(){
    this.activityList ??= this.db.prepare("SELECT id,name,source,install_path,executable,launch_uri FROM games WHERE executable != '' OR (install_path != '' AND (source IN ('steam','epic') OR launch_uri != ''))");
    return this.activityList.all();
  }
  getStatistics(options={},asOf=new Date()){
    const days=statisticsDays(options);
    const openSessions=this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE finished_at IS NULL').get().count;
    const rows=this.db.prepare(`SELECT s.game_id,s.started_at,s.finished_at,s.seconds,g.name,g.source,g.cover,g.icon
      FROM sessions s INNER JOIN games g ON g.id=s.game_id WHERE s.finished_at IS NOT NULL
      ORDER BY s.game_id,s.started_at,s.id LIMIT ?`).all(STATS_MAX_ROWS+1);
    if(rows.length>STATS_MAX_ROWS)throw Error('Statistics history exceeds the safe 100000-session read limit.');
    return statisticsFromRows(rows,openSessions,days,asOf);
  }
  get(id){return deserialize(this.db.prepare(`SELECT ${COLUMNS.join(',')} FROM games WHERE id=?`).get(id));}
  count(){return this.db.prepare('SELECT COUNT(*) as count FROM games').get().count;}
  exportBackup(){
    // Read one consistent SQLite snapshot; an unfinished session would make
    // the exported playtime/history incomplete, so reject the entire export.
    this.db.exec('BEGIN');
    try{
      if(this.db.prepare('SELECT 1 FROM sessions WHERE finished_at IS NULL LIMIT 1').get())
        throw Error('Cannot export while an unfinished playtime session exists. Finish or recover the session first.');
      const sessions=this.db.prepare('SELECT id,game_id,started_at,finished_at,seconds FROM sessions ORDER BY id LIMIT ?').all(STATS_MAX_ROWS+1);
      if(sessions.length>STATS_MAX_ROWS)throw Error('Session history exceeds the safe 100000-session backup limit.');
      const payload={format:'orbit.library.v1',exported_at:now(),settings:this.getSettings(),games:this.list(),sessions};
      validateSessionHistory(payload);
      this.db.exec('COMMIT');
      return payload;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  findExecutableDuplicate(executable,exceptId='',incoming=null){
    if(!executable)return undefined;
    const comparison=process.platform==='win32'?'executable=? COLLATE NOCASE':'executable=?';
    // A verified store product can share a binary with another distinct store
    // product (DLC/edition). Only manual or legacy unkeyed aliases coalesce.
    const aliasOnly=hasStoreIdentity(incoming)?" AND (source IN ('manual','folder') OR source_id = '')":'';
    const row=this.db.prepare(`SELECT id FROM games WHERE executable != '' AND ${comparison} AND id != ?${aliasOnly} ORDER BY rowid LIMIT 1`).get(path.normalize(executable),exceptId);
    return row;
  }
  findUriDuplicate(uri,exceptId='',incoming=null){
    if(!uri)return undefined;
    const aliasOnly=hasStoreIdentity(incoming)?" AND (source IN ('manual','folder') OR source_id = '')":'';
    return this.db.prepare(`SELECT id FROM games WHERE launch_uri != '' AND launch_uri=? COLLATE NOCASE AND id != ?${aliasOnly} ORDER BY rowid LIMIT 1`).get(uri,exceptId);
  }
  upsert(raw, updateExisting=false, requestedId=null){
    const parsed=cleanGame(raw);
    const key=duplicateKey(parsed);
    const exists=(key?this.db.prepare('SELECT id FROM games WHERE duplicate_key=?').get(key):undefined)||this.findExecutableDuplicate(parsed.executable,'',parsed)||this.findUriDuplicate(parsed.launch_uri,'',parsed);
    if(exists){if(!updateExisting)return {game:this.get(exists.id),added:false};return {game:this.update(exists.id,raw),added:false};}
    const id=requestedId??crypto.randomUUID(), date=now();
    const row={id,...parsed,tags:encode(parsed.tags),launch_args:encode(parsed.launch_args),favorite:Number(parsed.favorite),total_play_seconds:0,last_played_at:null,created_at:date,updated_at:date,duplicate_key:key};
    const fields=Object.keys(row);
    const stmt=this.db.prepare(`INSERT INTO games (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`);
    stmt.run(...fields.map(c=>row[c]));return {game:this.get(id),added:true};
  }
  upsertBatch(items){
    if(!Array.isArray(items)||items.length>100)throw Error('Import batch must contain at most 100 games.');
    let imported=0,skipped=0;
    const errors=[],addedGames=[];
    this.db.exec('BEGIN');
    try{
      for(const item of items){
        try{
          const result=this.upsert(item);
          if(result.added){imported++;addedGames.push(result.game)}
          else skipped++;
        }catch(error){errors.push(`${String(item?.name||'Entry').slice(0,100)}: ${error.message}`)}
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error}
    return {imported,skipped,errors,addedGames};
  }
  restoreGame(raw){
    this.db.exec('BEGIN');
    try{
      const result=this.restoreGameRow(raw);
      this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  restoreGameRow(raw,preserveId=false){
    const seconds=Number.isSafeInteger(raw?.total_play_seconds)&&raw.total_play_seconds>=0?Math.min(raw.total_play_seconds,100*365*24*3600):0;
    const isoDate=value=>{
      if(typeof value!=='string'||value.length>50)return null;
      const time=Date.parse(value);
      return Number.isFinite(time)?new Date(time).toISOString():null;
    };
    const result=this.upsert(raw,false,preserveId?raw.id:null);
    if(result.added){
      this.db.prepare('UPDATE games SET total_play_seconds=?,last_played_at=?,created_at=? WHERE id=?')
        .run(seconds,isoDate(raw?.last_played_at),isoDate(raw?.created_at)||result.game.created_at,result.game.id);
      result.game=this.get(result.game.id);
    }
    return result;
  }
  restoreBackupGames(payload){
    // Validate the entire history and every game before modifying SQLite.
    const sessions=validateSessionHistory(payload);
    if(!Object.hasOwn(payload,'sessions'))throw Error('Session history is missing from this backup.');
    for(const game of payload.games)cleanGame(game);
    const mapping=new Map();
    const targetIds=new Set();
    let imported=0,skipped=0,sessionsImported=0,sessionsSkipped=0;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const game of payload.games){
        const current=this.get(game.id);
        if(current){
          const parsed=cleanGame(game),key=duplicateKey(parsed);
          const collision=(key?this.db.prepare('SELECT id FROM games WHERE duplicate_key=? AND id!=?').get(key,game.id):null)||
            this.findExecutableDuplicate(parsed.executable,game.id,parsed)||this.findUriDuplicate(parsed.launch_uri,game.id,parsed);
          if(!sameBackupGame(current,parsed)||collision)
            throw Error(`Backup game ID ${game.id} conflicts with an existing game.`);
        }
        const result=current?{game:current,added:false}:this.restoreGameRow(game,true);
        if(result.added)imported++;else skipped++;
        if(targetIds.has(result.game.id))throw Error(`Multiple backup games resolve to the same destination game: ${result.game.id}`);
        targetIds.add(result.game.id);
        mapping.set(game.id,result.game.id);
      }
      const lookup=this.db.prepare('SELECT game_id,started_at,finished_at,seconds FROM sessions WHERE id=?');
      const insert=this.db.prepare('INSERT INTO sessions (id,game_id,started_at,finished_at,seconds) VALUES (?,?,?,?,?)');
      for(const session of sessions){
        const destinationId=mapping.get(session.game_id);
        if(!destinationId)throw Error('Backup session history refers to a game that could not be restored.');
        const old=lookup.get(session.id);
        if(old){
          if(old.game_id!==destinationId||old.started_at!==session.started_at||old.finished_at!==session.finished_at||old.seconds!==session.seconds)
            throw Error(`Conflicting existing backup session: ${session.id}`);
          sessionsSkipped++;
        }else{
          insert.run(session.id,destinationId,session.started_at,session.finished_at,session.seconds);
          sessionsImported++;
        }
      }
      // Game totals from the backup are already restored on newly added games.
      // Existing games retain their aggregate to avoid crediting playtime twice.
      this.db.exec('COMMIT');
      return {imported,skipped,errors:[],sessionsImported,sessionsSkipped};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  update(id,patch){const old=this.get(id);if(!old)throw Error('Game not found.');const parsed=cleanGame(patch,old);if(this.findExecutableDuplicate(parsed.executable,id,parsed))throw Error('This executable is already in your library.');if(this.findUriDuplicate(parsed.launch_uri,id,parsed))throw Error('This launcher link is already in your library.');const key=duplicateKey(parsed),date=now();const row={...parsed,tags:encode(parsed.tags),launch_args:encode(parsed.launch_args),favorite:Number(parsed.favorite),duplicate_key:key,updated_at:date};
    const fields=Object.keys(row);try{this.db.prepare(`UPDATE games SET ${fields.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...fields.map(k=>row[k]),id)}catch(e){if(String(e).includes('UNIQUE'))throw Error('This game is already in your library.');throw e}
    return this.get(id);
  }
  toggleFavorite(id){const old=this.get(id);if(!old)throw Error('Game not found.');return this.update(id,{favorite:!old.favorite});}
  remove(id){const result=this.db.prepare('DELETE FROM games WHERE id=?').run(id);return result.changes>0;}
  startSession(gameId){
    // The guard must be checked under SQLite's writer lock. Two Orbit processes
    // (or a tracker restarting after a failed finish) must never create two
    // unfinished sessions for the same game.
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(!this.db.prepare('SELECT 1 FROM games WHERE id=?').get(gameId))throw Error('Game not found.');
      if(this.db.prepare('SELECT 1 FROM sessions WHERE game_id=? AND finished_at IS NULL LIMIT 1').get(gameId))
        throw Error('This game already has an unfinished playtime session.');
      const id=crypto.randomUUID(),date=now();
      this.db.prepare('INSERT INTO sessions(id,game_id,started_at) VALUES (?,?,?)').run(id,gameId,date);
      this.db.prepare('UPDATE games SET last_played_at=?,updated_at=? WHERE id=?').run(date,date,gameId);
      this.db.exec('COMMIT');
      return id;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  checkpointSessions(entries){
    if(!Array.isArray(entries)||!entries.length)return 0;
    const update=this.db.prepare('UPDATE sessions SET heartbeat_seconds=?,last_seen_at=? WHERE id=? AND finished_at IS NULL AND heartbeat_seconds<=?');
    let changed=0;const stamped=now();
    this.db.exec('BEGIN');try{
      for(const entry of entries){
        if(typeof entry?.id!=='string'||!Number.isFinite(entry.seconds))continue;
        const elapsed=Math.min(7*86400,Math.max(0,Math.floor(entry.seconds)));
        changed+=update.run(elapsed,stamped,entry.id,elapsed).changes;
      }
      this.db.exec('COMMIT');return changed;
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  recoverInterruptedSessions(){
    // Never guess play time beyond the last durable checkpoint after a crash.
    const stale=this.db.prepare('SELECT id,game_id,heartbeat_seconds FROM sessions WHERE finished_at IS NULL').all();
    if(!stale.length)return 0;
    const close=this.db.prepare('UPDATE sessions SET finished_at=?,seconds=? WHERE id=? AND finished_at IS NULL');
    const credit=this.db.prepare('UPDATE games SET total_play_seconds=total_play_seconds+?,updated_at=? WHERE id=?');
    const date=now();let recovered=0;
    this.db.exec('BEGIN');try{
      for(const row of stale){
        const seconds=Math.min(7*86400,Math.max(0,Number(row.heartbeat_seconds)||0));
        if(close.run(date,seconds,row.id).changes){credit.run(seconds,date,row.game_id);recovered++;}
      }
      this.db.exec('COMMIT');return recovered;
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  finishSession(id,seconds){
    seconds=Math.max(0,Math.min(7*24*3600,Math.floor(Number(seconds)||0)));
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const session=this.db.prepare('SELECT game_id FROM sessions WHERE id=? AND finished_at IS NULL').get(id);
      if(!session){this.db.exec('COMMIT');return false;}
      const date=now();
      const done=this.db.prepare('UPDATE sessions SET finished_at=?,seconds=? WHERE id=? AND finished_at IS NULL').run(date,seconds,id);
      if(done.changes===1)this.db.prepare('UPDATE games SET total_play_seconds=total_play_seconds+?,updated_at=? WHERE id=?').run(seconds,date,session.game_id);
      this.db.exec('COMMIT');return done.changes===1;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
module.exports={LibraryDatabase,cleanGame,duplicateKey,normalizedPath,reconcileDiscoveredGames,DEFAULT_SETTINGS};

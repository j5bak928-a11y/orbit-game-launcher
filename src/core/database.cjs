'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark', accent: '#8b7aff', reduceMotion: false,
  autoScan: false, useSteamArtwork: true, scanDownloads: false, libraryFolders: [],
  view: 'grid', sort: 'name', onboardingDone: false,
});
const SORTS = {name: 'name COLLATE NOCASE ASC', recent: 'last_played_at DESC, name COLLATE NOCASE ASC', added: 'created_at DESC', time: 'total_play_seconds DESC, name COLLATE NOCASE ASC'};
const COLUMNS = ['id','name','source','source_id','executable','launch_uri','install_path','cover','banner','icon','genre','tags','favorite','total_play_seconds','last_played_at','created_at','updated_at','launch_args','working_dir'];
const json = (value, fallback) => { try {return JSON.parse(value)} catch {return fallback} };
const encode = x => JSON.stringify(x);
const now = () => new Date().toISOString();
function assertString(v,max=2000){return typeof v==='string' && v.length<=max;}
function cleanGame(raw, previous = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid game data.');
  const name = String(raw.name ?? previous.name ?? '').trim();
  if (!name || name.length > 140) throw new Error('Game name must contain 1–140 characters.');
  const source = String(raw.source ?? previous.source ?? 'manual');
  if (!['manual','steam','epic','gog','ea','ubisoft','battlenet','folder'].includes(source)) throw new Error('Unsupported game source.');
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
  return {...result, name, source, tags, launch_args: launchArgs, favorite: raw.favorite !== undefined ? !!raw.favorite : !!previous.favorite};
}
function normalizedPath(value, platform=process.platform) {return platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);}
function duplicateKey(game){
  if (game.source_id && game.source && game.source!=='manual' && game.source!=='folder') return `${game.source}:${game.source_id}`.toLowerCase();
  if (game.executable) return `file:${normalizedPath(game.executable)}`;
  if (game.launch_uri) return `uri:${game.launch_uri.toLowerCase()}`;
  return '';
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
 launch_args TEXT NOT NULL DEFAULT '[]', working_dir TEXT NOT NULL DEFAULT '', duplicate_key TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_duplicate ON games(duplicate_key) WHERE duplicate_key != '';
CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);
CREATE INDEX IF NOT EXISTS idx_games_executable ON games(executable) WHERE executable != '';
CREATE INDEX IF NOT EXISTS idx_games_uri ON games(launch_uri COLLATE NOCASE) WHERE launch_uri != '';
CREATE INDEX IF NOT EXISTS idx_games_executable_nocase ON games(executable COLLATE NOCASE) WHERE executable != '';
CREATE INDEX IF NOT EXISTS idx_games_recent ON games(last_played_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, started_at TEXT NOT NULL, finished_at TEXT, seconds INTEGER NOT NULL DEFAULT 0);`);
    // Existing user libraries predate the optional icon column. Migrate in place.
    if (!this.db.prepare('PRAGMA table_info(games)').all().some(column=>column.name==='icon')) {
      this.db.exec("ALTER TABLE games ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
    }
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
      if(key==='libraryFolders'&&(!Array.isArray(parsed)||parsed.length>60||parsed.some(p=>!assertString(p,4000))))continue;
      if(['reduceMotion','autoScan','useSteamArtwork','scanDownloads','onboardingDone'].includes(key)&&typeof parsed!=='boolean')continue;
      settings[key]=parsed;
    }
    settings.scanDownloads=false; // Legacy opt-in is ignored.
    return settings;
  }
  saveSettings(input){
    const allowed=['theme','accent','reduceMotion','autoScan','useSteamArtwork','libraryFolders','view','sort','onboardingDone'];
    const current=this.getSettings();const next={...current};
    for(const key of allowed)if(Object.hasOwn(input,key))next[key]=input[key];
    if(!['dark','light','system'].includes(next.theme))throw Error('Invalid theme.');
    if(!/^#[0-9a-fA-F]{6}$/.test(next.accent))throw Error('Invalid accent color.');
    if(!['grid','list'].includes(next.view)||!Object.hasOwn(SORTS,next.sort))throw Error('Invalid library preferences.');
    if(!Array.isArray(next.libraryFolders)||next.libraryFolders.length>60||next.libraryFolders.some(x=>!assertString(x,4000)))throw Error('Invalid library folders.');
    for(const key of ['reduceMotion','autoScan','useSteamArtwork','onboardingDone'])next[key]=!!next[key];
    const set=this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.db.exec('BEGIN');try{for(const key of allowed)set.run(key,encode(next[key]));this.db.exec('COMMIT')}catch(e){this.db.exec('ROLLBACK');throw e}
    return next;
  }
  list(sort='name'){const order=Object.hasOwn(SORTS,sort)?SORTS[sort]:SORTS.name;return this.db.prepare(`SELECT ${COLUMNS.join(',')} FROM games ORDER BY ${order}`).all().map(deserialize);}
  listActivityGames(){
    this.activityList ??= this.db.prepare("SELECT id,source,install_path FROM games WHERE source IN ('steam','epic') AND install_path != ''");
    return this.activityList.all();
  }
  get(id){return deserialize(this.db.prepare(`SELECT ${COLUMNS.join(',')} FROM games WHERE id=?`).get(id));}
  count(){return this.db.prepare('SELECT COUNT(*) as count FROM games').get().count;}
  findExecutableDuplicate(executable,exceptId=''){
    if(!executable)return undefined;
    const comparison=process.platform==='win32'?'executable=? COLLATE NOCASE':'executable=?';
    const row=this.db.prepare(`SELECT id FROM games WHERE executable != '' AND ${comparison} AND id != ? LIMIT 1`).get(path.normalize(executable),exceptId);
    return row;
  }
  findUriDuplicate(uri,exceptId=''){
    if(!uri)return undefined;
    return this.db.prepare("SELECT id FROM games WHERE launch_uri != '' AND launch_uri=? COLLATE NOCASE AND id != ? LIMIT 1").get(uri,exceptId);
  }
  upsert(raw, updateExisting=false){
    const parsed=cleanGame(raw);
    const key=duplicateKey(parsed);
    const exists=(key?this.db.prepare('SELECT id FROM games WHERE duplicate_key=?').get(key):undefined)||this.findExecutableDuplicate(parsed.executable)||this.findUriDuplicate(parsed.launch_uri);
    if(exists){if(!updateExisting)return {game:this.get(exists.id),added:false};return {game:this.update(exists.id,raw),added:false};}
    const id=crypto.randomUUID(), date=now();
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
    const seconds=Number.isSafeInteger(raw?.total_play_seconds)&&raw.total_play_seconds>=0?Math.min(raw.total_play_seconds,100*365*24*3600):0;
    const isoDate=value=>{
      if(typeof value!=='string'||value.length>50)return null;
      const time=Date.parse(value);
      return Number.isFinite(time)?new Date(time).toISOString():null;
    };
    this.db.exec('BEGIN');
    try{
      const result=this.upsert(raw);
      if(result.added){
        this.db.prepare('UPDATE games SET total_play_seconds=?,last_played_at=?,created_at=? WHERE id=?')
          .run(seconds,isoDate(raw?.last_played_at),isoDate(raw?.created_at)||result.game.created_at,result.game.id);
        result.game=this.get(result.game.id);
      }
      this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  update(id,patch){const old=this.get(id);if(!old)throw Error('Game not found.');const parsed=cleanGame(patch,old);if(this.findExecutableDuplicate(parsed.executable,id))throw Error('This executable is already in your library.');if(this.findUriDuplicate(parsed.launch_uri,id))throw Error('This launcher link is already in your library.');const key=duplicateKey(parsed),date=now();const row={...parsed,tags:encode(parsed.tags),launch_args:encode(parsed.launch_args),favorite:Number(parsed.favorite),duplicate_key:key,updated_at:date};
    const fields=Object.keys(row);try{this.db.prepare(`UPDATE games SET ${fields.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...fields.map(k=>row[k]),id)}catch(e){if(String(e).includes('UNIQUE'))throw Error('This game is already in your library.');throw e}
    return this.get(id);
  }
  toggleFavorite(id){const old=this.get(id);if(!old)throw Error('Game not found.');return this.update(id,{favorite:!old.favorite});}
  remove(id){const result=this.db.prepare('DELETE FROM games WHERE id=?').run(id);return result.changes>0;}
  startSession(gameId){if(!this.get(gameId))throw Error('Game not found.');const id=crypto.randomUUID();this.db.prepare('INSERT INTO sessions(id,game_id,started_at) VALUES (?,?,?)').run(id,gameId,now());this.db.prepare('UPDATE games SET last_played_at=?, updated_at=? WHERE id=?').run(now(),now(),gameId);return id;}
  finishSession(id,seconds){const session=this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);if(!session||session.finished_at)return false;seconds=Math.max(0,Math.min(7*24*3600,Math.floor(Number(seconds)||0)));
    this.db.exec('BEGIN');try{this.db.prepare('UPDATE sessions SET finished_at=?, seconds=? WHERE id=?').run(now(),seconds,id);this.db.prepare('UPDATE games SET total_play_seconds=total_play_seconds+?,updated_at=? WHERE id=?').run(seconds,now(),session.game_id);this.db.exec('COMMIT');return true}catch(e){this.db.exec('ROLLBACK');throw e}
  }
}
module.exports={LibraryDatabase,cleanGame,duplicateKey,normalizedPath,DEFAULT_SETTINGS};

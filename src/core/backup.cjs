'use strict';

// Portable Orbit backups use gzip-compressed JSON, including local artwork.
// Metadata-only .json exports remain supported for compatibility with v1.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {gzipSync, gunzipSync} = require('node:zlib');

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED = 192 * 1024 * 1024;
const MAX_ARTWORK_TOTAL = 100 * 1024 * 1024;
const MAX_IMAGE = 15 * 1024 * 1024;
const ART_NAME = /^[a-f\d-]{36}\.(png|jpg|jpeg|webp)$/i;
const FORMAT = 'orbit.portable.v1';
const MAX_SESSIONS = 100000;
const MAX_SESSION_SECONDS = 7 * 86400;
const validHistoryId = value => typeof value === 'string' && value.length > 0 &&
  value.isWellFormed() && Buffer.byteLength(value,'utf8') <= 128 &&
  value.trim() === value && !/\p{Cc}/u.test(value);
function historyTimestamp(value) {
  if (typeof value !== 'string' || value.length > 50) return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return NaN;
  const [year,month,day,hour,minute,second] = match.slice(1,7).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year,month-1,day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month-1 || calendar.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59 || Number(match[8] || 0) > 23 || Number(match[9] || 0) > 59) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
}
// A v1 library may have no sessions field. When present, history must be
// complete, attributable to exactly one exported game, and safe to import.
function validateSessionHistory(library) {
  if (library?.format !== 'orbit.library.v1') throw Error('Unrecognized Orbit library format.');
  if (!Array.isArray(library.games) || library.games.length > MAX_SESSIONS ||
      library.games.some(game=>!game || typeof game !== 'object' || Array.isArray(game)))
    throw Error('Invalid Orbit library games.');
  if (!Object.hasOwn(library, 'sessions')) return [];
  const sessions = library.sessions;
  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS) throw Error('Invalid backup session history or history limit exceeded.');
  const gameIds = new Set();
  for (const game of library.games) {
    if (!validHistoryId(game.id) || gameIds.has(game.id))
      throw Error('Backup session history has missing or duplicate game IDs.');
    gameIds.add(game.id);
  }
  const ids = new Set();
  for (const session of sessions) {
    if (!session || typeof session !== 'object' || Array.isArray(session) ||
        Object.keys(session).length !== 5 ||
        !['id','game_id','started_at','finished_at','seconds'].every(key=>Object.hasOwn(session,key)) ||
        !validHistoryId(session.id) || ids.has(session.id) ||
        typeof session.game_id !== 'string' || !gameIds.has(session.game_id) ||
        !Number.isSafeInteger(session.seconds) || session.seconds < 0 || session.seconds > MAX_SESSION_SECONDS ||
        !Number.isFinite(historyTimestamp(session.started_at)) || !Number.isFinite(historyTimestamp(session.finished_at)) ||
        historyTimestamp(session.finished_at) < historyTimestamp(session.started_at))
      throw Error('Backup contains invalid or unfinished session history.');
    ids.add(session.id);
  }
  return sessions;
}
function imageValid(name, bytes) {
  if (!ART_NAME.test(name) || bytes.length === 0 || bytes.length > MAX_IMAGE) return false;
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (ext === '.webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
}
function assetNames(games) {
  return [...new Set(games.flatMap(game => [game.cover, game.banner, game.icon]).filter(value => typeof value === 'string' && ART_NAME.test(value)))];
}
async function createPortableBackup(payload, folder) {
  if (!payload || !Array.isArray(payload.games)) throw Error('Invalid library for backup.');
  validateSessionHistory(payload);
  const artwork = Object.create(null);
  const missing = [];
  let total = 0;
  for (const name of assetNames(payload.games)) {
    let bytes;
    try {
      const file = path.join(folder, name);
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > MAX_IMAGE) throw Error('Invalid image size.');
      bytes = await fsp.readFile(file);
      if (!imageValid(name, bytes)) throw Error('Invalid image format.');
    } catch {
      missing.push(name);
      continue;
    }
    total += bytes.length;
    if (total > MAX_ARTWORK_TOTAL) throw Error('Artwork exceeds the 100 MB portable backup limit. Export a metadata-only JSON backup instead.');
    artwork[name] = bytes.toString('base64');
  }
  const text = JSON.stringify({format:FORMAT, library:payload, artwork});
  if (Buffer.byteLength(text) > MAX_UNCOMPRESSED) throw Error('Library exceeds the portable backup size limit.');
  const result = gzipSync(Buffer.from(text), {level:6});
  if (result.length > MAX_ARCHIVE) throw Error('Compressed backup exceeds the 128 MB limit.');
  return {bytes:result, missingArtwork:missing.length, artworkCount:Object.keys(artwork).length};
}
function decodePortableBackup(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE || bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw Error('Invalid Orbit portable backup.');
  let decoded;
  try {decoded = JSON.parse(gunzipSync(bytes, {maxOutputLength:MAX_UNCOMPRESSED}).toString('utf8'));}
  catch {throw Error('Portable backup is corrupt or exceeds the safe size limit.');}
  if (decoded?.format !== FORMAT || !decoded.library || !Array.isArray(decoded.library.games) ||
      !decoded.artwork || typeof decoded.artwork !== 'object' || Array.isArray(decoded.artwork)) throw Error('Unrecognized portable backup format.');
  validateSessionHistory(decoded.library);
  // Only accept assets referenced by game records, to avoid writing unrelated files.
  const expected = new Set(assetNames(decoded.library.games));
  const assets = new Map();
  let total = 0;
  for (const [name, encoded] of Object.entries(decoded.artwork)) {
    if (!expected.has(name) || typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_IMAGE * 4 / 3) + 8 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Error('Backup contains invalid artwork.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!imageValid(name, bytes) || bytes.toString('base64') !== encoded) throw Error('Backup contains invalid artwork.');
    total += bytes.length;
    if (total > MAX_ARTWORK_TOTAL) throw Error('Backup artwork exceeds the safe size limit.');
    assets.set(name, bytes);
  }
  return {library:decoded.library, assets};
}
async function installBackupArtwork(assets, folder, {created = new Map()} = {}) {
  const names = new Map();
  await fsp.mkdir(folder, {recursive:true});
  for (const [name, data] of assets) {
    // Content-addressing prevents repeated restores from creating an unlimited
    // number of identical image files. The result remains a safe UUID-shaped
    // filename accepted by Orbit's artwork protocol.
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const ext = path.extname(name).toLowerCase();
    let installed = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}${ext}`;
    // Write and sync a complete temporary file first. A failed or partial
    // write must never leave a truncated final artwork filename behind.
    const temporary = path.join(folder, `.orbit-art-import-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, 'wx');
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const destination = path.join(folder, installed);
        try {
          // Same-directory hard links atomically publish complete bytes. The
          // 'already exists' case never overwrites user-owned artwork.
          await fsp.link(temporary, destination);
          created.set(installed, data);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const info = await fsp.lstat(destination);
          if (info.isFile() && !info.isSymbolicLink() && info.size === data.length &&
              (await fsp.readFile(destination)).equals(data)) break;
          if (attempt === 2) throw Error('Could not allocate a unique artwork filename.');
          installed = `${crypto.randomUUID()}${ext}`;
        }
      }
    } finally {
      if (handle) await handle.close();
      await fsp.rm(temporary, {force:true});
    }
    names.set(name, installed);
  }
  return names;
}
// Only files created by this restore are eligible for cleanup. If a game
// actually references one of them, or another writer changed its contents,
// leave it alone. This also handles legacy restores with skipped games.
async function cleanupUnusedBackupArtwork(created, folder, games) {
  if (!created.size) return;
  const referenced = new Set(assetNames(games));
  for (const [name, original] of created) {
    if (referenced.has(name)) continue;
    const target = path.join(folder, name);
    let info;
    try {info = await fsp.lstat(target);}
    catch (error) {if (error.code === 'ENOENT') continue;throw error;}
    if (!info.isFile() || info.isSymbolicLink() || info.size !== original.length) continue;
    const current = await fsp.readFile(target);
    if (current.equals(original)) await fsp.unlink(target).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}
async function writeAtomic(file, bytes) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {await fsp.writeFile(temporary, bytes, {flag:'wx'});await fsp.rename(temporary, file);}
  finally {await fsp.rm(temporary, {force:true}).catch(() => {});}
}
module.exports = {createPortableBackup, decodePortableBackup, installBackupArtwork, cleanupUnusedBackupArtwork, writeAtomic, validateSessionHistory, validHistoryId, MAX_ARCHIVE, MAX_UNCOMPRESSED};

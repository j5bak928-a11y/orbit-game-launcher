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
async function installBackupArtwork(assets, folder) {
  const names = new Map();
  await fsp.mkdir(folder, {recursive:true});
  for (const [name, data] of assets) {
    // Content-addressing prevents repeated restores from creating an unlimited
    // number of identical image files. The result remains a safe UUID-shaped
    // filename accepted by Orbit's artwork protocol.
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const ext = path.extname(name).toLowerCase();
    let installed = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}${ext}`;
    try {await fsp.writeFile(path.join(folder, installed), data, {flag:'wx'});}
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A different existing file must never be overwritten, even if it has
      // the same truncated digest (or a user manually created that filename).
      const existing = await fsp.readFile(path.join(folder, installed));
      if (!existing.equals(data)) {
        installed = `${crypto.randomUUID()}${ext}`;
        await fsp.writeFile(path.join(folder, installed), data, {flag:'wx'});
      }
    }
    names.set(name, installed);
  }
  return names;
}
async function writeAtomic(file, bytes) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {await fsp.writeFile(temporary, bytes, {flag:'wx'});await fsp.rename(temporary, file);}
  finally {await fsp.rm(temporary, {force:true}).catch(() => {});}
}
module.exports = {createPortableBackup, decodePortableBackup, installBackupArtwork, writeAtomic, MAX_ARCHIVE, MAX_UNCOMPRESSED};

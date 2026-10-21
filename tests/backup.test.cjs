'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {gzipSync} = require('node:zlib');
const {createPortableBackup, decodePortableBackup, installBackupArtwork, writeAtomic} = require('../src/core/backup.cjs');

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)]);
const jpeg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(20, 2)]);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-backup-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  const cover = `${crypto.randomUUID()}.png`;
  const banner = `${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(source, cover), png);
  fs.writeFileSync(path.join(source, banner), jpeg);
  const icon = `${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(source, icon), Buffer.concat([png,Buffer.from([2]) ]));
  const payload = {format:'orbit.library.v1',settings:{theme:'dark'},games:[{name:'Example',cover,banner,icon,total_play_seconds:555}]};
  return {root,source,target,cover,banner,icon,payload};
}
test('portable backup includes both artwork fields and survives transfer to a clean data folder', async t => {
  const f = fixture();t.after(() => fs.rmSync(f.root, {recursive:true,force:true}));
  const archive = await createPortableBackup(f.payload, f.source);
  assert.equal(archive.artworkCount, 3);
  assert.equal(archive.missingArtwork, 0);
  const saved = path.join(f.root, 'collection.orbit');
  await writeAtomic(saved, archive.bytes);
  const parsed = decodePortableBackup(fs.readFileSync(saved));
  assert.deepEqual(parsed.library, f.payload);
  const mapping = await installBackupArtwork(parsed.assets, f.target);
  assert.notEqual(mapping.get(f.cover), f.cover);
  assert.deepEqual(fs.readFileSync(path.join(f.target, mapping.get(f.cover))), png);
  assert.deepEqual(fs.readFileSync(path.join(f.target, mapping.get(f.banner))), jpeg);
  assert.ok(mapping.get(f.icon));
  const again = await installBackupArtwork(parsed.assets, f.target);
  assert.deepEqual(again, mapping, 'restoring the same archive twice should reuse artwork');
  assert.equal(fs.readdirSync(f.target).length, 3);
});
test('missing artwork is reported rather than silently claimed to have been included', async t => {
  const f = fixture();t.after(() => fs.rmSync(f.root, {recursive:true,force:true}));
  fs.unlinkSync(path.join(f.source, f.cover));
  const backup = await createPortableBackup(f.payload, f.source);
  assert.equal(backup.missingArtwork, 1);
  assert.equal(decodePortableBackup(backup.bytes).assets.size, 2);
});
test('untrusted backup cannot extract non-referenced artwork or invalid image content', async t => {
  const f = fixture();t.after(() => fs.rmSync(f.root, {recursive:true,force:true}));
  const wrong = gzipSync(Buffer.from(JSON.stringify({format:'orbit.portable.v1',library:f.payload,artwork:{'../../game.png':png.toString('base64')}})));
  assert.throws(() => decodePortableBackup(wrong), /invalid artwork/i);
  const incorrect = gzipSync(Buffer.from(JSON.stringify({format:'orbit.portable.v1',library:f.payload,artwork:{[f.cover]:Buffer.from('bad').toString('base64')}})));
  assert.throws(() => decodePortableBackup(incorrect), /invalid artwork/i);
  const bomb = gzipSync(Buffer.from('A'.repeat(220 * 1024 * 1024)));
  assert.throws(() => decodePortableBackup(bomb), /corrupt|limit/i);
});
test('portable backup does not export oversized artwork', async t => {
  const f = fixture();t.after(() => fs.rmSync(f.root, {recursive:true,force:true}));
  fs.writeFileSync(path.join(f.source,f.cover),Buffer.concat([png,Buffer.alloc(15*1024*1024)]));
  const backup = await createPortableBackup(f.payload,f.source);
  assert.equal(backup.missingArtwork,1);
});

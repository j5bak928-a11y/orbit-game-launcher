'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LibraryDatabase} = require('../src/core/database.cjs');
const {createPortableBackup, decodePortableBackup} = require('../src/core/backup.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-language-settings-'));
  const handles = [];
  t.after(() => {
    for (const db of handles) db.close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {
    root,
    open(name) {
      const db = new LibraryDatabase(path.join(root, `${name}.sqlite`));
      handles.push(db);
      return db;
    }
  };
}

test('language defaults to system and every supported code persists through SQLite without migration', t => {
  const f = fixture(t), db = f.open('existing');
  assert.equal(db.getSettings().language, 'system');
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key='language'").get().count, 0);

  for (const language of ['system', 'en', 'nl', 'de', 'fr', 'es']) {
    const saved = db.saveSettings({language});
    assert.equal(saved.language, language);
    assert.equal(db.getSettings().language, language);
    assert.equal(f.open('existing').getSettings().language, language, 'a separate connection sees the language');
  }
  assert.equal(db.db.prepare("SELECT value FROM settings WHERE key='language'").get().value, '"es"');
  assert.equal(db.getSettings().theme, 'dark');
});

test('invalid updates reject atomically and malformed stored language falls back to system', t => {
  const f = fixture(t), db = f.open('invalid');
  db.saveSettings({language: 'fr', theme: 'light'});
  for (const invalid of ['it', 'EN', '', null, 1, {}, [], false]) {
    assert.throws(() => db.saveSettings({language: invalid, accent: '#123456'}), /Invalid language/);
    assert.equal(db.getSettings().language, 'fr');
    assert.equal(db.getSettings().accent, '#8b7aff', 'failed update must not write other settings');
  }
  const write = db.db.prepare("UPDATE settings SET value=? WHERE key='language'");
  for (const malformed of ['"it"', '"EN"', 'null', '42', 'true', '{}', '[]', '{not-json']) {
    write.run(malformed);
    assert.equal(db.getSettings().language, 'system');
    assert.equal(db.getSettings().theme, 'light');
  }
  assert.equal(db.saveSettings({language: 'nl'}).language, 'nl');
  assert.equal(db.getSettings().language, 'nl');
});

test('JSON and portable backups carry language; legacy settings remain importable', async t => {
  const f = fixture(t), source = f.open('source'), target = f.open('target');
  const game = source.upsert({name: 'Language roundtrip'}).game;
  const session = source.startSession(game.id);
  assert.equal(source.finishSession(session, 34), true);
  source.saveSettings({language: 'es', theme: 'light'});
  const json = source.exportBackup();
  assert.equal(json.settings.language, 'es');
  const archive = await createPortableBackup(json, f.root);
  const portable = decodePortableBackup(archive.bytes).library;
  assert.equal(portable.settings.language, 'es');
  assert.deepEqual(portable, JSON.parse(JSON.stringify(json)));

  assert.equal(target.restoreBackupGames(portable).sessionsImported, 1);
  assert.equal(target.saveSettings(portable.settings).language, 'es', 'app restore applies included settings');
  assert.equal(target.getSettings().language, 'es');
  assert.equal(target.exportBackup().settings.language, 'es');

  const legacy = f.open('legacy');
  const oldBackup = {...json, settings: {theme: 'light'}};
  assert.equal(legacy.restoreBackupGames(oldBackup).sessionsImported, 1);
  assert.equal(legacy.saveSettings(oldBackup.settings).language, 'system');
  assert.equal(legacy.getSettings().theme, 'light');
});

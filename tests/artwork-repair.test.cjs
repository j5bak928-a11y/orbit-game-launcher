'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the real main-process repair functions with local image metadata.
// Native Electron setup, online downloads and process enumeration stay inactive.
function fixture(t, width, height, { missing = false, cover = crypto.randomUUID() + '.png' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-repair-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const art = path.join(root, 'artwork');
  fs.mkdirSync(art);
  if (!missing) {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    fs.writeFileSync(path.join(art, cover), bytes);
  }
  const game = {
    id: crypto.randomUUID(), name: 'Fixture game', source: 'steam', source_id: '123',
    cover, icon: crypto.randomUUID() + '.png', executable: '', install_path: '',
  };
  const database = {
    list: () => [{ ...game }], get: () => ({ ...game }),
    getSettings: () => ({ useSteamArtwork: true }),
    update: (_, patch) => Object.assign(game, patch),
  };
  const main = path.join(__dirname, '../src/main.cjs');
  const realRequire = createRequire(main);
  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      getPath: () => root,
      whenReady: () => new Promise(() => {}),
      on() {},
    },
    protocol: { registerSchemesAsPrivileged() {} },
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : realRequire(name),
    __dirname: path.dirname(main), process, Buffer, fixtureDb: database,
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, { filename: main });
  vm.runInContext('db = fixtureDb;', context);
  let downloads = 0;
  const replacement = crypto.randomUUID() + '.jpg';
  context.downloadSteamCover = async () => { downloads++; return replacement; };
  return { context, game, replacement, downloads: () => downloads };
}

test('repair replaces an existing landscape cover with a portrait candidate', async t => {
  const f = fixture(t, 1280, 720);
  const result = await f.context.repairMissingSteamCovers({ replaceLandscape: true });
  assert.equal(result.found, 1);
  assert.equal(f.downloads(), 1);
  assert.equal(f.game.cover, f.replacement);
});

test('repair restores an artwork token whose file is missing', async t => {
  const f = fixture(t, 600, 900, { missing: true });
  const result = await f.context.repairMissingSteamCovers({ replaceLandscape: true });
  assert.equal(result.found, 1);
  assert.equal(f.downloads(), 1);
  assert.equal(f.game.cover, f.replacement);
});

test('repair preserves an existing valid portrait without downloading a replacement', async t => {
  const f = fixture(t, 600, 900);
  const original = f.game.cover;
  const result = await f.context.repairMissingSteamCovers({ replaceLandscape: true });
  assert.equal(result.attempted, 0);
  assert.equal(f.downloads(), 0);
  assert.equal(f.game.cover, original);
});

test('portrait validation rejects artwork paths outside the cache', async t => {
  const f = fixture(t, 600, 900, { missing: true, cover: '../outside.png' });
  assert.equal(await f.context.coverNeedsPortrait(f.game), false);
  assert.equal(f.downloads(), 0);
});

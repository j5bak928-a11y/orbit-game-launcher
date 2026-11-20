'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LibraryDatabase} = require('../src/core/database.cjs');
const {trayMenuEntries} = require('../src/core/tray-menu.cjs');

test('tray uses real open sessions and limits separate favorites and recent groups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-tray-db-'));
  const db = new LibraryDatabase(path.join(dir, 'library.sqlite'));
  try {
    const add = name => db.upsert({name, executable: path.join(dir, name + '.exe')}).game;
    const playing = add('Pinned game');
    db.toggleFavorite(playing.id);
    const running = db.startSession(playing.id);
    const completedGame = add('Recent game');
    const completed = db.startSession(completedGame.id);
    assert.equal(db.finishSession(completed, 25), true);
    const untracked = db.startSession(add('Unowned session').id);
    for (let index = 0; index < 7; index++) db.toggleFavorite(add(`Favorite ${index}`).id);

    const result = db.getTrayGames([running, completed]);
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].id, playing.id);
    assert.ok(Number.isFinite(Date.parse(result.active[0].started_at)));
    assert.equal(result.favorites.length, 5);
    assert.ok(result.favorites.some(game => game.id === playing.id));
    assert.ok(result.recent.some(game => game.id === completedGame.id));
    assert.ok(result.recent.every(game => game.id !== playing.id));
    assert.equal(db.getTrayGames([]).active.length, 0, `unowned session should not be shown: ${untracked}`);
  } finally {
    db.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('tray status and launch entries stay localized and distinguish active games', () => {
  const game = {id: 'game', name: 'War & Peace', started_at: '2026-11-17T12:00:00.123Z'};
  const entries = trayMenuEntries({
    active: [game],
    favorites: [game],
    recent: [{id: 'other', name: 'Other game'}]
  }, 'system', 'nl-NL', new Set([game.id]));

  assert.equal(entries[0].label, 'Orbit openen');
  assert.match(entries[1].label, /^War && Peace · Speeltijd bijgehouden sinds .+/);
  assert.equal(entries[1].enabled, false);
  assert.deepEqual(entries[2].submenu, [{label: 'War && Peace', id: 'game', enabled: false}]);
  assert.deepEqual(entries[3].submenu, [{label: 'Other game', id: 'other', enabled: true}]);
  assert.equal(entries.at(-1).label, 'Orbit afsluiten');
});

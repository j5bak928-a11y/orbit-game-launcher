'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LibraryUpdates } = require('../src/ui/library-updates.js');
const game = (id, favorite=false) => ({ id, name:`Game ${id}`, favorite });
function fixture(options = {}) {
  const scheduled = [], changes = [], errors = [];
  let reads = 0;
  const updates = new LibraryUpdates({
    snapshot:{ games:[game('a'), game('b')], runningIds:[], revision:0 },
    loadSnapshot:async () => { reads++; return options.read ? options.read() : { games:[game('a',true), game('b')], revision:2 }; },
    onChange:change => changes.push(change), onError:error => errors.push(error),
    schedule:callback => scheduled.push(callback),
  });
  return { updates, scheduled, changes, errors, reads:() => reads };
}
test('one-game events coalesce without loading a full library and retain unaffected records', async () => {
  const f = fixture(), untouched = f.updates.snapshot().games[1];
  f.updates.receive({ games:[game('a',true)], revision:1 });
  f.updates.receive({ games:[{ ...game('a',true), name:'Edited' }], revision:2 });
  assert.equal(f.scheduled.length, 1);
  await f.scheduled.shift()();
  assert.equal(f.reads(), 0);
  assert.equal(f.changes.length, 1);
  assert.equal(f.updates.snapshot().games[0].name, 'Edited');
  assert.equal(f.updates.snapshot().games[1], untouched);
  assert.deepEqual(f.changes[0].changedIds, ['a']);
});
test('duplicate or stale packets do not repeat a render or overwrite newer data', async () => {
  const f = fixture();
  f.updates.receive({ games:[game('a',true)], revision:1 });
  await f.updates.flush();
  f.updates.receive({ games:[game('a')], revision:0 });
  f.updates.receive({ games:[game('a')], revision:1 });
  await f.updates.flush();
  assert.equal(f.changes.length, 1);
  assert.equal(f.updates.snapshot().games[0].favorite, true);
});
test('bulk invalidations share one authoritative versioned snapshot', async () => {
  const f = fixture();
  f.updates.receive({ revision:1 });
  f.updates.receive({ revision:2 });
  await f.updates.flush();
  assert.equal(f.reads(), 1);
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].reset, true);
});
test('a snapshot cannot lose a newer patch received while IPC is pending', async () => {
  let resolve;
  const f = fixture({ read:() => new Promise(done => { resolve=done; }) });
  f.updates.receive({ revision:1 });
  const flushing = f.updates.flush();
  f.updates.receive({ games:[{ ...game('b'), name:'After snapshot' }], revision:2 });
  resolve({ games:[game('a',true), game('b')], revision:1 });
  await flushing;
  assert.equal(f.reads(), 1);
  assert.equal(f.updates.snapshot().games[1].name, 'After snapshot');
  assert.equal(f.changes.length, 1);
});
test('events already covered by an in-flight snapshot cause no second reload', async () => {
  let resolve;
  const f = fixture({ read:() => new Promise(done => { resolve=done; }) });
  f.updates.receive({ revision:1 });
  const flushing = f.updates.flush();
  f.updates.receive({ revision:2 });
  resolve({ games:[game('a')], revision:2 });
  await flushing;
  assert.equal(f.reads(), 1);
  assert.equal(f.changes.length, 1);
});
test('legacy event bursts share one read and one change notification', async () => {
  const f = fixture({ read:() => ({ games:[game('a')], runningIds:[] }) });
  for (let i=0; i<25; i++) f.updates.receive({});
  await f.updates.flush();
  assert.equal(f.reads(), 1);
  assert.equal(f.changes.length, 1);
});
test('removals and additions merge in order without a snapshot', async () => {
  const f = fixture();
  f.updates.receive({ removedIds:['a'], revision:1 });
  f.updates.receive({ games:[game('c')], revision:2 });
  await f.updates.flush();
  assert.deepEqual(f.updates.snapshot().games.map(g=>g.id), ['b','c']);
  assert.deepEqual(f.changes[0].removedIds, ['a']);
  assert.equal(f.reads(), 0);
});
test('running-only updates preserve the games array and avoid a full query', async () => {
  const f = fixture(), original = f.updates.snapshot().games;
  f.updates.receive({ games:[], runningIds:['a'], revision:1 });
  await f.updates.flush();
  assert.equal(f.updates.snapshot().games, original);
  assert.deepEqual(f.updates.snapshot().runningIds, ['a']);
  assert.equal(f.reads(), 0);
});
test('a revision gap recovers from an authoritative snapshot', async () => {
  const f = fixture({ read:() => ({ games:[game('b',true)], revision:4 }) });
  f.updates.receive({ games:[game('b',true)], revision:4 });
  await f.updates.flush();
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.updates.snapshot().games, [game('b',true)]);
});
test('a failed snapshot reports once and retries only on a later event', async () => {
  let fail = true;
  const f = fixture({ read:() => { if(fail) throw Error('offline'); return {games:[game('a')],revision:2}; } });
  f.updates.receive({ revision:1 });
  await f.updates.flush();
  assert.equal(f.errors.length, 1);
  assert.equal(f.reads(), 1);
  fail = false;
  f.updates.receive({ revision:2 });
  await f.updates.flush();
  assert.equal(f.reads(), 2);
  assert.equal(f.updates.snapshot().revision, 2);
});

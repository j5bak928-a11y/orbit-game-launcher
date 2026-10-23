'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { LibraryDatabase } = require('../src/core/database.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-tracking-bench-'));
const db = new LibraryDatabase(path.join(root, 'library.sqlite'));
const legacy = process.argv.includes('--legacy');
try {
  const games = Array.from({ length: 5000 }, (_, i) => ({
    name: `Game ${String(i).padStart(5, '0')}`,
    source: ['manual', 'gog', 'steam', 'epic', 'steam'][i % 5],
    source_id: String(100000 + i),
    install_path: path.win32.join('D:\\Games', `Game ${i}`),
    tags: ['Strategy', 'Adventure', 'Single player', 'Fixture'],
    genre: 'Adventure', launch_args: ['--fixture'], favorite: i % 7 === 0,
  }));
  for (let i = 0; i < games.length; i += 50) db.upsertBatch(games.slice(i, i + 50));
  const query = legacy ? () => db.list() : () => db.listActivityGames();
  for (let i = 0; i < 5; i++) query();
  const samplesMs = [];
  let rows;
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    rows = query();
    samplesMs.push(performance.now() - start);
  }
  const trackable = rows.filter(g => ['steam', 'epic'].includes(g.source) && g.install_path);
  assert.equal(trackable.length, 3000);
  if (!legacy) {
    assert.equal(rows.length, 3000);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'install_path', 'source']);
  }
  const sorted = samplesMs.slice().sort((a, b) => a - b);
  const result = {
    node: process.version, platform: process.platform, mode: legacy ? 'full-library' : 'tracking-projection',
    libraryGames: 5000, returnedGames: rows.length, trackableGames: trackable.length,
    fieldsPerGame: Object.keys(rows[0]).length, samples: 30,
    p50Ms: +sorted[14].toFixed(3), p95Ms: +sorted[28].toFixed(3), maxMs: +sorted[29].toFixed(3),
    samplesMs: samplesMs.map(n => +n.toFixed(3)),
    note: 'Synthetic SQLite query and row materialization only; no PowerShell, IPC or native Electron.',
  };
  const output = JSON.stringify(result, null, 2) + '\n';
  const destination = process.argv.slice(2).find(s => s.endsWith('.json'));
  if (destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, output);
  }
  process.stdout.write(output);
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

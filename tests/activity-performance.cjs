'use strict';
// Informational benchmark of matching only: no real process enumeration or games.
// Run from the repository root. Arguments: output JSON path, optional baseline module path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const implementation = process.argv[3] ? path.resolve(process.argv[3]) : '../src/core/windows-activity.cjs';
const { matchRunningGames } = require(implementation);
const SAMPLE_COUNT = 30;

function fixture(gameCount, processCount) {
  const games = Array.from({ length: gameCount }, (_, i) => ({
    id: 'game-' + i,
    source: i % 2 ? 'epic' : 'steam',
    install_path: 'D:\\Orbit Bench\\Game ' + i,
  }));
  const expected = new Set();
  const executables = Array.from({ length: processCount }, (_, i) => {
    if (i % 5 === 0) {
      const index = i % gameCount;
      expected.add('game-' + index);
      return 'd:\\ORBIT BENCH\\Game ' + index + '\\Binaries\\Win64\\Game.exe';
    }
    return 'C:\\Other Programs\\App ' + i + '\\App.exe';
  });
  // These must neither create a match nor suppress a real one.
  executables.push('D:\\Orbit Bench\\Game 1\\unins000.exe');
  executables.push('D:\\Orbit Bench\\Game 2 sibling\\Game.exe');
  return { games, executables, expected: games.filter(g => expected.has(g.id)).map(g => g.id) };
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function measure(gameCount, processCount) {
  const data = fixture(gameCount, processCount);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(matchRunningGames(data.games, data.executables), data.expected);
  }
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const samplesMs = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const start = performance.now();
    const actual = matchRunningGames(data.games, data.executables);
    samplesMs.push(performance.now() - start);
    assert.deepEqual(actual, data.expected);
  }
  global.gc?.();
  const memory = process.memoryUsage();
  const sorted = samplesMs.slice().sort((a, b) => a - b);
  const round = value => +value.toFixed(3);
  return {
    games: gameCount,
    processes: data.executables.length,
    matches: data.expected.length,
    samples: SAMPLE_COUNT,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
    rssMiB: round(memory.rss / 1024 / 1024),
    retainedHeapDeltaKiB: round((memory.heapUsed - heapBefore) / 1024),
    samplesMs: samplesMs.map(round),
  };
}

const result = {
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  note: 'Synthetic matching only; excludes SQLite reads, PowerShell enumeration, Electron IPC and rendering. P99 is the maximum of only 30 samples. This is not a leak test.',
  scenarios: [[100, 200], [5000, 1000], [5000, 10000]].map(([games, processes]) => measure(games, processes)),
};
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2]) {
  fs.mkdirSync(path.dirname(process.argv[2]), { recursive: true });
  fs.writeFileSync(process.argv[2], output);
}
process.stdout.write(output);

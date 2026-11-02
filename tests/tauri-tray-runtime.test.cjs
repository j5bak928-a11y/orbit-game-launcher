'use strict';

// Windows native integration probes. These assert real Win32 process/window
// state; source-text/regex checks cannot prove WebView2 was actually destroyed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn,spawnSync} = require('node:child_process');

const windows = process.platform === 'win32';
const scripts = path.join(__dirname, 'windows');
function powershell(script, args, timeout = 30_000) {
  return spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scripts, script), ...args
  ], {encoding:'utf8', timeout, windowsHide:true});
}
function jsonResult(result) {
  assert.equal(result.error, undefined, String(result.error || ''));
  assert.equal(result.status, 0, (result.stderr || '') + '\n' + (result.stdout || ''));
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  return JSON.parse(output);
}

test('Windows process-tree probe includes the real root process and bounded samples', {skip:!windows}, () => {
  const result = jsonResult(powershell('orbit-process-metrics.ps1', [
    '-ProcessId', String(process.pid), '-Samples', '2', '-IntervalMs', '100'
  ]));
  assert.equal(result.schema, 'orbit.process-tree.v1');
  assert.equal(result.rootPid, process.pid);
  assert.equal(result.samples.length, 2);
  for(const sample of result.samples) {
    assert.equal(sample.rootPid, process.pid);
    assert.ok(sample.processCount >= 1);
    assert.ok(sample.workingSetMiB > 0);
    assert.ok(sample.privateMiB > 0);
    assert.ok(sample.processes.some(p => p.pid === process.pid && p.name.toLowerCase() === 'node.exe'));
    const workingSum = sample.processes.reduce((acc, p) => acc + p.workingSetBytes, 0) / 1048576;
    assert.ok(Math.abs(workingSum - sample.workingSetMiB) < 0.02,
      'reported tree working set must equal the constituent real OS process values');
  }
  assert.match(result.note, /overlap|deduplicated/i);
});

test('Process-tree probe includes a real child process rather than root RSS alone', {
  skip:!windows
}, async () => {
  // Only this test-owned helper is terminated. Never attach to or kill the
  // user's Orbit process from the metrics test.
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    windowsHide:true, stdio:'ignore'
  });
  try {
    await new Promise((resolve, reject) => {
      helper.once('spawn', resolve);
      helper.once('error', reject);
    });
    const result = jsonResult(powershell('orbit-process-metrics.ps1', [
      '-ProcessId', String(process.pid), '-Samples', '1'
    ]));
    const row = result.samples[0].processes.find(p => p.pid === helper.pid);
    assert.ok(row, 'actual spawned child PID must be in sampled process tree');
    assert.equal(row.parentPid, process.pid);
    assert.ok(row.workingSetBytes > 0);
    assert.ok(result.samples[0].workingSetMiB >= row.workingSetBytes / 1048576);
  } finally {
    if(helper.pid) helper.kill();
  }
});

test('Process-tree sampling rejects a nonexistent PID', {skip:!windows}, () => {
  const result = powershell('orbit-process-metrics.ps1', [
    '-ProcessId', '2147483647', '-Samples', '1'
  ]);
  assert.notEqual(result.status, 0, 'absent PID must fail rather than report zero RAM');
  assert.match(result.stderr + result.stdout, /not running|not found/i);
});

test('Native lifecycle probe refuses to close an unrelated Node process', {skip:!windows}, () => {
  const result = powershell('tauri-tray-runtime.ps1', [
    '-ProcessId', String(process.pid), '-AllowWindowClose'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Refusing PID.*orbit-launcher\.exe/i);
  assert.ok(process.pid > 0, 'the caller must still be alive');
});

test('Native lifecycle Win32 interop compiles and enumerates real HWNDs safely', {
  skip:!windows
}, () => {
  const result = jsonResult(powershell('tauri-tray-runtime.ps1', [
    '-ProcessId', String(process.pid), '-InteropSmoke'
  ]));
  assert.equal(result.schema, 'orbit.tray-interop.v1');
  assert.equal(result.rootPid, process.pid);
  assert.equal(result.enumerated, true);
  assert.ok(result.windowCount >= 0);
});

const livePid = Number(process.env.ORBIT_TAURI_E2E_PID);
const liveEnabled = windows &&
  Number.isSafeInteger(livePid) && livePid > 0 &&
  process.env.ORBIT_TAURI_ALLOW_CLOSE === 'yes';
test('LIVE Tauri close destroys HWND, Rust PID survives, optional tray Open recreates HWND', {
  skip:liveEnabled ? false :
    'requires ORBIT_TAURI_E2E_PID=<running preview pid> and ORBIT_TAURI_ALLOW_CLOSE=yes'
}, () => {
  const args = ['-ProcessId', String(livePid), '-AllowWindowClose', '-TimeoutSeconds', '30'];
  const restore = process.env.ORBIT_TAURI_E2E_RESTORE === 'yes';
  if(restore) process.stdout.write('Operator: after the Orbit window closes, select Open Orbit from its real tray icon.\n');
  if(restore) args.push('-VerifyTrayRestore');
  const result = jsonResult(powershell('tauri-tray-runtime.ps1', args, restore ? 65_000 : 40_000));
  assert.equal(result.schema, 'orbit.tray-lifecycle.v1');
  assert.equal(result.rootPid, livePid);
  assert.equal(result.oldHwndDestroyed, true);
  assert.equal(result.processSurvivedClose, true);
  if(restore) {
    assert.equal(result.restored, true);
    assert.notEqual(result.newHwnd, result.oldHwnd);
  }
});

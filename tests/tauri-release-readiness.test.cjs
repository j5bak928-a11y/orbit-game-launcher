'use strict';

// Deterministic release-contract gates, plus optional read-only real-backup
// inspection. These are *not* a substitute for installer/tray/device tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {gunzipSync, gzipSync} = require('node:zlib');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

function decodePortableBackup(bytes) {
  return JSON.parse(gunzipSync(bytes).toString('utf8'));
}

function releaseConfigProblems(config, caps, packageJson, lockJson) {
  const problems = [];
  const version = read('src-tauri/Cargo.toml').match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version || config.version !== version || packageJson.version !== version) {
    problems.push('Tauri, Cargo and package.json versions differ');
  }
  if (lockJson.version !== version || lockJson.packages?.['']?.version !== version) {
    problems.push('package-lock.json version differs');
  }
  if (config.identifier !== 'com.orbitlauncher.desktop') problems.push('App identifier changed');
  if (config.productName !== 'Orbit Launcher') problems.push('Product name must remain Orbit Launcher');
  if (config.bundle?.active !== true ||
      JSON.stringify([...(config.bundle.targets || [])].sort()) !== JSON.stringify(['msi','nsis'])) {
    problems.push('Unsigned release targets must remain limited to NSIS/MSI');
  }
  if (config.build?.frontendDist !== '../tauri-web' ||
      config.app?.withGlobalTauri !== true) problems.push('Local Tauri renderer configuration changed');
  const windows = config.app?.windows || [];
  if (windows.length !== 1 || (windows[0].label || 'main') !== 'main' ||
      windows[0].visible !== true ||
      windows.some(w => typeof w.url === 'string' && /^https?:/i.test(w.url))) {
    problems.push('Expected one locally packaged main window');
  }
  if (caps.identifier !== 'default' || JSON.stringify(caps.windows) !== '["main"]' ||
      caps.remote != null) {
    problems.push('IPC capability is not restricted to main');
  }
  const csp = config.app?.security?.csp;
  if (typeof csp !== 'string' || !csp.includes("default-src 'self'") || !csp.includes("object-src 'none'")) {
    problems.push('Missing restrictive Tauri-level CSP');
  }
  if (config.bundle?.createUpdaterArtifacts) {
    problems.push('Updater artifact bundling must not be enabled in base tauri.conf.json');
  }
  if (JSON.stringify(caps.permissions) !== '["core:default"]') {
    problems.push('Unexpected privileged Tauri capability');
  }
  const updater = config.plugins?.updater;
  if (!updater || typeof updater !== 'object') {
    problems.push('Missing updater configuration in tauri.conf.json');
  } else {
    if (typeof updater.pubkey !== 'string' || updater.pubkey.trim().length <= 40) {
      problems.push('Invalid updater public key');
    }
    if (!Array.isArray(updater.endpoints) || !updater.endpoints.length ||
        updater.endpoints.some(url => typeof url !== 'string' || !url.startsWith('https://') || !url.endsWith('/releases/latest/download/latest.json'))) {
      problems.push('Updater endpoints must use HTTPS GitHub Releases latest.json');
    }
    if (updater.dangerousInsecureTransportProtocol === true) {
      problems.push('Insecure updater transport protocol must not be enabled');
    }
    if (updater.windows?.installMode !== 'passive') {
      problems.push('Windows updater installMode must remain passive');
    }
  }
  if (config.plugins?.shell || config.bundle?.publisher) {
    problems.push('Unexpected shell/publisher configuration');
  }
  if (packageJson.devDependencies?.electron || packageJson.devDependencies?.['electron-builder'] || packageJson.build) {
    problems.push('Legacy Electron packaging dependencies remain in package.json');
  }
  return problems;
}

test('Rust desktop installer has Orbit Launcher identity, matching versions, local window and signed updater config', () => {
  assert.deepEqual(releaseConfigProblems(tauri, capability, pkg, lock), []);
});

test('release-contract validator rejects identifier drift, legacy Electron deps, and unsafe updater/remote access', () => {
  const promoted = structuredClone(tauri);
  const caps = structuredClone(capability);
  const badPkg = structuredClone(pkg);
  promoted.identifier = 'com.example.other';
  promoted.productName = 'Renamed';
  promoted.bundle.targets = ['nsis', 'msi', 'updater'];
  promoted.bundle.createUpdaterArtifacts = true;
  promoted.app.windows[0].url = 'https://untrusted.invalid/orbit';
  promoted.app.security = {csp: null};
  promoted.plugins = {
    updater: {
      pubkey: '',
      endpoints: ['http://untrusted.invalid/latest.json'],
      dangerousInsecureTransportProtocol: true,
      windows: {installMode: 'basicUi'},
    },
    shell: {},
  };
  badPkg.devDependencies = {electron: '45.0.0'};
  caps.windows = ['*'];
  caps.permissions.push('updater:default');
  const problems = releaseConfigProblems(promoted, caps, badPkg, lock);
  assert.ok(problems.some(message => /identifier/i.test(message)));
  assert.ok(problems.some(message => /product name/i.test(message)));
  assert.ok(problems.some(message => /targets/i.test(message)));
  assert.ok(problems.some(message => /artifact bundling/i.test(message)));
  assert.ok(problems.some(message => /window/i.test(message)));
  assert.ok(problems.some(message => /capability/i.test(message)));
  assert.ok(problems.some(message => /csp/i.test(message)));
  assert.ok(problems.some(message => /privileged/i.test(message)));
  assert.ok(problems.some(message => /public key/i.test(message)));
  assert.ok(problems.some(message => /endpoints/i.test(message)));
  assert.ok(problems.some(message => /insecure/i.test(message)));
  assert.ok(problems.some(message => /installMode/i.test(message)));
  assert.ok(problems.some(message => /shell\/publisher/i.test(message)));
  assert.ok(problems.some(message => /electron/i.test(message)));
});

test('source integration contract wires signed in-app updater safely behind Rust IPC', () => {
  const cargo = read('src-tauri/Cargo.toml');
  assert.match(cargo, /tauri-plugin-updater[\s\S]*rustls-tls/);
  assert.doesNotMatch(cargo, /tauri-plugin-shell/);

  const src = read('src-tauri/src/lib.rs');
  assert.match(src, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(src, /updates::UpdateManager/);
  assert.match(src, /updates::maybe_start_background_check/);

  const getStatus = src.slice(src.indexOf('"getUpdateStatus" =>'), src.indexOf('"findOnlineCover" =>'));
  assert.match(getStatus, /"getUpdateStatus"\s*=>\s*Ok\(updates::current_status\(app\)\)/);
  assert.match(getStatus, /"checkForUpdates"\s*=>\s*Ok\(updates::start_check\(app\)\)/);
  assert.match(getStatus, /"installUpdate"\s*=>\s*updates::install_prepared\(app\)/);

  const updatesSrc = read('src-tauri/src/updates.rs');
  assert.match(updatesSrc, /crate::has_busy_game/);
  assert.match(updatesSrc, /crate::settle_sessions/);
  assert.match(updatesSrc, /crate::tray::set_quitting/);
  assert.match(updatesSrc, /prepared\.update\.verify\(&prepared\.bytes\)/);
  assert.match(updatesSrc, /prepared\.update\.install\(&prepared\.bytes\)/);
  assert.doesNotMatch(updatesSrc, /download_and_install/);
});

test('Tauri first-run migration must snapshot read-only prior Rust Preview or legacy Electron SQLite', () => {
  const src = read('src-tauri/src/lib.rs');
  assert.match(src, /"com\.orbitlauncher\.rustpreview"/);
  assert.match(src, /"orbit-game-launcher"/);
  assert.match(src, /"Orbit Launcher"/);
  const migrate = src.slice(src.indexOf('fn import_legacy_library('), src.indexOf('fn valid_art_name('));
  assert.match(migrate, /if old == destination/);
  assert.match(migrate, /if target_db\.exists\(\)\s*\{/);
  assert.match(migrate, /metadata\.len\(\) == 0/);
  assert.match(migrate, /return Ok\(\(\)\);/);
  assert.match(migrate, /SQLITE_OPEN_READ_ONLY/);
  assert.match(migrate, /VACUUM INTO \?1/);
  assert.match(migrate, /temp_db/);
  assert.match(migrate, /std::fs::rename\(&temp_db, &target_db\)/);
  assert.doesNotMatch(migrate, /(?:remove_file|rename)\(\s*&?old/);
  const setup = src.slice(src.indexOf('.setup(move |app|'), src.indexOf('.invoke_handler('));
  assert.ok(setup.indexOf('import_legacy_library(&data_dir)') <
    setup.indexOf('LibraryDatabase::open(&data_dir.join("library.sqlite"))'));
});

test('export/restore dialog cancellation occurs before any file or database mutation', () => {
  const src = read('src-tauri/src/lib.rs');
  const exportFlow = src.slice(src.indexOf('"exportLibrary" =>'), src.indexOf('"restoreLibrary" =>'));
  const restoreFlow = src.slice(src.indexOf('"restoreLibrary" =>'), src.indexOf('_ => Err(format!', src.indexOf('"restoreLibrary" =>')));
  const cancel = 'return Ok(Value::Null)';
  assert.ok(exportFlow.indexOf('.blocking_save_file()') >= 0);
  assert.ok(exportFlow.indexOf(cancel) > exportFlow.indexOf('.blocking_save_file()'));
  for (const operation of ['write_json_backup(', 'backup::export_backup(']) {
    assert.ok(exportFlow.indexOf(cancel) < exportFlow.indexOf(operation));
  }
  assert.ok(restoreFlow.indexOf('choose_file(app, &["orbit", "json"])') >= 0);
  assert.ok(restoreFlow.indexOf(cancel) > restoreFlow.indexOf('choose_file('));
  for (const operation of ['backup::import_backup_checked_staged(', 'db.restore_json(']) {
    assert.ok(restoreFlow.indexOf(cancel) < restoreFlow.indexOf(operation));
  }
  assert.match(restoreFlow, /staged\.finish\(restore, live_artwork\.as_ref\(\)\)/,
    'portable artwork cleanup must remain tied to the eventual database restore');
  assert.match(src.slice(src.indexOf('fn write_json_backup('), src.indexOf('fn argument(', src.indexOf('fn write_json_backup(')) > 0 ? src.indexOf('fn argument(', src.indexOf('fn write_json_backup(')) : src.length), /create_new\(true\)/);
});

test('portable backup format contract in Rust covers envelope headers, artwork fields, and bounded gunzip', () => {
  const names = ['png', 'jpg', 'webp'].map(ext => crypto.randomUUID() + '.' + ext);
  const library = {
    format:'orbit.library.v1', settings:{theme:'dark'},
    games:[{id:crypto.randomUUID(), name:'Offline Fixture', cover:names[0],
      banner:names[1], icon:names[2], total_play_seconds:1234}]
  };
  const payload = gzipSync(Buffer.from(JSON.stringify({
    format:'orbit.portable.v1',
    library,
    artwork:Object.fromEntries(names.map(name => [name, 'AAAA']))
  })));
  const decoded = decodePortableBackup(payload);
  assert.equal(decoded.format, 'orbit.portable.v1');
  assert.deepEqual(decoded.library, library);
  assert.deepEqual(Object.keys(decoded.artwork).sort(), [...names].sort());
  const rust = read('src-tauri/src/backup.rs');
  assert.match(rust, /const PORTABLE_FORMAT: &str = "orbit\.portable\.v1"/);
  assert.match(rust, /const LIBRARY_FORMAT: &str = "orbit\.library\.v1"/);
  assert.match(rust, /const ARTWORK_FIELDS: \[&str; 3\] = \["cover", "banner", "icon"\]/);
  assert.match(rust, /const MAX_ARCHIVE: u64 = 128 \* 1024 \* 1024/);
  assert.match(rust, /const MAX_UNCOMPRESSED: u64 = 192 \* 1024 \* 1024/);
  assert.match(rust, /fn gunzip_limited\(/);
});

test('optional existing backup inspection is strictly read-only and fails closed on malformed archives', {
  skip:!process.env.ORBIT_TAURI_READONLY_BACKUP
}, () => {
  const file = path.resolve(process.env.ORBIT_TAURI_READONLY_BACKUP);
  const before = fs.statSync(file);
  assert.ok(before.isFile() && before.size > 0 && before.size <= 128 * 1024 * 1024);
  const data = fs.readFileSync(file);
  if (file.toLowerCase().endsWith('.orbit')) {
    const backup = decodePortableBackup(data);
    assert.ok(Array.isArray(backup.library.games));
    assert.equal(backup.library.format, 'orbit.library.v1');
  } else if (file.toLowerCase().endsWith('.json')) {
    const library = JSON.parse(data.toString('utf8'));
    assert.equal(library.format, 'orbit.library.v1');
    assert.ok(Array.isArray(library.games));
  } else {
    assert.fail('Only .orbit or .json backup inspection is supported');
  }
  const after = fs.statSync(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('Windows read-only release checker examines a synthetic SQLite header without modifying it', {
  skip:process.platform !== 'win32'
}, t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-release-probe-'));
  t.after(() => fs.rmSync(tempDir, {recursive:true,force:true}));
  const db = path.join(tempDir, 'fixture.sqlite');
  const header = Buffer.alloc(100);
  header.write('SQLite format 3\u0000', 0, 'binary');
  fs.writeFileSync(db, header);
  const before = crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows', 'tauri-release-readonly.ps1'),
    '-LegacyDbPath', db], {encoding:'utf8', windowsHide:true, timeout:15000});
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(report.schema, 'orbit.release-readonly.v1');
  assert.equal(report.database.validHeader, true);
  assert.equal(report.database.readOnly, true);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex'), before);
});

test('Windows release inspector flags an unsigned synthetic artifact without running it or changing backup bytes', {
  skip:process.platform !== 'win32'
}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-signature-probe-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const binary = path.join(dir, 'unsigned-fixture.exe');
  const backup = path.join(dir, 'fixture.orbit');
  fs.writeFileSync(binary, Buffer.from('not a signed Windows executable'));
  fs.writeFileSync(backup, gzipSync(Buffer.from(JSON.stringify({
    format:'orbit.portable.v1',
    library:{format:'orbit.library.v1', settings:{}, games:[]},
    artwork:{}
  }))));
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const expectedBinary = digest(binary);
  const expectedBackup = digest(backup);
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows', 'tauri-release-readonly.ps1'),
    '-ArtifactPath', binary, '-BackupPath', backup], {encoding:'utf8', windowsHide:true, timeout:15000});
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(report.schema, 'orbit.release-readonly.v1');
  assert.equal(report.artifact.signed, false);
  assert.equal(report.artifact.publisherVerified, false);
  assert.equal(typeof report.artifact.signatureChecked, 'boolean');
  if(!report.artifact.signatureChecked)assert.equal(report.artifact.signatureStatus, 'Unavailable');
  assert.equal(report.artifact.sha256, expectedBinary);
  assert.equal(report.backup.expectedHeader, true);
  assert.equal(report.mutatingActions, 0);
  assert.equal(digest(binary), expectedBinary);
  assert.equal(digest(backup), expectedBackup);
});

test('Windows release inspector reports invalid SQLite and invalid backup header instead of claiming success', {
  skip:process.platform !== 'win32'
}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-bad-artifacts-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const db = path.join(dir, 'invalid.sqlite');
  const backup = path.join(dir, 'invalid.orbit');
  fs.writeFileSync(db, Buffer.from('not a SQLite database'));
  fs.writeFileSync(backup, Buffer.from('not a gzip archive'));
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows', 'tauri-release-readonly.ps1'),
    '-LegacyDbPath', db, '-BackupPath', backup], {encoding:'utf8', windowsHide:true, timeout:15000});
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(report.database.validHeader, false);
  assert.equal(report.backup.expectedHeader, false);
  assert.equal(report.mutatingActions, 0);
});

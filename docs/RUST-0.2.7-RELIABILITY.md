# Orbit Rust 0.2.7 — history-preserving reliability update

**Status:** development/unsigned preview. This document describes the source
contract and isolated verification; it is **not** approval to remove Electron,
delete old profiles, or enable automatic unsigned updates.

## Backup contract

Both Rust and Electron now export the existing `orbit.library.v1` JSON library
with an **optional `sessions` array**. Each completed session has the original
`id`, `game_id`, `started_at`, `finished_at`, and `seconds`. The outer `.orbit`
format stays `orbit.portable.v1` (gzip JSON plus referenced local artwork).
JSON exports include history but not image bytes.

- Exports refuse unfinished sessions, invalid timestamps/IDs, unknown games,
  and more than 100,000 session rows rather than quietly dropping history.
- Import validates history and references before database writes. With history
  present, game and session inserts are transactional, and conflicting session
  IDs or ambiguous game mappings abort the restore without partial credit.
- Repeated restore skips the same completed-session IDs. Sessions do **not**
  increment a game's stored aggregate playtime, because that aggregate may
  already account for them; newly created games retain their exported total.
- A session's `finished_at` may equal `started_at` for a legitimate zero-second
  record. Negative intervals, invalid/oversized playtime and unfinished rows
  cannot be imported as completed history.
- Older `orbit.library.v1` and `.orbit` archives **without** `sessions` still
  restore their games and aggregate counters. Missing old history cannot be
  inferred accurately and is not fabricated.
- Portable imports validate embedded history and artwork before writing files.
  The Rust handler also runs rollback-only database identity/session preflight
  **before** installing artwork, preventing rejected restores from leaving
  unintended image files behind. Existing local artwork is not overwritten.
- JSON exports that exceed the 128 MB restore limit fail rather than creating
  files that Orbit itself cannot later import.

## Database migration and recovery

On first Rust launch with no Rust database, Orbit snapshots the legacy Electron
database using SQLite `VACUUM INTO` through a **read-only** connection. This
captures committed WAL data and existing session rows. Electron files remain
untouched. A nonempty existing Rust database is not silently replaced or
re-synchronized when Electron changes later.

Before opening/migrating an existing Rust profile for 0.2.7, Orbit makes a
**one-time** consistent `library.before-rust-0.2.7.sqlite` backup alongside
`library.sqlite`. It refuses to claim that an empty, unsafe, or unrelated
SQLite file is a valid backup. It never overwrites the backup. The lightweight
startup check verifies the header and required Orbit tables; it does not
replace a full offline `PRAGMA integrity_check` or an independent backup.

Artwork migration is bounded and never overwrites conflicting local images;
it uses complete temporary files and retries safely. Failures leave the
Electron library untouched and refuse to finalize an incomplete import.

## Isolated automated verification

Run from the repository root, without using any installed application profile:

```powershell
npm run check
npm test
npm run lint
node --test tests/session-backup.test.cjs tests/tauri-release-readiness.test.cjs
npm run tauri:stage
cargo +stable-x86_64-pc-windows-msvc test --locked --lib --manifest-path src-tauri/Cargo.toml
```

The new cases exercise cross-edition JSON/portable backup parsing, actual
Electron IPC export/restore, duplicate and corrupt sessions, repeated imports,
live and failed recovery, WAL snapshots, missing/artwork collisions, stale
existing databases and a safe pre-upgrade copy. They operate on disposable
SQLite fixtures and never overwrite installed Orbit data.

For an optional local unsigned **build only** (requires GNU-LLVM Windows
toolchain, Node/npm and 7-Zip), use:

```powershell
powershell -NoProfile -NonInteractive -File scripts/windows/build-tauri-local-unsigned.ps1
```

The script generates NSIS/MSI installers and a portable ZIP with SHA-256
manifest, and verifies bundled WebView2/LLVM runtime DLLs. It does not install
or launch Orbit. Paid GitHub Actions and signing are not required.

## Still required before retiring Electron

- Real Windows 0.2.6 → 0.2.7 installer upgrade/uninstall in a disposable user
  profile, checking that the existing library and artwork are preserved.
- Native dialog cancellation and repeated `.orbit`/JSON export+restore against
  a live-running **isolated** Rust build, including a game played between runs.
- Several tray close/reopen cycles while live game tracking continues, plus
  sleep/resume, launch failures, controller focus and native process metrics.
- Confirmed Electron/Rust source parity on representative actual storefront
  installations and independent store IDs sharing an executable.

**Do not** uninstall Electron, delete profiles, disable raw SQLite backups,
or turn on automatic unsigned updates based on these fixture tests alone.

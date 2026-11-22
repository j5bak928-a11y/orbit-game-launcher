# Orbit Launcher native Rust / Tauri architecture

> **Update (v0.3.4):** The legacy Electron edition has been removed from this repository. Orbit Launcher now ships solely as the native Rust + Tauri 2 desktop application (`Orbit Launcher`, `com.orbitlauncher.desktop`). On first launch with an empty `com.orbitlauncher.desktop` profile, Orbit automatically imports from `com.orbitlauncher.rustpreview` first (or legacy Electron `orbit-game-launcher` / `Orbit Launcher` directories) via read-only `VACUUM INTO`.

Below is the historical migration and benchmark context leading up to retiring Electron in `0.3.4`:

## Why migrate to Rust?

Orbit needs to stay useful while games are running. Rust gives the Windows process tracker, SQLite library, artwork cache, backups and game-launch paths a native backend without requiring the full Electron/Node.js runtime for those tasks. Tauri retains the existing accessible frontend, allowing a gradual migration while the Electron build stays usable.

The aim is lower background overhead, faster library operations and predictable Windows process tracking — not an unsupported claim that the entire desktop application uses a particular amount of memory. The measured database speed and working-set improvements are documented below.

## Build on Windows

Install Node.js 22+, Rust stable with the MSVC target, Windows WebView2, Visual Studio C++ build tools and the Windows SDK. From the repository root:

```powershell
npm ci
npm run tauri:stage
npm run tauri:dev
```

Create a distributable Windows build using `npm run tauri:build`. It produces a Windows NSIS installer and MSI in `src-tauri/target/release/bundle/`. On systems without the native MSVC linker, use the **Verify Orbit Rust / Tauri desktop** GitHub workflow to compile and test. The previous Electron release is still built through `npm run dist:win`.

## Existing libraries and artwork

The new Rust edition uses its own Tauri application data folder. On its first launch, if that database does not exist and `%APPDATA%/orbit-game-launcher/library.sqlite` (or `%APPDATA%/Orbit Launcher/library.sqlite`) exists, the app creates a consistent SQLite snapshot using `VACUUM INTO`, then copies compatible cached artwork. It never deletes or rewrites the Electron database during import. Existing import, backup and database data formats remain `orbit.library.v1` and `orbit.portable.v1`.

Storefront detection is read-only and bounded. Game executables are launched directly with validated absolute paths and individual arguments. The Rust Windows tracker checks running processes against known install paths, and periodically records sessions. The first preview must be validated against real Steam/Epic/GOG installs before any release.

## Verified Windows preview

The GitHub Actions workflow [Verify Orbit Rust / Tauri desktop](https://github.com/j5bak928-a11y/orbit-game-launcher/actions/workflows/tauri-windows.yml) compiled the Rust backend, passed its native Rust unit tests and the frontend adapter tests, produced both NSIS and MSI installers plus a portable EXE, and saved a same-runner benchmark comparison. The JavaScript CI and browser regressions also passed. Download build and benchmark artifacts from the successful workflow run; installers are unsigned.

On a local Windows machine, the downloaded portable `orbit-launcher.exe` opened the expected Overview UI with an empty test library. The window was captured after startup, and closing it left the main process running in the tray as designed. The observed *parent process* working set was approximately 39 MB after 5 seconds, excluding the WebView2 child processes. This value is **not** the complete application's RAM usage or a cross-app speed comparison.

### Same-runner SQLite benchmark (5,000 games; median of three runs)

| Operation | Node.js + existing SQLite implementation | Rust + rusqlite | Relative improvement |
| --- | ---: | ---: | ---: |
| Insert 5,000 games | 5,169.4 ms | 3,108.0 ms | 39.9% less time |
| List 5,000 games | 65.3 ms | 35.7 ms | 45.3% less time |
| Look up 100 games | 4.5 ms | 2.5 ms | 44.4% less time |
| Process working set | 87.6 MiB | 30.3 MiB | 65.4% less memory |

The benchmark includes Node/V8 versus native-runtime overhead in memory results and intentionally excludes the UI and Electron/WebView2. The performance advantage of the **whole application** is not established by these figures.

### User-tested RAM: before Rust, with a game running, and idle

The maintainer reports the following hands-on observations:

| Version / state | Observed RAM |
| --- | ---: |
| Electron version, before switching to Rust (workload not specified) | Approximately **300 MB** |
| Rust/Tauri preview, with a game running | Approximately **5 MB** |
| Rust/Tauri preview, with no game running | Approximately **5 MB** |

These are the maintainer's reported figures, distinct from the reproducible CI benchmark above. The exact memory counter, capture procedure, Electron workload and whether WebView2 child processes were included were not recorded. **The 300 MB versus 5 MB readings are not independently verified as like-for-like whole-application memory use**, so no app-wide percentage reduction is inferred from them.

An earlier isolated empty-library Windows smoke recorded approximately 39 MB for the Tauri **parent process** after five seconds. Different memory counters, workload states and inclusion/exclusion of WebView2 processes can produce different readings; these measurements must not be substituted for a same-machine full-process-tree comparison.

### Remaining release verification

1. On Windows with a real installed library, verify first-run migration, artwork, game discovery, manual game addition, updates, launch, playtime, controller mode, portable backup export and restore.
2. Measure complete process-tree RSS (including Electron/WebView2 children), CPU and cold startup for both variants on the same computer, and compare installer sizes.
3. Review signing/distribution and test safe exit via the tray. PR #19 was merged as an isolated preview, but do not promote it to a production replacement until manual behavior parity is established.

Native Steam artwork search and repair are supported through the Rust backend when the user enables online artwork in Settings, subject to request limits and Performance Guard. Automatic update installation remains disabled in the unsigned Rust preview; the interface reports an unsupported status. Do not distribute the Rust preview as a production replacement until the above checks succeed.

## Release-readiness contract (2026-11-05; still experimental)

The native shell is **not approved to replace Electron** solely because Rust builds or the preview installer starts. The review covers changes to game discovery, artwork, cinematic UI, statistics and Rust desktop parity. Release decisions must distinguish automated source-contract checks from **runtime proof on Windows**.

Run the non-destructive automated gates from the repository root:

~~~powershell
node --test tests/tauri-release-readiness.test.cjs tests/tauri-tray-runtime.test.cjs
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm test
~~~

The first command validates the *current* preview package identity, bundled frontend and restricted main-window capabilities; tests the Electron portable-backup encoder with synthetic artwork; checks key Rust cancellation/migration/update contracts; and exercises native Windows read-only inspection on a temporary test-owned SQLite fixture. These tests **do not** install packages, open a real library in write mode, or prove that Tauri's file dialogs or installer work on the user's computer. The optional live tray test is disabled unless explicitly opted in as described in [Windows tray verification](VERIFICATION-TAURI-TRAY-WEBVIEW.md).

For a real artifact, database **header** or existing backup, an operator can run the read-only inspection:

~~~powershell
powershell -NoProfile -File tests/windows/tauri-release-readonly.ps1 -ArtifactPath 'C:\Review\Orbit Launcher Rust Preview_0.2.6_x64-setup.exe'
powershell -NoProfile -File tests/windows/tauri-release-readonly.ps1 -LegacyDbPath 'C:\Review\library.sqlite' -BackupPath 'C:\Review\collection.orbit'
~~~

The inspector never launches or installs an executable, never modifies SQLite, and never restores a backup. It reports SHA-256 and Authenticode status for a supplied installer/EXE, checks a SQLite **header only**, and checks a .orbit archive's gzip header and bounded size. For an explicit read-only *format* validation of an existing .orbit or .json backup (without restoring it):

~~~powershell
$env:ORBIT_TAURI_READONLY_BACKUP = 'C:\Review\collection.orbit'
node --test tests/tauri-release-readiness.test.cjs
Remove-Item Env:\ORBIT_TAURI_READONLY_BACKUP
~~~

Only use files you own and intend to inspect. A valid archive format does not prove a complete restorable library or image integrity beyond the format's checks. Do **not** test migration by deleting, renaming or changing the actual installed preview's SQLite database.

### Windows acceptance checklist and remaining evidence

| Gate | Safe check | Required evidence / current limitation |
| --- | --- | --- |
| **Parallel installation** | Compare Tauri preview ID com.orbitlauncher.rustpreview with Electron com.orbitlauncher.desktop; install NSIS and MSI **on a disposable Windows profile**, one installer type at a time | Confirm Start Menu/Uninstall entries, installation locations, upgrade and uninstall behavior, and Electron remains working. Source/config checks cannot verify installer actions. |
| **First-run import** | Use a **disposable copied Electron fixture and an isolated Windows account/VM**; start Tauri once with no existing Tauri DB | Confirm SQLite rows, playtime, favorites, cover/icon/banner assets and settings match the fixture; confirm original Electron DB and WAL are unchanged. VACUUM INTO is used with the Electron connection opened read-only, then a temporary DB is renamed only after artwork handling. This import happens **only if the Tauri DB is absent**; subsequent changes do not sync. |
| **Cancel dialogs** | Cancel Choose Executable/Folder/Artwork, Export Library and Restore Library in a disposable instance | A cancelled picker should not alter the library, generate a backup, create artwork or trigger a restore. Automated checks verify early cancellation branches; actual native dialog interactions still require manual verification. |
| **Backup parity (0.2.7 development)** | Export **both** .orbit and .json with a disposable library containing all three artwork types, completed sessions and known aggregates; restore in a fresh profile, repeat restore, then cross-check with Electron | Both formats now include completed session rows; .orbit embeds referenced artwork while .json does not. Verify source IDs, timestamps, aggregates, session-ID idempotence, malformed archives, live-session export refusal and no file/data loss. Old backups without session records remain accepted but cannot regenerate historical activity charts. |
| **Windows game workflows** | Test Steam, Epic, GOG and manually linked EXEs, launch, session recovery, controller mode, discovery, artwork, and Performance Guard | Compare expected discovered paths/IDs, real game playtime before/after suspend/restart, and absence of duplicate sessions. No live credentials or production game data are needed for synthetic fixtures. |
| **Tray/WebView2** | Follow the real HWND test and complete process-tree measurement in [tray verification](VERIFICATION-TAURI-TRAY-WEBVIEW.md) | X closes **destroy** WebView2 while Rust PID continues; tray Open must recreate and bootstrap; only Quit Orbit ends the backend. A previous close-only test **did not** verify reopen or live session persistence. |
| **Distribution/update trust** | Verify package contents (including native runtime DLLs), hashes, fresh Windows installer startup and absence of automatic installation | **Unsigned local test releases are allowed**, just like the existing Electron edition, and require no paid GitHub Actions. The installer must work on an isolated Windows profile. Automatic updates remain disabled because no authenticated update channel exists; publisher trust is a separate public-distribution concern, not a local-preview release gate. |
| **Renderer hardening** | Audit tauri-web's staged CSP, orbit-art scheme, navigation rules and exposed IPC against untrusted game metadata | Tauri app.security.csp is currently null while the bundled HTML has a restrictive CSP meta policy. This is a defense-in-depth concern, **not** evidence of exploitation. Tighten only after WebView2 CSP compatibility and full UI paths are tested. |

**Current release decision:** **CONDITIONAL GO** for unsigned Rust-first development/testing **side by side with an Electron fallback**, without paid GitHub Actions or code signing. The 0.2.7 development implementation adds session-history backup/restore and a one-time pre-upgrade SQLite snapshot; neither is a substitute for validating installed Windows upgrades. **NO-GO for deleting the Electron app or its user data** until clean Windows install/upgrade, complete history round trips, native dialogs, real tray recreation and live-session persistence are validated. Keep both profiles and raw SQLite backups; do not enable automatic unsigned updates.

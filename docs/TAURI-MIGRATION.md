# Orbit Launcher native Rust / Tauri migration

This repository includes a separate Tauri 2 executable backed by Rust, reusing Orbit's existing accessible JavaScript desktop interface. The Rust preview uses its own application identifier so it can be installed alongside the Electron release. The Electron release scripts and app remain available while the native version is validated. **The unsigned Rust build is experimental; merging the preview code did not publish or replace the Electron release.**

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

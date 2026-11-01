# Orbit Launcher native Rust / Tauri migration

This branch builds a separate Tauri 2 executable backed by Rust, reusing Orbit's existing accessible JavaScript desktop interface. The Rust preview uses its own application identifier so it can be installed alongside the Electron release. The Electron release scripts and app remain available until the native version passes review. **The unsigned Rust build is experimental.**

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

## Verification targets

1. Run Rust `cargo test` and `cargo check` plus the frontend adapter tests.
2. Build both native Windows installer formats in CI.
3. On Windows with a real installed library, verify migration, artwork, folders, manual game addition, import, edit, launch, playtime, fullscreen controller mode, export and restore.
4. Record cold startup, idle RSS, startup CPU and installer sizes against Electron on the same PC. **No speedup is claimed until these measurements are available.**

Native online artwork search, repair and automatic updates are deliberately unavailable while their Rust replacements are unfinished. The JS interface displays the returned error if invoked. Do not distribute the Rust build as a production replacement until these features are finished and real Windows smoke testing succeeds.

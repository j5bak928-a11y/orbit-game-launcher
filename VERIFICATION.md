# Verification checkpoint — 2026-10-21

This checkpoint was performed on Debian Linux with Node.js 22.16.0 and headless Chromium. It checks the standalone source project shipped with Orbit Launcher.

## Confirmed

- `npm run check` — passed JavaScript syntax checks for Electron main/preload, discovery, launching, database, and interface code.
- `npm test` — 24/24 passed. Coverage includes durable SQLite storage, cross-source duplicate prevention, restoration of backup metadata, corrupt settings fallback, Steam/Epic/GOG fixtures, Steam traversal rejection, custom-folder import overlap, safe process/URI launching, and immediate-exit session handling.
- `python tests/renderer-smoke.py` — passed in real headless Chromium with mocked desktop APIs. It exercised navigation, searching, add/edit, launch import preview, theme changes, sort/list toggle, empty-library UI, 5,000-item virtualization, and import checkbox focus.
- Layout inspection at viewports 910×610, 1024×768, 1440×900 and 1920×1080 showed no document-level horizontal overflow. Screenshot inspection also checked the minimum window size.
- Real Node child-process test launches a local test script via an argument vector and verifies exact output, including shell-special characters; no shell command evaluation occurs.
- Representative Linux Node benchmark: 5,000 SQLite entries inserted in ~2.7 s, complete 5,000-entry list read in ~38 ms, process memory ~56 MB RSS / 18 MB V8 heap. This is a standalone Node benchmark, **not Electron startup/memory usage**.
- Headless Chromium mock benchmark: 5,000 games keep ~50 cover cards mounted; one run measured ~109 ms simulated boot and ~141 ms initial library navigation. These numbers are environment-specific and exclude native Electron/backend loading.

## Fixed in this checkpoint

- Cross-source duplicates with the same executable path are prevented at insertion and editing time.
- Discovery combines GOG folder metadata with directory scans without showing duplicate executable entries.
- Fast-exiting game processes cannot leave an unfinalized play-time session before registration.
- Malformed stored settings fall back to safe defaults without crashing startup.
- Exported play time, favorites, tags, and date metadata now survive JSON library restoration. Valid settings are restored too.
- Steam manifest installation directories reject path traversal components.
- Corrected the macOS GOG root selection logic.
- Reduced work in folder scanning by replacing repeated queue shifts with an indexed queue.
- Import checkbox interaction keeps keyboard focus and scroll position.

## Still unverified

- The Electron executable could **not** be downloaded: npm failed to resolve `registry.npmjs.org` (`EAI_AGAIN`). No Electron install/build or packaged application ran during this checkpoint.
- The connected Windows environment exposed read access but did not accept terminal/command invocations in this session. A native Windows game launch, registry discovery, file picker, Steam/Epic URI handoff, and Windows installer build were therefore not verified.
- macOS application launching, entitlements/signing, and Linux package builds remain untested.
- Installer signing and end-user distribution were not attempted.

Once dependencies are available, run `npm install`, `npm run check`, `npm test`, `npm start`, and `npm run dist:<platform>` on the target system. Verify the app visually and with a deliberately safe local test executable before claiming end-to-end game-launch compatibility.

# Stage 5 — Final acceptance and delivery verification

Date: 2026-10-21. Test environment: Debian Linux, Node.js v22.16.0, npm 10.9.2, Python Playwright with system Chromium. This is **source-code acceptance**, not an installed/packaged application certification.

## Delivery status

The complete Orbit source application has an Electron main process, sandboxed preload API, HTML/CSS/JavaScript interface, local SQLite persistence, launch service, Steam/Epic/GOG discovery, configurable folder scan, artwork storage and download, settings, backup, tests, icons, and installer configuration. It is distributed as a **source archive**. The native Electron application and its installer have **not** been successfully built or run in this environment. A native release cannot yet be certified.

## Final fixes after Stage 4

- Replaced the discovery dialog's first-800-results cutoff with 100-item pagination. Checkboxes retain their state across pages. Global selection supports 10,000 entries per import, and rescanning selects new results even if they occur after 10,000 already-imported games. Added graphical regression checks for result-page navigation and large rescans.
- Added case-insensitive launch-URI duplicate detection. A manually added Steam shortcut and its subsequently discovered Steam manifest now map to one entry, and editing another game to use that URI produces an explicit error. The discovery preview also marks matching launcher URIs as already imported. Added a persistent database regression test.
- Stabilized Chromium handler-backed test teardown by allowing outstanding IPC events to settle before closing each page.

## Acceptance review

| Original requirement | Source implementation / verification |
| --- | --- |
| Polished gaming interface, dark/light/system themes, accents, keyboard interaction | Present; Chromium screenshots and interaction tests exercised themes and key flows. Native presentation remains unverified. |
| Dashboard, library grid/list, search, filters, favorites, recent and details | Implemented; Chromium smoke and handler-backed workflows pass. |
| Manual add/edit/remove, artwork, arguments, folders, launch links | Implemented; handler-backed workflow tests add/edit/remove and launch with arguments. Artwork reading has automated bounds checks; native OS dialogs remain unverified. |
| Steam, Epic, GOG and folder scanning | Implemented from available local manifests/paths with graceful warnings. Unit tests verify fixture parsers; handler-backed workflow tests Steam/GOG fixtures. Real client installations remain unverified. |
| Real game launching | Linux process-spawn test executes a harmless real script, verifies working directory and arguments, and tracks its exit. Real games and Windows/macOS launchers remain unverified. |
| SQLite persistence, settings and JSON backup | Verified by tests with database reopen, backend process restart, and restore flows. Backup JSON excludes artwork files, explained in README. |
| Large libraries, speed and resource use | 5,000/20,000-game Chromium smoke tests and 5,000-game SQLite benchmark pass. Results exclude native Electron startup/memory. |
| Security and accessibility | IPC exposed through preload, nodeIntegration disabled, shell-free process launching, URI allowlist, bounded artwork downloads, modal keyboard focus checks, minimum-size viewport checks. Remaining OS-dependent properties require native review. |
| Scripts, packaging configuration and setup instructions | npm scripts, Electron Builder config, icons and README are present. Installer creation not verified due missing dependencies. |

## Commands executed for Stage 5

- `npm run check` — **passed**.
- `npm test` — **32/32 passed**, including manual/store URI deduplication.
- `python tests/renderer-smoke.py` — **passed**, including first/last import pages, rescans with >10,000 prior imports, 5,000 and 20,000-game virtualized libraries; no browser page errors.
- `python tests/workflow-integration.py` — **passed**, including real main-process handlers, actual SQLite, a safe executable spawn, backup, errors and process restart. The harness substitutes for Electron and system dialogs.
- `node tests/performance.cjs` — **passed**. Three 5,000-game batch inserts: 1,227/1,184/1,150 ms; three library reads: 46/61/66 ms; 1,020-file synthetic scan: 42.8 ms. RSS varied from ~61 to 133 MiB during the Node benchmark. Values are from the Linux test host.
- `npm ping --fetch-timeout=5000 --fetch-retries=0` — **failed** with `EAI_AGAIN` resolving registry.npmjs.org.
- `npm run dist:linux` — **failed** because `electron-builder` was not installed (the npm packages could not be downloaded).
- Windows connected workspace check — **failed** because the tunnel client was offline. It was not possible to install, launch or build on the Windows PC.

## Platform coverage and remaining limits

- **Linux**: Node integration and Chromium interface tested; no native Electron binary launched.
- **Windows**: No successful launch, installer build or real Steam/Epic/GOG integration test performed.
- **macOS**: No native app bundle, Gatekeeper or application-launch test performed.
- Some game-specific launchers and DRM clients can only be launched through their registered URI and cannot be reliably timed by Orbit. Manual entry is the fallback for unsupported store formats.
- Backup JSON transfers metadata/settings; artwork must be copied from the Orbit user-data artwork folder to preserve custom assets across machines.
- Distribution signing/notarization is not configured, and none should be inferred.

## How to complete native acceptance

On a machine with npm connectivity and Node 22.13+:

```
npm install
npm run check
npm test
npm start
```

Interactively verify first launch, executable chooser, optional artwork import, native window controls, folder chooser, local game launch, installed Steam/Epic/GOG manifest discovery, games from disconnected drives, and persistence after reopening Orbit. Build with `npm run dist:win` on Windows, `npm run dist:mac` on macOS, or `npm run dist:linux` on Linux, then install and verify the produced binary on that platform. Package signing/notarization, when needed for public distribution, is separate work.

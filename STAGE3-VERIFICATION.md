# Stage 3 — Workflow verification (2026-10-21)

## Outcome

Ran an interactive Chromium workflow with Orbit's **actual `src/main.cjs` IPC handlers, SQLite data layer, manifest discoverers and process-launch implementation**. Electron's host APIs were supplied by a small test stand-in (`tests/electron-stub-host.cjs`); the interface was driven with Playwright in both headless Chromium and headful Chromium under Xvfb. This is stronger than mocked front-end tests but **is not a running native Electron executable**.

## Reproduced workflows

- Opened a new library and confirmed the empty-library experience.
- Used the application’s executable selection UI (stand-in file chooser) to add a local test game; saved tags, genre and JSON launch arguments to real SQLite.
- Favorited and edited that game through the interface; confirmed values in SQLite.
- Clicked Play in the interface and actually spawned a harmless local shell test script. Verified its working directory and that separate arguments including one with spaces reached the process unchanged; verified last-played time and final tracked duration.
- Changed theme and accent; added a library location through the folder chooser stand-in.
- Scanned a fixture Steam installation manifest and GOG `.info` metadata via Orbit's actual discovery handler; previewed and imported two new entries, avoiding duplicate executables.
- Exported the real library to JSON; restored it, confirming duplicate imports are skipped.
- Added an entry whose executable was missing and confirmed an actionable error toast.
- Removed a game through the interface and verified the game binary remained on disk.
- Restarted the Chromium UI and then restarted the **Node main process** against the same SQLite file; confirmed games, deletion, theme and accent persisted.
- Checked a 910 × 610 window, dialog keyboard focus cycling with Tab/Shift+Tab, Escape closure, and UI JavaScript errors. Inspected generated light-theme screenshots for clipping and feedback overlap.

## Repairs made

- Fixed the dialog keyboard focus trap to cycle between actual focusable controls; initial dialog focus now moves logically with Tab and Shift+Tab.
- Limited simultaneous notifications to three after observing a stack of five overlapping toasts during rapid UI actions.

## Commands completed

```bash
npm run check                  # Passed
npm test                       # 24/24 Node tests passed
python tests/renderer-smoke.py # Passed; 5,000 fixture-game virtualization smoke test
python tests/workflow-integration.py # Passed headless Chromium + real main-process handlers
xvfb-run -a env ORBIT_HEADFUL=1 python tests/workflow-integration.py # Passed visible Chromium
```

Environment: Debian Linux, Node 22.16.0, installed Python Playwright and `/usr/bin/chromium`. The screenshots `stage3-library-integration.png` and `stage3-settings-integration.png` were captured during headful Chromium workflow testing.

## Not tested or established

- Installing or running the actual Electron executable. `npm view electron` failed with `EAI_AGAIN` resolving `registry.npmjs.org`, so `npm install` and Electron packaging could not be completed.
- Genuine Electron OS file dialogs, window management, preload/context isolation or `orbit-art` protocol handling. Those native APIs are represented by a deliberately limited test stand-in.
- Windows/macOS installation, games on actual store clients, OS protocol association, native startup responsiveness or installer behavior.
- A native memory/CPU benchmark. The 5,000-game browser fixture numbers concern only the Chromium renderer and simulated data.

The completed workflow test does demonstrate a **real Linux child-process launch and durable SQLite metadata**, while keeping Electron integration and game-store handling claims clearly separate.

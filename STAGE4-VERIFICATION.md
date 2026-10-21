# Stage 4 — Performance, compatibility and quality refinement

Date: 2026-10-21. Test host: Debian Linux, Node 22.16.0, Chromium via Python Playwright. This report describes verified source and test-harness behavior. **No native Electron desktop binary or target-OS installer was executed.**

## Repairs implemented

- Added `LibraryDatabase.upsertBatch` with transactions for groups of up to 100 entries; IPC imports and startup rescans now import 50 entries at a time and yield to the event loop between groups. Duplicates and individual malformed entries still receive accurate per-entry feedback. This reduces SQLite commit overhead and limits uninterrupted main-process work.
- The virtualized game library now preserves its DOM when the range of visible cards has not changed, avoiding unnecessary redraws during tiny scroll movements. Window calculation is clamped for lists that shrink after filtering, and category/source/tag filtering returns the view to the top.
- Remote Steam artwork is streamed through `src/core/artwork.cjs` with a 5 MiB hard limit, including responses that omit `Content-Length`. Unexpected MIME types, invalid JPEG headers, and oversized images are rejected; oversize streams are cancelled.
- Colored primary buttons and the app mark use dark foreground text, keeping all six available light/medium accent backgrounds readable. The darkest available accent (`#8b7aff`) has an approximately 6.3:1 dark-text contrast ratio, versus approximately 3.3:1 for white text.
- Settings sort choices use an own-property whitelist, preventing names inherited from the JavaScript object prototype (for example, `toString` or `__proto__`) from being mistakenly accepted as SQL sort expressions.
- Added targeted tests for streamed artwork bounds, batched import behavior, invalid sort values, symlink cycles, entry limits, and filtering from deep-scroll positions.

## Verification commands (all passed)

```
npm run check
npm test
python tests/renderer-smoke.py
python tests/workflow-integration.py
npm run bench
```

**Backend test result: 31/31 passed.** Chromium renderer smoke passes, with no reported JavaScript page errors. The handler-backed workflow passes, covering durable SQLite data, safe process launching with arguments, scanning Steam/GOG fixtures, game add/edit/favorite/remove, themes, errors, and backup restore after restarting the backend process.

## Performance measurements

Measurements on this *Linux test host*, from locally generated synthetic data; numbers are informational rather than device-independent targets:

| Scenario | Observed | Scope |
| --- | --- | --- |
| 5,000 sequential inserts, pre-batch control | 2,950 ms | SQLite Node process; matching 5,000-game input |
| 5,000 batched inserts, three trials | 1,058–1,125 ms; median 1,091 ms | SQLite Node process; batches of 50 |
| 5,000-game full library read | 40–52 ms; median 50 ms | Node SQLite + JSON-deserialization layer |
| 100 primary-key lookups | 3.1–3.5 ms; median 3.1 ms | Node SQLite |
| Directory scan, 1,020 synthetic files | 40.6 ms | Linux filesystem with 20 discovered game scripts |
| 5,000-game Chromium mock boot | 88.6 ms | Renderer-only, excluding Electron launch and SQLite boot |
| 5,000-game Chromium library navigation | 89.3 ms | Renderer-only |
| 20,000-game Chromium mock boot + library | 279.6 ms | Renderer-only, 50 cards rendered after a deep scroll |

Batched insertion in the synthetic comparison was approximately **63% faster** (1.09 s vs 2.95 s). Performance will vary with disk speed, filesystem, process contention, and game metadata sizes. The 5,000-game process measurements included approximately 60–124 MiB RSS across repeated runs; they are not Electron memory figures and include retained allocations between runs.

## Resilience and accessibility

Automated checks cover malformed settings, duplicate source and executable records, unsafe Steam installation manifest components, corrupted GOG/Epic metadata, missing executables, invalid paths, offline-compatible libraries without art files, disconnected library folders, symlink cycles, bounded folder scans, rapid process exit, and backup restoration. A 910×610 Chromium viewport is checked for document overflow. Import checkbox focus, modal focus cycling, reduced motion configuration and a 20,000-game virtual library are exercised in the existing UI/workflow harness.

## Native compatibility remains unverified

A fresh `npm ping --fetch-timeout=4000 --fetch-retries=0` failed with `EAI_AGAIN` connecting to `registry.npmjs.org` on this host; Electron was absent from the runtime. No Windows Steam/Epic/GOG installation, macOS `.app` launch, Electron file dialogs or packaging tests were run. The Windows Chat On Steroids connector returned a project folder listing but terminal invocations failed with `UNKNOWN_TOOL`, so native testing through that connection was unavailable. A host-installed Electron build is still needed before a claim of end-to-end desktop support.

For native acceptance on a Windows test PC, run `npm install`, `npm run check`, `npm test`, `npm start`, verify Steam/Epic/GOG installed-game discovery and a harmless local `.exe` launch, then run `npm run dist:win`. Repeat platform-specific checks on macOS/Linux before claiming support there.

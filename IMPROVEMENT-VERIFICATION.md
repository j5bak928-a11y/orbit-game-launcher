# Orbit Launcher — Follow-up Improvement Audit

Date: 2026-10-21. Baseline: Stage 5 source ZIP. Changes made in a separate copy of the baseline, with a local Git commit preserving the original source state. The prior source archive and existing workspace were not overwritten.

## Audit and prioritized findings

| Priority | Evidence at baseline | Change | Acceptance evidence |
| --- | --- | --- | --- |
| P1 — duplicated launches | The Electron handler only checked active tracked sessions, after awaiting `spawn`. Two simultaneous IPC calls were accepted, launching two `sleep` processes. | Reserve IDs synchronously while a game is launching; release the reservation in `finally`; give an accurate success message when starting tracking fails after the OS process has started. | Exact same concurrent-request reproduction: Stage 5 **2** successful launches vs improved **1**. Handler-backed Chromium workflow passes. |
| P1 — nonportable backup | Stage 5 JSON backups omitted all locally stored cover and banner bytes. A restore on a new PC could lose its artwork. | Added compressed `.orbit` portable format embedding referenced artwork, retaining optional legacy `.json` exports/restores. Save backups atomically, validate compressed input and image types, reject decompression bombs, cap stored assets. | Actual main-process export and restore into a **separate empty profile**, confirming the restored cover matches the original imported PNG. Backup unit tests pass. |
| P2 — repeated restore storage waste | Reinstalling archived images under new random names would make repeated restores create duplicate images, even when library rows were skipped. | Deterministic content-hash artwork filenames with collision checks and no overwriting; duplicate restores reuse files. | Unit test restores one archive twice and confirms exactly 2 artwork files remain. |
| P2 — scan dismissal | A long scan opened an import dialog after the user had closed the scanning dialog. | Ignore late scan results when the original scan modal has been dismissed. | Browser test dismisses an unresolved scan, resolves its promise, and confirms no modal reappears. |
| P2 — stale global search | Navigating between sections reset filters but retained the old search query, leaving navigation unexpectedly filtered. | Clear query when switching routes. | Browser test verifies that navigating to Settings clears the old library query. |

The original design system, navigation, local SQLite schema, Steam/Epic/GOG detection, launcher URI handling, virtualization, existing preferences, and all legacy JSON backups were retained. No framework migration or external dependency was introduced.

## Test evidence

- **Before changes:** `npm run check` passed; `npm test` **32/32** passed; Chromium renderer smoke passed; handler-backed Chromium workflow passed.
- **After changes:** `npm run check` passed; `npm test` **36/36** passed (32 baseline plus 4 portable backup tests); `python tests/renderer-smoke.py` passed, including the cancel-scan and search reset regressions.
- `python tests/workflow-integration.py` passed with real IPC handlers and SQLite. New checks cover concurrent launches, both backup formats, real PNG artwork chosen through the dialog handler, and archive migration to a fresh user profile.
- `xvfb-run -a env ORBIT_HEADFUL=1 python tests/workflow-integration.py` passed in graphical Chromium. The Settings screenshot was inspected; the backup explanation and controls remain readable and aligned.
- `node tests/performance.cjs` after changes: median ~1,189 ms to insert 5,000 games, ~62 ms to read them, ~44 ms for a synthetic 1,020-file scan on Linux. Baseline Stage 5 reported median ~1,184 ms for insertion and 61 ms for reads; the small differences are measurement noise, **not** a proven performance gain. 20,000-game frontend smoke still renders ~50 cards during deep scrolling.
- `npm ping` failed with `EAI_AGAIN` resolving `registry.npmjs.org`. The native Electron and Electron Builder packages remain unavailable; native desktop startup and OS-specific packages **were not built or tested**. The connected Windows workstation returned a tunnel-client-offline error.

## Security and integrity boundaries

Portable archives use gzip-compressed JSON with a known format marker. The loader enforces a 128 MB compressed-input limit and a 192 MB decompressed limit, verifies that artwork is referenced and has a UUID-shaped filename, checks base64 encodings and image signatures, and bounds artwork to 100 MB. Files are written only within Orbit's artwork directory under content-derived filenames. Legacy JSON format remains compatible. Backup files remain local and contain executable/install paths, so treat them as private.

## Remaining limitations and release blockers

- Native Electron runtime, Windows/macOS launching, Electron Builder installers, signing, and real Steam/Epic/GOG handoffs **remain unverified**. The improvement pass does not make this a certified installable release.
- Portable backups cannot preserve installed games themselves, store credentials, or make game paths portable. Each computer still needs its game binaries and relevant launcher clients.
- Portable archives are designed for reasonable-sized personal libraries; exceptionally large cover collections above the documented bounds must use the metadata-only export and back up artwork separately.
- The current renderer still uses a custom virtual list and imperative DOM rendering. It passed the measured test cases; a rewrite is unjustified without a demonstrated regression.

**Recommended next action:** On a machine with npm access, install dependencies and verify native Electron startup, local game launching, dialog behavior and installer packaging. Run that acceptance sequence on Windows first, since that is the primary intended platform.

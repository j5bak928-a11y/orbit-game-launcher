# Orbit 0.10.0 — verification

Verification date: 24 October 2026. Source baseline: main `a073b45965ef768bbf50cb6650ada68d54447d3e` (0.9.4). This is an in-place Electron/SQLite upgrade; user databases and backup formats are retained.

## Demonstrated

| Check | Evidence |
| --- | --- |
| Dependency installation | `npm ci --no-audit --no-fund` completed; lockfile resolves Electron 38.8.6 and electron-builder 26.18.0 |
| Syntax | `npm run check`: **46 JavaScript files passed**, including all new helpers |
| Unit/integration fixtures | `npm test`: **145 passed, 0 failed** |
| Lint | Pinned Biome 2.6.2: **0 errors, 0 new warnings, 7 explicitly reviewed strict-mode/reduced-motion warnings**; no blanket lint-rule suppression |
| Existing 5,000-game renderer journey | Search/edit/favorite/remove/add, new filter options, focus retention, event coalescing, running state, unchanged DOM identity |
| New experience regression suite | Platform chips/clear filters, suggestion without launch, pending/duplicate launch guard, keyboard dialogs/focus, provider diagnostics, light theme |
| Virtual scroll | 5,000 records at 28 grid positions and seven list bottoms across widths 1440, 1181, 1180, 910, 750, 500, 390; final record reachable, <=120 rendered records, row/spacer agreement and no body overflow |
| Screenshot inspection | 1440×900 and minimum 910×610 desktop, optional 390×844 narrow layout, light mode and scan diagnostics |
| Desktop packaging | `npm run dist -- --linux dir --publish never` completed; unpacked Electron application and ASAR contained the runtime source/assets and new helpers |

Browser: Chromium 153.0.8010.0, headless Playwright. Host: Linux x64, Node 24.22.1. The browser IPC, installation paths and screenshot play history are deterministic fixtures. Screenshot game names and public Steam artwork are authentic; the sample collection is not a user's library. Test transport intercepts fixture art; production uses its local `orbit-art:` scheme.

A single-game favorite update and a 25-event update burst perform **zero full-library reads and zero page rebuilds** in the existing renderer journey. Unchanged cards retain their DOM identity; keyboard focus is preserved.

## Focused regressions

Discovery fixtures cover non-default Steam registry/libraries, installed/update state and ID checks, modern Epic catalog identities and duplicate manifests, incomplete installs/DLC, realpath containment, GOG FileTask selection, nested binaries, utilities/ambiguity, macOS bundles, Heroic/Legendary schemas and launcher handoff, conservative vendor metadata, bounded provider concurrency and diagnostics. No discovered game runs in these tests.

Artwork tests cover stream/image limits, true portrait validation, separate landscape banners, local cache access with network disabled, custom Steam roots, stale title/edit protection, shared in-flight jobs, bounded concurrency/cache entries, miss expiry/retry and queue recovery after an exception.

Review caught and corrected Windows Legendary's wrong-client URI, grouped macOS applications, unsafe GOG tasks, interface cardinality/incremental/fallback cases, and a cover-edit race during asynchronous portrait validation. Focused regressions protect these changes. A final scoped review approved the two final fixes; the POSIX permission tests skip explicitly on Windows while Windows discovery fixtures remain active.

## Informational measurements

Synthetic 5,000-game SQLite run on this host: median full-library read **39.8 ms**, 100 individual lookups **3.8 ms**, and batched insertion **1,366.1 ms**. A bounded scan found **20 fixture games among 1,020 entries in 86 ms**. The eligible tracking projection returned 3,000 records with only three fields each, p50 **2.365 ms**, p95 **3.538 ms** over 30 samples.

These are fixture/database measurements, not game FPS, native storefront benchmarks or a claimed before/after speedup. Browser layout and native OS scheduling vary by device.

## Native limits

An actual Electron launch was attempted after installing dependencies. The host rejected `socket()` in Chromium's `process_singleton_posix` with `Operation not permitted`, so native startup could not complete here. The app's production single-instance/security behavior was preserved. Packaged/native startup is therefore **not claimed**.

Real Windows registry contents, game executables, filesystem dialogs, URI registration, interactive animation on a user's GPU, and installed-game launches were **not tested on a Windows PC**. Neither macOS packaging/signing nor Linux AppImage/deb installation was performed. A Windows PR workflow builds and verifies installer and portable EXEs; its result is reported separately, not inferred from local Linux packaging. GitHub artifact-storage quotas can block downloadable attachments, and upload status is reported separately from test/build status. The first Windows CI run exposed a pre-existing fixture using a POSIX shell target on Windows; that positive fixture now selects a host-appropriate executable without weakening production validation.

## Native Windows acceptance

1. Export an existing `.orbit` backup before installing a test build.
2. Open the installer/portable build and confirm the existing collection, custom artwork and play history appear.
3. Scan with Steam on a non-default drive, Epic (including Rocket League if installed), GOG and installed vendor clients; inspect diagnostics and review candidates before importing.
4. Compare detected paths with the real game installations; verify tools/installers are absent and missing drives show usable diagnostics.
5. Test one storefront handoff and one direct executable; verify pending/playing feedback, duplicate-click prevention and available time tracking.
6. Disable Steam artwork, restart offline and check cached covers/icons still render. Try an unknown title and a manually selected portrait/banner.
7. Search/filter/sort a large collection, scroll to the end in grid and list, change theme/reduced motion, and export/restore a portable backup.

## Reproduce browser QA

Install or point to an existing Playwright installation and Chromium/Chrome; these are optional developer tools, not production dependencies.

```bash
npm run test:renderer
npm run test:experience
```

For a shared installation/custom browser use `ORBIT_PLAYWRIGHT_PATH`, `ORBIT_BROWSER_EXECUTABLE` and `ORBIT_QA_OUTPUT`. Both suites run offline with mocked desktop IPC. Screenshots in [images](images/) show the inspected sample desktop layout.

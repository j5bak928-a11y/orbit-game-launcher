# Orbit library updates and quality checks

Implementation and local validation recorded on 2026-10-23 from repository snapshot `512948047790401ce1395014712fa47c2cc5e652`.

## Library changes and tracking

Single-game mutations now publish the changed record or removed ID with a monotonic revision and current running IDs. The renderer combines queued events, preserves unaffected cards and focus, and refreshes filters and selected details. Bulk imports/restores share a versioned snapshot; stale packets are ignored, missed revisions trigger recovery, and changes received during a snapshot remain applied.

Background tracking uses a cached statement selecting only `id`, `source` and `install_path` for eligible Steam/Epic installations. Tracking notifications contain only game IDs whose sessions changed. The existing matching optimization and artwork validation fixes from the preceding review are retained.

| Measurement | Before | After |
| --- | ---: | ---: |
| Favorite: full-library reads | 2 | 0 |
| Favorite: page rebuilds | 2 | 0 |
| 25 queued changes: full-library reads | 25 | 0 |
| 25 queued changes: page rebuilds | 25 | 0 |
| Unaffected card node / favorite keyboard focus retained | No / No | Yes / Yes |
| Tracking query p50 | 19.926 ms | 1.483 ms |
| Tracking query p95 | 21.900 ms | 2.239 ms |
| Returned tracking rows / fields per row | 5,000 / 19 | 3,000 / 3 |

These are synthetic 5,000-game fixtures. Browser counts use installed headless Chrome with mocked IPC. SQLite query measurements use 30 samples after five warmups and cover query execution and row materialization only. The query p50 improved about 13.4 times; this does not measure whole-app speed or native process enumeration.

Timing and browser results: [query before](reports/library-updates/tracking-before.json), [query after](reports/library-updates/tracking-after.json), [browser before](reports/library-updates/renderer-before.json), [browser after](reports/library-updates/renderer-after.json).

## Review of all 38 warnings

| Biome rule | Before | After | Review outcome |
| --- | ---: | ---: | --- |
| noPrototypeBuiltins | 5 | 0 | Use Object.hasOwn. |
| noUnusedFunctionParameters | 5 | 0 | Remove unused parameters; forward host-stub arguments explicitly. |
| noUnusedVariables | 4 | 0 | Remove unused imports/helper/bindings. |
| noTemplateCurlyInString | 8 | 0 | Preserve literal Steam filename placeholders with escaped template strings. |
| noArguments | 1 | 0 | Use explicit rest parameters. |
| noDescendingSpecificity | 2 | 0 | Place card hover styles after base cover rules. |
| noImportantStyles | 12 | 5 | Remove redundant declarations; retain reduced-motion overrides. |
| noRedundantUseStrict | 1 | 1 | Retain explicit strict mode for the classic browser script. |
| Total | 38 | 6 | 32 fixed; six individually reviewed. |

`npm run lint` pins Biome 2.6.2. GitHub CI runs it between syntax checks and tests. The gate rejects errors, new warnings, omitted/incomplete output, duplicate/stale review entries, and changes to the exact reviewed source or diagnostic location. Every retained diagnostic has a rationale in `scripts/lint-review.json`; no Biome rules are disabled. The final report also contains 28 informational diagnostics.

The five retained CSS declarations ensure OS/app reduced-motion settings override component and inline animation, transition and scrolling styles. Browser computed-style checks verify these overrides, list icon sizing, play button styles and hidden landscape artwork.

## Validation

- `npm run check`: passed.
- `npm test`: 111 tests passed, none failed or skipped.
- `npm run lint`: zero errors and zero unreviewed warnings.
- Headless Chrome: passed favorite, edit, add/delete, filter-option updates, favorite removal, batched snapshot recovery and running-state journeys.
- Handler tests use the actual main-process IPC functions and temporary SQLite storage; they confirm mutation payloads require no collection reads.
- Queue tests cover deduplication, revision gaps, in-flight snapshot races and failure recovery.
- Lint-gate tests cover new warnings, changed source, stale reviews and malformed reports.

Local runtime: Node v26.3.0 on Windows, Chrome 155.0.8059.86. CI is configured for Node 22; at local validation time the remote workflow had not yet run for these changes. Native Electron, real storefront launches, Windows process enumeration and installers remain unvalidated. User library data was not used for these fixtures.

`reports/library-updates/orbit-library-quality.patch` contains the cumulative source changes, including the preceding performance fixes. `changes-this-pass.patch` contains only this request's changes. These local handoff patches are checked and replayed against their saved baselines; original source hashes are verified against the recorded GitHub blobs.

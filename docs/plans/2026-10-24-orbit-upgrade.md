# Orbit desktop experience upgrade

User intent: improve the existing Orbit launcher with a clean, beautiful interface, smooth restrained motion, exceptional responsiveness and more reliable installed-game detection. Earlier feedback specifically identifies missing Epic/Rocket League covers, badly cropped Steam art and weak icon fallbacks.

## Decisions and constraints

Keep Electron, vanilla JavaScript and SQLite. Preserve existing libraries, backups, local-first behavior, reviewed imports and the ban on automatic Downloads scanning. No accounts, paid API keys, new frontend frameworks, game injection or background whole-disk crawls. Do not auto-import ambiguous executables. Use real games only in the user's library; any QA library is explicitly a test fixture. Retain keyed updates and bounded DOM rendering for thousands of games. All optional network lookups respect the artwork setting. Existing working controls remain functional. Deliver on a new review branch without merging main.

Considered approaches: a cosmetic-only refresh leaves known detection failures; a framework rewrite adds migration and performance risk. Selected by the implementer: improve the existing app in place and validate both rendered interactions and backend behavior.

## Task 1: reliable discovery

Own src/core/discovery.cjs and discovery-specific new tests. Preserve public exports and return shapes. Improve non-default Steam roots, Epic manifests (namespace/catalog launch identifiers, incomplete installs and duplicate metadata), Heroic/Legendary installations, Windows vendor metadata where reliable, and selected-folder discovery of nested game executables. Skip tools/installers/symlink cycles, bound all traversal and concurrency, validate installation paths and do not cross trust boundaries. Return optional per-provider diagnostics alongside games/warnings. Write fixture regression tests before implementing. Do not change database, main process or UI; report any required source/protocol integration.

## Task 2: polished, functional library

Own src/ui/app.js, styles.css and index.html plus a focused optional UI QA script. Create a cohesive premium dark desktop experience: quiet near-black surfaces, clear typography, compact sidebar, a useful game-led hero and continue-playing section, confident cover layout, readable metadata and restrained transform/opacity motion. Fix artwork placeholders and broken-image fallbacks. Add useful real capabilities: clickable platform filters with counts, launch pending feedback, shuffle an existing game, visible scan state/diagnostics, good keyboard behavior and clear active filters. Preserve all existing functions, IDs used by tests, modal/focus behavior, light/system themes, reduced-motion preference, row/grid views and incremental updates. Derive virtual row measurements from actual layout rather than fragile hardcoded CSS numbers. Bound DOM work for 5,000+ games. No fake data in production.

## Task 3: backend integration and artwork reliability

Own main/preload, database/launch integration, artwork-related helpers and tests, package metadata and documentation. Integrate discovered source names and protocol validation without accepting arbitrary shell URLs. Add deduplicated bounded artwork work with negative-result caching, online opt-out at execution time and stale-result guards so edits win over pending lookups. Preserve local icon fallback and portrait validation. Add local/remote landscape banner retrieval for the hero where feasible. Avoid N full-library reads/IPC refreshes. Extend package syntax checks to new files. Increment to v0.10.0 once verified.

## Validation and delivery

Baseline unit/syntax suite, meaningful new fixture regressions, whole-suite rerun, representative 1,000/5,000-game benchmarks, mocked Chromium UI at 1440x900 and minimum desktop size, game details/edit/favorite/search/filter/list/scan/keyboard/reduced-motion flows. Test real Electron boot if runtime is available. Distinguish mocked/fixture results from real Windows storefront detection and installed-game launches. Review the whole diff, fix findings, then publish a reviewable GitHub branch/PR through the selected GitHub plugin. Do not release or merge without request.

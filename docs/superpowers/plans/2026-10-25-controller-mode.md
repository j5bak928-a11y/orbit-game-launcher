# Controller Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A usable fullscreen library controlled with a gamepad, keyboard or mouse.

**Architecture:** An isolated overlay shares the current library and launch/favorite actions. A pure input policy owns gamepad edge/repeat handling; Electron owns native fullscreen. The overlay renders bounded pages and suspends polling when inactive.

**Tech Stack:** Existing Electron 38, vanilla JavaScript/CSS, Node tests, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-controller-mode-design.md`

## Global Constraints

- Preserve the approved purple planet branding and existing desktop flows.
- No new runtime dependencies, EXE downloads, releases or main-branch merge.
- Standard mapped controllers; keyboard/mouse fallback for absent or unknown controllers.
- Poll only while mode is open, visible and focused; require neutral input after resume/reconnect.
- Keep clear ring gaps in the approved logo; respect application and OS reduced-motion settings.

## Review Focus

- Held input across entry, game selection and focus changes cannot launch or back out repeatedly.
- Native fullscreen changes, failed entry, rapid exit/re-entry and stale promises cannot strand an inert desktop.
- Removing/favoriting a focused game or changing pages must retain useful focus, including empty lists.
- Multiple/disconnected controllers, null gamepad slots and malformed axes cannot steal navigation or throw.
- Large libraries, resizing and repeated entries must not grow DOM, listeners or active polling loops.

---

### Task 1: Input policy and native fullscreen boundary

**Files:** Create `src/ui/controller-input.js`, `tests/controller-input.test.cjs`; modify `src/main.cjs`, `src/preload.cjs`, `tests/library-ipc.test.cjs`, `tests/electron-stub-host.cjs`.

**Interfaces:** `GamepadInput.read(pads, now)` returns `{actions, status}`; `reset()` requires neutral input. Actions are up/down/left/right/select/back/favorite/recent/previousPage/nextPage. `getWindowState()` returns `{fullscreen}`; `setFullscreen(boolean)` requests native state. Native enter/leave events publish `type:windowState` with the actual fullscreen boolean.

- [x] Write deterministic tests for held actions, neutral arming, drift, directional repeat, reconnect/null/unknown layouts, multiple controllers and directional geometry. Run them red.
- [x] Implement the pure input policy and `directionalTarget(origin, candidates, direction)` returning a candidate index or -1.
- [x] Add real-main IPC tests for boolean validation, requested state, destroyed window and state queries; run red before adding handlers.
- [x] Implement the whitelisted IPC methods and native change events. Run focused tests, the whole unit suite and syntax checks; commit.

### Task 2: Controller surface and desktop integration

**Files:** Create `src/ui/controller-mode.js`, `src/ui/controller-mode.css`, `tests/controller-renderer.cjs`; modify `src/ui/app.js`, `src/ui/index.html`, `tests/fixtures/renderer.cjs`.

**Interfaces:** `OrbitControllerMode.create({snapshot, api, launch, favorite, onExit})` returns a view with `active`, `enter()`, `exit({restoreFullscreen})`, `update()` and `windowState(state)`. `snapshot()` supplies games, runningIds and pendingLaunches. Existing desktop actions remain authoritative for launch/favorite.

- [x] Add a browser journey that fails for the missing entry point; extend it to exercise keyboard/gamepad navigation, recent ordering, focus trap/restore, details, favorites, pending launches, empty states and native exit.
- [x] Build the branded fullscreen shell, recent rail, paged responsive cards, focus geometry, game sheet and status hints. Add keyboard and gamepad lifecycle with teardown and neutral arming.
- [x] Integrate the entry button/F11, shared state and launch guards without changing desktop navigation. Add scripts/styles to the real page and fixtures for native window state.
- [x] Run the controller suite, existing experience/library suites and visual desktop/compact/reduced-motion checks. Commit the integrated feature.

### Task 3: Verification, review and delivery

**Files:** Modify `package.json`, `.github/workflows/ci.yml`, `README.md`; document actual evidence under `docs/`.

- [x] Add `test:controller` to the existing source/browser workflow, without changing Windows distribution behavior.
- [x] Run unit tests, syntax, lint and all browser suites on the final files. Capture and inspect screenshots with a clearly mocked library.
- [x] Request one fresh review against the feature base, spec and plan. Fix material findings with reproducing tests and rerun affected checks.
- [x] Publish verified files to the existing draft PR branch with an expected-head guard; report implementation and genuine hardware/OS limits. Do not merge or create/download EXEs.

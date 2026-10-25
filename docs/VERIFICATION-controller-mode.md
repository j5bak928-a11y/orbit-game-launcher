# Controller mode verification — 25 October 2026

The requested scope is a controller-friendly fullscreen library with large cards, clear focus and quick access to recently played games. The implementation shares Orbit's existing library, launch guards and favorite actions. It adds no runtime dependency or database migration.

## Automated evidence

- `npm test`: 163 tests passed. New tests cover input neutral arming, held-button suppression, bounded directional repeat, stick drift/hysteresis, reconnects, null slots, unknown mappings, stable ownership across multiple controllers and suspension, spatial focus, fullscreen argument validation, asynchronous native transition ordering/timeouts/closed windows, and native F11 interception.
- `npm run check`: 52 JavaScript files passed syntax validation.
- `npm run lint`: 0 errors, 0 new warnings; the previous 7 reviewed warnings remain unchanged.
- `npm run test:controller`: actual renderer in Chromium 153 with 5,000 fixture games; recent ordering, arrow/Tab and injected gamepad navigation, held selection, launch pending/running state, favorites becoming empty, page changes, focused-game removal, native exit, failed entry, rapid exit/re-entry, prior-fullscreen restoration, empty library, polling suspension and focus restoration passed. A second connected controller and blur/resume preserve the active controller; changing the column count preserves the selected game's page. Layout was checked at 1920, 1440, 910, 500 and 390px; fewer than 40 game elements were rendered.
- `npm run test:renderer`: existing 5,000-game library journeys passed. Favorite updates and the 25-event burst made no full-library reads or page rebuilds.
- `npm run test:experience`: existing launch/scan feedback, filters, keyboard and theme checks passed, including 28 grid scroll positions and 7 list bottoms.
- The source/browser CI workflow now includes `test:controller`. Its YAML parsed successfully.

The controller test runs the real page with its CSP and local assets. Only game data, artwork responses, gamepad snapshots and Electron/native launch/window boundaries are mocked. The browser is brought to the foreground before focus-sensitive input checks.

## Visual inspection

Inspected dark, light, compact and game-sheet views with a sample library and public Steam artwork. The approved logo remains purple. Portraits are contained; landscape banners remain landscape card artwork. A banner-only game sheet contains its fallback image. Both theme variants retain a visible fallback mark when artwork is missing. The light theme uses darker purple focus and playtime accents for contrast.

One independent final review found controller ownership resetting on connection/focus events and selection moving to another game after a column-count change. Both were reproduced, fixed and covered by regressions before delivery.

## Remaining native checks

No physical controller or native OS fullscreen transition was demonstrated on this host. On a real desktop, verify USB/Bluetooth discovery and browser-standard mapping, repeat behavior, launching a game and returning to Orbit, focus loss, F11, native Escape/fullscreen exit, and prior-window-state restoration. Unsupported mappings retain keyboard/mouse controls. No game installation, EXE download, release or main-branch merge is part of this change.

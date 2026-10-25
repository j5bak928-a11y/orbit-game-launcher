# Orbit controller mode

The user selected controller-friendly fullscreen mode: large cards, clear focus indicators, controller navigation, and quick access to recently played games. Keep the approved purple planet identity and existing desktop library. Do not create EXE downloads or publish a release.

## Approach

Add a dedicated fullscreen overlay in the existing vanilla renderer. This gives controller navigation a predictable focus boundary while keeping desktop settings, library state, artwork and launch logic shared. Reusing the small desktop controls would compromise distant readability; a separate application/runtime would add unnecessary synchronization and dependencies.

## Behavior

- Enter from a labelled controller button in the top bar or F11. Exit with the visible Exit button, Escape, or controller B/Circle; close a game sheet before exiting the mode.
- Request native Electron fullscreen through a boolean-only preload IPC method. Remember the previous native fullscreen state and restore it on exit. Native fullscreen exit also closes the overlay without re-entering fullscreen.
- Show the approved logo, connection status, a Continue playing horizontal row (up to 8 most recent real play dates), and a paged All games/Favorites library. Render two library rows per page with responsive columns, rather than thousands of cards.
- Focus starts on the most recently played game when available. Large focus outlines, explicit selected-game text, keyboard Tab/arrow navigation and smooth focus scrolling remain usable with reduced motion.
- D-pad/left stick move focus; A/Cross selects or activates; B/Circle backs out; X/Square favorites the focused game; Y/Triangle jumps to Continue playing; LB/RB change library pages. Selecting a game opens a large Play/Favorite/Back sheet, and launching uses Orbit's existing duplicate/running guards.
- Use browser-standard mapped controllers. An unknown layout gets a clear keyboard fallback rather than guessed button positions. Keyboard and mouse work without a connected controller.
- Poll only while the mode is open, visible and focused. Require neutral input after entering/reconnecting/resuming; apply stick dead zones and directional repeat delay. Held action buttons never repeat into another screen. Disconnects must not move focus or launch games.
- Preserve focus across favorites, running-state/artwork updates, page changes, resize and removed games. Reconcile with the desktop library when the overlay closes. Empty libraries and empty favorites retain reachable exit/navigation controls.

## Verification and limits

Test the real input policy with deterministic controller snapshots. Exercise the actual renderer with keyboard and injected standard-gamepad snapshots, a 5,000-game library, fullscreen IPC success/failure, reconnect/blur, native exit, favorites, launch pending/errors and reduced motion. Keep the existing unit and browser suites passing. Native controller hardware and OS fullscreen transitions require a local desktop smoke test; do not claim those from mocks.

References: Electron BrowserWindow fullscreen/events documentation and the W3C Gamepad specification. No new runtime dependencies.

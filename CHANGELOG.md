# Changelog

This changelog covers the changes users receive with Orbit's Windows editions. **Rust/Tauri is the recommended direction starting with 0.2.8**, but its separately named download remains an **experimental, unsigned preview** while installed Windows acceptance is incomplete. Electron remains a supported fallback with separate application data. Release files appear on [GitHub Releases](https://github.com/j5bak928-a11y/orbit-game-launcher/releases); check the version on the download before installing.

## 0.2.10 — Favorite visibility and themed release notes (9 November 2026)

- **Poster favorite visibility:** unsaved hearts are hidden on idle desktop posters and appear when you hover over the card or focus it with a keyboard. **Selected favorites stay visible**, even when the pointer moves away. Touch controls remain visible, and the original left-heart/right-menu positions are unchanged.
- **Orbit-themed scrollbar:** the What's New dialog has a narrow, rounded scrollbar with an accent-colored thumb and subtle dark track, replacing the stark white Windows design. Custom accent colors, mouse wheel, touchpad, keyboard scroll and a Firefox fallback are preserved.
- The first-start release notes retain all four versions (**0.2.7 through 0.2.10**) in five languages. Dismissal remains version-specific, with manual reopening from the sidebar and Settings.
- Rust remains the recommended unsigned preview, Electron remains a fallback with a separate profile. Fully **Quit Orbit from the system tray** before updating; closing the window alone keeps its tracker active.

## 0.2.9 — Favorite-heart and release-notes reliability (9 November 2026)

### Interface and first-run release notes

- **Correct favorite alignment:** poster-card hearts **remain top-left**, with the actions menu **still top-right**. The heart moves upward to match the original menu height on desktop and compact layouts; neither control swaps sides.
- **Correct accent-colored hearts:** unfavorited hearts have a transparent center and purple/configured-accent **outline**. Favorited hearts have both a solid accent **fill and outline** in posters, list rows and game details, including hover, focus and custom-accent themes.
- **Reliable What's New:** the v0.2.9 first-start dialog includes the full highlights from **0.2.9, 0.2.8 and 0.2.7**, reappears when the packaged release version changes, tolerates packaged version metadata, and waits for another startup dialog to close rather than silently abandoning the announcement. The release notes can also be reopened directly from the **sidebar** or **Settings**, in English, Dutch, German, French and Spanish. Same-version dismissal remains stored separately for each app profile.
- **Rocket League exit detection:** a leftover `RocketLeague_EAC.exe` anti-cheat helper no longer keeps a Steam/Epic storefront game falsely marked **Playing** or extends playtime. Orbit requires a real recognized game executable and still uses two missed process observations to confirm exit. Applied to both Rust and Electron trackers; explicitly linked manual executables retain their existing behavior.

### Xbox / PC Game Pass artwork recovery (merged in #48)

- The Rust edition can read verified, local square logo assets from an installed Xbox GDK game's `MicrosoftGame.config` and use them as **icon fallbacks** when artwork is missing. Existing manually selected covers and icons are not replaced; automatic repair also works offline.
- Xbox identities and the installed executable are checked before accessing bounded, package-contained PNG files. The Rust artwork repair no longer searches Steam by title alone for an Xbox/Game Pass entry, avoiding incorrect cross-store artwork.
- **Still to do:** obtain actual *portrait* cover artwork through verified Microsoft Store/Xbox catalog identity, and support packaged-only Game Pass titles that do not expose the verified GDK executable/manifest ([issue #47](https://github.com/j5bak928-a11y/orbit-game-launcher/issues/47)). Square logos are not stretched into portrait covers. This change is **newly included in v0.2.9**, not in the published 0.2.8 binaries.

### Updating from older versions

- **Fully quit Orbit from the Windows system tray before installing and launching 0.2.9.** Closing the window only keeps Rust's tray process alive for tracking. A running 0.2.7 process can retain control of the single-instance app even after downloading 0.2.8 or later, so neither a new heart UI nor the What's New dialog can appear until that old process exits and the new executable starts. Check the actual executable's version after restarting; downloading an installer alone does not upgrade the running process.
- Rust remains the recommended **experimental, unsigned** Windows preview. Keep its separate `com.orbitlauncher.rustpreview` identity, Electron (`com.orbitlauncher.desktop`) fallback, independent data and backups. Unsigned automatic update installation stays disabled; the application does not silently alter running games or user libraries during an update.

## 0.2.8 — Rust-first Windows release (8 November 2026)

### What's new

- **Rust-first download choice:** the standalone Rust/Tauri 2 Windows preview is the recommended edition to try for 0.2.8. It uses a native Rust backend for the SQLite library, discovery, tracking, artwork and backups, with the familiar Orbit interface in WebView2. The Rust build is separately identified and packaged; the Electron desktop build remains available as a fallback.
- **Fully purple favorited hearts:** saved favorites use a solid configured accent-color heart on poster cards, list rows and game details, including hover and keyboard focus. Unsaved favorites remain outlines. Updated button labels and `aria-pressed` expose the saved state to assistive technology. ([#44](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/44))
- **What's New after installation or update:** the first start of v0.2.8 in a profile shows a release-highlights dialog with both 0.2.8 changes and the inherited 0.2.7 improvements. It can be dismissed, stays dismissed for that version in the same profile, and can always be reopened from **Settings → What's new**. The dialog follows Orbit's five interface languages, keyboard focus and smaller windows.
- **All 0.2.7 improvements retained:** session-history backups and migration protections, the five-language UI, redesigned library and cinematic views, responsive fixes, and full standard-mapped controller navigation are included in the 0.2.8 source. The detailed 0.2.7 history is below.

### Which Windows edition should I download?

- **Recommended for trying Rust:** choose the separately named **Orbit Rust Preview** Windows NSIS setup, or its MSI/portable ZIP if that is your preferred deployment. The portable ZIP must keep `WebView2Loader.dll` and `libunwind.dll` alongside the executable. Confirm that the release assets actually say **0.2.8** before downloading.
- **Fallback:** choose **Orbit Launcher** (Electron) setup or portable EXE if you need the established edition while native Rust behavior is being verified. The two editions have distinct application IDs and SQLite data folders. First-run Rust migration can copy a consistent snapshot of the Electron library, but later changes **do not synchronize**.
- **Limits:** unsigned installers can trigger Windows SmartScreen. Automatic unsigned updates remain disabled. Physical gamepad behavior, real game launches/tracking, installed backup migration, tray recovery and installer upgrades still require full native Windows acceptance; preview source tests and build success do not establish production parity. Keep independent backups and the Electron fallback during the transition.

## 0.2.7 — Major Windows reliability and interface update (7 November 2026)

Version 0.2.7 combined the substantial work since 0.2.6, grouped here by user-visible behavior and safety.

### Game library, discovery and statistics

- Introduced a separate Rust/Tauri 2 desktop preview alongside Electron, retaining the familiar interface and using distinct application IDs and data directories. Improved Windows library/discovery handling, native SQLite, local artwork and executable/storefront recognition without moving installed games. ([#19](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/19), [#20](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/20), [#35](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/35))
- Expanded conservative discovery for supported installed storefront titles, including additional Windows/Xbox PC and Battle.net metadata checks. Kept distinct verified storefront products separate even when they share an executable; ambiguous background tracking avoids assigning one process to multiple games. ([#34](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/34), [#35](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/35))
- Added a **Statistics** experience for recent sessions, daily activity and period summaries. Reports derive from finished session records, coalesce overlapping periods of the *same* game for reporting, and do not rewrite stored playtime. ([#35](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/35))
- Added cinematic Overview/game-details presentation, artwork-first 2:3 poster cards, recent-game showcases and a compact game actions dropdown. Improved artwork loading, local cover/icon fallback and Rust WebView2 artwork routing. ([#20](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/20), [#28](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/28), [#29](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/29), [#33](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/33), [#35](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/35))

### Protecting playtime and backups

- **Complete session-history export/restore:** both Electron and Rust can export completed play sessions with stable IDs, game references, start/end times and durations in JSON and portable `.orbit` backups. The established `orbit.library.v1` / `orbit.portable.v1` formats remain compatible; older archives without individual sessions still import their available data. ([#37](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/37), [#38](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/38))
- **No silent history loss:** exports refuse unfinished/invalid history and excessive session counts instead of claiming a complete archive. Restores validate references and conflicting IDs before database changes, handle sessions transactionally and avoid awarding aggregate playtime twice. Repeated restores skip already imported session IDs. ([#37](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/37), [#38](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/38))
- **Migration safeguards:** first-run Rust import takes a consistent, read-only Electron SQLite snapshot including committed WAL/session data. Existing Rust profiles receive a one-time pre-upgrade SQLite backup; empty, invalid or unrelated files cannot silently count as valid backups. Artwork copy/import uses bounds, temporary files and failure cleanup/rollback, preserving existing images and source libraries. ([#37](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/37), [#38](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/38))
- Hardened Rust tracking against duplicate/phantom external sessions, including shared-executable ambiguity, and improved interruption recovery. Closing the Rust window to the tray releases the WebView2 UI while native tracking continues; native reopen and live-game continuity still need installed acceptance. ([#26](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/26), [#32](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/32), [#34](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/34))

### Language, design and accessibility

- **Five complete interface languages:** English, Nederlands, Deutsch, Français and Español, plus automatic system-language selection. Language preference persists in the local database/backups, and desktop/controller text changes without a restart. ([#39](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/39))
- Poster-card **Play** controls now use the purple/configured accent rather than a neutral treatment. ([#40](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/40))
- Corrected narrow-screen overflow, large hero layouts, poster labels, Settings controls, statistics contrast, modal positioning, focus behavior and controller headers down to 320px. Added **497 route/modal visual snapshots** across five languages, light/dark themes and multiple viewport sizes; these are automated browser scenarios, not hardware acceptance. ([#41](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/41))
- Expanded fullscreen controller navigation for standard-mapped Xbox/PlayStation controls: a fresh **Menu/Options/Start** press can enter from the focused desktop, **LT/RT** and **LB/RB** change pages, right stick scrolls, and View/Share/Guide actions are handled where available. Focus ownership, held-button suppression, reconnects, 5,000-game navigation, narrow layouts, screen-reader state and duplicate-A launch safety received browser and unit coverage. ([#30](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/30), [#31](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/31), [#42](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/42))

### Release presentation and limitations

- Refreshed README, version guidance, Rust/Electron comparison and **four UI screenshots** captured with a synthetic sample library and simulated playtime. The phrase **“Ultra fast cold startup: 1s”** records one user's Windows observation, **not** an independent multi-run benchmark or a guaranteed startup time. ([#43](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/43))
- Kept unsigned Windows build options, local verification and the Electron fallback available. Unsigned automatic update installation remains disabled. Browser fixtures and build output do not replace physical controller, storefront, installer, migration or live tracking acceptance. ([#35](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/35), [#37](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/37))
- Added repository dependency/source/secret scanning and kept build workflows manually triggered during hosted-build limitations. The local Rust build path verifies required Windows runtime DLLs; published installer trust and real hardware acceptance remain separate requirements. ([#23](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/23), [#35](https://github.com/j5bak928-a11y/orbit-game-launcher/pull/35))

For technical backup details, see [Rust 0.2.7 reliability](docs/RUST-0.2.7-RELIABILITY.md), [Tauri migration](docs/TAURI-MIGRATION.md), and [controller verification](docs/VERIFICATION-controller-mode.md).

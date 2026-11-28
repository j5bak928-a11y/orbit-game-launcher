# Changelog

This changelog covers the changes users receive with Orbit's Windows desktop releases. **Starting with 0.3.4, native Rust/Tauri 2 is the sole Orbit Launcher application** (Electron has been retired and removed). Starting with **0.3.6**, in-app updates verify Ed25519 signatures via GitHub Releases (`latest.json`), while manual installers remain Authenticode-unsigned. Release files appear on [GitHub Releases](https://github.com/j5bak928-a11y/orbit-game-launcher/releases); check the version and `SHA256SUMS.txt` before installing.

## 0.6.0 — Orbit Intelligence (Local Insights & Smarter Discovery)

- **Rich Playtime Analytics:** Upgraded **Statistics** with a 12-month (365-day) calendar activity heatmap, current and longest play streaks, average and longest session length, playtime breakdowns by storefront, genre, and play status, and one-click CSV/JSON export with spreadsheet formula-injection protection. Backed by an indexed SQLite query executing in `< 50 ms` on 10,000+ session rows.
- **Per-Game Notes & 1–5 Star Ratings:** Add personal notes (up to 4,000 characters) and 1–5 star personal ratings directly in **Game Details** or the **Edit Game** dialog. Notes and ratings are searchable from the top search bar (including `rating:>=4`, `rating:5`, `rating:unrated` operators and **Highest rated** sorting), displayed cleanly in List View, and round-trip intact through portable `.orbit` and JSON backups.
- **Library Health Check:** Added an on-demand, strictly read-only **Library health check** in **Settings → Library discovery** that identifies missing executables, moved install folders, broken cached covers, and missing covers, with one-click **Relocate .exe**, **Find cover**, **Mark Completed**, **Hide**, and **Remove** actions.
- **Xbox / Packaged Store Discovery 2.0 & Optional SteamGridDB Fallback:** Expanded Xbox / Microsoft Store scanning with native Windows Registry `Appx` package lookup (`AppxManifest.xml` gaming-signal verification + `Square150x150Logo` fallback without spawning subprocesses), plus an optional user-supplied **SteamGridDB API key** in Settings for high-resolution portrait covers and hero banners (stored locally and excluded from backups).

## 0.5.3 — Smarter manual artwork lookup & automatic hero banners

- Manual title lookups now normalize Roman and Arabic numerals (e.g., `Schedule 1` → `Schedule I`), camelCase executable filenames, folder version tags, and official store editions while still rejecting demos, soundtracks, and DLCs.
- Online artwork search, executable inspection, and cover repair fetch wide hero banners alongside portrait covers, and selecting an executable in Add Game automatically checks Steam and Epic Games when online artwork is enabled.

## 0.5.2 — UI polish, streamlined Library & Game Details, and Controller Mode upgrades

- Streamlined the Library toolbar into two rows with focus-preserving filter disclosure, scrollable custom collections, List View action menus, and bulk Favorite/Remove controls; tightened Game Details into two action tiers with inline status selection and unsaved-changes/destructive confirmation guards.
- Synced Controller Mode accent and status colors, added Xbox/PlayStation button prompts, A–Z quick jumping, and polished card action menus.

## 0.5.1 — Faster updates, sharper controller artwork & polished favorites

- Accelerated automatic update checks (startup, reopen, focus, 15-minute cadence) with cache-bypass headers, upgraded Controller Mode covers to true 2:3 poster framing with ambient backdrops, and refined favorite buttons across desktop and Controller Mode.

## 0.5.0 — Console Experience (Controller Mode 2.0)

- **Full 0.4.x library parity in Controller Mode:** Browse **Custom Collections**, **Play Status** shelves (**Currently Playing**, **Backlog**, **Completed**, **On Hold**), **Hidden games**, and multiple sort orders (`A–Z`, `Recently played`, `Most played`, `Recently added`) directly from a couch or handheld.
- **Couch Browse Drawer, Game Options Sheet & Quick Search:** Open the native `<dialog>` **Browse & filter** drawer (`R3` / `F2`), manage play statuses, collections, visibility, and launch alternative **Launch Profiles** from the game profile (`Game options` / `R3`), and search any game without a physical keyboard using the gamepad **Quick search** overlay (`L3` / `Ctrl+F` / `F3`) with an on-screen keyboard and live matches.
- **Zero idle polling, opt-in auto-entry & seamless return:** Controller Mode performs zero background gamepad polling when unfocused or when no standard gamepad is connected. New Settings → **Controller mode** toggles let you auto-enter Controller Mode on startup when a gamepad is connected, enable subtle Web Audio navigation/launch cues (automatically muted during active gameplay), and enable short launch-confirmation rumble pulses. Finishing a Controller Mode game under Windows Performance Guard automatically reopens Orbit right back to your previous shelf, card, and scroll position without overwriting desktop window placement.
- **Controller-mode update & discovery notices:** Actionable inline banners surface verified Orbit updates ready to install and newly discovered games without stealing focus, mirrored permanently inside the Browse drawer across all 5 languages (`en`, `nl`, `de`, `fr`, `es`).

## 0.4.1 — Docked update controls & automatic checks on reopen

- **Redesigned sidebar update dock & Settings panel:** Moved the update action out of the navigation list and anchored it directly above the version footer in `.side-bottom` with live **downloading** (native `<progress>` bar), **ready-to-install**, **busy (game running)**, **installing**, and narrow icon-rail indicator states. Refined **Settings → Performance & updates** with status dots, tabular version badge, native `<progress>`, and leading **Install & restart** hierarchy.
- **Automatic update checks on GUI reopen:** Reopening Orbit from the Windows system tray, restoring from a minimized taskbar state, or reactivating via single-instance launch now automatically triggers a cooldown-guarded (`30s`) background check for signed updates when **Automatic updates** is enabled and no game is active.

## 0.4.0 — Your Gaming Library

- **Play status, hidden games & custom collections:** Organize games with built-in statuses (**Currently Playing**, **Backlog**, **Completed**, **On Hold**), per-game hidden state, and custom SQLite collections with color/icon pickers that round-trip through `.orbit` and JSON backups. Launching a **Backlog** game automatically promotes it to **Currently Playing**.
- **Multi-filter bar, smart search operators & Bulk Action Dock:** Combine storefront, status, collection, tag, category, playtime (`Never played`, `Under 2h`, `2h–10h`, `10h+`), and hidden filters alongside search operators (`status:`, `source:`, `tag:`, `in:`, `time:`, `is:hidden`, `is:fav`), multi-select mode (`Shift+Click` range selection), and a sticky Bulk Action Dock for atomic batch updates.
- **Launch profiles, environment overrides & Xbox AppsFolder support:** Configure per-game working directories, `KEY=VALUE` environment variables, and up to 12 alternative launch profiles (mod loaders, DirectX modes, custom executables/URIs/args/env), plus deterministic `PublisherId` computation and validated `shell:AppsFolder\<PackageFamilyName>!<AppId>` launching for Xbox/GDK titles.

## 0.3.6 — Signed automatic updates and release hardening

- Added cryptographically signed in-app auto-updates using `tauri-plugin-updater` v2 with Ed25519 signature verification against GitHub Releases (`releases/latest/download/latest.json`).
- Added background update checks on startup (configurable under **Settings → Automatic updates**), a sidebar update banner, live download progress, and automatic install protection while a game is running (`Install & restart` quits the tray cleanly before launching the passive NSIS upgrade).
- Enabled `strip = true` in `src-tauri/Cargo.toml` and compiler `--remap-path-prefix` flags in `scripts/windows/build-tauri-local-unsigned.ps1` so release executables omit local workspace and user-profile paths.
- Enforced a restrictive Tauri-level Content Security Policy (`app.security.csp`) in `src-tauri/tauri.conf.json`, ignored updater signing keys/manifests in `.gitignore`, and translated all updater status and `0.3.6` What's New strings across all 5 languages (`en`, `nl`, `de`, `fr`, `es`).

## 0.3.5 — Overview layout, poster cards and accessibility

- Refined Overview hero artwork alignment (`0 px²` overlap across `1440×900` and `910×610`), deduplicated the featured Hero game from `Continue playing`, enabled in-place platform filtering, and translated all library and playtime counters.
- Aligned poster-card corner controls, added a persistent live `Playing` badge during active sessions, replaced nested interactive buttons with sibling triggers, added 2D arrow-key grid navigation and right-click context menus, and isolated `#app` with `inert` while modals are open.
- Added quick management actions in Game Details, plain CLI flag parsing for launch arguments, `Hours` & `Minutes` play-session duration editing, dismissible toasts with hover/focus pause, native Windows dark/light titlebar sync, a `>=12px` typography floor, and WCAG AA contrast in both light and dark themes.

## 0.3.4 — Native Rust main edition (Electron removed)

- Retired and removed the legacy Electron runtime, `electron-builder` packaging, Node backend modules, C++ process-list helper, and Electron workflow/tests so **Rust + Tauri 2 is now the main Orbit Launcher** (`Orbit Launcher`, `com.orbitlauncher.desktop`).
- Updated first-run profile migration to import an existing `com.orbitlauncher.rustpreview` library first (before falling back to legacy Electron folders `orbit-game-launcher` or `Orbit Launcher`) via read-only SQLite `VACUUM INTO` and compatible artwork copy without touching original files.
- Switched Windows release assets from preview naming to standard `Orbit-Launcher-Setup-0.3.4.exe`, `Orbit-Launcher-0.3.4.msi`, and `Orbit-Launcher-Portable-0.3.4.zip`, and excluded leftover Electron `assets/bin` binaries during frontend staging.

## 0.3.3 — Rust recovery, tray and artwork reliability

- Recover interrupted playtime sessions using their last checkpoint timestamp instead of relaunch time, preventing statistics distortion or dropped sessions after >7 days offline, and stop counting valid 0-second sessions as invalid.
- Prevent automatic and manual online artwork scans from permanently starving after 8 unmatched titles, resolve all generated executable titles before scanning artwork, reuse the HTTP client, and preserve valid 5–15 MB user-chosen covers.
- Move tray SQLite queries off the main Windows UI thread, cache tray translations, and preserve prior window bounds when Performance Guard hides a minimized window.
- Synchronize background session polling with exit settlement, clean up active/pending state when removing a game, and retry direct-session DB registration if startup persistence fails transiently.
- Decode portable `.orbit` backups before locking the database, make `save_artwork` staging atomic, serve uppercase `.PNG`/`.WEBP` `orbit-art` MIME types accurately, align `discoverGames` `alreadyAdded` with DB deduplication, discover Steam registry install paths, and skip idle process enumeration.

## 0.3.2 — Playtime and backup reliability

- Preserve playtime tracking when a directly launched game closes during startup.
- Report tracking and save failures without repeating notifications every poll.
- Restore JSON backups with less copying and shorter database lock times. Bound reads for manifests, backup files and artwork.
- Use one Xbox manifest snapshot to verify each game and its artwork.

## 0.3.1 — Play button contrast

- Restored the Play button’s accent color on poster cards. The artwork shading stays behind the button, keeping the label and icon readable.

## 0.3.0 — Library, launches and playtime

- Browse the full collection in Overview. Poster shading now continues smoothly behind the Play button.
- See when a supported storefront launch is waiting for process detection. Orbit prevents repeat launch requests during that wait.
- Review newly discovered games before adding them. Hide scan results temporarily or ignore individual entries across scans.
- View and correct completed playtime sessions from game details. Quick-launch favorites and recent games from the tray, which also shows active session start times.
- Return to the same game and scroll position in controller mode after a tracked play session.

## 0.2.11 — Release-notes close button and neutral window frame (9 November 2026)

- **Aligned X:** the What's New close button follows the right padding of the header at desktop and compact window sizes, and its icon stays centered without inherited padding or overlap.
- **No purple outline around the entire dialog:** the temporary keyboard-focus ring around the modal's outer frame is suppressed. The window retains its subtle neutral border; the close button and other interactive controls retain visible keyboard focus states.
- The first-run release notes preserve the full **0.2.7–0.2.11** history and remain manually accessible, localized in five languages. The purple scrollbar remains unchanged. Windows installers are unsigned; **Quit Orbit from the tray** before updating so the new process starts.

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


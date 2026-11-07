# Orbit Game Launcher

**Your games. One library. Less clutter.**

Orbit is a local-first desktop game launcher for finding, organizing, and playing installed games. It brings games from different storefronts into one library without replacing their launchers or moving their files.

The main desktop application uses **Electron**. A separate, **experimental Rust + Tauri 2 preview** is available for Windows. Both use Orbit's familiar interface; the Rust preview is not yet a production replacement.

![Orbit library with game covers, filters, and search](docs/images/orbit-library-current.png)

> Screenshots use a sample library, public artwork, and simulated playtime. They are UI previews, not measurements of a real gaming session.

## What Orbit can do

- **One game library:** discover supported Steam, Epic, GOG, Battle.net, Xbox PC and standalone installations, add executables, and organize entries with favorites, tags, categories, and filters.
- **Find games quickly:** search with `Ctrl/Cmd + K`, sort the library, and switch between grid and list views.
- **Launch through the right client:** use a game's storefront URI or a validated executable, without moving or modifying game installations.
- **Track playtime:** record supported direct-launch sessions and detect certain externally launched games on Windows. Tracking accuracy depends on how a game starts and which processes can be identified.
- **Show game artwork:** look for validated portrait artwork in bounded neighboring folders, use cached covers and icons offline, optionally look up online artwork, or select your own cover, banner, and icon.
- **Play with a controller:** use a fullscreen, gamepad-friendly library with keyboard and mouse fallback.
- **Choose your language:** use Orbit in English, Nederlands, Deutsch, Français or Español; follow the system language automatically or select one in Settings. Both desktop editions save this preference locally.
- **Review gaming statistics:** recorded-session totals for recent days and weeks, a daily activity chart, recent games and a period-best day. Overlapping records for a single game are deduplicated in reports without rewriting play history.
- **Keep your data local:** store games, settings, and play history in SQLite; export and restore library backups.

<table>
<tr><td><img src="docs/images/orbit-overview-current.png" alt="Orbit Overview with featured game and Continue playing"></td><td><img src="docs/images/orbit-settings-current.png" alt="Orbit appearance and performance settings"></td></tr>
</table>

## Current editions

| | Electron desktop | Rust / Tauri preview |
| --- | --- | --- |
| Version in this repository | **0.2.7** | **0.2.7** |
| Status | Main desktop implementation | Rust reliability update under development (not yet published) |
| UI | Orbit HTML/CSS/JavaScript | The same interface, hosted in WebView2 |
| Backend | Node.js/Electron, with a native Windows process helper | Rust for library, discovery, tracking, artwork, and backups |
| Windows packaging | NSIS setup and portable EXE | NSIS setup, MSI, and portable EXE |
| Game tracking in the tray | Continues while the Electron window is hidden | Rust keeps running while the WebView2 window is destroyed on close |

The editions have **different application IDs and data directories**. On first launch, the Rust preview can make a snapshot of an existing Electron library and copy compatible artwork without modifying the original database. Changes made later in one edition do not automatically sync to the other.

## Roadmap: Rust-first Orbit 1.0

**Direction:** make the fast, local-first Rust/Tauri edition the primary Windows launcher, then develop library organization, a console-quality controller experience, and optional offline intelligence. Keep the existing Electron edition as a fallback during the transition; do not throw away users' libraries or playtime history to accelerate a version bump.

These are **planned milestones, not released features or promised dates**. Electron also uses version `0.2.7`; Rust `0.2.7` is the current reliability development milestone, not an automatically published release.

| Planned Rust version | Theme | Deliverable / exit criteria |
| --- | --- | --- |
| **0.2.7 — Reliability** | Protect the foundation | Preserve the **full session history** in portable backups and restore; verify existing-profile upgrades, first-run library migration, tray recreation, single-instance startup, game tracking and recovery on real Windows fixtures. Keep Electron and Rust libraries separate until verified. |
| **0.3.0 — Rust First** | Primary Windows edition | Use Rust as the actively developed, recommended edition, with Electron still available as a fallback. Confirm game launching, artwork, discovery, controller behavior and playtime parity; provide a reproducible local unsigned installer and portable package. |
| **0.4.0 — Your Gaming Library** | Organization and personalization | Smart collections (**Currently Playing**, **Backlog**, **Completed**), custom collections, advanced filtering, tags, favorites, per-game launch preferences, and responsive libraries with 5,000+ games. |
| **0.5.0 — Console Experience** | Controller Mode 2.0 | A polished fullscreen/couch interface, immersive game details, robust controller ownership and focus recovery, plus efficient idle gamepad polling. |
| **0.6.0 — Orbit Intelligence** | Useful local insights | Offline playtime insights, activity heatmaps, game suggestions, neglected-backlog prompts and optional milestones. No mandatory accounts, constantly running AI service or new background overhead. |
| **1.0.0 — Orbit Complete** | Stable release | Verified install/upgrade/uninstall, safe migration and full backup round trips, reliable session recovery, accessible polished UI, repeatable performance results and documented limitations. |

**Rules for every release:**

1. **Protect performance.** Use the maintainer's observations of roughly **5 MB in tracking-only background use** and **130–180 MB with the UI open** as *reference measurements*, not hard guarantees. Compare whole process trees (including WebView2), startup time, game-launch latency and CPU on matched workloads. Reject unnecessary services, unbounded scans and regressions.
2. **Protect data.** Never silently alter or double-count historical playtime. Test SQLite migrations, backups, restores and crash/sleep recovery using disposable profiles. Do not run separate Electron/Rust trackers against the same game during migration testing without establishing ownership.
3. **Ship useful functionality, not cosmetic version bumps.** Keep the existing Orbit visual identity and use restrained animation. Features must work with actual games and native Windows behavior, not just browser mocks.
4. **Keep local builds available.** Paid GitHub Actions and code signing are **not prerequisites for locally tested, unsigned preview builds**. Signing and trusted update distribution can be considered separately for future public releases; automatic unsigned updates remain disabled.

**Repository maintenance:** GitHub Actions workflows are preserved as optional `workflow_dispatch` tools, but are not triggered by every push, pull request or scheduled run while hosted builds are billing-blocked. Run `npm run check`, `npm test`, `npm run lint`, the browser tests and the native Rust tests locally for each release candidate; do not infer green checks from a skipped hosted workflow.

### Memory usage (maintainer observations)

| Edition / state | Reported RAM |
| --- | ---: |
| Earlier Electron edition, with its UI open | **~300 MB** |
| Rust / Tauri preview, UI open | **~130–180 MB** |
| Rust tracking playtime while gaming, UI closed to tray | **~5 MB** |

Compared with the earlier ~300 MB Electron observation, **130–180 MB with the Tauri window open is approximately 40–57% lower**. This is an *informal comparison*, not a repeatable benchmark: the snapshots were not collected with a controlled workload and consistent process-memory metric. The ~5 MB figure refers to the reported lightweight Rust **tracking/background state**, and must not be confused with the open UI or assumed to include every shared WebView2 process. A visible Tauri window runs WebView2 renderer/GPU processes; looking at the Rust parent alone significantly understates the total.

Closing the Rust preview to the tray now destroys its WebView2 window while native game tracking continues. The window-destruction and Rust-process-survival test passed on Windows; the **complete standalone process-tree RAM delta**, tray reopening, and uninterrupted real-game playtime still need end-to-end verification. Artwork uses lazy loading, and Orbit avoids loading a redundant icon behind a valid cover to reduce unnecessary image work. No fixed additional RAM reduction is claimed for those optimizations.

See [Rust migration](docs/TAURI-MIGRATION.md) and [tray verification](docs/VERIFICATION-TAURI-TRAY-WEBVIEW.md) for methodology and remaining checks.

### Performance comparison: Orbit vs other launchers

This is a **comparison framework, not a claim that Orbit outperforms another launcher**. Steam, Epic Games Launcher, Playnite, Heroic Games Launcher and Ascendara serve different purposes and keep different services running. Published RAM figures from unrelated PCs are not reliable head-to-head benchmarks. The earlier informal Orbit numbers above must **not** be treated as results from this test.

| Launcher | Main UI technology / scope | Controlled idle RAM | Controlled idle CPU |
| --- | --- | --- | --- |
| **Orbit Electron 0.2.7** | Electron; unified local library and tracking | Not measured in common test | Not measured |
| **Orbit Rust Preview 0.2.6** | Tauri 2, Rust, WebView2; native tracking | Not measured in common test | Not measured |
| [Steam](https://store.steampowered.com/about/) | Full storefront and social client with `steamwebhelper` processes | Not measured | Not measured |
| [Epic Games Launcher](https://store.epicgames.com/download) | Storefront, social features and library | Not measured | Not measured |
| [Playnite](https://github.com/JosefNemec/Playnite) | .NET / WPF; unified desktop library and controller mode | Not measured | Not measured |
| [Heroic](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher) | Electron; Epic, GOG and Amazon game management | Not measured | Not measured |
| [Ascendara](https://github.com/Ascendara/ascendara) | Electron; game discovery, management and downloads | Not measured | Not measured |

On Windows, run the **read-only** comparison collector, first with one launcher at a time and then with Orbit, using the same display resolution, similar library size and no game running:

```powershell
powershell -NoProfile -File scripts/windows/compare-launchers-readonly.ps1 -SampleSeconds 5
```

It lists running processes, totals their **Working Set** (MiB) including known browser/helper descendants, and samples CPU as a percentage of all logical processors. Applications not running are reported as **Not running**, not as zero RAM. This script does not install, start, stop, sign in to, or modify any launcher or game. Repeat measurements after startup settles (e.g. 30 seconds), ideally three times, and report medians together with Windows version, launcher versions, library sizes and whether storefront/social features are enabled. Resident Working Set is **not** private/unique RAM: shared memory can be counted more than once. Startup latency, actual in-game overhead and installer size require separate measurements. Do not fill the table with guesses.

## Run the Electron edition

Install [Node.js](https://nodejs.org/) **22.13 or newer** and npm, then:

```bash
npm ci
npm start
```

For development tools, use `npm run dev`. Windows is the primary tested desktop platform; macOS and Linux are supported build targets, but storefront integration should be tested on each target system.

## Run the Rust / Tauri preview on Windows

Install Node.js 22.13+, stable Rust with the MSVC target, Visual Studio C++ Build Tools with the Windows SDK, and Microsoft Edge WebView2.

```bash
npm ci
npm run tauri:dev
```

To create a Windows preview installer:

```bash
npm run tauri:build
```

Tauri builds place the Windows NSIS and MSI packages under `src-tauri/target/release/bundle/`. CI is optional: **you do not need paid GitHub Actions or a code-signing certificate to build an unsigned local preview**. On Windows without MSVC Build Tools, install the `stable-x86_64-pc-windows-gnullvm` Rust toolchain, LLVM-MinGW, Node/npm and 7-Zip, then run:

```powershell
powershell -NoProfile -File scripts/windows/build-tauri-local-unsigned.ps1
```

The script runs native Rust tests, compiles the preview, bundles the GNU-LLVM runtime (`WebView2Loader.dll` and `libunwind.dll`) **beside** the executable in NSIS/MSI, verifies their inclusion, and generates a portable ZIP under `src-tauri/target/x86_64-pc-windows-gnullvm/release/local-distribution/`. A bare executable built with that toolchain cannot be distributed without its runtime DLLs. This script does not install or run Orbit and does not open application profiles. The [Tauri Windows CI workflow](https://github.com/j5bak928-a11y/orbit-game-launcher/actions/workflows/tauri-windows.yml) remains an optional build path, not a prerequisite for local testing.

**This preview is unsigned and not promoted to a production release.** The separate Electron build and installed games remain unaffected. The Rust preview's close-to-tray behavior frees its UI window while retaining native tracking; use **Quit Orbit** in the tray to stop the application completely.

## Finding and launching games

Use **Find installed games** to preview discoveries before importing them, or **Add game** to select an executable manually. Orbit reads available local installation metadata where supported:

| Source | Discovery method / caveat |
| --- | --- |
| Steam | Installed app manifests and declared Steam library folders |
| Epic Games | Installed manifests on Windows; independently launchable expansions retain distinct identities |
| GOG | Local game metadata and supported Windows registry entries; verified separate products are preserved |
| Heroic and Legendary | Installed-game metadata where their launch handlers or executables are available |
| EA, Ubisoft, Battle.net | Conservative Windows registry detection with verified publishers; the Rust preview also reads bounded Battle.net Agent metadata, requiring a real launch target |
| Xbox PC | Validates local `MicrosoftGame.config` and a contained Windows executable in known Xbox install folders or explicitly chosen library folders; protected/packaged games may not be accessible |
| Custom folders | Bounded scans of explicitly selected directories; ambiguous entries may need manual selection |

Discovery is read-only and does not launch games. **Downloads is not scanned automatically.** Some Xbox PC/GDK games require registered Windows app-launch through Gaming Services to obtain title identity; discovering their executable does **not** guarantee that direct EXE launch will work. Protected Microsoft Store installations and unusual launchers may require manual setup. Optional **Scan at startup** is off by default.

Storefront entries still require their respective client and any game-specific authentication. Direct executables are launched without shell command interpolation; advanced launch arguments use a JSON array, for example `["--fullscreen"]`.

## Artwork and library organization

Orbit keeps portrait covers separate from landscape banners. It can reuse local Steam caches and executable icons without the internet. When **Online artwork** is enabled, it can also search Steam and Epic sources for supported matches.

If a cover is missing or incorrect, choose **Settings → Repair library covers**, or select artwork manually when editing the game. Automatic discovery and online lookups are bounded; some titles may need a manual cover. User-selected artwork is not meant to be overwritten by an automatic refresh.

You can customize how covers fit and align, choose library density, switch between light/dark/system themes, and use reduced-motion settings.

The **poster grid** is artwork-first: covers fill a 2:3 card, with a favorite button at the top left, a compact game actions menu at the top right, and a wide blue **Spelen** button along the bottom on hover, keyboard focus, or touch. Only the cards use this visual treatment; Orbit's sidebar, filters, statistics, details dialog, list view and controller screen remain their own layouts. Cards still use one lazily loaded cover each, with an executable icon or named placeholder when artwork is missing.

## Controller mode

![Orbit fullscreen controller mode with sample games](docs/images/orbit-controller-current.png)

Choose the controller button next to Search or press **F11** to enter fullscreen controller mode. Use the D-pad or left stick to navigate, **A / Cross** to select, and **B / Circle** to go back. **LB / RB** switches pages; the on-screen controls remain usable by keyboard and mouse.

Orbit uses the browser's standard gamepad mapping. Not every controller or driver has been tested; `npm run test:controller` verifies the browser-level interactions with simulated controller input.

The cinematic controller detail view keeps game artwork contained and provides a large focused Play action. The connected controller is polled at a lower idle rate instead of using a continuous high-frequency animation loop when no input is happening.

## Gaming statistics and recording limits

Open **Statistics** in the sidebar to view the last 7 and 30 local calendar days, an activity chart, period-best day, recent completed games, and all recorded finished-session time. The calculations read session history, not the game's editable/imported aggregate counter. They omit unfinished checkpoints and flag invalid timestamps; overlapping sessions for the **same game ID** are coalesced in this *report only*. Existing historical sessions and `games.total_play_seconds` are not modified, and separate game IDs or two independently running editions may still have separate records. An old imported library with aggregate playtime but no session rows can show lower recorded-session statistics than game cards.

## Interface languages

Open **Settings → Appearance → Language** to choose **System (automatic)**, English, Nederlands, Deutsch, Français, or Español. The system option follows the browser/WebView2 language when it is supported; otherwise Orbit uses English. Switching languages updates the library interface and fullscreen controller experience without restarting. The language choice is stored with the other local SQLite preferences and included in backups. Game titles, personal tags, filenames, and storefront metadata are **not** machine-translated or renamed.

The built-in localization files live in `src/ui/i18n.js` and require no connection or translation service. New strings must have an English fallback and should be added to all supported language catalogs. Native OS dialogs and game storefront interfaces may continue using their own display language.

## Your data and backups

Orbit stores its library, play history, preferences, and cached artwork locally. Use **Settings → Open folder** to find the current edition's data directory.

- **Portable `.orbit` backup:** includes library metadata, settings, completed play-session history, and cached artwork (within size limits).
- **JSON export:** includes game records, settings, and completed play-session history; artwork bytes are **not embedded**.
- **Restore:** imports supported entries and historical sessions without deleting installed games or inventing playtime; game paths may need adjustment on another computer. Repeating a restore does not re-credit the same session ID.

**Rust 0.2.7 reliability behavior:** The new backup contract saves individual **completed** session records, retaining original session identities and timestamps. Export refuses to claim a complete history while an unfinished session remains; finish any running games before exporting. Older `orbit.library.v1` / `orbit.portable.v1` backups lacking a `sessions` array still import, but **missing historical sessions cannot be reconstructed from aggregate game counters**. First-run migration into an empty Rust profile copies the Electron SQLite library read-only (including sessions). Before the first Rust 0.2.7 database open, an existing Rust library receives a one-time `library.before-rust-0.2.7.sqlite` snapshot alongside it. **Neither edition automatically syncs subsequent changes.** Keep the Electron fallback and independent raw SQLite backups until installed Windows upgrade, restore, and live-session tests are complete.

Orbit does not require an Orbit account or upload game executables. Online artwork requests are optional. Store clients and individual games can still have their own online requirements.

**Shared executable ambiguity:** independently identified storefront products (for example, a base game and an expansion) may legitimately use the *same* executable. Orbit preserves those distinct library entries, but external Windows-process tracking cannot reliably tell which product was started from a shared executable. To avoid crediting the same physical game twice, ambiguous background matches are excluded. Starting the desired entry directly from Orbit can retain explicit game ownership where that launcher path is supported. This is not a claim that every shared executable or GDK title can launch directly.

## Development and verification

```bash
npm run check
npm test
npm run lint
npm run test:controller
npm run test:languages
npm run test:visual
npm run test:renderer
npm run test:experience
npm run test:cinematic
npm run test:cards
npm run bench
```

Renderer and experience tests use Playwright and an installed Chromium-compatible browser. `npm run test:visual` checks responsive layouts, translated labels, keyboard focus and touch actions across five languages, both themes and five viewport sizes using synthetic data. These checks do not prove that real games launch successfully or that packaged Windows WebView2/Electron rendering is identical.

Package the Electron edition on the matching operating system with `npm run dist:win`, `npm run dist:mac`, or `npm run dist:linux`. On Windows, packaged Electron builds also need the native process-inventory helper; GitHub's [Windows build workflow](https://github.com/j5bak928-a11y/orbit-game-launcher/actions/workflows/windows-build.yml) compiles it automatically. Review builds do **not** publish a release; publishing requires the explicit manual workflow option.

Windows installers are currently unsigned. Automatic update installation is disabled until trusted signing and update verification are ready. Do not treat a successful CI build as proof of real-world storefront, tracking, or controller compatibility.

For detailed validation and limits, see [controller-mode verification](docs/VERIFICATION-controller-mode.md), [Tauri migration](docs/TAURI-MIGRATION.md), and [Windows tray lifecycle tests](docs/VERIFICATION-TAURI-TRAY-WEBVIEW.md).

## Troubleshooting

- **Game not found:** check the correct installation drive and scan results, add its library folder, or browse to its executable.
- **Cover missing:** enable online artwork if desired, run **Repair library covers**, or choose a cover yourself.
- **Game won't start:** check the store client, launch URI, executable, working directory, and any game-specific requirements.
- **Playtime seems wrong:** external clients, short-lived launch wrappers, and unrecognized processes can limit tracking.
- **Database problem:** back up the app's data folder before attempting repairs; do not delete the SQLite database to troubleshoot.

## License

MIT — see [LICENSE](LICENSE). Game names, trademarks, and artwork belong to their respective owners.

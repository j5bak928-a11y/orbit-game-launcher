# Orbit — Game Launcher

Orbit is a local-first desktop game launcher with an established Electron edition and a separately installable experimental Rust/Tauri preview. Keep installed games in one fast library, find something to play, and open it through its own launcher or a verified executable. Your library, preferences, artwork and play history stay on your computer.

![Orbit game library showing filters and sample game covers](docs/images/orbit-library-current.png)

Screenshots show the current development interface in a browser preview using a sample library, public Steam artwork, and simulated playtime. They do not show a user’s installed games or measured play history.

## Why we're moving Orbit to Rust

Orbit runs in the background to track games, update playtime and keep the library available. The goal of the Rust/Tauri port is to make those native tasks faster and less resource-intensive without redesigning the familiar interface. Rust handles SQLite, Windows game discovery, process tracking, artwork and backups; Tauri hosts the existing HTML/CSS/JavaScript UI. The original Electron edition remains available while the native preview is tested.

**Windows CI benchmark — 5,000 games, median of three runs on the same runner:**

| Operation | Electron edition's Node.js/SQLite backend | Rust/rusqlite backend | Change |
| --- | ---: | ---: | ---: |
| Insert 5,000 games | 5,169.4 ms | 3,108.0 ms | 39.9% less time |
| List 5,000 games | 65.3 ms | 35.7 ms | 45.3% less time |
| Look up 100 games | 4.5 ms | 2.5 ms | 44.4% less time |
| Benchmark process working set | 87.6 MiB | 30.3 MiB | 65.4% less memory |

**Maintainer-tested RAM:** During hands-on testing of the Rust preview, approximately **5 MB of RAM was observed while a game was running**, and approximately **5 MB while no game was running**. These are the maintainer's reported readings, not the CI benchmark or a verified whole-application measurement. The measurement method and whether WebView2 child processes were included were not recorded, so the 5 MB readings must not be presented as Orbit's total process-tree memory usage.

The benchmark compares isolated database processes, **not complete Electron versus Tauri desktop RAM or startup performance**. Full process-tree measurements, including WebView2, and real-library/game parity checks remain release gates. See [Rust/Tauri migration and verification](docs/TAURI-MIGRATION.md).

## Screenshots

**Overview**

![Orbit overview showing a featured game and continue playing](docs/images/orbit-overview-current.png)

**Settings**

![Orbit settings showing appearance and performance options](docs/images/orbit-settings-current.png)

## Run from source

Use Node.js **22.13 or newer** and npm:

```bash
npm ci
npm start
```

Use `npm run dev` to enable development tools. Windows 10/11, desktop Linux and modern macOS are intended targets; actual storefront integration still needs smoke testing on the target OS. See [verification and limits](docs/VERIFICATION-v0.10.0.md).

## Review branch: performance, recovery and updates (unreleased)

This branch is under review. Do **not** treat its features as a published release or as proof of native Windows performance improvement.

- Windows installer builds compile a small native, read-only Win32 process inventory helper; Orbit uses it for game tracking when available, with its existing bounded PowerShell enumeration as a fallback. Polls adapt to activity (6 seconds around launches, 15 seconds for active sessions, 60 seconds while idle). External processes are still confirmed by installed path, not by filename alone.
- Session checkpoints are batched once per minute. On startup Orbit closes orphaned sessions using the last checkpoint rather than claiming all time since a crash. Windows suspend ends detected sessions and pauses direct-session clocks; resume starts detection again. A crash can still lose up to one minute of uncheckpointed playtime.
- Optional Performance Guard hides the window when a game starts while preserving unsaved edits; the tracker keeps running. This does not release the renderer or change game processes. If the tray is unavailable, Orbit remains visible.
- Game covers have persisted Fill/Fit and Top/Center/Bottom choices; Library density can be Comfortable or Compact. UI typography and interaction affordances have been refined without introducing a framework.
- Electron 45.1.0, restricted IPC sender validation, hardened Electron package fuses and production dependency audit improve baseline security. Windows releases now include a SHA-256 artifact manifest. The files must still be signed before being relied on for a public distribution.
- Automatic updater downloads and installation are disabled until releases are signed and a trusted publisher is pinned. Source and portable builds do not install updates.
  
**Update availability:** In addition to signed releases and publisher verification, external installed users will need an accessible update feed. The current repository is private, and no personal token is embedded.

Native helper build on Windows: use an MSVC Developer PowerShell/Command Prompt with `cl.exe` available, compile `src/native/process-list.cpp` to `assets/bin/orbit-process-list.exe` (link Psapi.lib), then run `npm run dist:win`. GitHub's Windows workflow compiles the helper automatically before packaging.

## What's new in 0.2.1

- A quieter charcoal interface, game-led dashboard, separate landscape hero artwork, compact continue-playing cards and readable portrait covers.
- Platform filters with counts, visible active filters, grid/list views, favorites, tags, categories, sorting, and Ctrl/Cmd+K search.
- Fullscreen controller mode with a Continue playing row, large cards, clear focus, favorites and a paged library.
- Clear pending-launch feedback and protection against repeated clicks. **Choose a game** suggests an existing library game and opens its details before launching.
- A scan report showing which metadata providers completed, their candidate counts, warnings and timing. Preview discoveries and select the games to import.
- More Steam locations, correct Epic catalog launch identities, Heroic/Legendary metadata, nested game executables, and conservative EA/Ubisoft/Blizzard registry detection on Windows.
- Shared, bounded artwork work. Repeated lookups are coalesced, missing art is briefly cached, local icon work stays separate from network work, and stale responses cannot overwrite a game edited while loading.
- A reproducible dependency lock and pull-request Windows build checks.

## Controller mode

![Orbit controller mode showing a sample game library](docs/images/orbit-controller-current.png)

Browser preview with sample games and simulated playtime; no controller is connected.

Choose the **controller button** beside Search or press **F11**. Orbit opens a fullscreen library, focuses your most recently played game, and shows up to eight games in **Continue playing**. All games and Favorites use bounded pages, including with a large library. Selecting a card opens large Play, Favorite and Back controls.

| Action | Controller position / Xbox–PlayStation labels | Keyboard |
| --- | --- | --- |
| Move focus | D-pad or left stick | Arrow keys; Tab / Shift+Tab |
| Select | South button: A / Cross | Enter / Space |
| Back; exit from the library | East button: B / Circle | Escape / Backspace |
| Toggle the focused game's favorite | West button: X / Square | Use the Favorite button in the game sheet |
| Jump to Continue playing | North button: Y / Triangle | Home |
| Previous / next library page | LB / RB | Page Up / Page Down |
| Toggle controller mode | Visible exit control | F11 |

Connect your controller and press then release a button if it has not appeared yet. Orbit uses controllers exposed by Chromium with a **standard** mapping. Unrecognized layouts show a keyboard fallback; the displayed button labels use Xbox/PlayStation positions. Mouse and keyboard remain available without a controller.

Input pauses while Orbit is unfocused, hidden or outside controller mode. Stick drift is filtered, and held selection buttons must be released before another action can fire. Exiting restores the window's previous fullscreen state and returns focus to the entry button. Native fullscreen exit also returns to the desktop library. OS and application reduced-motion preferences are respected.

Run the browser journey with `npm run test:controller`. Tests inject gamepad snapshots and native-window IPC responses; actual USB/Bluetooth hardware, driver mapping and native OS fullscreen still require a desktop smoke test.

## Find your games

Choose **Find installed games** or **Scan for games**, review the results, then import the selected entries. Orbit does not execute a discovered game during scanning.

| Provider | Metadata used | Requirements and limits |
| --- | --- | --- |
| Steam | App manifests, declared libraries, standard/native/Flatpak locations, Windows Steam registry | A verified installation folder and an installed manifest state; supported on Windows/macOS/Linux |
| Epic Games Launcher | Installed `.item` manifests | Windows; uses namespace, catalog item and app name when available; incomplete installs and DLC are excluded |
| GOG | `goggame-*.info` and Windows GOG registry | A contained, platform-appropriate executable; installers and utility targets are rejected |
| Heroic | Installed Epic/Legendary and GOG metadata, including Linux Flatpak config | Heroic must be installed and own its launch URI handler; runtime/authentication is handed back to Heroic |
| Standalone Legendary | `installed.json` | A verified native executable; Windows/Wine games on Linux/macOS without Heroic need manual setup; no Epic client is assumed |
| EA / Ubisoft / Battle.net | Windows uninstall registry | Exact recognized publisher, real installation directory and contained game EXE; records without credible executable metadata are skipped |
| Selected folders | Bounded scans of user-selected directories, including Binaries/Win64-style layouts | Installers, crash tools and symlink cycles are skipped; ambiguous executables require manual selection; macOS app bundles stay separate |

A scan is bounded. If a folder hits its entry limit, choose a smaller game-library folder and rescan. Zero candidates means no usable installed records were found at the supported locations; it does not prove that the launcher is absent. Xbox/Microsoft Store protected packages and other unsupported stores can be added manually when they provide a suitable launch target.

**Downloads is never scanned automatically.** To add a standalone game, use **Add game → Browse**, or explicitly select its game-library folder in Settings. The optional **Scan at startup** setting imports new verified candidates at startup; it is off by default.

## Artwork

Portrait covers and landscape banners are kept separate. Wide store headers never become stretched portrait covers; missing/broken art falls back to a small game icon and readable title.

Orbit reads local Steam cache images and executable icons without requiring a network connection. When **Online artwork** is enabled, public Steam metadata/art and exact-title matching can fill missing artwork, and Epic catalog identifiers can be used to look up Epic covers. No API key is needed. The setting controls online requests, not local cache access. Artwork requests send app IDs or title searches to Steam and Epic catalog identifiers to Epic, never executable files or installation paths.

Use **Settings → Repair library covers** to explicitly retry missing or malformed art. Valid portraits are preserved. Add/Edit Game also lets you choose or clear a cover, banner and icon, or find a cover by its exact title. A delisted or unmatched title may still require manually selected artwork.

## Launching and play time

Storefront URIs require the appropriate installed game client. Direct executables are started with argument arrays and no shell; advanced launch arguments use a JSON array, such as `["--fullscreen"]`. Orbit does not install, modify or inject into games.

Direct-process sessions track time until their process exits. Windows can also detect running Steam/Epic game processes within known installation directories. A launcher wrapper that exits before its child game, an unrecognized vendor runtime or an external URI on other operating systems may not yield accurate tracked time; Orbit does not invent play history.

Use **Enter/Space** to open a focused game, **Tab** to move between controls, **Escape** to close dialogs and **Ctrl/Cmd+K** to search. Light, dark and system themes, six accents, keyboard focus and both OS/app reduced-motion settings remain supported.

## Data and backup

**Settings → Open folder** shows the local SQLite database and artwork cache. Existing libraries are opened in place, including the prior icon-column migration. This upgrade does not change the database format or replace user libraries.

Export a portable **`.orbit` backup** to include metadata, settings and local artwork, or choose **JSON** for metadata only. Restore preserves favorites, tags, dates and tracked time; existing duplicates are skipped. It does not uninstall games or overwrite existing entries. Paths still refer to the original machine and may need editing after a move. Portable backups cap embedded artwork at 100 MB and the compressed archive at 128 MB.

No account, analytics, credential scraping or game-binary upload is used. Games remain in their original locations. Online artwork is optional; the local library and direct-game launch paths work offline, subject to each game's own requirements.

## Build and check

```bash
npm run check
npm test
npm run lint
npm run bench
npm run bench:tracking
npm run test:renderer
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The optional renderer suite needs Playwright and an installed Chrome. It accepts `ORBIT_PLAYWRIGHT_PATH`, `ORBIT_BROWSER_CHANNEL`, `ORBIT_BROWSER_EXECUTABLE` and `ORBIT_QA_OUTPUT` for existing/shared installations. Its IPC is mocked; it does not launch real games. The extended interactive regression suite is `npm run test:experience` and uses the same browser variables.

Build on the target OS. GitHub pull requests run a Windows installer/portable build, verify both EXEs exist, and attempt an artifact upload; PR builds do not publish releases. Artifact storage quotas can prevent downloads even when tests and packaging pass; the job summary reports this separately. Publishing a release requires a manual workflow run with **Publish a Windows release** explicitly enabled; merges, pushes and ordinary manual build checks do not publish releases. Explicit release builds retain a rebuild fallback if artifact storage is unavailable. Unsigned installers may be subject to the OS's normal verification prompts. The build currently disables automatic signing discovery; it does not produce signed installers. When a trusted signing certificate is available, configure a protected signing process, sign both application and installer, and verify their Authenticode signatures and publisher on a clean Windows machine before publishing. Signing alone does not guarantee that SmartScreen warnings disappear. Automatic updates must remain disabled until publisher verification and a trusted feed are implemented and tested.

### Upgrade checklist

Before a release, run `npm test`: release configuration tests check the package and lockfile versions, four-part Windows version, installer filenames, application identity, install scope, and preservation of application data on uninstall. These checks cannot prove that Windows upgrades work. Before publishing, install the previous release in a disposable Windows user profile, add games and settings, export a `.orbit` backup, upgrade in place, and verify games, artwork, favorites, settings, and playtime. Also test launching and uninstalling without deleting user data. Keep the package name, application ID and product name stable unless a tested migration is provided. Version `0.2.4+1` is displayed as `0.2.4.1`; build metadata does not increase SemVer precedence, so choose a properly ordered version before introducing automatic updates.

## Troubleshooting

- **A game is missing:** inspect the scan diagnostics, connect the installation drive, add its actual library folder, or choose its executable manually. Custom store locations outside the known metadata roots may need manual setup.
- **A scan stops early:** use a smaller library folder rather than selecting an entire drive.
- **A cover is missing:** use Repair library covers, check the artwork setting, or choose a portrait manually. Cached local art works offline.
- **A game fails to open:** confirm its store client is installed or edit the executable/working directory. Game-specific authentication, launch arguments or runtimes remain the game's responsibility.
- **Time is not increasing:** check whether the game uses an external launcher or a wrapper process; see the tracking limitations above.
- **Startup cannot open the database:** Orbit reports the data location without deleting it. Back up that directory before making any manual repairs.

## License

MIT; see [LICENSE](LICENSE). Game names and artwork belong to their respective owners.

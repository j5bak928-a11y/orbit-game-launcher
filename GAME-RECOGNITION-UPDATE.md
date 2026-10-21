# Standalone game recognition and artwork — update report

## User story

A local executable with an abbreviated filename, such as `hoi4.exe`, should be added as **Hearts of Iron IV** in Orbit even when Steam, Epic, or GOG has not installed it. The app should preserve the direct executable launch path, discover a cover or icon, and provide a way to find artwork for other standalone titles.

## Changes

- Added a conservative offline alias catalog for popular standalone game executables (`hoi4.exe`, `eu4.exe`, `ck3.exe`, `vic3.exe`, `gta5.exe`, `rdr2.exe` and others). Matched titles never acquire a fabricated Steam source or launch URI. Store IDs are used only to obtain public artwork when enabled.
- Matching considers executable names, up to three relevant parent folder names, and optionally the Windows file-version `ProductName` property. VERSIONINFO is read with Windows PowerShell via a static encoded script and shell-free process arguments. The executable is **not** run for detection. Unsupported or malformed metadata falls back to folder/filename.
- Selecting a recognized executable automatically attempts to cache a matching Steam cover when `Steam artwork` is enabled. It still prefers valid local cover files, and it falls back to the native icon or a gradient offline. Artwork is downloaded with a 4-second timeout and an enforced 5 MB image stream limit, cached by SHA-256 to avoid duplicates.
- Added **Find online cover by title** to the Add/Edit Game dialog. It searches the public Steam Store title search, accepts only exact normalized game-name matches, and downloads a cover if available. This permits users to get artwork for games outside the alias catalog by entering the correct title. Lookups are optional and require the existing artwork setting.
- Custom-folder scanning also resolves known alias names. Optional background artwork fetching applies to imported recognized folder entries.
- The editor preserves custom user-entered titles and existing artwork; selecting an executable still stores its own local path. Removing a game from the library never deletes the binary.

## Verification performed

- Baseline before this change: **40/40** backend tests, syntax validation, and the Chromium integration tests passed.
- `npm run check`: **passed**.
- `npm test`: **51/51 passed**, including offline alias matching, version-resource command encoding, generic filename fallback, local artwork precedence, online/offline behavior, custom-folder imports, exact Steam title matching, rejection of similar titles/DLC, malformed responses, and bounded network payloads.
- `python tests/workflow-integration.py`: **passed**, covering the real IPC handlers and SQLite with a simulated native picker. Specifically added `hoi4.exe` with a simulated Steam cover response, verified **Hearts of Iron IV**, `source: manual`, direct file path preservation, cover caching, and safe removal. The manual **Celeste** title also fetched a cover by exact title using simulated network responses. Existing launch, backup, import and restart workflows passed.
- `python tests/renderer-smoke.py`: **passed**, including the 5,000/20,000-game UI simulations.
- Inspected the Add Game Chromium screenshot; the new artwork search action and automatic-detection feedback fit the existing dialog. Screenshot artwork is a test fixture.
- During final regression testing, adding automatic inspection on text-field blur created a duplicate error notification for invalid paths. That proposed behavior was reverted and the handler-backed workflow returned to passing.

## Limits and release blockers

- The new online artwork source depends on Steam's public search and CDN availability. Steam is neither required to run a manually added executable nor implied to own the game. Games absent from Steam can use nearby artwork, a native icon, or a manually selected cover.
- Recognizing a filename cannot guarantee the actual binary is that title; users can edit the detected name. Product-name extraction from real Windows executables requires native Windows verification.
- Electron dependencies are unavailable in this sandbox, and the connected Windows machine was offline in earlier checks. **No native Windows build/installer or real game executable launch was verified for this update.** This archive contains updated source, not an installer.

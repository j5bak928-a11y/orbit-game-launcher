# Add local executables and detect game artwork

## Implemented

- **Add game → Browse .exe** opens Orbit's native file picker. On Windows it filters `.exe` and `.com`; no game binary is copied or uploaded. Orbit saves the full executable path for local launching.
- After choosing the file, Orbit checks it, fills an empty game title and working directory, and looks for named images in the same folder or in nearby `art`, `artwork` and `images` directories. Recognized names include `cover`, `poster`, `boxart`, `keyart`, `library_600x900`, `folder` and the game name with an artwork suffix. The search is deliberately bounded and avoids unrelated screenshots.
- Orbit asks Electron for the operating system's file icon and stores the resulting PNG if available. Cover artwork is displayed as a poster; a native icon is centered on the existing gradient card if no cover exists. The Edit dialog lets users detect again, choose their own images or clear an image to use the icon fallback.
- Existing SQLite databases gain an optional `icon` column in place and preserve all existing game records and artwork. Portable `.orbit` backups include the icon as well as cover/banner images, and restore all three in a different profile.
- Artwork and extracted icons use stable hash-based filenames, so repeated selection does not produce additional copies of identical images. Invalid or inaccessible nearby artwork is skipped without preventing games from being added.

## Verification performed

- `npm run check`: passed.
- `npm test`: **40/40 passing** including new local-executable discovery, icon fallback, missing files, and database-migration tests.
- `python tests/renderer-smoke.py`: passed including 5,000 and 20,000-game Chromium mock checks.
- `python tests/workflow-integration.py`: passed against the real main-process handlers, SQLite, local file-picker substitute, file selection, automatic cover and icon storage, repeated detection, rename, save, artwork clear, add/remove, safe launch and original regression workflows.
- Inspected `preview-add-executable.png` in Chromium using actual saved fixture image bytes. This is a **browser-rendered preview**, not a native Electron screenshot. The artwork fixture is a colored 1-pixel PNG.

## Known limitations

- Native Windows Electron testing and installer packaging are **not verified** in this environment; Electron is not installed here. Windows icon extraction uses Electron's documented `app.getFileIcon` API, which still requires testing on a Windows computer with real game executables.
- Nearby artwork is best-effort local discovery. A standalone `.exe` often does not contain high-resolution promotional cover artwork; when no nearby image is present Orbit uses the executable icon or its gradient placeholder. Online artwork matching for arbitrary executables is not claimed.
- On a second machine, exported metadata still contains original executable paths, which may need editing. The game binary is never included in a backup.

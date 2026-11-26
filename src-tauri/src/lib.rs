mod artwork;
mod backup;
mod database;
mod files;
mod native;
mod tray;
mod updates;

#[cfg(test)]
mod migration_reliability_tests;

use database::LibraryDatabase;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct ControllerReturn(Mutex<Value>);

struct OrbitState {
    db: Mutex<LibraryDatabase>,
    revision: AtomicU64,
    active: Mutex<HashMap<String, (String, Instant)>>,
    launching: Mutex<HashSet<String>>,
    confirming: Mutex<HashMap<String, Instant>>,
    // A process can exit while SQLite is temporarily locked or unavailable.
    // Keep its final duration until the database has accepted it exactly once.
    pending_finishes: Mutex<HashMap<String, (String, i64)>>,
    artwork_pending: AtomicU64,
    artwork_busy: AtomicBool,
    artwork_misses: Mutex<HashMap<String, (String, Instant)>>,
    repair_lock: Mutex<()>,
    poll_lock: Mutex<()>,
    shutdown: Mutex<bool>,
    shutdown_cv: Condvar,
    data_dir: PathBuf,
    artwork_dir: PathBuf,
}

impl OrbitState {
    fn new(db: LibraryDatabase, data_dir: PathBuf, artwork_dir: PathBuf) -> Self {
        Self {
            db: Mutex::new(db),
            revision: AtomicU64::new(0),
            active: Mutex::new(HashMap::new()),
            launching: Mutex::new(HashSet::new()),
            confirming: Mutex::new(HashMap::new()),
            pending_finishes: Mutex::new(HashMap::new()),
            artwork_pending: AtomicU64::new(0),
            artwork_busy: AtomicBool::new(false),
            artwork_misses: Mutex::new(HashMap::new()),
            repair_lock: Mutex::new(()),
            poll_lock: Mutex::new(()),
            shutdown: Mutex::new(false),
            shutdown_cv: Condvar::new(),
            data_dir,
            artwork_dir,
        }
    }
}

pub(crate) fn apply_window_theme<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    theme: Option<&str>,
) {
    let tauri_theme = match theme {
        Some("light") => Some(tauri::Theme::Light),
        Some("dark") => Some(tauri::Theme::Dark),
        _ => None,
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_theme(tauri_theme);
    }
}

pub(crate) fn sync_saved_window_theme<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let theme = app
        .try_state::<OrbitState>()
        .and_then(|state| state.db.lock().ok().and_then(|db| db.get_settings().ok()))
        .and_then(|settings| {
            settings
                .get("theme")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        });
    apply_window_theme(app, theme.as_deref());
}

fn lock_or_err<'a, T>(mutex: &'a Mutex<T>, label: &str) -> Result<MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|_| format!("Orbit {label} lock is unavailable after an earlier error."))
}

const LEGACY_APP_DATA_DIRS: &[&str] = &[
    "com.orbitlauncher.rustpreview",
    "orbit-game-launcher",
    "Orbit Launcher",
];

fn legacy_library_dir_in(roaming: &Path) -> Option<PathBuf> {
    LEGACY_APP_DATA_DIRS
        .iter()
        .map(|name| roaming.join(name))
        .find(|path| path.join("library.sqlite").is_file())
}

fn legacy_library_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let roaming = PathBuf::from(std::env::var_os("APPDATA")?);
        return legacy_library_dir_in(&roaming);
    }
    #[cfg(not(target_os = "windows"))]
    None
}

// On first launch in a fresh profile directory, snapshot an existing Rust Preview
// or legacy Electron database using read-only SQLite VACUUM INTO so older data
// stays untouched on disk.
fn import_legacy_library(destination: &Path) -> Result<(), String> {
    let Some(old) = legacy_library_dir() else {
        return Ok(());
    };
    if old == destination {
        return Ok(());
    }
    import_legacy_library_from(&old, destination)
}

/// Separate source/destination arguments let us verify first-run migration on
/// disposable SQLite/WAL fixtures without touching real user profiles.
fn import_legacy_library_from(old: &Path, destination: &Path) -> Result<(), String> {
    let target_db = destination.join("library.sqlite");
    if target_db.exists() {
        let metadata = std::fs::symlink_metadata(&target_db).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
            return Err("Existing Orbit library.sqlite is empty or not a safe regular file. Refusing to replace it or silently ignore the prior profile; inspect or restore your backup manually.".into());
        }
        return Ok(());
    }
    std::fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let src = rusqlite::Connection::open_with_flags(
        old.join("library.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("Cannot read existing Orbit library: {e}"))?;
    let temp_db = destination.join(format!(".orbit-import-{}.sqlite", uuid::Uuid::new_v4()));
    let snapshot = src.execute("VACUUM INTO ?1", [temp_db.to_string_lossy().as_ref()]);
    if let Err(error) = snapshot {
        let _ = std::fs::remove_file(&temp_db);
        return Err(format!(
            "Cannot copy existing Orbit library safely: {error}"
        ));
    }
    let result = (|| -> Result<(), String> {
        let from = old.join("artwork");
        let to = destination.join("artwork");
        if from.is_dir() {
            if std::fs::symlink_metadata(&from)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err(
                    "Legacy artwork directory is a symlink; migration will not follow it.".into(),
                );
            }
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            let destination_metadata = std::fs::symlink_metadata(&to).map_err(|e| e.to_string())?;
            if !destination_metadata.is_dir() || destination_metadata.file_type().is_symlink() {
                return Err("Destination artwork directory is not a safe local directory.".into());
            }
            for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !valid_art_name(&name) {
                    continue;
                }
                if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                    continue;
                }
                let metadata = entry.metadata().map_err(|e| e.to_string())?;
                if metadata.len() > 15 * 1024 * 1024 {
                    return Err(format!("Legacy artwork {name} exceeds the safe 15 MB limit; migration was not completed."));
                }
                let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
                if bytes.len() > 15 * 1024 * 1024 {
                    return Err(format!("Legacy artwork {name} changed while migrating; retry without running another Orbit edition."));
                }
                let target = to.join(name.as_ref());
                if let Ok(existing) = std::fs::symlink_metadata(&target) {
                    if existing.file_type().is_symlink()
                        || !existing.is_file()
                        || existing.len() > 15 * 1024 * 1024
                        || std::fs::read(&target).map_err(|e| e.to_string())? != bytes
                    {
                        return Err(format!(
                            "Conflicting existing artwork {name}; migration will not overwrite it."
                        ));
                    }
                    continue;
                }
                // Reserve the final file with a hard link to a complete
                // temporary copy; a failed copy cannot leave a truncated
                // image under its final UUID filename.
                let temporary_artwork =
                    to.join(format!(".orbit-art-import-{}.tmp", uuid::Uuid::new_v4()));
                let installed = (|| -> Result<(), String> {
                    std::fs::write(&temporary_artwork, bytes).map_err(|e| e.to_string())?;
                    std::fs::hard_link(&temporary_artwork, &target).map_err(|e| e.to_string())
                })();
                let _ = std::fs::remove_file(&temporary_artwork);
                installed?;
            }
        }
        // Commit only after artwork has been copied. No live Electron rows
        // or WAL files are modified by the read-only SQLite source handle.
        std::fs::rename(&temp_db, &target_db)
            .map_err(|e| format!("Cannot finalize Orbit library migration: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_db);
    }
    result
}

/// One-time, consistent backup *before* opening/migrating an existing Rust
/// preview library. Unlike copying library.sqlite directly, SQLite VACUUM
/// INTO includes committed WAL transactions. Never overwrite a prior backup.
fn snapshot_rust_library_before_upgrade(destination: &Path) -> Result<bool, String> {
    let current = destination.join("library.sqlite");
    let backup = destination.join("library.before-rust-0.2.7.sqlite");
    if !current.exists() {
        return Ok(false);
    }
    if backup.exists() {
        let metadata = std::fs::symlink_metadata(&backup).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() < 100 {
            return Err("Existing Orbit pre-upgrade backup is not a usable SQLite file; refusing to treat it as recovery protection.".into());
        }
        // Validate the cheap SQLite header on every subsequent launch. A full
        // integrity scan belongs in explicit recovery QA, not the cold path.
        use std::io::Read as _;
        let mut header = [0u8; 16];
        std::fs::File::open(&backup)
            .and_then(|mut file| file.read_exact(&mut header))
            .map_err(|e| format!("Cannot verify pre-upgrade backup: {e}"))?;
        if &header != b"SQLite format 3\0" {
            return Err("Existing Orbit pre-upgrade backup has an invalid SQLite header.".into());
        }
        // A random SQLite file is not a valid Orbit recovery point. Verify
        // the three persistent tables via a cheap read-only schema query;
        // avoid a full integrity scan on every cold startup.
        let verified = rusqlite::Connection::open_with_flags(
            &backup,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .and_then(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('games','sessions','settings')",
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .map_err(|e| format!("Cannot verify Orbit pre-upgrade backup schema: {e}"))?;
        if verified != 3 {
            return Err("Existing pre-upgrade SQLite file does not contain the Orbit library, sessions and settings tables.".into());
        }
        return Ok(false);
    }
    let metadata = std::fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err("Existing Orbit library is not a regular SQLite file.".into());
    }
    let source =
        rusqlite::Connection::open_with_flags(&current, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Cannot read existing Orbit library: {e}"))?;
    let temporary = destination.join(format!(".orbit-upgrade-{}.sqlite", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        source
            .execute("VACUUM INTO ?1", [temporary.to_string_lossy().as_ref()])
            .map_err(|e| format!("Cannot create safe pre-upgrade snapshot: {e}"))?;
        std::fs::rename(&temporary, &backup)
            .map_err(|e| format!("Cannot finalize safe pre-upgrade snapshot: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map(|()| true)
}

fn valid_art_name(name: &str) -> bool {
    let Some((id, ext)) = name.rsplit_once('.') else {
        return false;
    };
    uuid::Uuid::parse_str(id).is_ok()
        && matches!(
            ext.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "webp"
        )
        && name.len() <= 42
}

pub(crate) fn emit(app: &tauri::AppHandle, payload: Value) {
    let menu_changed = payload["type"] == "settingsChanged"
        || (payload["type"] == "gamesChanged" && payload["reason"] != "artwork");
    let _ = app.emit("orbit:event", payload);
    if menu_changed {
        tray::request_menu_refresh(app);
    }
}

const LAUNCH_CONFIRMATION: Duration = Duration::from_secs(90);

fn launch_pending(state: &OrbitState) -> Vec<Value> {
    let now = Instant::now();
    let Ok(mut pending) = state.confirming.lock() else {
        return Vec::new();
    };
    pending.retain(|_, deadline| *deadline > now);
    pending
        .iter()
        .map(|(id, deadline)| {
            let wait_ms = deadline.saturating_duration_since(now).as_millis() as u64;
            json!({"id":id,"waitMs":wait_ms.max(1)})
        })
        .collect()
}

pub(crate) fn launch_game(app: &tauri::AppHandle, id: &str) -> Result<Value, String> {
    launch_game_with_profile(app, id, None)
}

fn launch_game_with_profile(
    app: &tauri::AppHandle,
    id: &str,
    profile_id: Option<&str>,
) -> Result<Value, String> {
    let state = app.state::<OrbitState>();
    let _reservation = reserve_game_launch(&state, id)?;
    let game = lock_or_err(&state.db, "database")?.get(id)?;
    if game.is_null() {
        return Err("Game not found".into());
    }
    let mut result = native::launch_game_with_profile(&game, profile_id)?;
    if result["mode"] == "external" {
        let absolute_path = |key: &str| {
            game[key]
                .as_str()
                .is_some_and(|path| Path::new(path).is_absolute())
        };
        let watchable = cfg!(windows)
            && (absolute_path("executable")
                || (matches!(game["source"].as_str(), Some("steam" | "epic" | "xbox"))
                    && absolute_path("install_path")));
        if watchable {
            lock_or_err(&state.confirming, "launch confirmation")?
                .insert(id.into(), Instant::now() + LAUNCH_CONFIRMATION);
            let wait_ms = LAUNCH_CONFIRMATION.as_millis() as u64;
            result["confirmationTimeoutMs"] = json!(wait_ms);
            emit(
                app,
                json!({"type":"launchPending","id":id,"waitMs":wait_ms}),
            );
        }
        if let Err(error) = lock_or_err(&state.db, "database")?.record_external_launch(id) {
            emit(
                app,
                json!({"type":"error","message":format!("Launcher opened, but recent-play information could not be saved: {error}")}),
            );
            result["message"] =
                json!("Launcher opened. Recent-play information could not be saved.");
        }
    }
    if result["tracked"].as_bool() == Some(true) {
        let session_result = lock_or_err(&state.db, "database")?.start_session(id);
        match session_result {
            Ok(session_id) => {
                lock_or_err(&state.active, "active sessions")?
                    .insert(id.to_string(), (session_id, Instant::now()));
                native::acknowledge_direct_session(id);
            }
            Err(error) => {
                result["tracked"] = json!(false);
                result["message"] = json!("Game launched, but play-time tracking could not start.");
                emit(
                    app,
                    json!({"type":"error","message":format!("Game launched, but play time could not be recorded: {error}")}),
                );
            }
        }
    }
    notify_game(app, &state, id, "launch");
    let settings = state.db.lock().ok().and_then(|db| db.get_settings().ok());
    if let Some(settings) = settings {
        let _ = tray::hide_for_performance_guard(
            app,
            settings["performanceGuard"] == true,
            !running_ids(&state).is_empty(),
        );
    }
    Ok(result)
}

fn running_ids(state: &OrbitState) -> Vec<String> {
    let Ok(active) = state.active.lock() else {
        return Vec::new();
    };
    let mut ids: Vec<String> = active.keys().cloned().collect();
    ids.sort();
    ids
}

pub(crate) fn has_busy_game(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<OrbitState>() else {
        return false;
    };
    if !running_ids(&state).is_empty() || !launch_pending(&state).is_empty() {
        return true;
    }
    state
        .launching
        .lock()
        .is_ok_and(|launching| !launching.is_empty())
}

pub(crate) fn auto_updates_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<OrbitState>()
        .and_then(|state| state.db.lock().ok().and_then(|db| db.get_settings().ok()))
        .is_some_and(|settings| settings["autoUpdates"] == true)
}

struct LaunchReservation<'a> {
    state: &'a OrbitState,
    id: String,
}

impl Drop for LaunchReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut launching) = self.state.launching.lock() {
            launching.remove(&self.id);
        }
    }
}

fn reserve_game_launch<'a>(
    state: &'a OrbitState,
    id: &str,
) -> Result<LaunchReservation<'a>, String> {
    // The reservation and checks share one mutex with native activity
    // registration and session completion, closing the check/spawn race.
    let mut launching = state.launching.lock().map_err(|error| error.to_string())?;
    if !launching.insert(id.to_string()) {
        return Err("This game is already launching".into());
    }
    // Session ownership also spans confidently identical Steam/Epic and
    // manually linked copies of one installation, not just one library ID.
    let aliases = state
        .db
        .lock()
        .map_err(|error| error.to_string())
        .and_then(|db| db.list_activity_games())
        .map(|games| native::installation_alias_ids(&games, id));
    let aliases = match aliases {
        Ok(ids) => ids,
        Err(error) => {
            launching.remove(id);
            return Err(error);
        }
    };
    {
        let now = Instant::now();
        let mut confirming = lock_or_err(&state.confirming, "launch confirmation")?;
        confirming.retain(|_, deadline| *deadline > now);
        if confirming.contains_key(id) || aliases.iter().any(|other| confirming.contains_key(other))
        {
            launching.remove(id);
            return Err("This game is already launching".into());
        }
    }
    {
        let active = lock_or_err(&state.active, "active sessions")?;
        let pending = lock_or_err(&state.pending_finishes, "pending finishes")?;
        if aliases.iter().any(|other| {
            launching.contains(other) || active.contains_key(other) || pending.contains_key(other)
        }) {
            launching.remove(id);
            return Err(
                "This installation already has a tracked session running or saving.".into(),
            );
        }
        if active.contains_key(id) {
            launching.remove(id);
            return Err("This game is already running".into());
        }
        // Reject before spawning the executable. Otherwise a temporary SQLite
        // failure could leave an old finalization queued, launch a second game,
        // and only THEN fail to create its new playtime row.
        if pending.contains_key(id) {
            launching.remove(id);
            return Err("Orbit is still saving this game's playtime. Try again shortly.".into());
        }
    }
    Ok(LaunchReservation {
        state,
        id: id.to_string(),
    })
}

// Called while holding the launching reservation mutex. A process snapshot
// can become stale between Windows enumeration and SQLite registration, so
// activity must recheck other aliases just before opening its session.
fn activity_registration_conflicts(
    state: &OrbitState,
    watchlist: &Value,
    id: &str,
    launching: &HashSet<String>,
) -> bool {
    let aliases = native::installation_alias_ids(watchlist, id);
    let (Ok(active), Ok(pending)) = (state.active.lock(), state.pending_finishes.lock()) else {
        return true;
    };
    launching.contains(id)
        || active.contains_key(id)
        || pending.contains_key(id)
        || aliases.iter().any(|other| {
            launching.contains(other) || active.contains_key(other) || pending.contains_key(other)
        })
}

fn online_artwork_allowed(state: &OrbitState) -> bool {
    // Release SQLite before inspecting running games to avoid lock inversion
    // with the session poller. This check is repeated for every Steam request.
    let settings = state.db.lock().ok().and_then(|db| db.get_settings().ok());
    let Some(settings) = settings else {
        return false;
    };
    settings["useSteamArtwork"] == true
        && !(settings["performanceGuard"] == true && !running_ids(state).is_empty())
}

fn snapshot(state: &OrbitState) -> Result<Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let games = db.list("name")?;
    let collections = db.list_collections()?;
    drop(db);
    Ok(
        json!({"games":games,"collections":collections,"runningIds":running_ids(state),"launchPending":launch_pending(state),"revision":state.revision.load(Ordering::SeqCst)}),
    )
}

fn changed(
    app: &tauri::AppHandle,
    state: &OrbitState,
    games: Vec<Value>,
    removed_ids: Vec<Value>,
    reason: &str,
    reset: bool,
) {
    let revision = state.revision.fetch_add(1, Ordering::SeqCst) + 1;
    let mut msg = json!({"type":"gamesChanged","reason":reason,"revision":revision,"runningIds":running_ids(state)});
    if !reset {
        msg["games"] = json!(games);
        msg["removedIds"] = json!(removed_ids);
    }
    emit(app, msg);
}

// Fetch the record before emitting: emitting may need the active-session lock.
// Never hold the SQLite mutex while acquiring the active-session mutex.
fn notify_game(app: &tauri::AppHandle, state: &OrbitState, id: &str, reason: &str) {
    let game = state.db.lock().ok().and_then(|db| db.get(id).ok());
    if let Some(game) = game.filter(|g| !g.is_null()) {
        changed(app, state, vec![game], vec![], reason, false);
    }
}

// Automatic suggestions never rewrite a user-supplied title. Only a clearly
// generated executable label or an exact old executable-stem title qualifies.
fn replaceable_name(game: &Value) -> bool {
    if game["source"] != "manual" && game["source"] != "folder" {
        return false;
    }
    let Some(name) = game["name"].as_str().map(str::trim) else {
        return false;
    };
    if name.is_empty() || name.len() > 140 {
        return false;
    }
    if [
        "bootstrappackagedgame",
        "game-win64-shipping",
        "unityplayer",
        "win64-shipping",
    ]
    .contains(&name.to_ascii_lowercase().as_str())
    {
        return true;
    }
    let Some(executable) = game["executable"].as_str() else {
        return false;
    };
    let Some(stem) = Path::new(executable).file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    name.eq_ignore_ascii_case(stem)
}

fn trustworthy_detected_name(previous: &str, info: &Value) -> bool {
    let Some(name) = info["name"].as_str().map(str::trim) else {
        return false;
    };
    info["recognized"] == true
        && !name.is_empty()
        && name.len() <= 140
        && ![
            "untitled game",
            "bootstrappackagedgame",
            "game-win64-shipping",
        ]
        .contains(&name.to_ascii_lowercase().as_str())
        && !name.eq_ignore_ascii_case(previous)
}

/// Returns true when another bounded background pass is needed. The visited
/// set belongs to one scan generation, so stale entries cannot be retried
/// indefinitely or prevent later entries from being inspected.
fn refresh_generated_names(app: &tauri::AppHandle, visited: &mut HashSet<String>) -> bool {
    let state = app.state::<OrbitState>();
    let Some(games) = state
        .db
        .lock()
        .ok()
        .and_then(|db| db.list("name").ok())
        .and_then(|games| games.as_array().cloned())
    else {
        return false;
    };
    // Work through every candidate once, including those after missing files.
    // Each pass is bounded by time, not a fixed first 150 game rows.
    let candidates = games
        .iter()
        .filter(|game| replaceable_name(game))
        .filter(|game| game["id"].as_str().is_some_and(|id| !visited.contains(id)))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return false;
    }
    let started = Instant::now();
    let mut examined = 0;
    while examined < candidates.len() && started.elapsed() < Duration::from_secs(8) {
        let game = candidates[examined];
        examined += 1;
        let Some(id) = game["id"].as_str() else {
            continue;
        };
        visited.insert(id.to_owned());
        let (Some(path), Some(previous)) = (game["executable"].as_str(), game["name"].as_str())
        else {
            continue;
        };
        let Ok(info) = native::inspect_game_title(path) else {
            continue;
        };
        if !trustworthy_detected_name(previous, &info) {
            continue;
        }
        let name = info["name"].as_str().unwrap();
        let updated = state.db.lock().ok().and_then(|mut db| {
            let current = db.get(id).ok()?;
            if current["name"] != game["name"] || current["executable"] != game["executable"] {
                return None;
            }
            db.update(id, &json!({"name":name})).ok()
        });
        if let Some(updated) = updated {
            changed(app, &state, vec![updated], vec![], "name-detection", false);
        }
    }
    examined < candidates.len()
}

// Cover repair runs outside the UI thread, after boot and when the library
// changes. Keep a single worker so duplicate scans cannot race with edits.
// A generation counter guarantees that a concurrent import triggers another
// pass even when a slow online artwork request is already running.
fn queue_artwork_scan(app: &tauri::AppHandle) {
    let state = app.state::<OrbitState>();
    state.artwork_pending.fetch_add(1, Ordering::SeqCst);
    if state.artwork_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let last_processed = loop {
            std::thread::sleep(Duration::from_millis(900));
            let state = handle.state::<OrbitState>();
            if state.shutdown.lock().is_ok_and(|stopped| *stopped) {
                return;
            }
            let generation = state.artwork_pending.load(Ordering::SeqCst);
            let mut visited_names = HashSet::new();
            // Resolve generated executable titles across the full library first
            // so newly detected titles can receive artwork in the following scan.
            while refresh_generated_names(&handle, &mut visited_names) {
                if state.shutdown.lock().is_ok_and(|stopped| *stopped) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            for pass in 0..4 {
                if state.shutdown.lock().is_ok_and(|stopped| *stopped)
                    || state.artwork_pending.load(Ordering::SeqCst) != generation
                {
                    break;
                }
                match handle_command(&handle, "repairSteamArtwork", &[json!("automatic")]) {
                    Ok(report) => {
                        let more_online = report["onlineEnabled"] == true
                            && report["paused"] != true
                            && (report["truncated"] == true || report["found"].as_u64() == Some(8));
                        if !more_online || pass == 3 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(400));
                    }
                    Err(error) => {
                        eprintln!("Orbit automatic artwork scan: {error}");
                        break;
                    }
                }
            }
            if state.artwork_pending.load(Ordering::SeqCst) == generation {
                break generation;
            }
        };
        let state = handle.state::<OrbitState>();
        state.artwork_busy.store(false, Ordering::SeqCst);
        if !state.shutdown.lock().is_ok_and(|stopped| *stopped)
            && state.artwork_pending.load(Ordering::SeqCst) != last_processed
        {
            queue_artwork_scan(&handle);
        }
    });
}

#[cfg(test)]
mod automatic_artwork_tests {
    use super::*;

    #[test]
    fn repairs_only_auto_generated_manual_titles() {
        let sample = |name: &str, source: &str, executable: &str| {
            json!({
                "name":name,"source":source,"executable":executable
            })
        };
        assert!(replaceable_name(&sample(
            "BootstrapPackagedGame",
            "manual",
            r"C:\Games\Bodycam\Bodycam.exe"
        )));
        assert!(replaceable_name(&sample(
            "creed",
            "manual",
            r"C:\Games\Assassins Creed Mirage\creed.exe"
        )));
        assert!(!replaceable_name(&sample(
            "Assassin's Creed Mirage",
            "manual",
            r"C:\Games\Assassins Creed Mirage\creed.exe"
        )));
        assert!(!replaceable_name(&sample(
            "Fortnite",
            "epic",
            r"C:\Games\Fortnite\FortniteClient-Win64-Shipping.exe"
        )));
        assert!(!replaceable_name(&sample(
            "My custom name",
            "manual",
            r"C:\Games\Foo\game.exe"
        )));
    }

    #[test]
    fn rejects_untrusted_auto_title_without_downgrading_existing_name() {
        assert!(!trustworthy_detected_name(
            "BootstrapPackagedGame",
            &json!({"name":"Untitled game","recognized":false,"name_source":"filename"})
        ));
        assert!(!trustworthy_detected_name(
            "BootstrapPackagedGame",
            &json!({"name":"Downloads","recognized":false,"name_source":"filename"})
        ));
        assert!(trustworthy_detected_name(
            "BootstrapPackagedGame",
            &json!({"name":"Bodycam","recognized":true,"name_source":"folder"})
        ));
        assert!(!trustworthy_detected_name(
            "My Game",
            &json!({"name":"My Game","recognized":true,"name_source":"metadata"})
        ));
    }
}

fn argument<'a>(args: &'a [Value], index: usize) -> Result<&'a Value, String> {
    args.get(index)
        .ok_or_else(|| format!("Missing argument {index}"))
}
fn str_argument<'a>(args: &'a [Value], index: usize) -> Result<&'a str, String> {
    argument(args, index)?
        .as_str()
        .ok_or_else(|| format!("Argument {index} must be a string"))
}
fn game_id(args: &[Value]) -> Result<&str, String> {
    let id = str_argument(args, 0)?;
    if !database::valid_backup_id(id) {
        return Err("Invalid game identifier".into());
    }
    Ok(id)
}

#[cfg(test)]
mod backup_game_id_acceptance_tests {
    use super::*;

    #[test]
    fn imported_historical_game_ids_remain_accessible_to_all_game_commands() {
        for id in [
            "legacy-game-001",
            "old.steam:1234",
            "db:history:edition_a",
            "legacy/path:edition-A",
            r"legacy\path",
            "..",
            "bc69e933-023b-4574-bfef-1522a6ab61ca",
        ] {
            assert_eq!(game_id(&[json!(id)]).unwrap(), id);
        }
        for id in ["", " ", "two\nlines", "zero\0byte", " leading", "trailing "] {
            assert!(
                game_id(&[json!(id)]).is_err(),
                "accepted malformed game ID: {id:?}"
            );
        }
        assert!(game_id(&[json!("x".repeat(129))]).is_err());
        assert!(game_id(&[Value::Null]).is_err());
    }

    #[test]
    fn legacy_non_uuid_game_id_survives_restore_and_parameterized_database_access() {
        let root = std::env::temp_dir().join(format!("orbit-api-legacy-{}", uuid::Uuid::new_v4()));
        let file = root.join("db.sqlite");
        let mut db = database::LibraryDatabase::open(&file).unwrap();
        let legacy_id = "legacy.title:before-uuid";
        let payload = json!({
            "format":"orbit.library.v1",
            "games":[{"id":legacy_id,"name":"Legacy playable title","source":"gog","source_id":"legacy-001"}],
            "sessions":[{"id":"legacy-session-1","game_id":legacy_id,
                "started_at":"2025-01-01T10:00:00Z","finished_at":"2025-01-01T10:02:00Z","seconds":120}]
        });
        assert_eq!(db.restore_json(&payload).unwrap()["sessionsImported"], 1);
        let id_args = [json!(legacy_id)];
        let id = game_id(&id_args).unwrap();
        assert_eq!(db.get(id).unwrap()["name"], "Legacy playable title");
        assert_eq!(db.toggle_favorite(id).unwrap()["favorite"], true);
        assert_eq!(
            db.update(id, &json!({"name":"Playable again"})).unwrap()["name"],
            "Playable again"
        );
        let session = db.start_session(id).unwrap();
        assert!(db.finish_session(&session, 10).unwrap());
        assert_eq!(db.get(id).unwrap()["total_play_seconds"], 10);
        assert_eq!(
            db.export_json().unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(db.remove(id).unwrap());
        assert!(db.get(id).unwrap().is_null());

        // SQL metacharacters are not interpolated into a query or used as
        // paths; a forged lookup cannot select a different library game.
        let untouched = db.upsert(&json!({"name":"Untouched"})).unwrap();
        let suspicious = "' OR 1=1 --";
        assert!(db.get(suspicious).unwrap().is_null());
        assert_eq!(db.count().unwrap(), 1);
        assert!(!untouched["game"]["id"].as_str().unwrap().is_empty());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn choose_file(app: &tauri::AppHandle, extensions: &[&str]) -> Result<Option<PathBuf>, String> {
    Ok(app
        .dialog()
        .file()
        .add_filter("Files", extensions)
        .blocking_pick_file()
        .map(|selected| selected.into_path().map_err(|e| e.to_string()))
        .transpose()?)
}
fn choose_folder(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|selected| selected.into_path().map_err(|e| e.to_string()))
        .transpose()?)
}
fn save_artwork(source: &Path, artwork_dir: &Path) -> Result<String, String> {
    let meta = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > 15 * 1024 * 1024 {
        return Err("Artwork must be an image file smaller than 15 MB".into());
    }
    let bytes = files::read_regular_bounded(source, 15 * 1024 * 1024)?;
    if bytes.is_empty() {
        return Err("Artwork must be smaller than 15 MB".into());
    }
    let ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let valid = match ext.as_str() {
        "png" => bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(&b"WEBP"[..]),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        _ => false,
    };
    if !valid {
        return Err("Invalid image format".into());
    }
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let name = format!(
        "{}-{}-{}-{}-{}.{}",
        &digest[..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32],
        ext
    );
    std::fs::create_dir_all(artwork_dir).map_err(|e| e.to_string())?;
    let path = artwork_dir.join(&name);
    let temporary = artwork_dir.join(format!(".orbit-art-{}.tmp", uuid::Uuid::new_v4()));
    use std::io::Write;
    let write_tmp = (|| -> Result<(), std::io::Error> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()
    })();
    if let Err(error) = write_tmp {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    let linked = std::fs::hard_link(&temporary, &path);
    let _ = std::fs::remove_file(&temporary);
    match linked {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_file())
                || files::read_regular_bounded(&path, 15 * 1024 * 1024)? != bytes
            {
                return Err("Artwork name collision detected".into());
            }
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::Unsupported | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            match std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
            {
                Ok(mut file) => {
                    if let Err(write_err) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
                        let _ = std::fs::remove_file(&path);
                        return Err(write_err.to_string());
                    }
                }
                Err(exists) if exists.kind() == std::io::ErrorKind::AlreadyExists => {
                    if !std::fs::symlink_metadata(&path)
                        .is_ok_and(|meta| meta.file_type().is_file())
                        || files::read_regular_bounded(&path, 15 * 1024 * 1024)? != bytes
                    {
                        return Err("Artwork name collision detected".into());
                    }
                }
                Err(other) => return Err(other.to_string()),
            }
        }
        Err(error) => return Err(error.to_string()),
    }
    Ok(name)
}

fn restored_artwork_token(value: &Value, dir: &Path) -> String {
    use std::io::Read;
    let Some(token) = value.as_str() else {
        return String::new();
    };
    if !valid_art_name(token) {
        return String::new();
    }
    let path = dir.join(token);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return String::new();
    };
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > 15 * 1024 * 1024 {
        return String::new();
    }
    let Ok(mut file) = std::fs::File::open(&path) else {
        return String::new();
    };
    let mut header = [0u8; 12];
    let Ok(count) = file.read(&mut header) else {
        return String::new();
    };
    let valid = match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => count >= 8 && header[..8] == [137, 80, 78, 71, 13, 10, 26, 10],
        "jpg" | "jpeg" => count >= 3 && header[..3] == [255, 216, 255],
        "webp" => count >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP",
        _ => false,
    };
    if valid {
        token.to_string()
    } else {
        String::new()
    }
}

fn sanitize_restore_payload(payload: &mut Value, artwork_dir: &Path) -> Result<(), String> {
    if payload["format"] != "orbit.library.v1" {
        return Err("Invalid Orbit backup format".into());
    }
    let games = payload["games"].as_array_mut().ok_or("Invalid game list")?;
    if games.len() > 100_000 {
        return Err("Too many games in backup".into());
    }
    for game in games.iter_mut().filter_map(Value::as_object_mut) {
        for field in ["cover", "banner", "icon"] {
            let token = game
                .get(field)
                .map(|value| restored_artwork_token(value, artwork_dir))
                .unwrap_or_default();
            game.insert(field.into(), json!(token));
        }
    }
    Ok(())
}

fn write_json_backup(path: &Path, payload: &Value) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Backup folder unavailable")?;
    let file_name = path
        .file_name()
        .ok_or("Backup filename unavailable")?
        .to_string_lossy();
    let temporary = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let write = (|| -> Result<(), String> {
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut output, payload).map_err(|e| e.to_string())?;
        if output.metadata().map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
            return Err(
                "JSON backup exceeds the 128 MB restore limit; no incomplete export was saved."
                    .into(),
            );
        }
        output.flush().map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        std::fs::rename(&temporary, path).map_err(|e| format!("Cannot finalize backup: {e}"))?;
        Ok(())
    })();
    if write.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write
}

const ARTWORK_MISS_TTL: Duration = Duration::from_secs(6 * 3600);

fn artwork_lookup_signature(game: &Value) -> String {
    format!(
        "{}|{}|{}",
        game["source"].as_str().unwrap_or(""),
        game["source_id"].as_str().unwrap_or(""),
        game["name"].as_str().unwrap_or("")
    )
}

fn prioritize_unattempted_games(
    games: &[Value],
    misses: &mut HashMap<String, (String, Instant)>,
) -> Vec<Value> {
    let now = Instant::now();
    misses.retain(|_, (_, at)| now.duration_since(*at) < ARTWORK_MISS_TTL);
    let mut fresh = Vec::with_capacity(games.len());
    let mut deferred = Vec::new();
    for game in games {
        let missed = game["id"].as_str().is_some_and(|id| {
            misses
                .get(id)
                .is_some_and(|(sig, _)| *sig == artwork_lookup_signature(game))
        });
        if missed {
            deferred.push(game.clone());
        } else {
            fresh.push(game.clone());
        }
    }
    fresh.extend(deferred);
    fresh
}

fn handle_command(app: &tauri::AppHandle, method: &str, args: &[Value]) -> Result<Value, String> {
    let state = app.state::<OrbitState>();
    match method {
        "bootstrap" => {
            let mut result = snapshot(&state)?;
            result["settings"] = lock_or_err(&state.db, "database")?.get_settings()?;
            result["platform"] = json!(platform());
            result["version"] = json!(app.package_info().version.to_string());
            result["controllerReturn"] =
                lock_or_err(&app.state::<ControllerReturn>().0, "controller state")?.clone();
            Ok(result)
        }
        "saveControllerReturn" => {
            let position = argument(args, 0)?;
            if !position.is_null() && (!position.is_object() || position.to_string().len() > 2048) {
                return Err("Invalid controller return position.".into());
            }
            *lock_or_err(&app.state::<ControllerReturn>().0, "controller state")? =
                position.clone();
            Ok(Value::Null)
        }
        "librarySnapshot" => snapshot(&state),
        "listGames" => lock_or_err(&state.db, "database")?.list("name"),
        "getStatistics" => {
            let days = match args.first() {
                None | Some(Value::Null) => 30,
                Some(Value::Object(options)) => match options.get("days") {
                    None | Some(Value::Null) => 30,
                    Some(value) => value
                        .as_i64()
                        .ok_or("Statistics days must be an integer from 7 to 90.")?,
                },
                _ => return Err("Statistics options must be an object.".into()),
            };
            lock_or_err(&state.db, "database")?.get_statistics(days)
        }
        "listSessions" => {
            let page = args
                .get(1)
                .map_or(Ok(0), |page| page.as_i64().ok_or("Invalid session page."))?;
            lock_or_err(&state.db, "database")?.list_sessions(game_id(args)?, page)
        }
        "correctSession" => {
            let id = game_id(args)?;
            let seconds = argument(args, 2)?
                .as_i64()
                .ok_or("Invalid session duration.")?;
            let game = lock_or_err(&state.db, "database")?.correct_session(
                id,
                str_argument(args, 1)?,
                seconds,
            )?;
            changed(app, &state, vec![game.clone()], vec![], "playtime", false);
            Ok(game)
        }
        "runningGames" => Ok(json!(running_ids(&state))),
        "getGame" => lock_or_err(&state.db, "database")?.get(game_id(args)?),
        "addGame" => {
            let result = lock_or_err(&state.db, "database")?.upsert(argument(args, 0)?)?;
            if let Some(game) = result.get("game").cloned() {
                changed(app, &state, vec![game], vec![], "add", false);
                queue_artwork_scan(app);
            }
            Ok(result)
        }
        "updateGame" => {
            let id = game_id(args)?;
            let game = lock_or_err(&state.db, "database")?.update(id, argument(args, 1)?)?;
            if let Ok(mut misses) = state.artwork_misses.lock() {
                misses.remove(id);
            }
            changed(app, &state, vec![game.clone()], vec![], "edit", false);
            if argument(args, 1)?.get("executable").is_some()
                || argument(args, 1)?.get("name").is_some()
                || game["cover"].as_str().unwrap_or("").is_empty()
            {
                queue_artwork_scan(app);
            }
            Ok(game)
        }
        "removeGame" => {
            let id = game_id(args)?;
            let result = lock_or_err(&state.db, "database")?.remove(id)?;
            if result {
                if let Ok(mut confirming) = state.confirming.lock() {
                    confirming.remove(id);
                }
                if let Ok(mut active) = state.active.lock() {
                    active.remove(id);
                }
                if let Ok(mut pending) = state.pending_finishes.lock() {
                    pending.remove(id);
                }
                if let Ok(mut misses) = state.artwork_misses.lock() {
                    misses.remove(id);
                }
                native::forget_game(id);
                changed(app, &state, vec![], vec![json!(id)], "remove", false);
                if let Ok(collections) =
                    lock_or_err(&state.db, "database").and_then(|db| db.list_collections())
                {
                    emit(
                        app,
                        json!({"type":"collectionsChanged","collections":collections}),
                    );
                }
            }
            Ok(json!(result))
        }
        "favoriteGame" => {
            let game = lock_or_err(&state.db, "database")?.toggle_favorite(game_id(args)?)?;
            changed(app, &state, vec![game.clone()], vec![], "favorite", false);
            Ok(game)
        }
        "listCollections" => lock_or_err(&state.db, "database")?.list_collections(),
        "createCollection" => {
            let created =
                lock_or_err(&state.db, "database")?.create_collection(argument(args, 0)?)?;
            let collections = lock_or_err(&state.db, "database")?.list_collections()?;
            emit(
                app,
                json!({"type":"collectionsChanged","collections":collections}),
            );
            Ok(created)
        }
        "updateCollection" => {
            let id = str_argument(args, 0)?;
            let updated =
                lock_or_err(&state.db, "database")?.update_collection(id, argument(args, 1)?)?;
            let collections = lock_or_err(&state.db, "database")?.list_collections()?;
            emit(
                app,
                json!({"type":"collectionsChanged","collections":collections}),
            );
            Ok(updated)
        }
        "deleteCollection" => {
            let id = str_argument(args, 0)?;
            let deleted = lock_or_err(&state.db, "database")?.delete_collection(id)?;
            if deleted {
                let collections = lock_or_err(&state.db, "database")?.list_collections()?;
                emit(
                    app,
                    json!({"type":"collectionsChanged","collections":collections}),
                );
            }
            Ok(json!(deleted))
        }
        "setGameCollections" => {
            let id = game_id(args)?;
            let ids = argument(args, 1)?
                .as_array()
                .ok_or("Expected collection IDs array.")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or("Invalid collection ID.")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let collections = lock_or_err(&state.db, "database")?.set_game_collections(id, &ids)?;
            emit(
                app,
                json!({"type":"collectionsChanged","collections":collections.clone()}),
            );
            Ok(collections)
        }
        "bulkUpdateGames" => {
            let ids = argument(args, 0)?
                .as_array()
                .ok_or("Expected game IDs array.")?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or("Invalid game ID."))
                .collect::<Result<Vec<_>, _>>()?;
            let result =
                lock_or_err(&state.db, "database")?.bulk_update_games(&ids, argument(args, 1)?)?;
            if let Some(updated_games) = result.get("updatedGames").and_then(Value::as_array) {
                if !updated_games.is_empty() {
                    changed(app, &state, updated_games.clone(), vec![], "bulk", false);
                }
            }
            if let Some(collections) = result.get("collections") {
                emit(
                    app,
                    json!({"type":"collectionsChanged","collections":collections}),
                );
            }
            Ok(result)
        }
        "saveSettings" => {
            let settings = lock_or_err(&state.db, "database")?.save_settings(argument(args, 0)?)?;
            apply_window_theme(
                app,
                settings.get("theme").and_then(serde_json::Value::as_str),
            );
            emit(app, json!({"type":"settingsChanged","settings":settings}));
            if argument(args, 0)?.get("useSteamArtwork").is_some()
                || argument(args, 0)?.get("performanceGuard").is_some()
            {
                queue_artwork_scan(app);
            }
            Ok(settings)
        }
        "getWindowState" => {
            let window = app
                .get_webview_window("main")
                .ok_or("Orbit window unavailable")?;
            Ok(json!({"fullscreen":window.is_fullscreen().map_err(|e|e.to_string())?}))
        }
        "setFullscreen" => {
            let enabled = argument(args, 0)?
                .as_bool()
                .ok_or("Fullscreen state must be boolean")?;
            let window = app
                .get_webview_window("main")
                .ok_or("Orbit window unavailable")?;
            window.set_fullscreen(enabled).map_err(|e| e.to_string())?;
            emit(app, json!({"type":"windowState","fullscreen":enabled}));
            Ok(json!({"fullscreen":enabled}))
        }
        "chooseExecutable" => Ok(json!(choose_file(
            app,
            if cfg!(windows) {
                &["exe", "com"][..]
            } else {
                &["*"][..]
            }
        )?
        .map(|p| p.to_string_lossy().to_string()))),
        "chooseFolder" => Ok(json!(
            choose_folder(app)?.map(|p| p.to_string_lossy().to_string())
        )),
        "chooseArtwork" => Ok(json!(choose_file(app, &["png", "jpg", "jpeg", "webp"])?
            .map(|path| save_artwork(&path, &state.artwork_dir))
            .transpose()?)),
        "inspectGameFile" => {
            let mut info = native::inspect_game_file(str_argument(args, 0)?)?;
            if let Some(path) = info["local_artwork"].as_str() {
                if let Ok(token) = save_artwork(Path::new(path), &state.artwork_dir) {
                    info["cover"] = json!(token);
                    info["cover_source"] = json!("local");
                }
            }
            if let Some(obj) = info.as_object_mut() {
                obj.remove("local_artwork");
            }
            Ok(info)
        }
        "openGameFolder" => {
            let game = lock_or_err(&state.db, "database")?.get(game_id(args)?)?;
            native::open_game_folder(&game)
        }
        "openAppData" => native::open_path(&state.data_dir.to_string_lossy()),
        "getAppInfo" => Ok(
            json!({"platform":platform(),"version":app.package_info().version.to_string(),"dataPath":state.data_dir.to_string_lossy()}),
        ),
        "discoverGames" => {
            use sha2::{Digest, Sha256};
            static STARTUP_DISCOVERY_ATTEMPTED: AtomicBool = AtomicBool::new(false);
            if args.first() == Some(&Value::Bool(true))
                && (!running_ids(&state).is_empty()
                    || STARTUP_DISCOVERY_ATTEMPTED.swap(true, Ordering::Relaxed))
            {
                return Ok(Value::Null);
            }
            let settings = lock_or_err(&state.db, "database")?.get_settings()?;
            let mut result = native::discover_games(&settings)?;
            let games = lock_or_err(&state.db, "database")?.list("name")?;
            let known = database::LibraryDuplicateIndex::from_games(
                games.as_array().map(Vec::as_slice).unwrap_or(&[]),
            );
            if let Some(items) = result.get_mut("games").and_then(Value::as_array_mut) {
                for game in items {
                    game["alreadyAdded"] = json!(known.contains(game));
                    let identity = database::duplicate_key(game);
                    if !identity.is_empty() {
                        game["discoveryKey"] =
                            json!(format!("{:x}", Sha256::digest(identity.as_bytes())));
                    }
                }
            }
            Ok(result)
        }
        "importGames" => {
            let games = argument(args, 0)?.as_array().ok_or("Expected game list")?;
            if games.len() > 10_000 {
                return Err("Import list is too large".into());
            }
            let mut result = json!({"imported":0,"skipped":0,"errors":[]});
            for batch in games.chunks(50) {
                let next = lock_or_err(&state.db, "database")?.upsert_batch(batch)?;
                result["imported"] = json!(
                    result["imported"].as_u64().unwrap_or(0)
                        + next["imported"].as_u64().unwrap_or(0)
                );
                result["skipped"] = json!(
                    result["skipped"].as_u64().unwrap_or(0) + next["skipped"].as_u64().unwrap_or(0)
                );
                if let Some(errors) = next["errors"].as_array() {
                    result["errors"]
                        .as_array_mut()
                        .unwrap()
                        .extend(errors.iter().cloned());
                }
            }
            changed(app, &state, vec![], vec![], "import", true);
            if result["imported"].as_u64().unwrap_or(0) > 0 {
                queue_artwork_scan(app);
            }
            Ok(result)
        }
        "launchGame" => {
            let profile_id = args.get(1).and_then(Value::as_str);
            launch_game_with_profile(app, game_id(args)?, profile_id)
        }
        "getUpdateStatus" => Ok(updates::current_status(app)),
        "checkForUpdates" => Ok(updates::start_check(app)),
        "installUpdate" => updates::install_prepared(app).map(|()| json!({"started":true})),
        "findOnlineCover" => {
            let settings = lock_or_err(&state.db, "database")?.get_settings()?;
            if settings["useSteamArtwork"] != true {
                return Err("Enable online artwork in Settings first.".into());
            }
            if settings["performanceGuard"] == true && !running_ids(&state).is_empty() {
                return Err(
                    "Online artwork is paused by Performance Guard while a game is running.".into(),
                );
            }
            artwork::find_online_cover_guarded(str_argument(args, 0)?, &state.artwork_dir, &|| {
                online_artwork_allowed(&state)
            })
        }
        "repairSteamArtwork" => {
            let _repair_guard = lock_or_err(&state.repair_lock, "artwork repair")?;
            let (settings, games) = {
                let db = lock_or_err(&state.db, "database")?;
                (db.get_settings()?, db.list("name")?)
            };
            let enabled = settings["useSteamArtwork"] == true;
            let paused = settings["performanceGuard"] == true && !running_ids(&state).is_empty();
            let originals_raw = games.as_array().ok_or("Invalid game list")?;
            let originals = {
                let mut misses = lock_or_err(&state.artwork_misses, "artwork cache")?;
                prioritize_unattempted_games(originals_raw, &mut misses)
            };
            // Automatic enrichment fills missing artwork only. The explicit
            // Repair button remains allowed to replace a landscape cover.
            let automatic = args.first().and_then(Value::as_str) == Some("automatic");
            let allowed = || online_artwork_allowed(&state);
            let mut result = if automatic {
                artwork::repair_artwork_auto_guarded(
                    &originals,
                    &state.artwork_dir,
                    enabled,
                    paused,
                    &allowed,
                )?
            } else {
                artwork::repair_artwork_guarded(
                    &originals,
                    &state.artwork_dir,
                    enabled,
                    paused,
                    &allowed,
                )?
            };
            let original_by_id: HashMap<String, &Value> = originals
                .iter()
                .filter_map(|game| Some((game["id"].as_str()?.to_string(), game)))
                .collect();
            let mut changes = Vec::new();
            let mut updated_covers = HashSet::new();
            let mut covers = 0;
            let mut icons = 0;
            if let Some(updates) = result["updates"].as_array() {
                let mut db = lock_or_err(&state.db, "database")?;
                for patch in updates {
                    let Some(id) = patch["id"].as_str() else {
                        continue;
                    };
                    let Some(original) = original_by_id.get(id) else {
                        continue;
                    };
                    let current = db.get(id)?;
                    if current.is_null()
                        || game_identity(&current) != game_identity(original)
                        || current["name"] != original["name"]
                        || current["source"] != original["source"]
                        || current["install_path"] != original["install_path"]
                    {
                        continue;
                    }
                    let mut allowed = serde_json::Map::new();
                    for key in ["cover", "icon"] {
                        if patch.get(key).is_some() && current[key] == original[key] {
                            allowed.insert(key.into(), patch[key].clone());
                        }
                    }
                    if allowed.is_empty() {
                        continue;
                    }
                    let changed_game = db.update(id, &Value::Object(allowed.clone()))?;
                    if allowed.contains_key("cover") {
                        covers += 1;
                        updated_covers.insert(id.to_owned());
                    }
                    if allowed.contains_key("icon") {
                        icons += 1;
                    }
                    changes.push(changed_game);
                }
            }
            if let Some(attempted_ids) = result["onlineAttempted"].as_array() {
                if let Ok(mut misses) = state.artwork_misses.lock() {
                    let now = Instant::now();
                    for id in attempted_ids.iter().filter_map(Value::as_str) {
                        if updated_covers.contains(id) {
                            misses.remove(id);
                        } else if let Some(game) = original_by_id.get(id) {
                            if misses.len() >= 5_000 {
                                misses.retain(|_, (_, at)| {
                                    now.duration_since(*at) < ARTWORK_MISS_TTL
                                });
                                if misses.len() >= 5_000 {
                                    misses.clear();
                                }
                            }
                            misses.insert(id.to_owned(), (artwork_lookup_signature(game), now));
                        }
                    }
                }
            }
            if !changes.is_empty() {
                changed(app, &state, changes, vec![], "artwork", false);
            }
            result["found"] = json!(covers);
            result["icons"] = json!(icons);
            if let Some(obj) = result.as_object_mut() {
                obj.remove("updates");
                obj.remove("onlineAttempted");
            }
            Ok(result)
        }
        "exportLibrary" => {
            let Some(path) = app
                .dialog()
                .file()
                .add_filter("Orbit backup", &["orbit", "json"])
                .blocking_save_file()
                .map(|v| v.into_path().map_err(|e| e.to_string()))
                .transpose()?
            else {
                return Ok(Value::Null);
            };
            // Export is one SQLite snapshot of games, settings and completed
            // sessions. Incomplete live sessions must not be silently omitted.
            let payload = lock_or_err(&state.db, "database")?.export_json()?;
            let count = payload["games"].as_array().map_or(0, Vec::len);
            if path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .eq_ignore_ascii_case("json")
            {
                write_json_backup(&path, &payload)?;
                Ok(json!({"path":path,"count":count,"portable":false}))
            } else {
                backup::export_backup(&payload, &state.artwork_dir, &path)
            }
        }
        "restoreLibrary" => {
            let Some(path) = choose_file(app, &["orbit", "json"])? else {
                return Ok(Value::Null);
            };
            let portable = path.extension().and_then(|s| s.to_str()) == Some("orbit");
            let json_payload = if portable {
                None
            } else {
                let bytes = files::read_regular_bounded(&path, backup::MAX_ARCHIVE)
                    .map_err(|error| format!("Cannot read JSON backup (128 MB limit): {error}"))?;
                let mut payload =
                    serde_json::from_slice::<Value>(&bytes).map_err(|error| error.to_string())?;
                drop(bytes);
                sanitize_restore_payload(&mut payload, &state.artwork_dir)?;
                Some(payload)
            };
            let result = if let Some(payload) = json_payload {
                lock_or_err(&state.db, "database")?.restore_json(&payload)?
            } else {
                // Decompress and decode outside the DB mutex; acquire and retain
                // DB ownership from preflight through artwork install, commit,
                // and cleanup so concurrent writes cannot alter identity mapping.
                let mut db_guard = None;
                let mut staged =
                    backup::import_backup_checked_staged(&path, &state.artwork_dir, |library| {
                        let mut db = lock_or_err(&state.db, "database")?;
                        db.preflight_restore_json(library)?;
                        db_guard = Some(db);
                        Ok(())
                    })?;
                let mut db = match db_guard.take() {
                    Some(db) => db,
                    None => lock_or_err(&state.db, "database")?,
                };
                let payload = staged.library_mut();
                let restore = sanitize_restore_payload(payload, &state.artwork_dir)
                    .and_then(|()| db.restore_json(payload));
                // Old v1 restores can succeed partially. Preserve artwork used
                // by any committed game and prune only newly installed files
                // that are unreferenced after the database operation.
                let live_artwork = if restore.is_ok() {
                    db.list("name").ok().and_then(|library| {
                        library.as_array().map(|games| {
                            games
                                .iter()
                                .flat_map(|game| {
                                    ["cover", "banner", "icon"]
                                        .into_iter()
                                        .filter_map(|field| game[field].as_str().map(str::to_owned))
                                })
                                .collect::<HashSet<_>>()
                        })
                    })
                } else {
                    None
                };
                staged.finish(restore, live_artwork.as_ref())?
            };
            changed(app, &state, vec![], vec![], "restore", true);
            if let Ok(collections) =
                lock_or_err(&state.db, "database").and_then(|db| db.list_collections())
            {
                emit(
                    app,
                    json!({"type":"collectionsChanged","collections":collections}),
                );
            }
            queue_artwork_scan(app);
            Ok(result)
        }
        _ => Err(format!("Orbit command '{method}' is unavailable")),
    }
}

fn game_identity(game: &Value) -> String {
    let get = |key: &str| game[key].as_str().unwrap_or("").to_ascii_lowercase();
    if !get("source_id").is_empty() && !get("source").is_empty() {
        return format!("{}:{}", get("source"), get("source_id"));
    }
    if !get("executable").is_empty() {
        return format!("file:{}", get("executable"));
    }
    if !get("launch_uri").is_empty() {
        return format!("uri:{}", get("launch_uri"));
    }
    format!("name:{}", get("name"))
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

#[tauri::command]
async fn orbit_invoke(
    app: tauri::AppHandle,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || handle_command(&app, &method, &args))
        .await
        .map_err(|e| e.to_string())?
}

fn queue_finished_session(state: &OrbitState, id: &str, seconds: Option<i64>) {
    // Make the move from active to pending atomic relative to a new launch.
    let Ok(_launching) = state.launching.lock() else {
        return;
    };
    let Ok(mut active) = state.active.lock() else {
        return;
    };
    let Some((session_id, started)) = active.remove(id) else {
        return;
    };
    let elapsed = seconds.unwrap_or(started.elapsed().as_secs() as i64);
    if let Ok(mut pending) = state.pending_finishes.lock() {
        pending.insert(id.to_string(), (session_id, elapsed));
    }
}

fn flush_finished_sessions(state: &OrbitState, mut report_error: impl FnMut(&str)) -> Vec<String> {
    let Ok(pending_guard) = state.pending_finishes.lock() else {
        return Vec::new();
    };
    let pending = pending_guard
        .iter()
        .map(|(id, (session, seconds))| (id.clone(), session.clone(), *seconds))
        .collect::<Vec<_>>();
    drop(pending_guard);
    let mut completed = Vec::new();
    for (game_id, session_id, seconds) in pending {
        let result = lock_or_err(&state.db, "database")
            .and_then(|mut db| db.finish_session(&session_id, seconds));
        match result {
            Ok(_) => {
                if let Ok(mut map) = state.pending_finishes.lock() {
                    map.remove(&game_id);
                }
                completed.push(game_id);
            }
            Err(error) => report_error(&error),
        }
    }
    completed
}

#[derive(Default)]
struct TrackingDiagnostics {
    last_log: HashMap<&'static str, Instant>,
    last_notice: Option<Instant>,
}

impl TrackingDiagnostics {
    fn report(&mut self, app: &tauri::AppHandle, stage: &'static str, error: &str) {
        const INTERVAL: Duration = Duration::from_secs(300);
        let now = Instant::now();
        if self
            .last_log
            .get(stage)
            .is_none_or(|last| now.duration_since(*last) >= INTERVAL)
        {
            self.last_log.insert(stage, now);
            eprintln!("Orbit playtime ({stage}): {error}");
        }
        if self
            .last_notice
            .is_none_or(|last| now.duration_since(last) >= INTERVAL)
        {
            self.last_notice = Some(now);
            emit(
                app,
                json!({
                    "type":"error",
                    "message":"Orbit could not update playtime. Tracking will retry in the background."
                }),
            );
        }
    }
}

fn poll_sessions(app: &tauri::AppHandle, diagnostics: &mut TrackingDiagnostics) {
    let state = app.state::<OrbitState>();
    for id in flush_finished_sessions(&state, |error| {
        diagnostics.report(app, "finish session", error);
    }) {
        notify_game(app, &state, &id, "playtime");
    }
    // Keep the reservation set stable while inspecting child handles. A fast
    // exit must remain in the native tracker until its session is registered.
    let exits = match state.launching.lock() {
        Ok(launching) => native::poll_sessions(&launching),
        Err(error) => Err(error.to_string()),
    };
    let exits = exits.unwrap_or_else(|error| {
        diagnostics.report(app, "direct process check", &error);
        Value::Null
    });
    if let Some(error) = exits["error"].as_str() {
        diagnostics.report(app, "direct process check", error);
    }
    let mut observed: HashMap<String, u64> = HashMap::new();
    if let Some(checkpoints) = exits["checkpoints"].as_array() {
        for checkpoint in checkpoints {
            if let (Some(id), Some(seconds)) = (
                checkpoint["game_id"].as_str(),
                checkpoint["seconds"].as_u64(),
            ) {
                observed.insert(id.to_string(), seconds);
            }
        }
    }
    if let Some(unregistered) = exits["unregistered"].as_array() {
        for id in unregistered.iter().filter_map(Value::as_str) {
            let Ok(launching) = state.launching.lock() else {
                break;
            };
            if launching.contains(id) {
                continue;
            }
            let already_tracked = state.active.lock().is_ok_and(|a| a.contains_key(id))
                || state
                    .pending_finishes
                    .lock()
                    .is_ok_and(|p| p.contains_key(id));
            if already_tracked {
                continue;
            }
            let session =
                lock_or_err(&state.db, "database").and_then(|mut db| db.start_session(id));
            match session {
                Ok(session_id) => {
                    if let Ok(mut active) = state.active.lock() {
                        active.insert(id.to_string(), (session_id, Instant::now()));
                    }
                    native::acknowledge_direct_session(id);
                    drop(launching);
                    notify_game(app, &state, id, "playtime");
                }
                Err(error) => {
                    drop(launching);
                    diagnostics.report(app, "register direct session", &error);
                }
            }
        }
    }
    if let Some(items) = exits["completed"].as_array() {
        for item in items {
            let Some(id) = item["game_id"].as_str() else {
                continue;
            };
            queue_finished_session(&state, id, item["seconds"].as_i64());
        }
        if !items.is_empty() {
            tray::request_menu_refresh(app);
        }
    }
    for id in flush_finished_sessions(&state, |error| {
        diagnostics.report(app, "finish session", error);
    }) {
        notify_game(app, &state, &id, "playtime");
    }
    // External launcher processes are tracked from verified install paths by
    // the Rust Windows process-inventory implementation.
    let watchlist = if cfg!(windows) {
        lock_or_err(&state.db, "database")
            .and_then(|db| db.list_activity_games())
            .map_err(|error| diagnostics.report(app, "read tracked games", &error))
            .ok()
    } else {
        None
    };
    if let Some(watchlist) = watchlist {
        let activity = native::poll_activity(&watchlist)
            .map_err(|error| diagnostics.report(app, "process inventory", &error))
            .ok();
        if let Some(activity) = activity {
            if let Some(checkpoints) = activity["checkpoints"].as_array() {
                for checkpoint in checkpoints {
                    if let (Some(id), Some(seconds)) = (
                        checkpoint["game_id"].as_str(),
                        checkpoint["seconds"].as_u64(),
                    ) {
                        observed.insert(id.to_string(), seconds);
                    }
                }
            }
            if let Some(started) = activity.get("started").and_then(Value::as_array) {
                for id in started.iter().filter_map(Value::as_str) {
                    // While a direct launch is between its reservation,
                    // native spawn, and database insertion, automatic
                    // inventory detection must not claim the same game or
                    // its manually linked/storefront alias.
                    let Ok(launching) = state.launching.lock() else {
                        break;
                    };
                    if activity_registration_conflicts(&state, &watchlist, id, &launching) {
                        continue;
                    }
                    let session =
                        lock_or_err(&state.db, "database").and_then(|mut db| db.start_session(id));
                    let session = match session {
                        Ok(session) => session,
                        Err(error) => {
                            drop(launching);
                            diagnostics.report(app, "register detected session", &error);
                            continue;
                        }
                    };
                    if let Ok(mut active) = state.active.lock() {
                        active.insert(id.into(), (session, Instant::now()));
                    }
                    if let Ok(mut confirming) = state.confirming.lock() {
                        confirming.remove(id);
                    }
                    native::acknowledge_activity_session(id);
                    drop(launching);
                    notify_game(app, &state, id, "playtime");
                    let settings = state.db.lock().ok().and_then(|db| db.get_settings().ok());
                    if let Some(settings) = settings {
                        let _ = tray::hide_for_performance_guard(
                            app,
                            settings["performanceGuard"] == true,
                            !running_ids(&state).is_empty(),
                        );
                    }
                }
            }
            if let Some(finished) = activity.get("finished").and_then(Value::as_array) {
                for item in finished {
                    let Some(id) = item["game_id"].as_str() else {
                        continue;
                    };
                    queue_finished_session(&state, id, item["seconds"].as_i64());
                }
                if !finished.is_empty() {
                    tray::request_menu_refresh(app);
                }
                for id in flush_finished_sessions(&state, |error| {
                    diagnostics.report(app, "finish session", error);
                }) {
                    notify_game(app, &state, &id, "playtime");
                }
            }
        }
    }
    let checkpoints: Vec<Value> = state
        .active
        .lock()
        .map(|active| {
            active
                .iter()
                .filter_map(|(id, (session, _))| {
                    Some(json!({"id":session,"seconds":observed.get(id)?}))
                })
                .collect()
        })
        .unwrap_or_default();
    if !checkpoints.is_empty() {
        let checkpoint = lock_or_err(&state.db, "database")
            .and_then(|mut db| db.checkpoint_sessions(&checkpoints));
        if let Err(error) = checkpoint {
            diagnostics.report(app, "save session checkpoints", &error);
        }
    }
}

pub(crate) fn settle_sessions(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<OrbitState>() else {
        return;
    };
    if let Ok(mut stopped) = state.shutdown.lock() {
        *stopped = true;
        state.shutdown_cv.notify_all();
    }
    let _poll_guard = state.poll_lock.lock();
    let elapsed: HashMap<String, i64> = native::stop_sessions()
        .ok()
        .and_then(|value| value["completed"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|row| {
            Some((
                row["game_id"].as_str()?.to_string(),
                row["seconds"].as_i64()?,
            ))
        })
        .collect();
    let ended: Vec<_> = state
        .active
        .lock()
        .map(|mut active| active.drain().collect())
        .unwrap_or_default();
    for (id, (session_id, started)) in ended {
        let seconds = elapsed
            .get(&id)
            .copied()
            .unwrap_or(started.elapsed().as_secs() as i64);
        if let Ok(mut pending) = state.pending_finishes.lock() {
            pending.insert(id, (session_id, seconds));
        }
    }
    flush_finished_sessions(&state, |error| {
        eprintln!("Orbit: cannot finish playtime on exit: {error}");
    });
}

#[cfg(test)]
mod playtime_persistence_tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn stale_activity_snapshot_cannot_register_while_direct_alias_launches() {
        let folder =
            std::env::temp_dir().join(format!("orbit-alias-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let db = LibraryDatabase::open(&folder.join("library.sqlite")).unwrap();
        let state = OrbitState::new(db, folder.clone(), folder.join("artwork"));
        let watchlist = json!([
            {"id":"store","name":"Example","source":"steam","install_path":r"D:\SteamLibrary\steamapps\common\Example"},
            {"id":"direct","name":"Example","source":"manual","executable":r"D:\SteamLibrary\steamapps\common\Example\Bin\Example.exe"},
            {"id":"bonus","name":"Independent Bonus","source":"manual","executable":r"D:\SteamLibrary\steamapps\common\Example\DLC\Bonus.exe"}
        ]);
        let mut launching = HashSet::from(["direct".to_string()]);
        assert!(activity_registration_conflicts(
            &state, &watchlist, "store", &launching
        ));
        assert!(!activity_registration_conflicts(
            &state, &watchlist, "bonus", &launching
        ));
        launching.clear();
        state
            .active
            .lock()
            .unwrap()
            .insert("direct".into(), ("direct-session".into(), Instant::now()));
        assert!(activity_registration_conflicts(
            &state, &watchlist, "store", &launching
        ));
        state.active.lock().unwrap().clear();
        state
            .pending_finishes
            .lock()
            .unwrap()
            .insert("direct".into(), ("direct-session".into(), 20));
        assert!(activity_registration_conflicts(
            &state, &watchlist, "store", &launching
        ));
        state.pending_finishes.lock().unwrap().clear();
        assert!(!activity_registration_conflicts(
            &state, &watchlist, "store", &launching
        ));
        drop(state);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn failed_finish_is_retained_and_retried_exactly_once_after_sqlite_unlocks() {
        let folder = std::env::temp_dir().join(format!("orbit-dedup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("library.sqlite");
        let mut db = LibraryDatabase::open(&file).unwrap();
        let game = db.upsert(&json!({"name":"Retryable session"})).unwrap()["game"].clone();
        let id = game["id"].as_str().unwrap().to_string();
        let session = db.start_session(&id).unwrap();
        let state = OrbitState::new(db, folder.clone(), folder.join("artwork"));
        state
            .active
            .lock()
            .unwrap()
            .insert(id.clone(), (session, Instant::now()));
        queue_finished_session(&state, &id, Some(120));
        assert!(state.active.lock().unwrap().is_empty());
        assert_eq!(state.pending_finishes.lock().unwrap().len(), 1);

        let locked = rusqlite::Connection::open(&file).unwrap();
        locked.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(flush_finished_sessions(&state, |_| {}).is_empty());
        assert_eq!(state.pending_finishes.lock().unwrap().len(), 1);
        assert!(
            reserve_game_launch(&state, &id).is_err(),
            "a queued finish must block untracked launches"
        );
        locked.execute_batch("ROLLBACK").unwrap();

        assert_eq!(flush_finished_sessions(&state, |_| {}), vec![id.clone()]);
        let launch = reserve_game_launch(&state, &id).unwrap();
        assert!(
            reserve_game_launch(&state, &id).is_err(),
            "a concurrent launch must be reserved"
        );
        drop(launch);
        assert!(reserve_game_launch(&state, &id).is_ok());
        assert_eq!(
            state.db.lock().unwrap().get(&id).unwrap()["total_play_seconds"],
            120
        );
        assert!(flush_finished_sessions(&state, |_| {}).is_empty());
        assert!(state.pending_finishes.lock().unwrap().is_empty());
        assert_eq!(
            state.db.lock().unwrap().get(&id).unwrap()["total_play_seconds"],
            120
        );

        drop(locked);
        drop(state);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn prioritize_unattempted_games_defers_recent_misses_without_dropping_them() {
        let games = vec![
            json!({"id":"g1","source":"manual","source_id":"","name":"Alpha"}),
            json!({"id":"g2","source":"manual","source_id":"","name":"Beta"}),
            json!({"id":"g3","source":"manual","source_id":"","name":"Gamma"}),
        ];
        let mut misses = HashMap::from([
            (
                "g1".to_string(),
                (artwork_lookup_signature(&games[0]), Instant::now()),
            ),
            (
                "g2".to_string(),
                ("manual||Old Beta Title".to_string(), Instant::now()),
            ),
        ]);
        let ordered = prioritize_unattempted_games(&games, &mut misses);
        let ids: Vec<&str> = ordered.iter().filter_map(|g| g["id"].as_str()).collect();
        // Renamed g2 and untouched g3 run first; already-missed g1 is deferred.
        assert_eq!(ids, vec!["g2", "g3", "g1"]);
    }

    #[test]
    fn art_mime_type_handles_uppercase_extensions_and_save_artwork_cleans_up_temp() {
        assert_eq!(
            art_mime_type("01234567-89ab-cdef-0123-456789abcdef.PNG"),
            "image/png"
        );
        assert_eq!(
            art_mime_type("01234567-89ab-cdef-0123-456789abcdef.WEBP"),
            "image/webp"
        );
        assert_eq!(
            art_mime_type("01234567-89ab-cdef-0123-456789abcdef.JPG"),
            "image/jpeg"
        );
        let dir = std::env::temp_dir().join(format!("orbit-save-art-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("sample.png");
        std::fs::write(
            &src,
            [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4],
        )
        .unwrap();
        let out_dir = dir.join("out");
        let saved = save_artwork(&src, &out_dir).unwrap();
        assert!(valid_art_name(&saved));
        assert!(out_dir.join(&saved).is_file());
        // No leftover temporary file in artwork directory.
        assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn art_mime_type(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if ext.eq_ignore_ascii_case("png") {
        "image/png"
    } else if ext.eq_ignore_ascii_case("webp") {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

pub fn run() {
    let scheme_dir = Arc::new(Mutex::new(None::<PathBuf>));
    let scheme_handler = scheme_dir.clone();
    let last_fullscreen = Arc::new(Mutex::new(None::<bool>));
    tauri::Builder::default()
        // Only one Rust tracker may write playtime to this profile. Without
        // a single-instance guard, launching Orbit again while it is in the
        // tray creates a second poller for the same running game.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            #[cfg(target_os = "windows")]
            if let Err(error) = tray::open_orbit(app) {
                // During startup the first instance's tray may not exist
                // yet; its main window will become visible on its own.
                eprintln!("Orbit single-instance reopen: {error}");
            }
            #[cfg(not(target_os = "windows"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(move |window, event| {
            // Destroying the UI window is not quitting Orbit. In particular,
            // don't stop process tracking or settle playtime on Destroyed.
            let _ = tray::handle_window_event(window, event);
            // OS fullscreen exits (for example via a window shortcut) must
            // close the controller overlay too. Unlike Electron's native
            // enter/leave-full-screen events, the IPC path alone cannot
            // observe changes initiated outside setFullscreen.
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true)
                )
            {
                if let Ok(fullscreen) = window.is_fullscreen() {
                    let changed_state = last_fullscreen
                        .lock()
                        .map(|mut prev| {
                            if *prev == Some(fullscreen) {
                                false
                            } else {
                                *prev = Some(fullscreen);
                                true
                            }
                        })
                        .unwrap_or(true);
                    if changed_state {
                        emit(
                            window.app_handle(),
                            json!({"type":"windowState","fullscreen":fullscreen}),
                        );
                    }
                }
            }
        })
        .register_uri_scheme_protocol("orbit-art", move |_context, request| {
            let path = request.uri().path().trim_start_matches('/');
            let name = path.strip_prefix("file/").unwrap_or(path);
            let response = (|| {
                if !valid_art_name(name) {
                    return None;
                }
                let dir = scheme_handler.lock().ok()?.clone()?;
                let full = dir.join(name);
                if !std::fs::symlink_metadata(&full).ok()?.file_type().is_file() {
                    return None;
                }
                let data = files::read_regular_bounded(&full, 15 * 1024 * 1024).ok()?;
                Some((data, art_mime_type(name)))
            })();
            match response {
                Some((bytes, mime)) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("X-Content-Type-Options", "nosniff")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            import_legacy_library(&data_dir).map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&data_dir)?;
            snapshot_rust_library_before_upgrade(&data_dir).map_err(std::io::Error::other)?;
            let artwork_dir = data_dir.join("artwork");
            std::fs::create_dir_all(&artwork_dir)?;
            *scheme_dir.lock().unwrap() = Some(artwork_dir.clone());
            let mut db = LibraryDatabase::open(&data_dir.join("library.sqlite"))
                .map_err(std::io::Error::other)?;
            db.recover_interrupted_sessions()
                .map_err(std::io::Error::other)?;
            app.manage(ControllerReturn::default());
            app.manage(OrbitState::new(db, data_dir, artwork_dir));
            app.manage(updates::UpdateManager::new());
            sync_saved_window_theme(app.handle());
            #[cfg(target_os = "windows")]
            tray::install_tray(app).map_err(std::io::Error::other)?;
            queue_artwork_scan(app.handle());
            updates::maybe_start_background_check(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut diagnostics = TrackingDiagnostics::default();
                loop {
                    let state = handle.state::<OrbitState>();
                    let Ok(stopped) = state.shutdown.lock() else {
                        break;
                    };
                    if *stopped {
                        break;
                    }
                    let (stopped, _) = state
                        .shutdown_cv
                        .wait_timeout(stopped, Duration::from_secs(10))
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if *stopped {
                        break;
                    }
                    drop(stopped);
                    if let Ok(_poll_guard) = state.poll_lock.lock() {
                        if state.shutdown.lock().is_ok_and(|s| *s) {
                            break;
                        }
                        poll_sessions(&handle, &mut diagnostics);
                    };
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![orbit_invoke])
        .build(tauri::generate_context!())
        .expect("Orbit Tauri desktop failed to build")
        .run(|handle, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                // Only suppress last-window/UI closes. Never block a
                // deliberate programmatic exit or restart.
                if code.is_none() && tray::should_keep_running(handle) {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::Exit => settle_sessions(handle),
            _ => {}
        });
}

mod artwork;
mod backup;
mod database;
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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct OrbitState {
    db: Mutex<LibraryDatabase>,
    revision: AtomicU64,
    active: Mutex<HashMap<String, (String, Instant)>>,
    launching: Mutex<HashSet<String>>,
    // A process can exit while SQLite is temporarily locked or unavailable.
    // Keep its final duration until the database has accepted it exactly once.
    pending_finishes: Mutex<HashMap<String, (String, i64)>>,
    artwork_pending: AtomicU64,
    artwork_busy: AtomicBool,
    data_dir: PathBuf,
    artwork_dir: PathBuf,
}

fn legacy_library_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let roaming = PathBuf::from(std::env::var_os("APPDATA")?);
        for name in ["orbit-game-launcher", "Orbit Launcher"] {
            let path = roaming.join(name);
            if path.join("library.sqlite").is_file() {
                return Some(path);
            }
        }
    }
    None
}

// The first Tauri launch snapshots the old Electron database with SQLite's own
// VACUUM INTO. Existing Electron data remains untouched and usable.
fn import_legacy_library(destination: &Path) -> Result<(), String> {
    let Some(old) = legacy_library_dir() else {
        return Ok(());
    };
    import_legacy_library_from(&old, destination)
}

/// Separate source/destination arguments let us prove first-run migration on
/// disposable SQLite/WAL fixtures, never on an installed Electron profile.
fn import_legacy_library_from(old: &Path, destination: &Path) -> Result<(), String> {
    let target_db = destination.join("library.sqlite");
    if target_db.exists() {
        let metadata = std::fs::symlink_metadata(&target_db).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
            return Err("Existing Rust library.sqlite is empty or not a safe regular file. Refusing to replace it or silently ignore the legacy Electron library; inspect or restore your backup manually.".into());
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
            .map_err(|e| format!("Cannot read existing Rust preview library: {e}"))?;
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

fn emit(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit("orbit:event", payload);
}

fn running_ids(state: &OrbitState) -> Vec<String> {
    let mut ids: Vec<String> = state.active.lock().unwrap().keys().cloned().collect();
    ids.sort();
    ids
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
    if aliases.iter().any(|other| {
        launching.contains(other)
            || state.active.lock().unwrap().contains_key(other)
            || state.pending_finishes.lock().unwrap().contains_key(other)
    }) {
        launching.remove(id);
        return Err("This installation already has a tracked session running or saving.".into());
    }
    if state.active.lock().unwrap().contains_key(id) {
        launching.remove(id);
        return Err("This game is already running".into());
    }
    // Reject before spawning the executable. Otherwise a temporary SQLite
    // failure could leave an old finalization queued, launch a second game,
    // and only THEN fail to create its new playtime row.
    if state.pending_finishes.lock().unwrap().contains_key(id) {
        launching.remove(id);
        return Err("Orbit is still saving this game's playtime. Try again shortly.".into());
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
    let active = state.active.lock().unwrap();
    let pending = state.pending_finishes.lock().unwrap();
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
    let games = state.db.lock().map_err(|e| e.to_string())?.list("name")?;
    Ok(
        json!({"games":games,"runningIds":running_ids(state),"revision":state.revision.load(Ordering::SeqCst)}),
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
        let Ok(info) = native::inspect_game_file(path) else {
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
            let generation = state.artwork_pending.load(Ordering::SeqCst);
            let mut visited_names = HashSet::new();
            let mut more_names = refresh_generated_names(&handle, &mut visited_names);
            if let Err(error) = handle_command(&handle, "repairSteamArtwork", &[json!("automatic")])
            {
                eprintln!("Orbit automatic artwork scan: {error}");
            }
            // A large or slow library is processed in bounded passes, with
            // a brief yield between passes. No stale first page can starve
            // later titles just because the user never changes the library.
            while more_names {
                std::thread::sleep(Duration::from_millis(100));
                more_names = refresh_generated_names(&handle, &mut visited_names);
            }
            if state.artwork_pending.load(Ordering::SeqCst) == generation {
                break generation;
            }
        };
        let state = handle.state::<OrbitState>();
        state.artwork_busy.store(false, Ordering::SeqCst);
        if state.artwork_pending.load(Ordering::SeqCst) != last_processed {
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
    use std::io::Read;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(source)
        .map_err(|e| e.to_string())?
        .take(15 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > 15 * 1024 * 1024 {
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
        "{}-{}-{}-{}{}.{}",
        &digest[..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        format!("-{}", &digest[20..32]),
        ext
    );
    std::fs::create_dir_all(artwork_dir).map_err(|e| e.to_string())?;
    let path = artwork_dir.join(&name);
    use std::io::Write;
    match std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
    {
        Ok(mut file) => file.write_all(&bytes).map_err(|e| e.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if std::fs::read(&path).map_err(|e| e.to_string())? != bytes {
                return Err("Artwork name collision detected".into());
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

fn handle_command(app: &tauri::AppHandle, method: &str, args: &[Value]) -> Result<Value, String> {
    let state = app.state::<OrbitState>();
    match method {
        "bootstrap" => {
            let mut result = snapshot(&state)?;
            result["settings"] = state.db.lock().unwrap().get_settings()?;
            result["platform"] = json!(platform());
            result["version"] = json!(app.package_info().version.to_string());
            Ok(result)
        }
        "librarySnapshot" => snapshot(&state),
        "listGames" => state.db.lock().unwrap().list("name"),
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
            state.db.lock().unwrap().get_statistics(days)
        }
        "runningGames" => Ok(json!(running_ids(&state))),
        "getGame" => state.db.lock().unwrap().get(game_id(args)?),
        "addGame" => {
            let result = state.db.lock().unwrap().upsert(argument(args, 0)?)?;
            if let Some(game) = result.get("game").cloned() {
                changed(app, &state, vec![game], vec![], "add", false);
                queue_artwork_scan(app);
            }
            Ok(result)
        }
        "updateGame" => {
            let id = game_id(args)?;
            let game = state.db.lock().unwrap().update(id, argument(args, 1)?)?;
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
            let result = state.db.lock().unwrap().remove(id)?;
            if result {
                changed(app, &state, vec![], vec![json!(id)], "remove", false);
            }
            Ok(json!(result))
        }
        "favoriteGame" => {
            let game = state.db.lock().unwrap().toggle_favorite(game_id(args)?)?;
            changed(app, &state, vec![game.clone()], vec![], "favorite", false);
            Ok(game)
        }
        "saveSettings" => {
            let settings = state.db.lock().unwrap().save_settings(argument(args, 0)?)?;
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
            let game = state.db.lock().unwrap().get(game_id(args)?)?;
            native::open_game_folder(&game)
        }
        "openAppData" => native::open_path(&state.data_dir.to_string_lossy()),
        "getAppInfo" => Ok(
            json!({"platform":platform(),"version":app.package_info().version.to_string(),"dataPath":state.data_dir.to_string_lossy()}),
        ),
        "discoverGames" => {
            let settings = state.db.lock().unwrap().get_settings()?;
            let mut result = native::discover_games(&settings)?;
            let games = state.db.lock().unwrap().list("name")?;
            let known: HashSet<String> = games
                .as_array()
                .into_iter()
                .flatten()
                .map(game_identity)
                .collect();
            if let Some(items) = result.get_mut("games").and_then(Value::as_array_mut) {
                for game in items {
                    game["alreadyAdded"] = json!(known.contains(&game_identity(game)));
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
                let next = state.db.lock().unwrap().upsert_batch(batch)?;
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
            let id = game_id(args)?;
            let _reservation = reserve_game_launch(&state, id)?;
            let game = state.db.lock().unwrap().get(id)?;
            if game.is_null() {
                return Err("Game not found".into());
            }
            let mut result = native::launch_game(&game)?;
            if result["mode"] == "external" {
                if let Err(error) = state.db.lock().unwrap().record_external_launch(id) {
                    emit(
                        app,
                        json!({"type":"error","message":format!("Launcher opened, but recent-play information could not be saved: {error}")}),
                    );
                    result["message"] =
                        json!("Launcher opened. Recent-play information could not be saved.");
                }
            }
            if result["tracked"].as_bool() == Some(true) {
                let session_result = state.db.lock().unwrap().start_session(id);
                match session_result {
                    Ok(session_id) => {
                        state
                            .active
                            .lock()
                            .unwrap()
                            .insert(id.to_string(), (session_id, Instant::now()));
                    }
                    Err(error) => {
                        result["tracked"] = json!(false);
                        result["message"] =
                            json!("Game launched, but play-time tracking could not start.");
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
        "getUpdateStatus" => Ok(json!({"state":"idle","message":"Update check not started."})),
        "checkForUpdates" => Ok(updates::check(
            &app.package_info().version.to_string(),
            &state.data_dir,
        )),
        "openUpdateDownload" => {
            let tag = match args.first() {
                None | Some(Value::Null) => None,
                Some(Value::String(tag)) => Some(tag.as_str()),
                _ => return Err("Invalid Orbit release.".into()),
            };
            native::open_external(&updates::release_page(tag)?)?;
            Ok(json!(true))
        }
        "installUpdate" => {
            Err("Automatic updates require a signed release and trusted update feed".into())
        }
        "findOnlineCover" => {
            let settings = state.db.lock().unwrap().get_settings()?;
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
            let db = state.db.lock().unwrap();
            let settings = db.get_settings()?;
            let games = db.list("name")?;
            drop(db);
            let enabled = settings["useSteamArtwork"] == true;
            let paused = settings["performanceGuard"] == true && !running_ids(&state).is_empty();
            let originals = games.as_array().ok_or("Invalid game list")?;
            // Automatic enrichment fills missing artwork only. The explicit
            // Repair button remains allowed to replace a landscape cover.
            let automatic = args.first().and_then(Value::as_str) == Some("automatic");
            let allowed = || online_artwork_allowed(&state);
            let mut result = if automatic {
                artwork::repair_artwork_auto_guarded(
                    originals,
                    &state.artwork_dir,
                    enabled,
                    paused,
                    &allowed,
                )?
            } else {
                artwork::repair_artwork_guarded(
                    originals,
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
            let mut covers = 0;
            let mut icons = 0;
            if let Some(updates) = result["updates"].as_array() {
                let mut db = state.db.lock().unwrap();
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
                    }
                    if allowed.contains_key("icon") {
                        icons += 1;
                    }
                    changes.push(changed_game);
                }
            }
            if !changes.is_empty() {
                changed(app, &state, changes, vec![], "artwork", false);
            }
            result["found"] = json!(covers);
            result["icons"] = json!(icons);
            if let Some(obj) = result.as_object_mut() {
                obj.remove("updates");
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
            let payload = state.db.lock().unwrap().export_json()?;
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
            let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if metadata.len() > 128 * 1024 * 1024 {
                return Err("Backup exceeds 128MB".into());
            }
            // Retain DB ownership through portable archive preflight, artwork
            // installation and the eventual session transaction, so no other
            // window command can invalidate the identity mapping between the
            // validation and commit. Native playtime tracking continues after
            // this explicit, bounded user-requested restore operation.
            let mut db = state.db.lock().unwrap();
            let portable = path.extension().and_then(|s| s.to_str()) == Some("orbit");
            let staged = if portable {
                Some(backup::import_backup_checked_staged(
                    &path,
                    &state.artwork_dir,
                    |library| db.preflight_restore_json(library),
                )?)
            } else {
                None
            };
            let json_payload = if portable {
                None
            } else {
                Some(
                    serde_json::from_slice::<Value>(
                        &std::fs::read(&path).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?,
                )
            };
            let payload = staged
                .as_ref()
                .map(backup::StagedBackup::library)
                .or(json_payload.as_ref())
                .ok_or("Missing Orbit restore payload")?;
            let restore = (|| -> Result<Value, String> {
                if payload["format"] != "orbit.library.v1" {
                    return Err("Invalid Orbit backup format".into());
                }
                let games = payload["games"].as_array().ok_or("Invalid game list")?;
                if games.len() > 100_000 {
                    return Err("Too many games in backup".into());
                }
                let mut clean_payload = payload.clone();
                let clean_games = clean_payload["games"]
                    .as_array_mut()
                    .ok_or("Invalid game list")?;
                // Artwork tokens have already been extracted/validated by backup;
                // a JSON backup may only refer to safe, existing local files.
                for (clean, original) in clean_games.iter_mut().zip(games.iter()) {
                    if let Some(game) = clean.as_object_mut() {
                        for field in ["cover", "banner", "icon"] {
                            game.insert(
                                field.into(),
                                json!(restored_artwork_token(&original[field], &state.artwork_dir)),
                            );
                        }
                    }
                }
                // The database layer maps source IDs and imports completed
                // history without crediting aggregate playtime twice.
                db.restore_json(&clean_payload)
            })();
            let result = if let Some(staged) = staged {
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
            } else {
                restore?
            };
            drop(db);
            changed(app, &state, vec![], vec![], "restore", true);
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
    let _launching = state.launching.lock().unwrap();
    let Some((session_id, started)) = state.active.lock().unwrap().remove(id) else {
        return;
    };
    let elapsed = seconds.unwrap_or(started.elapsed().as_secs() as i64);
    state
        .pending_finishes
        .lock()
        .unwrap()
        .insert(id.to_string(), (session_id, elapsed));
}

fn flush_finished_sessions(state: &OrbitState) -> Vec<String> {
    let pending = state
        .pending_finishes
        .lock()
        .unwrap()
        .iter()
        .map(|(id, (session, seconds))| (id.clone(), session.clone(), *seconds))
        .collect::<Vec<_>>();
    let mut completed = Vec::new();
    for (game_id, session_id, seconds) in pending {
        let result = state
            .db
            .lock()
            .map_err(|error| error.to_string())
            .and_then(|mut db| db.finish_session(&session_id, seconds));
        match result {
            Ok(_) => {
                state.pending_finishes.lock().unwrap().remove(&game_id);
                completed.push(game_id);
            }
            Err(error) => {
                eprintln!("Orbit: retrying unfinished playtime save: {error}");
            }
        }
    }
    completed
}

fn poll_sessions(app: &tauri::AppHandle) {
    let state = app.state::<OrbitState>();
    for id in flush_finished_sessions(&state) {
        notify_game(app, &state, &id, "playtime");
    }
    let Ok(exits) = native::poll_sessions() else {
        return;
    };
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
    let Some(items) = exits.get("completed").and_then(Value::as_array) else {
        return;
    };
    for item in items {
        let Some(id) = item["game_id"].as_str() else {
            continue;
        };
        queue_finished_session(&state, id, item["seconds"].as_i64());
    }
    for id in flush_finished_sessions(&state) {
        notify_game(app, &state, &id, "playtime");
    }
    // External launcher processes are tracked from verified install paths by
    // the Rust Windows process-inventory implementation.
    let watchlist = state
        .db
        .lock()
        .ok()
        .and_then(|db| db.list_activity_games().ok());
    if let Some(watchlist) = watchlist {
        if let Ok(activity) = native::poll_activity(&watchlist) {
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
                    let launching = state.launching.lock().unwrap();
                    if activity_registration_conflicts(&state, &watchlist, id, &launching) {
                        continue;
                    }
                    let session = state
                        .db
                        .lock()
                        .map_err(|e| e.to_string())
                        .and_then(|mut db| db.start_session(id));
                    if let Ok(session) = session {
                        state
                            .active
                            .lock()
                            .unwrap()
                            .insert(id.into(), (session, Instant::now()));
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
            }
            if let Some(finished) = activity.get("finished").and_then(Value::as_array) {
                for item in finished {
                    let Some(id) = item["game_id"].as_str() else {
                        continue;
                    };
                    queue_finished_session(&state, id, item["seconds"].as_i64());
                }
                for id in flush_finished_sessions(&state) {
                    notify_game(app, &state, &id, "playtime");
                }
            }
        }
    }
    let checkpoints: Vec<Value> = state
        .active
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(id, (session, _))| Some(json!({"id":session,"seconds":observed.get(id)?})))
        .collect();
    if !checkpoints.is_empty() {
        if let Ok(mut db) = state.db.lock() {
            let _ = db.checkpoint_sessions(&checkpoints);
        }
    }
}

fn settle_sessions(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<OrbitState>() else {
        return;
    };
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
        state
            .pending_finishes
            .lock()
            .unwrap()
            .insert(id, (session_id, seconds));
    }
    flush_finished_sessions(&state);
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
        let state = OrbitState {
            db: Mutex::new(db),
            revision: AtomicU64::new(0),
            active: Mutex::new(HashMap::new()),
            launching: Mutex::new(HashSet::new()),
            pending_finishes: Mutex::new(HashMap::new()),
            artwork_pending: AtomicU64::new(0),
            artwork_busy: AtomicBool::new(false),
            data_dir: folder.clone(),
            artwork_dir: folder.join("artwork"),
        };
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
        let state = OrbitState {
            db: Mutex::new(db),
            revision: AtomicU64::new(0),
            active: Mutex::new(HashMap::new()),
            launching: Mutex::new(HashSet::new()),
            pending_finishes: Mutex::new(HashMap::new()),
            artwork_pending: AtomicU64::new(0),
            artwork_busy: AtomicBool::new(false),
            data_dir: folder.clone(),
            artwork_dir: folder.join("artwork"),
        };
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
        assert!(flush_finished_sessions(&state).is_empty());
        assert_eq!(state.pending_finishes.lock().unwrap().len(), 1);
        assert!(
            reserve_game_launch(&state, &id).is_err(),
            "a queued finish must block untracked launches"
        );
        locked.execute_batch("ROLLBACK").unwrap();

        assert_eq!(flush_finished_sessions(&state), vec![id.clone()]);
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
        assert!(flush_finished_sessions(&state).is_empty());
        assert!(state.pending_finishes.lock().unwrap().is_empty());
        assert_eq!(
            state.db.lock().unwrap().get(&id).unwrap()["total_play_seconds"],
            120
        );

        drop(locked);
        drop(state);
        std::fs::remove_dir_all(folder).unwrap();
    }
}

pub fn run() {
    let scheme_dir = Arc::new(Mutex::new(None::<PathBuf>));
    let scheme_handler = scheme_dir.clone();
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
        .on_window_event(|window, event| {
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
                    emit(
                        window.app_handle(),
                        json!({"type":"windowState","fullscreen":fullscreen}),
                    );
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
                let metadata = full.metadata().ok()?;
                if !metadata.is_file() || metadata.len() > 15 * 1024 * 1024 {
                    return None;
                }
                let data = std::fs::read(full).ok()?;
                let mime = if name.ends_with(".png") {
                    "image/png"
                } else if name.ends_with(".webp") {
                    "image/webp"
                } else {
                    "image/jpeg"
                };
                Some((data, mime))
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
            app.manage(OrbitState {
                db: Mutex::new(db),
                revision: AtomicU64::new(0),
                active: Mutex::new(HashMap::new()),
                launching: Mutex::new(HashSet::new()),
                pending_finishes: Mutex::new(HashMap::new()),
                artwork_pending: AtomicU64::new(0),
                artwork_busy: AtomicBool::new(false),
                data_dir,
                artwork_dir,
            });
            #[cfg(target_os = "windows")]
            tray::install_tray(app).map_err(std::io::Error::other)?;
            queue_artwork_scan(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(10));
                poll_sessions(&handle);
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

mod artwork;
mod backup;
mod database;
mod native;
mod tray;

use database::LibraryDatabase;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct OrbitState {
    db: Mutex<LibraryDatabase>,
    revision: AtomicU64,
    active: Mutex<HashMap<String, (String, Instant)>>,
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
    let target_db = destination.join("library.sqlite");
    if target_db.exists() {
        return Ok(());
    }
    let Some(old) = legacy_library_dir() else {
        return Ok(());
    };
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
    let from = old.join("artwork");
    let to = destination.join("artwork");
    if from.is_dir() {
        std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
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
            if metadata.len() <= 15 * 1024 * 1024 {
                let target = to.join(name.as_ref());
                if !target.exists() {
                    std::fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    // Commit the snapshot only when all required artwork is copied. A failed
    // import leaves Electron's database intact and is retried on next launch.
    std::fs::rename(&temp_db, &target_db).map_err(|e| {
        let _ = std::fs::remove_file(&temp_db);
        format!("Cannot finalize Orbit library migration: {e}")
    })?;
    Ok(())
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
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("Invalid game identifier".into());
    }
    Ok(id)
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
        "runningGames" => Ok(json!(running_ids(&state))),
        "getGame" => state.db.lock().unwrap().get(game_id(args)?),
        "addGame" => {
            let result = state.db.lock().unwrap().upsert(argument(args, 0)?)?;
            if let Some(game) = result.get("game").cloned() {
                changed(app, &state, vec![game], vec![], "add", false);
            }
            Ok(result)
        }
        "updateGame" => {
            let id = game_id(args)?;
            let game = state.db.lock().unwrap().update(id, argument(args, 1)?)?;
            changed(app, &state, vec![game.clone()], vec![], "edit", false);
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
            Ok(result)
        }
        "launchGame" => {
            let id = game_id(args)?;
            if state.active.lock().unwrap().contains_key(id) {
                return Err("This game is already running".into());
            }
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
        "getUpdateStatus" => Ok(
            json!({"state":"unsupported","message":"Update installation is unavailable in this unsigned Rust preview."}),
        ),
        "checkForUpdates" => Ok(
            json!({"state":"unsupported","message":"Update installation is unavailable in this unsigned Rust preview."}),
        ),
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
            let mut result = artwork::repair_artwork_guarded(
                originals,
                &state.artwork_dir,
                enabled,
                paused,
                &|| online_artwork_allowed(&state),
            )?;
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
            let db = state.db.lock().unwrap();
            let games = db.list("name")?;
            let count = games.as_array().map(|x| x.len()).unwrap_or(0);
            let payload = json!({"format":"orbit.library.v1","exported_at":chrono::Utc::now().to_rfc3339(),"settings":db.get_settings()?,"games":games});
            drop(db);
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
            let payload = if path.extension().and_then(|s| s.to_str()) == Some("orbit") {
                backup::import_backup(&path, &state.artwork_dir)?
            } else {
                serde_json::from_slice::<Value>(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?
            };
            if payload["format"] != "orbit.library.v1" {
                return Err("Invalid Orbit backup format".into());
            }
            let games = payload["games"].as_array().ok_or("Invalid game list")?;
            if games.len() > 100_000 {
                return Err("Too many games in backup".into());
            }
            let mut imported = 0;
            let mut skipped = 0;
            let mut errors = Vec::new();
            let mut db = state.db.lock().unwrap();
            for g in games {
                let mut clean = g.clone();
                if let Some(game) = clean.as_object_mut() {
                    for field in ["cover", "banner", "icon"] {
                        game.insert(
                            field.into(),
                            json!(restored_artwork_token(&g[field], &state.artwork_dir)),
                        );
                    }
                }
                match db.restore_game(&clean) {
                    Ok(out) => {
                        if out["added"].as_bool() == Some(true) {
                            imported += 1;
                        } else {
                            skipped += 1;
                        }
                    }
                    Err(err) => errors.push(err),
                }
            }
            let settings_restored = if payload.get("settings").and_then(Value::as_object).is_some()
            {
                db.save_settings(&payload["settings"]).is_ok()
            } else {
                false
            };
            drop(db);
            changed(app, &state, vec![], vec![], "restore", true);
            Ok(
                json!({"imported":imported,"skipped":skipped,"errors":errors,"settingsRestored":settings_restored}),
            )
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

fn poll_sessions(app: &tauri::AppHandle) {
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
    let state = app.state::<OrbitState>();
    for item in items {
        let Some(id) = item["game_id"].as_str() else {
            continue;
        };
        let Some((session_id, start)) = state.active.lock().unwrap().remove(id) else {
            continue;
        };
        let seconds = item["seconds"]
            .as_i64()
            .unwrap_or(start.elapsed().as_secs() as i64);
        if let Ok(mut db) = state.db.lock() {
            let _ = db.finish_session(&session_id, seconds);
        }
        notify_game(app, &state, id, "playtime");
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
                    if state.active.lock().unwrap().contains_key(id) {
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
                    let Some((session_id, start)) = state.active.lock().unwrap().remove(id) else {
                        continue;
                    };
                    let seconds = item["seconds"]
                        .as_i64()
                        .unwrap_or(start.elapsed().as_secs() as i64);
                    if let Ok(mut db) = state.db.lock() {
                        let _ = db.finish_session(&session_id, seconds);
                    }
                    notify_game(app, &state, id, "playtime");
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
    if let Ok(mut db) = state.db.lock() {
        for (id, (session_id, started)) in ended {
            let seconds = elapsed
                .get(&id)
                .copied()
                .unwrap_or(started.elapsed().as_secs() as i64);
            let _ = db.finish_session(&session_id, seconds);
        }
    };
}

pub fn run() {
    let scheme_dir = Arc::new(Mutex::new(None::<PathBuf>));
    let scheme_handler = scheme_dir.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if tray::handle_window_event(window, event) {
                return;
            }
            if window.label() != "main" || !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            settle_sessions(window.app_handle());
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
                data_dir,
                artwork_dir,
            });
            #[cfg(target_os = "windows")]
            tray::install_tray(app).map_err(std::io::Error::other)?;
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
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                settle_sessions(handle);
            }
        });
}

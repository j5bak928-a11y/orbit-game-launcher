//! Portable Orbit backups. This format is shared with src/core/backup.cjs.
//! Only artwork referenced by a library game may be restored to disk.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::DateTime;
use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED: u64 = 192 * 1024 * 1024;
const MAX_IMAGE: u64 = 15 * 1024 * 1024;
const MAX_ARTWORK_TOTAL: u64 = 100 * 1024 * 1024;
const MAX_LIBRARY_ROWS: usize = 100_000;
const MAX_SESSION_SECONDS: u64 = 7 * 86_400;
const MAX_SESSION_ID_LENGTH: usize = 128;
const MAX_SESSION_DATE_LENGTH: usize = 50;
const PORTABLE_FORMAT: &str = "orbit.portable.v1";
const LIBRARY_FORMAT: &str = "orbit.library.v1";
const ARTWORK_FIELDS: [&str; 3] = ["cover", "banner", "icon"];

fn err(message: &str) -> String {
    message.to_owned()
}

fn valid_artwork_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    // Matches the Electron portable-format contract: 36 hex/hyphen
    // characters followed by one of the image suffixes. This also rejects
    // separators, absolute paths, drive names, and traversal components.
    stem.len() == 36
        && stem.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
        && ["png", "jpg", "jpeg", "webp"]
            .iter()
            .any(|candidate| ext.eq_ignore_ascii_case(candidate))
}

fn image_extension(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1;
    ["png", "jpg", "jpeg", "webp"]
        .into_iter()
        .find(|candidate| ext.eq_ignore_ascii_case(candidate))
}

fn valid_image(name: &str, bytes: &[u8]) -> bool {
    if !valid_artwork_name(name) || bytes.is_empty() || (bytes.len() as u64) > MAX_IMAGE {
        return false;
    }
    match image_extension(name) {
        Some("png") => bytes.starts_with(&[0x89, b'P', b'N', b'G', 13, 10, 26, 10]),
        Some("jpg" | "jpeg") => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        Some("webp") => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn games(library: &Value) -> Result<&Vec<Value>, String> {
    if library.get("format").and_then(Value::as_str) != Some(LIBRARY_FORMAT) {
        return Err(err("Unrecognized Orbit library format."));
    }
    let rows = library
        .get("games")
        .and_then(Value::as_array)
        .ok_or_else(|| err("Invalid library for backup."))?;
    if rows.len() > MAX_LIBRARY_ROWS || rows.iter().any(|game| !game.is_object()) {
        return Err(err("Invalid games in Orbit library."));
    }
    validate_sessions(library, rows)?;
    validate_collections(library)?;
    Ok(rows)
}

fn validate_collections(library: &Value) -> Result<(), String> {
    let Some(value) = library.get("collections") else {
        return Ok(());
    };
    let items = value
        .as_array()
        .ok_or_else(|| err("Invalid collections in Orbit library."))?;
    if items.len() > 100 {
        return Err(err("Orbit collections exceed the 100-collection limit."));
    }
    let mut seen = BTreeSet::new();
    for item in items {
        let obj = item
            .as_object()
            .ok_or_else(|| err("Invalid collection entry in Orbit library."))?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_session_id(id))
            .ok_or_else(|| err("Invalid collection ID in Orbit library."))?;
        if !seen.insert(id) {
            return Err(err("Duplicate collection ID in Orbit library."));
        }
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| {
                !n.is_empty() && n.chars().count() <= 60 && !n.chars().any(char::is_control)
            });
        if name.is_none() {
            return Err(err("Invalid collection name in Orbit library."));
        }
        let game_ids = obj
            .get("game_ids")
            .and_then(Value::as_array)
            .ok_or_else(|| err("Invalid collection games in Orbit library."))?;
        if game_ids.len() > MAX_LIBRARY_ROWS
            || game_ids
                .iter()
                .any(|gid| gid.as_str().map_or(true, |s| !valid_session_id(s)))
        {
            return Err(err("Invalid collection game ID in Orbit library."));
        }
    }
    Ok(())
}

/// An absent sessions property is valid for original orbit.library.v1 backups.
/// When present, every record must represent a completed session referring to
/// an exported game. Reject the entire archive before installing any artwork.
fn validate_sessions(library: &Value, rows: &[Value]) -> Result<(), String> {
    let Some(value) = library.get("sessions") else {
        return Ok(());
    };
    let sessions = value
        .as_array()
        .ok_or_else(|| err("Invalid sessions in Orbit library."))?;
    if sessions.len() > MAX_LIBRARY_ROWS {
        return Err(err(
            "Orbit session history exceeds the 100000-session limit.",
        ));
    }
    let mut game_ids = BTreeSet::new();
    for game in rows {
        let id = game
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_session_id(id))
            .ok_or_else(|| err("Session history references invalid game IDs."))?;
        if !game_ids.insert(id) {
            return Err(err("Session history contains duplicate game IDs."));
        }
    }

    let mut seen = BTreeSet::new();
    for session in sessions {
        let fields = session
            .as_object()
            .filter(|fields| {
                fields.len() == 5
                    && ["id", "game_id", "started_at", "finished_at", "seconds"]
                        .iter()
                        .all(|key| fields.contains_key(*key))
            })
            .ok_or_else(|| err("Invalid completed session in Orbit library."))?;
        let id = fields
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_session_id(id))
            .ok_or_else(|| err("Invalid session ID in Orbit library."))?;
        fields
            .get("game_id")
            .and_then(Value::as_str)
            .filter(|id| game_ids.contains(id))
            .ok_or_else(|| err("Session history references an unknown game."))?;
        if !seen.insert(id) {
            return Err(err("Duplicate session ID in Orbit library."));
        }

        let parse_date = |key| {
            fields
                .get(key)
                .and_then(Value::as_str)
                .filter(|date| !date.is_empty() && date.len() <= MAX_SESSION_DATE_LENGTH)
                .and_then(|date| DateTime::parse_from_rfc3339(date).ok())
        };
        let started = parse_date("started_at")
            .ok_or_else(|| err("Invalid session start time in Orbit library."))?;
        let finished = parse_date("finished_at")
            .ok_or_else(|| err("Invalid completed session time in Orbit library."))?;
        if finished < started {
            return Err(err(
                "Session history contains a session ending before its start.",
            ));
        }
        if !fields
            .get("seconds")
            .and_then(Value::as_u64)
            .is_some_and(|seconds| seconds <= MAX_SESSION_SECONDS)
        {
            return Err(err("Invalid completed session duration in Orbit library."));
        }
    }
    Ok(())
}

fn valid_session_id(id: &str) -> bool {
    id.len() <= MAX_SESSION_ID_LENGTH && crate::database::valid_backup_id(id)
}

fn asset_names(rows: &[Value]) -> BTreeSet<String> {
    rows.iter()
        .flat_map(|game| {
            ARTWORK_FIELDS
                .into_iter()
                .filter_map(move |field| game.get(field).and_then(Value::as_str))
        })
        .filter(|name| valid_artwork_name(name))
        .map(ToOwned::to_owned)
        .collect()
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(err("File is not a regular file within the size limit."));
    }
    crate::files::read_regular_bounded(path, limit)
}

fn gzip_bounded(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() as u64 > MAX_UNCOMPRESSED {
        return Err(err("Library exceeds the portable backup size limit."));
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(bytes).map_err(|e| e.to_string())?;
    let compressed = encoder.finish().map_err(|e| e.to_string())?;
    if compressed.len() as u64 > MAX_ARCHIVE {
        return Err(err("Compressed backup exceeds the 128 MB limit."));
    }
    Ok(compressed)
}

fn gunzip_limited(bytes: &[u8], output_limit: u64) -> Result<Vec<u8>, String> {
    if bytes.len() < 2 || bytes[..2] != [0x1f, 0x8b] || bytes.len() as u64 > MAX_ARCHIVE {
        return Err(err("Invalid Orbit portable backup."));
    }
    let mut unpacked = Vec::new();
    MultiGzDecoder::new(bytes)
        .take(output_limit + 1)
        .read_to_end(&mut unpacked)
        .map_err(|_| err("Portable backup is corrupt or exceeds the safe size limit."))?;
    if unpacked.len() as u64 > output_limit {
        return Err(err(
            "Portable backup is corrupt or exceeds the safe size limit.",
        ));
    }
    Ok(unpacked)
}

fn gunzip_bounded(bytes: &[u8]) -> Result<Vec<u8>, String> {
    gunzip_limited(bytes, MAX_UNCOMPRESSED)
}

fn write_atomic(output: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = output
        .file_name()
        .ok_or_else(|| err("Invalid backup output path."))?;
    let tmp_name = format!(".{}.{}.tmp", file_name.to_string_lossy(), Uuid::new_v4());
    let temporary = parent.join(tmp_name);
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, output).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Writes the gzip JSON .orbit archive atomically and returns the UI's
/// export metadata: path, count, portable, artworkCount, missingArtwork.
pub fn export_backup(payload: &Value, artwork_dir: &Path, output: &Path) -> Result<Value, String> {
    let rows = games(payload)?;
    let mut artwork = Map::new();
    let mut missing = 0usize;
    let mut total = 0u64;
    for name in asset_names(rows) {
        let path = artwork_dir.join(&name);
        let Ok(bytes) = read_bounded(&path, MAX_IMAGE) else {
            missing += 1;
            continue;
        };
        if !valid_image(&name, &bytes) {
            missing += 1;
            continue;
        }
        total += bytes.len() as u64;
        if total > MAX_ARTWORK_TOTAL {
            return Err(err("Artwork exceeds the 100 MB portable backup limit."));
        }
        artwork.insert(name, Value::String(BASE64.encode(bytes)));
    }
    let artwork_count = artwork.len();
    let envelope = json!({"format":PORTABLE_FORMAT,"library":payload,"artwork":artwork});
    let encoded = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    let compressed = gzip_bounded(&encoded)?;
    write_atomic(output, &compressed)?;
    Ok(json!({
        "path":output.to_string_lossy(),
        "count":rows.len(),
        "portable":true,
        "artworkCount":artwork_count,
        "missingArtwork":missing
    }))
}

fn existing_is_identical(path: &Path, bytes: &[u8]) -> bool {
    matches!(read_bounded(path, MAX_IMAGE), Ok(existing) if existing == bytes)
}

fn ensure_artwork_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(err("Invalid artwork directory."));
    }
    Ok(())
}

/// Atomically links a complete temporary file to a new, sanitized name.
/// The link operation never overwrites an existing file, including symlinks.
struct CreatedArtwork {
    name: String,
    path: PathBuf,
    digest: [u8; 32],
}

/// Tracks only final hard links created by this import, never pre-existing
/// identical or conflicting files. Dropping a pending restore rolls them back.
pub struct StagedBackup {
    library: Value,
    created: Vec<CreatedArtwork>,
    artwork_dir: PathBuf,
    created_dir: bool,
    committed: bool,
}

impl StagedBackup {
    #[cfg(test)]
    pub fn library(&self) -> &Value {
        &self.library
    }

    pub(crate) fn library_mut(&mut self) -> &mut Value {
        &mut self.library
    }

    fn rollback_unused(&mut self, referenced: &HashSet<String>) -> Result<(), String> {
        let mut errors = Vec::new();
        let mut pending = Vec::new();
        for artwork in self.created.drain(..) {
            if referenced.contains(&artwork.name) {
                // A committed database game now points to this image.
                continue;
            }
            // A changed file or symlink is no longer ours to delete. Hashing
            // before unlink also avoids deleting another writer's replacement.
            let removal = match fs::symlink_metadata(&artwork.path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
                Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                    Err("artwork was replaced by another filesystem object".into())
                }
                Ok(_) => match read_bounded(&artwork.path, MAX_IMAGE) {
                    Ok(contents)
                        if <[u8; 32]>::from(Sha256::digest(&contents)) == artwork.digest =>
                    {
                        fs::remove_file(&artwork.path).map_err(|e| e.to_string())
                    }
                    Ok(_) => Err("artwork contents changed after installation".into()),
                    Err(e) => Err(e),
                },
            };
            if let Err(message) = removal {
                errors.push(format!("{}: {message}", artwork.name));
                pending.push(artwork);
            }
        }
        self.created = pending;
        if self.created_dir && self.created.is_empty() {
            // Only remove an empty directory created by this import. It may
            // contain unrelated files placed there by another process.
            if fs::remove_dir(&self.artwork_dir).is_ok() {
                self.created_dir = false;
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Could not roll back newly installed artwork: {}",
                errors.join("; ")
            ))
        }
    }

    /// On a successful restore, preserve only images referenced by the final
    /// database library. Legacy v1 can import some games and skip others.
    /// If the DB cannot be read, pass None and conservatively retain images.
    pub fn finish(
        mut self,
        restore: Result<Value, String>,
        referenced: Option<&HashSet<String>>,
    ) -> Result<Value, String> {
        match restore {
            Ok(report) => {
                if let Some(referenced) = referenced {
                    if let Err(e) = self.rollback_unused(referenced) {
                        self.committed = true; // DB already committed; don't undo referenced images.
                        return Err(format!("Library restored, but artwork cleanup failed: {e}"));
                    }
                }
                self.created.clear();
                self.committed = true;
                Ok(report)
            }
            Err(reason) => {
                let cleanup = self.rollback_unused(&HashSet::new());
                self.committed = cleanup.is_ok();
                match cleanup {
                    Ok(()) => Err(reason),
                    Err(e) => Err(format!("{reason}; {e}")),
                }
            }
        }
    }

    #[cfg(test)]
    fn into_library(mut self) -> Value {
        self.committed = true;
        std::mem::take(&mut self.library)
    }
}

impl Drop for StagedBackup {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.rollback_unused(&HashSet::new());
        }
    }
}

fn install_artwork(
    dir: &Path,
    original: &str,
    bytes: &[u8],
) -> Result<(String, Option<CreatedArtwork>), String> {
    let digest = format!("{:x}", Sha256::digest(bytes));
    let ext = image_extension(original).ok_or_else(|| err("Backup contains invalid artwork."))?;
    let preferred = format!(
        "{}-{}-{}-{}-{}.{}",
        &digest[0..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32],
        ext
    );
    let temporary = dir.join(format!(".orbit-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(String, Option<CreatedArtwork>), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        for attempt in 0..8 {
            let name = if attempt == 0 {
                preferred.clone()
            } else {
                format!("{}.{}", Uuid::new_v4(), ext)
            };
            let target = dir.join(&name);
            match fs::hard_link(&temporary, &target) {
                Ok(()) => {
                    let created = CreatedArtwork {
                        name: name.clone(),
                        path: target,
                        digest: Sha256::digest(bytes).into(),
                    };
                    return Ok((name, Some(created)));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if existing_is_identical(&target, bytes) {
                        return Ok((name, None));
                    }
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Err(err("Could not reserve a unique artwork filename."))
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn decode_artwork(
    artwork: &Map<String, Value>,
    referenced: &BTreeSet<String>,
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut assets = BTreeMap::new();
    let mut total = 0u64;
    for (name, encoded) in artwork {
        let source = encoded
            .as_str()
            .ok_or_else(|| err("Backup contains invalid artwork."))?;
        if !referenced.contains(name) || source.len() > ((MAX_IMAGE as usize + 2) / 3) * 4 {
            return Err(err("Backup contains invalid artwork."));
        }
        let bytes = BASE64
            .decode(source)
            .map_err(|_| err("Backup contains invalid artwork."))?;
        if !valid_image(name, &bytes) {
            return Err(err("Backup contains invalid artwork."));
        }
        total += bytes.len() as u64;
        if total > MAX_ARTWORK_TOTAL {
            return Err(err("Backup artwork exceeds the safe size limit."));
        }
        assets.insert(name.to_owned(), bytes);
    }
    Ok(assets)
}

/// Validates an untrusted .orbit archive, installs only referenced artwork,
/// and returns the orbit.library.v1 object for database restoration. Artwork
/// fields are rewritten to locally installed filenames or cleared.
#[cfg(test)]
pub fn import_backup(input: &Path, artwork_dir: &Path) -> Result<Value, String> {
    import_backup_checked(input, artwork_dir, |_| Ok(()))
}

/// The caller must validate database identity/session conflicts before any
/// artwork is installed. A malformed library must not leave arbitrary assets
/// behind when its eventual DB restore fails. Old archives remain readable.
#[cfg(test)]
pub fn import_backup_checked<F>(
    input: &Path,
    artwork_dir: &Path,
    preflight: F,
) -> Result<Value, String>
where
    F: FnOnce(&Value) -> Result<(), String>,
{
    Ok(import_backup_checked_staged(input, artwork_dir, preflight)?.into_library())
}

/// Keep newly installed artwork reversible until the caller completes the
/// actual SQLite restore. The UI uses finish() after db.restore_json().
pub fn import_backup_checked_staged<F>(
    input: &Path,
    artwork_dir: &Path,
    preflight: F,
) -> Result<StagedBackup, String>
where
    F: FnOnce(&Value) -> Result<(), String>,
{
    import_backup_staged_with_installer(input, artwork_dir, preflight, install_artwork)
}

fn import_backup_staged_with_installer<F, I>(
    input: &Path,
    artwork_dir: &Path,
    preflight: F,
    mut installer: I,
) -> Result<StagedBackup, String>
where
    F: FnOnce(&Value) -> Result<(), String>,
    I: FnMut(&Path, &str, &[u8]) -> Result<(String, Option<CreatedArtwork>), String>,
{
    let compressed = read_bounded(input, MAX_ARCHIVE)
        .map_err(|_| err("Invalid Orbit portable backup or archive exceeds the 128 MB limit."))?;
    let unpacked = gunzip_bounded(&compressed)?;
    drop(compressed);
    let mut envelope: Value = serde_json::from_slice(&unpacked)
        .map_err(|_| err("Portable backup is corrupt or exceeds the safe size limit."))?;
    drop(unpacked);
    if envelope.get("format").and_then(Value::as_str) != Some(PORTABLE_FORMAT) {
        return Err(err("Unrecognized portable backup format."));
    }
    let mut library = envelope
        .as_object_mut()
        .and_then(|fields| fields.remove("library"))
        .ok_or_else(|| err("Unrecognized portable backup format."))?;
    let rows = games(&library)?;
    // Validate every game before installing embedded artwork, including a
    // sessions: [] backup (which otherwise skipped game-ID checks).
    for game in rows {
        crate::database::clean_game(game, None)?;
    }
    let referenced = asset_names(rows);
    let artwork = envelope
        .get("artwork")
        .and_then(Value::as_object)
        .ok_or_else(|| err("Unrecognized portable backup format."))?;
    // Fully validate the entire archive before making any filesystem changes.
    let assets = decode_artwork(artwork, &referenced)?;
    preflight(&library)?;
    let mut installed = BTreeMap::new();
    let mut staged = StagedBackup {
        library: Value::Null,
        created: Vec::new(),
        artwork_dir: artwork_dir.to_path_buf(),
        created_dir: false,
        committed: false,
    };
    if !assets.is_empty() {
        staged.created_dir = fs::symlink_metadata(artwork_dir)
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
        ensure_artwork_dir(artwork_dir)?;
        for (name, bytes) in &assets {
            let (installed_name, created) = installer(artwork_dir, name, bytes)?;
            if let Some(created) = created {
                staged.created.push(created);
            }
            installed.insert(name.clone(), installed_name);
        }
    }
    for game in library["games"].as_array_mut().expect("validated games") {
        let fields = game.as_object_mut().expect("validated game record");
        for field in ARTWORK_FIELDS {
            let Some(original) = fields.get(field).and_then(Value::as_str) else {
                fields.insert(field.to_owned(), Value::String(String::new()));
                continue;
            };
            let replacement = if let Some(name) = installed.get(original) {
                name.clone()
            } else if valid_artwork_name(original)
                && read_bounded(&artwork_dir.join(original), MAX_IMAGE)
                    .is_ok_and(|bytes| valid_image(original, &bytes))
            {
                // An incomplete portable backup can still use already-local
                // artwork, matching Orbit's existing Electron restore flow.
                original.to_owned()
            } else {
                String::new()
            };
            fields.insert(field.to_owned(), Value::String(replacement));
        }
    }
    staged.library = library;
    Ok(staged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::File;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        dest: PathBuf,
        output: PathBuf,
        cover: String,
        banner: String,
        icon: String,
        payload: Value,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("orbit-backup-test-{}", Uuid::new_v4()));
            let source = root.join("source");
            let dest = root.join("dest");
            fs::create_dir_all(&source).unwrap();
            let cover = format!("{}.png", Uuid::new_v4());
            let banner = format!("{}.jpg", Uuid::new_v4());
            let icon = format!("{}.webp", Uuid::new_v4());
            fs::write(source.join(&cover), png()).unwrap();
            fs::write(source.join(&banner), jpeg()).unwrap();
            fs::write(source.join(&icon), webp()).unwrap();
            let game_id = Uuid::new_v4().to_string();
            let payload = json!({
                "format":"orbit.library.v1",
                "settings":{"theme":"dark"},
                "games":[{"id":game_id,"name":"Example","cover":cover,"banner":banner,"icon":icon,"total_play_seconds":555}],
                "sessions":[{
                    "id":Uuid::new_v4().to_string(),"game_id":game_id,
                    "started_at":"2025-07-20T10:00:00.000Z",
                    "finished_at":"2025-07-20T10:09:15.000Z","seconds":555
                }]
            });
            let output = root.join("backup.orbit");
            Self {
                root,
                source,
                dest,
                output,
                cover,
                banner,
                icon,
                payload,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn png() -> Vec<u8> {
        [vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10], vec![1; 32]].concat()
    }

    fn jpeg() -> Vec<u8> {
        [vec![0xff, 0xd8, 0xff], vec![2; 20]].concat()
    }

    fn webp() -> Vec<u8> {
        [b"RIFF".to_vec(), vec![0; 4], b"WEBP".to_vec(), vec![3; 20]].concat()
    }

    fn write_envelope(f: &Fixture, library: &Value, artwork: Value) {
        let value = json!({"format":PORTABLE_FORMAT,"library":library,"artwork":artwork});
        fs::write(
            &f.output,
            gzip_bounded(&serde_json::to_vec(&value).unwrap()).unwrap(),
        )
        .unwrap();
    }

    fn artwork_entry(name: &str, encoded: String) -> Value {
        let mut map = Map::new();
        map.insert(name.to_owned(), Value::String(encoded));
        Value::Object(map)
    }

    #[test]
    fn cross_format_roundtrip_and_repeated_restore_reuses_files() {
        let f = Fixture::new();
        let result = export_backup(&f.payload, &f.source, &f.output).unwrap();
        assert_eq!(result["artworkCount"], 3);
        assert_eq!(result["missingArtwork"], 0);
        let restored = import_backup(&f.output, &f.dest).unwrap();
        assert_eq!(restored["settings"], f.payload["settings"]);
        assert_eq!(restored["sessions"], f.payload["sessions"]);
        for (field, name, expected) in [
            ("cover", &f.cover, png()),
            ("banner", &f.banner, jpeg()),
            ("icon", &f.icon, webp()),
        ] {
            let new_name = restored["games"][0][field].as_str().unwrap();
            assert_ne!(new_name, name.as_str());
            assert!(valid_artwork_name(new_name));
            assert_eq!(fs::read(f.dest.join(new_name)).unwrap(), expected);
        }
        let again = import_backup(&f.output, &f.dest).unwrap();
        assert_eq!(restored, again);
        assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 3);
    }

    #[test]
    fn legacy_v1_without_session_history_still_imports() {
        let f = Fixture::new();
        let mut legacy = f.payload.clone();
        legacy.as_object_mut().unwrap().remove("sessions");
        write_envelope(&f, &legacy, json!({}));
        let restored = import_backup(&f.output, &f.dest).unwrap();
        assert!(restored.get("sessions").is_none());
        assert_eq!(restored["games"][0]["name"], "Example");
        assert!(!f.dest.exists());
    }

    #[test]
    fn zero_second_completed_sessions_accept_valid_timezone_offsets() {
        let f = Fixture::new();
        let mut library = f.payload.clone();
        library["sessions"][0]["started_at"] = json!("2025-07-20T12:00:00+02:00");
        library["sessions"][0]["finished_at"] = json!("2025-07-20T10:00:01Z");
        library["sessions"][0]["seconds"] = json!(0);
        export_backup(&library, &f.source, &f.output).unwrap();
        let restored = import_backup(&f.output, &f.dest).unwrap();
        assert_eq!(restored["sessions"], library["sessions"]);
    }

    #[test]
    fn zero_second_completed_session_with_identical_timestamps_roundtrips() {
        let f = Fixture::new();
        let mut library = f.payload.clone();
        library["sessions"][0]["finished_at"] = library["sessions"][0]["started_at"].clone();
        library["sessions"][0]["seconds"] = json!(0);
        export_backup(&library, &f.source, &f.output).unwrap();
        let restored = import_backup(&f.output, &f.dest).unwrap();
        assert_eq!(restored["sessions"], library["sessions"]);
        assert_eq!(
            restored["sessions"][0]["started_at"],
            restored["sessions"][0]["finished_at"]
        );
        assert_eq!(restored["sessions"][0]["seconds"], 0);
    }

    #[test]
    fn malformed_sessions_cannot_install_artwork_or_export_backup() {
        let f = Fixture::new();
        fs::create_dir_all(&f.dest).unwrap();
        fs::write(f.dest.join("preserve.txt"), b"untouched").unwrap();
        let sample = f.payload["sessions"][0].clone();
        let mut duplicate = sample.clone();
        duplicate["finished_at"] = json!("2025-07-20T11:00:00.000Z");
        let mut missing_id = sample.clone();
        missing_id.as_object_mut().unwrap().remove("id");
        let mut extra_field = sample.clone();
        extra_field["heartbeat_seconds"] = json!(3);
        let mut invalid_end = sample.clone();
        invalid_end["finished_at"] = Value::Null;
        let mut invalid_seconds = sample.clone();
        invalid_seconds["seconds"] = json!(1.5);
        let mut future_duration = sample.clone();
        future_duration["seconds"] = json!(MAX_SESSION_SECONDS + 1);
        let mut unknown_game = sample.clone();
        unknown_game["game_id"] = json!(Uuid::new_v4().to_string());
        let mut backwards = sample.clone();
        backwards["finished_at"] = json!("2025-07-20T09:00:00.000Z");
        let mut malformed_date = sample.clone();
        malformed_date["started_at"] = json!("2025-13-20T10:00:00Z");
        let mut nonstring_id = sample.clone();
        nonstring_id["id"] = json!(4);
        let mut empty_id = sample.clone();
        empty_id["id"] = json!("");
        let mut very_long_id = sample.clone();
        very_long_id["id"] = json!("a".repeat(MAX_SESSION_ID_LENGTH + 1));
        let mut invalid_integer = sample.clone();
        invalid_integer["seconds"] = json!(-1);
        for sessions in [
            Value::Null,
            json!({}),
            json!([null]),
            json!([missing_id]),
            json!([extra_field]),
            json!([invalid_end]),
            json!([invalid_seconds]),
            json!([future_duration]),
            json!([unknown_game]),
            json!([backwards]),
            json!([malformed_date]),
            json!([nonstring_id]),
            json!([empty_id]),
            json!([very_long_id]),
            json!([invalid_integer]),
            json!([sample.clone(), duplicate]),
        ] {
            let mut library = f.payload.clone();
            library["sessions"] = sessions;
            write_envelope(&f, &library, artwork_entry(&f.cover, BASE64.encode(png())));
            assert!(import_backup(&f.output, &f.dest).is_err(), "{library}");
            assert!(export_backup(&library, &f.source, &f.root.join("bad-export.orbit")).is_err());
            assert!(!f.root.join("bad-export.orbit").exists());
            assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 1);
            assert_eq!(fs::read(f.dest.join("preserve.txt")).unwrap(), b"untouched");
        }
    }

    #[test]
    fn session_history_rejects_duplicate_game_ids_and_excessive_rows() {
        let f = Fixture::new();
        let mut library = f.payload.clone();
        let repeated_game = library["games"][0].clone();
        library["games"].as_array_mut().unwrap().push(repeated_game);
        write_envelope(&f, &library, artwork_entry(&f.cover, BASE64.encode(png())));
        assert!(import_backup(&f.output, &f.dest).is_err());
        assert!(!f.dest.exists());

        let mut too_many = f.payload.clone();
        too_many["sessions"] =
            Value::Array(vec![f.payload["sessions"][0].clone(); MAX_LIBRARY_ROWS + 1]);
        write_envelope(&f, &too_many, artwork_entry(&f.cover, BASE64.encode(png())));
        assert!(import_backup(&f.output, &f.dest).is_err());
        assert!(export_backup(&too_many, &f.source, &f.root.join("bad-export.orbit")).is_err());
        assert!(!f.dest.exists());
    }

    #[test]
    fn crafted_portable_game_or_database_conflict_cannot_install_artwork() {
        let f = Fixture::new();
        let embedded = artwork_entry(&f.cover, BASE64.encode(png()));

        // An empty sessions array used to evade game-ID validation. The
        // archive must not create artwork that the DB will later reject.
        let mut missing_game_id = f.payload.clone();
        missing_game_id["sessions"] = json!([]);
        missing_game_id["games"][0]
            .as_object_mut()
            .unwrap()
            .remove("id");
        write_envelope(&f, &missing_game_id, embedded.clone());
        assert!(import_backup(&f.output, &f.dest).is_err());
        assert!(!f.dest.exists());

        // Even a structurally valid history may conflict with a real target
        // game/session. The caller's rollback-only DB preflight must run
        // before portable artwork installation.
        write_envelope(&f, &f.payload, embedded);
        let result = import_backup_checked(&f.output, &f.dest, |_| {
            Err("Conflicting session ID in destination".into())
        });
        assert!(result.unwrap_err().contains("Conflicting session"));
        assert!(!f.dest.exists());
    }

    #[test]
    fn legacy_portable_without_sessions_runs_sql_preflight_before_artwork_installation() {
        let f = Fixture::new();
        let mut legacy = f.payload.clone();
        legacy.as_object_mut().unwrap().remove("sessions");
        write_envelope(&f, &legacy, artwork_entry(&f.cover, BASE64.encode(png())));
        let sqlite = f.root.join("library.sqlite");
        let mut db = crate::database::LibraryDatabase::open(&sqlite).unwrap();
        let conn = rusqlite::Connection::open(&sqlite).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER block_legacy_restore BEFORE INSERT ON games
             BEGIN SELECT RAISE(ABORT,'database import rejected'); END;",
        )
        .unwrap();

        let failure = import_backup_checked(&f.output, &f.dest, |payload| {
            db.preflight_restore_json(payload)
        })
        .unwrap_err();
        assert!(failure.contains("database import rejected"), "{failure}");
        assert!(
            !f.dest.exists(),
            "failed legacy SQL preflight must not install artwork"
        );
        assert_eq!(db.count().unwrap(), 0);

        conn.execute_batch("DROP TRIGGER block_legacy_restore")
            .unwrap();
        let restored = import_backup_checked(&f.output, &f.dest, |payload| {
            db.preflight_restore_json(payload)
        })
        .unwrap();
        assert_eq!(db.count().unwrap(), 0, "preflight must roll back writes");
        assert_eq!(db.restore_json(&restored).unwrap()["imported"], 1);
        assert_eq!(db.count().unwrap(), 1);
        let image = restored["games"][0]["cover"].as_str().unwrap();
        assert_eq!(fs::read(f.dest.join(image)).unwrap(), png());
        drop(conn);
        drop(db);
    }

    #[test]
    fn partial_artwork_install_failure_rolls_back_new_links_but_keeps_identical_existing() {
        let f = Fixture::new();
        let mut artwork = Map::new();
        let mut images = vec![
            (f.cover.clone(), png()),
            (f.banner.clone(), jpeg()),
            (f.icon.clone(), webp()),
        ];
        images.sort_by(|left, right| left.0.cmp(&right.0));
        for (name, bytes) in &images {
            artwork.insert(name.clone(), json!(BASE64.encode(bytes)));
        }
        write_envelope(&f, &f.payload, Value::Object(artwork));
        fs::create_dir_all(&f.dest).unwrap();
        let (existing_name, seeded) = install_artwork(&f.dest, &images[0].0, &images[0].1).unwrap();
        assert!(seeded.is_some());
        fs::write(f.dest.join("keep.txt"), b"unrelated").unwrap();

        let mut attempts = 0;
        let failed = import_backup_staged_with_installer(
            &f.output,
            &f.dest,
            |_| Ok(()),
            |directory, name, bytes| {
                attempts += 1;
                if attempts == 3 {
                    return Err("simulated ENOSPC writing third artwork".into());
                }
                install_artwork(directory, name, bytes)
            },
        );
        assert!(failed
            .err()
            .expect("injected failure must abort")
            .contains("simulated ENOSPC"));
        assert_eq!(attempts, 3);
        assert_eq!(fs::read(f.dest.join(&existing_name)).unwrap(), images[0].1);
        assert_eq!(fs::read(f.dest.join("keep.txt")).unwrap(), b"unrelated");
        assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 2);
    }

    #[test]
    fn post_preflight_database_failure_rolls_back_only_new_artwork() {
        let f = Fixture::new();
        let mut artwork = Map::new();
        artwork.insert(f.cover.clone(), json!(BASE64.encode(png())));
        artwork.insert(f.banner.clone(), json!(BASE64.encode(jpeg())));
        write_envelope(&f, &f.payload, Value::Object(artwork));
        fs::create_dir_all(&f.dest).unwrap();
        let (existing_name, _) = install_artwork(&f.dest, &f.cover, &png()).unwrap();
        let sqlite = f.root.join("sqlite-post-preflight.sqlite");
        let mut db = crate::database::LibraryDatabase::open(&sqlite).unwrap();
        let staged = import_backup_checked_staged(&f.output, &f.dest, |library| {
            db.preflight_restore_json(library)
        })
        .unwrap();
        assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 2);

        // A transient DB error appears only after preflight and artwork
        // installation; session restore is transactional and rolls back.
        let other = rusqlite::Connection::open(&sqlite).unwrap();
        other
            .execute_batch(
                "CREATE TRIGGER inject_post_artwork_failure BEFORE INSERT ON sessions
             BEGIN SELECT RAISE(ABORT,'simulated SQLITE_FULL'); END;",
            )
            .unwrap();
        let restore = db.restore_json(staged.library());
        let failure = staged.finish(restore, None).unwrap_err();
        assert!(failure.contains("simulated SQLITE_FULL"), "{failure}");
        assert_eq!(db.count().unwrap(), 0);
        assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 1);
        assert_eq!(fs::read(f.dest.join(existing_name)).unwrap(), png());
    }

    #[test]
    fn legacy_partial_restore_keeps_art_for_committed_games_and_prunes_orphans() {
        let f = Fixture::new();
        let mut legacy = f.payload.clone();
        legacy.as_object_mut().unwrap().remove("sessions");
        legacy["games"][0]["banner"] = json!("");
        legacy["games"][0]["icon"] = json!("");
        legacy["games"].as_array_mut().unwrap().push(json!({
            "name":"Reject this game after preflight", "source":"gog",
            "source_id":"rejected-unique-identity", "cover":f.banner
        }));
        let mut artwork = Map::new();
        artwork.insert(f.cover.clone(), json!(BASE64.encode(png())));
        artwork.insert(f.banner.clone(), json!(BASE64.encode(jpeg())));
        write_envelope(&f, &legacy, Value::Object(artwork));
        let sqlite = f.root.join("legacy-partial.sqlite");
        let mut db = crate::database::LibraryDatabase::open(&sqlite).unwrap();
        let staged = import_backup_checked_staged(&f.output, &f.dest, |payload| {
            db.preflight_restore_json(payload)
        })
        .unwrap();
        assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 2);

        let conn = rusqlite::Connection::open(&sqlite).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_one_import BEFORE INSERT ON games
             WHEN NEW.name='Reject this game after preflight'
             BEGIN SELECT RAISE(ABORT, 'simulated legacy per-item error'); END;",
        )
        .unwrap();
        let restored = db.restore_json(staged.library());
        assert!(
            restored.as_ref().unwrap()["errors"]
                .as_array()
                .unwrap()
                .len()
                == 1
        );
        let referenced = db
            .list("name")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|game| {
                ["cover", "banner", "icon"]
                    .into_iter()
                    .filter_map(|field| game[field].as_str().map(str::to_owned))
            })
            .collect::<HashSet<String>>();
        let report = staged.finish(restored, Some(&referenced)).unwrap();
        assert_eq!(report["imported"], 1);
        assert_eq!(db.count().unwrap(), 1);
        assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 1);
        let cover = db.list("name").unwrap()[0]["cover"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(fs::read(f.dest.join(cover)).unwrap(), png());
    }

    #[test]
    fn missing_and_oversized_source_images_are_reported() {
        let f = Fixture::new();
        fs::remove_file(f.source.join(&f.cover)).unwrap();
        let mut too_large = png();
        too_large.resize((MAX_IMAGE + 1) as usize, 0);
        fs::write(f.source.join(&f.banner), too_large).unwrap();
        let result = export_backup(&f.payload, &f.source, &f.output).unwrap();
        assert_eq!(result["artworkCount"], 1);
        assert_eq!(result["missingArtwork"], 2);
        let restored = import_backup(&f.output, &f.dest).unwrap();
        assert_eq!(restored["games"][0]["cover"], "");
        assert_eq!(restored["games"][0]["banner"], "");
    }

    #[test]
    fn rejects_traversal_unreferenced_images_and_noncanonical_base64() {
        let f = Fixture::new();
        let raw = BASE64.encode(png());
        for artwork in [
            artwork_entry("../../escape.png", raw.clone()),
            artwork_entry(&format!("{}.png", Uuid::new_v4()), raw.clone()),
            artwork_entry(&f.cover, format!("{raw}\n")),
            artwork_entry(&f.cover, BASE64.encode(b"bad")),
        ] {
            write_envelope(&f, &f.payload, artwork);
            assert!(import_backup(&f.output, &f.dest).is_err());
            assert!(!f.dest.exists());
        }
    }

    #[test]
    fn archive_is_bounded_and_corrupt_gzip_is_rejected() {
        let f = Fixture::new();
        fs::write(&f.output, b"not gzip").unwrap();
        assert!(import_backup(&f.output, &f.dest).is_err());
        fs::write(&f.output, [0x1f, 0x8b, 0x00]).unwrap();
        assert!(import_backup(&f.output, &f.dest).is_err());
        let file = File::create(&f.output).unwrap();
        file.set_len(MAX_ARCHIVE + 1).unwrap();
        drop(file);
        assert!(import_backup(&f.output, &f.dest).is_err());
        let packed = gzip_bounded(&vec![b'A'; 2000]).unwrap();
        assert!(gunzip_limited(&packed, 1024).is_err());
    }

    #[test]
    fn a_conflicting_content_addressed_file_is_never_overwritten() {
        let f = Fixture::new();
        export_backup(&f.payload, &f.source, &f.output).unwrap();
        fs::create_dir_all(&f.dest).unwrap();
        let digest = format!("{:x}", Sha256::digest(png()));
        let collision = format!(
            "{}-{}-{}-{}-{}.png",
            &digest[0..8],
            &digest[8..12],
            &digest[12..16],
            &digest[16..20],
            &digest[20..32]
        );
        fs::write(f.dest.join(&collision), b"unrelated contents").unwrap();
        let restored = import_backup(&f.output, &f.dest).unwrap();
        let installed = restored["games"][0]["cover"].as_str().unwrap();
        assert_ne!(installed, collision);
        assert_eq!(
            fs::read(f.dest.join(&collision)).unwrap(),
            b"unrelated contents"
        );
        assert_eq!(fs::read(f.dest.join(installed)).unwrap(), png());
    }
}

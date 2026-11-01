//! Portable Orbit backups. This format is shared with src/core/backup.cjs.
//! Only artwork referenced by a library game may be restored to disk.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};
use uuid::Uuid;

const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED: u64 = 192 * 1024 * 1024;
const MAX_IMAGE: u64 = 15 * 1024 * 1024;
const MAX_ARTWORK_TOTAL: u64 = 100 * 1024 * 1024;
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
    if rows.len() > 100_000 || rows.iter().any(|game| !game.is_object()) {
        return Err(err("Invalid games in Orbit library."));
    }
    Ok(rows)
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
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(err("File exceeds the safe size limit."));
    }
    Ok(bytes)
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
fn install_artwork(dir: &Path, original: &str, bytes: &[u8]) -> Result<String, String> {
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
    let result = (|| -> Result<String, String> {
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
                Ok(()) => return Ok(name),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if existing_is_identical(&target, bytes) {
                        return Ok(name);
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
        if !valid_image(name, &bytes) || BASE64.encode(&bytes) != source {
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
pub fn import_backup(input: &Path, artwork_dir: &Path) -> Result<Value, String> {
    let compressed = read_bounded(input, MAX_ARCHIVE)
        .map_err(|_| err("Invalid Orbit portable backup or archive exceeds the 128 MB limit."))?;
    let unpacked = gunzip_bounded(&compressed)?;
    let envelope: Value = serde_json::from_slice(&unpacked)
        .map_err(|_| err("Portable backup is corrupt or exceeds the safe size limit."))?;
    if envelope.get("format").and_then(Value::as_str) != Some(PORTABLE_FORMAT) {
        return Err(err("Unrecognized portable backup format."));
    }
    let mut library = envelope
        .get("library")
        .cloned()
        .ok_or_else(|| err("Unrecognized portable backup format."))?;
    let rows = games(&library)?;
    let referenced = asset_names(rows);
    let artwork = envelope
        .get("artwork")
        .and_then(Value::as_object)
        .ok_or_else(|| err("Unrecognized portable backup format."))?;
    // Fully validate the entire archive before making any filesystem changes.
    let assets = decode_artwork(artwork, &referenced)?;
    let mut installed = BTreeMap::new();
    if !assets.is_empty() {
        ensure_artwork_dir(artwork_dir)?;
        for (name, bytes) in &assets {
            installed.insert(name.clone(), install_artwork(artwork_dir, name, bytes)?);
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
    Ok(library)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
            let payload = json!({
                "format":"orbit.library.v1",
                "settings":{"theme":"dark"},
                "games":[{"name":"Example","cover":cover,"banner":banner,"icon":icon,"total_play_seconds":555}]
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

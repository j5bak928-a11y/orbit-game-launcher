//! Orbit's local game and operating-system operations.
//! The database owns session records. This module owns only process handles and
//! reports completed sessions/checkpoints for the database to persist.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, DirEntry};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAX_ENTRIES: usize = 6_000;
const MAX_ROOTS: usize = 64;
const MANIFEST_BYTES: u64 = 3 * 1024 * 1024;
const MAX_SESSIONS: usize = 128;
const MAX_STORE_RECORDS: usize = 2_048;

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn safe_text(text: &str, limit: usize) -> bool {
    !text.trim().is_empty() && text.len() <= limit && !text.chars().any(char::is_control)
}

fn require_absolute_file(text: &str) -> Result<PathBuf, String> {
    if !safe_text(text, 4_000) {
        return Err("Choose an executable file on this computer.".into());
    }
    let path = PathBuf::from(text);
    if !path.is_absolute() {
        return Err("Executable path must be absolute.".into());
    }
    if !path.is_file() {
        return Err(
            "The game executable was not found. Check whether the drive is connected.".into(),
        );
    }
    #[cfg(windows)]
    if !matches!(extension(&path).as_str(), "exe" | "com") {
        return Err("Choose a Windows executable (.exe or .com).".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("Selected file is not marked executable.".into());
        }
    }
    Ok(path)
}

fn extension(file: &Path) -> String {
    file.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn filename(file: &Path) -> String {
    file.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn clean_name(value: &str) -> String {
    value
        .replace('_', " ")
        .replace('-', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(140)
        .collect()
}

fn normalized_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn known_game(value: &str) -> Option<&'static str> {
    let needle = normalized_name(value);
    const CATALOG: &[(&str, &[&str])] = &[
        (
            "Call of Duty: Modern Warfare 4",
            &[
                "callofdutymodernwarfare4",
                "modernwarfare4",
                "codmodernwarfare4",
                "codmw4",
                "cod26cod",
            ],
        ),
        (
            "Hearts of Iron IV",
            &["hoi4", "heartsofiron4", "heartsofironiv"],
        ),
        (
            "Europa Universalis IV",
            &["eu4", "europauniversalis4", "europauniversalisiv"],
        ),
        (
            "Crusader Kings III",
            &["ck3", "crusaderkings3", "crusaderkingsiii"],
        ),
        (
            "Crusader Kings II",
            &["ck2", "crusaderkings2", "crusaderkingsii"],
        ),
        ("Victoria 3", &["vic3", "victoria3", "vicky3"]),
        ("Stellaris", &["stellaris"]),
        ("Cities: Skylines", &["citiesskylines", "cities1"]),
        ("Cities: Skylines II", &["citiesskylines2", "cities2"]),
        (
            "Grand Theft Auto V",
            &["gta5", "gtav", "grandtheftauto5", "grandtheftautov"],
        ),
        ("Red Dead Redemption 2", &["rdr2", "reddeadredemption2"]),
        ("Cyberpunk 2077", &["cyberpunk2077"]),
        (
            "The Witcher 3: Wild Hunt",
            &["witcher3", "thewitcher3", "witcher3wildhunt"],
        ),
        ("Baldur’s Gate 3", &["bg3", "baldursgate3"]),
        ("Elden Ring", &["eldenring"]),
        ("Hollow Knight", &["hollowknight"]),
        (
            "Hollow Knight: Silksong",
            &["silksong", "hollowknightsilksong"],
        ),
        ("RimWorld", &["rimworld", "rimworldwin64"]),
        ("Factorio", &["factorio"]),
        ("Terraria", &["terraria"]),
        ("Stardew Valley", &["stardewvalley"]),
        ("Valheim", &["valheim"]),
        (
            "Project Zomboid",
            &["projectzomboid", "zomboid64", "zomboid"],
        ),
        (
            "Mount & Blade II: Bannerlord",
            &["bannerlord", "mountblade2bannerlord"],
        ),
        ("The Sims 4", &["ts4", "thesims4"]),
        ("Counter-Strike 2", &["cs2", "counterstrike2"]),
        ("Dota 2", &["dota2"]),
        ("Rocket League", &["rocketleague"]),
        (
            "Kingdom Come: Deliverance",
            &["kingdomcome", "kingdomcomedeliverance"],
        ),
    ];
    CATALOG
        .iter()
        .find(|(title, aliases)| {
            normalized_name(title) == needle
                || aliases.iter().any(|alias| *alias == needle.as_str())
        })
        .map(|(title, _)| *title)
}

fn sensible_product_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    valid_title(name)
        && name.chars().count() >= 3
        && !generic_game_label(name)
        && ![
            "microsoft",
            "windows",
            "unity",
            "unreal engine",
            "electron",
            "game engine",
            "product name",
            "unknown",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

/// Unreal's bootstrap and shipping binaries describe the runtime, not the
/// installed game's identity. These are also directory components that should
/// never outrank an actual product folder.
fn generic_game_label(value: &str) -> bool {
    matches!(
        normalized_name(value).as_str(),
        "" | "game"
            | "gamewin32shipping"
            | "gamewin64shipping"
            | "bootstrappackagedgame"
            | "bootstrapper"
            | "bootstrap"
            | "launcher"
            | "launch"
            | "start"
            | "play"
            | "run"
            | "shipping"
            | "win32shipping"
            | "win64shipping"
            | "unityplayer"
            | "unrealengine"
            | "unreal"
            | "ue4game"
            | "ue5game"
            | "application"
            | "program"
            | "project"
            | "setup"
            | "install"
            | "binaries"
            | "bin"
            | "win32"
            | "win64"
            | "x64"
            | "x86"
            | "x8664"
            | "engine"
            | "content"
            | "retail"
            | "release"
            | "windows"
            | "games"
            | "gamefiles"
            | "downloads"
            | "desktop"
            | "documents"
            | "users"
            | "programfiles"
            | "programfilesx86"
            | "steamapps"
            | "common"
            | "redist"
            | "prerequisites"
    )
}

fn without_shipping_suffix(value: &str) -> &str {
    let lower = value.to_ascii_lowercase();
    for suffix in [
        "-win64-shipping",
        "_win64_shipping",
        "-win32-shipping",
        "_win32_shipping",
        "-shipping",
        "_shipping",
    ] {
        if lower.ends_with(suffix) {
            return value[..value.len() - suffix.len()]
                .trim_end_matches(|c: char| c == '-' || c == '_' || c == ' ');
        }
    }
    value
}

/// Strip well-known distribution labels, not arbitrary words such as "Games"
/// which may legitimately be part of a game's title.
fn clean_product_folder(value: &str) -> Option<String> {
    let mut label = value.trim();
    for marker in [
        "-steamrip.com",
        "_steamrip.com",
        "-ankergames",
        "_ankergames",
        "-steamunlocked.net",
        "_steamunlocked.net",
        "-gog-games.com",
        "-fitgirl-repacks",
        "-fitgirl-repack",
        "-dodi-repacks",
        "-dodi-repack",
        "-elamigos",
        "-skidrow",
        "-tenoke",
    ] {
        let lowercase = label.to_ascii_lowercase();
        if lowercase.ends_with(marker) {
            label = label[..label.len() - marker.len()]
                .trim_end_matches(|c: char| matches!(c, '-' | '_' | '.' | ' '));
            break;
        }
    }
    // Other suffixes that look like download-site domains are not game names.
    // Only remove a trailing hyphen/underscore-delimited domain.
    if let Some(index) = label.rfind(|c: char| c == '-' || c == '_') {
        let suffix = &label[index + 1..];
        let lower = suffix.to_ascii_lowercase();
        if [".com", ".net", ".org", ".to"]
            .iter()
            .any(|tld| lower.ends_with(tld))
            && suffix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.')
        {
            label = label[..index].trim_end_matches(|c: char| matches!(c, '-' | '_' | '.' | ' '));
        }
    }
    let cleaned = clean_name(label);
    (!generic_game_label(&cleaned) && valid_title(&cleaned) && cleaned.chars().count() >= 3)
        .then_some(cleaned)
}

fn title_contains_stem(title: &str, stem: &str) -> bool {
    let stem = normalized_name(stem);
    if stem.len() < 3 {
        return false;
    }
    let title = normalized_name(title);
    title.contains(&stem) || (title.starts_with("assassinscreed") && stem.starts_with("ac"))
}

/// Pure identity heuristic, separate from file validation and OS metadata I/O,
/// so Unreal layouts and unpacked-folder names can be regression tested.
/// Returns (display name, suggestion, evidence source).
fn game_file_title(file: &Path, product: Option<&str>) -> (String, String, &'static str) {
    let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let shortened = without_shipping_suffix(stem);
    let executable_title = clean_product_folder(shortened);
    let shipping_binary = shortened != stem;
    let mut folders = Vec::new();
    let mut parent = file.parent();
    // Win64 -> Binaries -> <game> and nested UE5 engine layouts fit within
    // five ancestors. Stop at a filesystem root; do not use generic folders.
    for _ in 0..5 {
        let Some(dir) = parent else {
            break;
        };
        let folder = filename(dir);
        // Directory names above the game installation are not product
        // evidence. In particular, never turn a Windows account name into
        // the title of a generic Unreal bootstrap executable.
        let boundary = matches!(
            normalized_name(&folder).as_str(),
            "downloads"
                | "desktop"
                | "documents"
                | "users"
                | "games"
                | "steamapps"
                | "common"
                | "programfiles"
                | "programfilesx86"
                | "appdata"
                | "local"
                | "roaming"
                | "temp"
                | "tmp"
        );
        let profile_root = dir
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| normalized_name(&name.to_string_lossy()) == "users");
        if boundary || profile_root {
            break;
        }
        if let Some(title) = clean_product_folder(&folder) {
            folders.push(title);
        }
        parent = dir.parent();
    }
    // Prefer a richer title from a containing folder if it includes the short
    // executable identity (Creed.exe -> Assassin's Creed Mirage), even when
    // another nested folder has just "Creed".
    let ambiguous_folder = executable_title.is_none()
        && folders.first().is_some_and(|closest| {
            folders
                .iter()
                .skip(1)
                .any(|outer| normalized_name(outer) != normalized_name(closest))
        });
    let folder_title = if let Some(exe) = executable_title.as_deref() {
        // A short executable such as Creed.exe can justify a more specific
        // enclosing title. Do not prefer longer unrelated ancestor folders.
        folders
            .iter()
            .filter(|name| title_contains_stem(name, exe))
            .max_by_key(|name| name.chars().count())
            .or_else(|| folders.first())
            .cloned()
    } else {
        // For generic Unreal binaries prefer an expanded display title when
        // an enclosing directory is the same name with word separators.
        // Never promote an unrelated (possibly temporary) parent directory
        // into a game title. Distinct nested names remain unverified instead.
        folders.first().map(|closest| {
            folders
                .iter()
                .skip(1)
                .filter(|outer| normalized_name(outer) == normalized_name(closest))
                .max_by_key(|outer| outer.chars().count())
                .cloned()
                .unwrap_or_else(|| closest.clone())
        })
    };
    let fallback = match (&executable_title, &folder_title) {
        (None, Some(folder)) => folder.clone(),
        (Some(_), Some(folder)) if shipping_binary => folder.clone(),
        (Some(exe), Some(folder))
            if title_contains_stem(folder, exe) && folder.chars().count() > exe.chars().count() =>
        {
            folder.clone()
        }
        (Some(exe), _) => exe.clone(),
        (None, None) => "Untitled game".to_string(),
    };
    if let Some(known) = known_game(stem).or_else(|| known_game(shortened)) {
        return (known.to_string(), fallback, "executable");
    }
    let product = product
        .filter(|name| sensible_product_name(name))
        .and_then(clean_product_folder);
    if let Some(known) = product.as_deref().and_then(known_game) {
        return (known.to_string(), fallback, "metadata");
    }
    for folder in &folders {
        if let Some(known) = known_game(folder) {
            return (known.to_string(), fallback, "folder");
        }
    }
    if let Some(product) = product {
        // VersionInfo may contain just an internal project codename, even
        // when a more complete game name is visible in an enclosing folder.
        if let Some(folder) = &folder_title {
            if title_contains_stem(folder, &product)
                && folder.chars().count() > product.chars().count()
            {
                return (folder.clone(), fallback, "folder");
            }
        }
        return (product, fallback, "metadata");
    }
    let kind = if ambiguous_folder {
        "folder-unverified"
    } else if folder_title.as_deref() == Some(fallback.as_str()) {
        "folder"
    } else {
        "filename"
    };
    (fallback.clone(), fallback, kind)
}

#[cfg(windows)]
fn read_windows_product_name(file: &Path) -> Option<String> {
    use std::ffi::c_void;
    #[link(name = "version")]
    extern "system" {
        fn GetFileVersionInfoSizeW(file: *const u16, handle: *mut u32) -> u32;
        fn GetFileVersionInfoW(
            file: *const u16,
            handle: u32,
            length: u32,
            data: *mut c_void,
        ) -> i32;
        fn VerQueryValueW(
            data: *const c_void,
            key: *const u16,
            result: *mut *mut c_void,
            length: *mut u32,
        ) -> i32;
    }
    if extension(file) != "exe" {
        return None;
    }
    let path = wide(file.as_os_str());
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
    if size == 0 || size > 1024 * 1024 {
        return None;
    }
    let mut bytes = vec![0_u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, bytes.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let query = wide(std::ffi::OsStr::new(r"\VarFileInfo\Translation"));
    let mut address: *mut c_void = std::ptr::null_mut();
    let mut length = 0_u32;
    let mut translations = vec![(0x0409_u16, 0x04B0_u16), (0x0409, 0x04E4)];
    if unsafe {
        VerQueryValueW(
            bytes.as_ptr().cast(),
            query.as_ptr(),
            &mut address,
            &mut length,
        )
    } != 0
        && length >= 4
        && !address.is_null()
    {
        let offset = (address as usize).checked_sub(bytes.as_ptr() as usize)?;
        if offset.checked_add(4)? <= bytes.len() {
            let language = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
            let codepage = u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]);
            translations.insert(0, (language, codepage));
        }
    }
    for (language, codepage) in translations {
        let key = wide(std::ffi::OsStr::new(&format!(
            r"\StringFileInfo\{language:04X}{codepage:04X}\ProductName"
        )));
        address = std::ptr::null_mut();
        length = 0;
        if unsafe {
            VerQueryValueW(
                bytes.as_ptr().cast(),
                key.as_ptr(),
                &mut address,
                &mut length,
            )
        } == 0
            || length == 0
            || length > 512
            || address.is_null()
        {
            continue;
        }
        let Some(offset) = (address as usize).checked_sub(bytes.as_ptr() as usize) else {
            continue;
        };
        if offset
            .checked_add(length as usize * 2)
            .map_or(true, |end| end > bytes.len())
        {
            continue;
        }
        let utf16 = bytes[offset..offset + length as usize * 2]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .take_while(|u| *u != 0)
            .collect::<Vec<_>>();
        if let Ok(name) = String::from_utf16(&utf16) {
            let name = clean_name(&name);
            if sensible_product_name(&name) {
                return Some(name);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn read_windows_product_name(_file: &Path) -> Option<String> {
    None
}

fn valid_title(value: &str) -> bool {
    safe_text(value, 560) && value.chars().count() <= 140
}

fn valid_app_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .enumerate()
            .all(|(i, c)| c.is_ascii_alphanumeric() || (i > 0 && matches!(c, b'_' | b'.' | b'-')))
}

fn ignored_executable(file: &Path) -> bool {
    let stem = file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if stem.is_empty() {
        return true;
    }
    // Installer/launcher helpers can remain alive after the real game exits.
    // Never treat their presence alone as proof of an active game session.
    if stem == "launchgame"
        || stem.ends_with("launcher")
        || stem.ends_with("launcher64")
        || stem.ends_with("_eac")
        || stem.ends_with("-eac")
    {
        return true;
    }
    [
        "unins",
        "uninstall",
        "setup",
        "install",
        "crash",
        "update",
        "updater",
        "bootstrap",
        "vcredist",
        "vc_redist",
        "dxsetup",
        "redist",
        "eac",
        "easyanticheat",
        "eos",
        "repair",
        "launcherinstaller",
        "ue4prereq",
    ]
    .iter()
    .any(|prefix| stem.starts_with(prefix))
        || [
            "helper",
            "service",
            "dedicatedserver",
            "benchmark",
            "configtool",
        ]
        .iter()
        .any(|fragment| stem.contains(fragment))
}

fn ignored_dir(path: &Path) -> bool {
    let value = filename(path).to_ascii_lowercase();
    [
        "node_modules",
        ".git",
        "__pycache__",
        "redist",
        "redistributables",
        "_commonredist",
        "engine",
        "plugins",
        "content",
        "data",
        "assets",
        "support",
        "prerequisites",
        "system32",
        "tools",
        "installers",
        "directx",
        "easyanticheat",
        "crashreporter",
        "documentation",
    ]
    .contains(&value.as_str())
}

fn binary_dir(path: &Path) -> bool {
    [
        "bin",
        "binaries",
        "win64",
        "win32",
        "x64",
        "x86",
        "game",
        "gamefiles",
        "retail",
        "release",
        "shipping",
        "client",
    ]
    .contains(&filename(path).to_ascii_lowercase().as_str())
}

fn add_root(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if roots.len() >= MAX_ROOTS || !path.is_absolute() || roots.iter().any(|p| same_path(p, &path))
    {
        return;
    }
    roots.push(path);
}

fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn entries_at(dir: &Path, budget: usize) -> Result<(Vec<DirEntry>, bool), String> {
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        if entries.len() >= budget {
            truncated = true;
            break;
        }
        entries.push(item.map_err(|e| e.to_string())?);
    }
    Ok((entries, truncated))
}

fn small_text(file: &Path) -> Result<String, String> {
    let stat = fs::metadata(file).map_err(|e| e.to_string())?;
    if !stat.is_file() || stat.len() > MANIFEST_BYTES {
        return Err("Manifest too large or not a regular file".into());
    }
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MANIFEST_BYTES {
        return Err("Manifest too large".into());
    }
    String::from_utf8(bytes).map_err(|_| "Manifest is not UTF-8".into())
}

fn contained_file(root: &Path, relative: &str) -> Option<PathBuf> {
    if !safe_text(relative, 4_000) {
        return None;
    }
    let normalized = relative.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let candidate = root.join(path);
    let base = fs::canonicalize(root).ok()?;
    let actual = fs::canonicalize(&candidate).ok()?;
    if actual.starts_with(&base) && actual != base && actual.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn safe_installed_dir(dir: &str) -> Option<PathBuf> {
    if !safe_text(dir, 4_000) {
        return None;
    }
    let path = PathBuf::from(dir);
    if path.is_absolute() && path.is_dir() {
        Some(path)
    } else {
        None
    }
}

fn score_executable(file: &Path, title: &str, owner: &Path, depth: usize) -> i32 {
    if ignored_executable(file) {
        return -1000;
    }
    let simple = |text: &str| {
        text.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let name = simple(file.file_stem().and_then(|s| s.to_str()).unwrap_or(""));
    let title = simple(title);
    let folder = simple(&filename(owner));
    let mut score = 20 - (depth as i32 * 8);
    if name == title && !name.is_empty() {
        score += 150;
    }
    if name == folder && !name.is_empty() {
        score += 120;
    }
    if name.len() >= 3 && title.contains(&name) {
        score += 80;
    }
    if name.len() >= 3 && folder.contains(&name) {
        score += 60;
    }
    if !title.is_empty() && name.contains(&title) {
        score += 95;
    }
    if name.contains("launcher")
        || name.contains("helper")
        || name.contains("config")
        || name.contains("editor")
    {
        score -= 45;
    }
    if name.ends_with("shipping") || name.ends_with("win64") {
        score -= 12;
    }
    score
}

fn scan_folder(root: &Path, max_entries: usize, max_depth: usize) -> (Vec<Value>, Vec<String>) {
    let mut games = Vec::new();
    let mut warnings = Vec::new();
    if !root.is_absolute() || !root.is_dir() {
        return (
            games,
            vec![format!("Folder unavailable: {}", root.display())],
        );
    }
    let mut queue = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0_usize));
    let mut groups: HashMap<PathBuf, Vec<(PathBuf, i32)>> = HashMap::new();
    let mut checked = 0_usize;
    let mut truncated = false;
    while let Some((dir, depth)) = queue.pop_front() {
        if checked >= max_entries {
            truncated = true;
            break;
        }
        let (items, excess) = match entries_at(&dir, max_entries - checked) {
            Ok(items) => items,
            Err(error) => {
                warnings.push(format!("Cannot read {}: {}", dir.display(), error));
                continue;
            }
        };
        checked += items.len();
        truncated |= excess;
        for item in items {
            let file = item.path();
            let kind = match item.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir()
                && depth < max_depth
                && !ignored_dir(&file)
                && (depth < 2 || binary_dir(&file))
            {
                queue.push_back((file, depth + 1));
            } else if kind.is_file() && extension(&file) == "exe" {
                let mut owner = dir.clone();
                while owner != root && binary_dir(&owner) {
                    owner = owner.parent().unwrap_or(root).to_path_buf();
                }
                let score = score_executable(&file, &filename(&owner), &owner, depth);
                if score >= 0 {
                    groups.entry(owner).or_default().push((file, score));
                }
            }
        }
    }
    for (owner, mut candidates) in groups {
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        if owner == root {
            let recognized = candidates
                .iter()
                .filter_map(|(file, _)| {
                    let title =
                        known_game(file.file_stem().and_then(|s| s.to_str()).unwrap_or(""))?;
                    Some((file, title))
                })
                .collect::<Vec<_>>();
            if !recognized.is_empty() {
                let mut names = HashSet::new();
                for (file, title) in recognized {
                    if names.insert(title) {
                        games.push(json!({"name":title,"source":"folder","install_path":owner,
                            "executable":file,"tags":[]}));
                    }
                }
                continue;
            }
        }
        let top = candidates[0].1;
        let plausible = candidates
            .iter()
            .filter(|(_, score)| top - *score < 20)
            .count();
        let identified = candidates
            .iter()
            .take(plausible)
            .filter_map(|(file, _)| {
                known_game(file.file_stem().and_then(|s| s.to_str()).unwrap_or(""))
            })
            .collect::<HashSet<_>>();
        // Generic executables in the same folder cannot be reliably assigned to games.
        if plausible > 1 && identified.len() != 1 {
            warnings.push(format!(
                "Ambiguous executables in {}; select the game's executable manually.",
                owner.display()
            ));
            continue;
        }
        let file = if plausible > 1 {
            &candidates
                .iter()
                .find(|(file, _)| {
                    known_game(file.file_stem().and_then(|s| s.to_str()).unwrap_or("")).is_some()
                })
                .unwrap_or(&candidates[0])
                .0
        } else {
            &candidates[0].0
        };
        let label = if owner == root {
            file.file_stem().and_then(|s| s.to_str()).unwrap_or("")
        } else {
            owner.file_name().and_then(|s| s.to_str()).unwrap_or("")
        };
        let title = known_game(file.file_stem().and_then(|s| s.to_str()).unwrap_or(""))
            .or_else(|| known_game(label));
        games.push(
            json!({"name":title.map(str::to_owned).unwrap_or_else(||clean_name(label)),
            "source":"folder","install_path":owner,
            "executable":file,"tags":[]}),
        );
    }
    if truncated || checked >= max_entries {
        warnings.push(format!("Scan stopped at {max_entries} entries for {}; choose smaller folders for complete results.",root.display()));
    }
    (games, warnings)
}

// Minimal Valve KeyValues parser with an explicit token and nesting budget.
fn vdf_tokens(source: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        if c == '/' && chars.peek() == Some(&'/') {
            for ch in chars.by_ref() {
                if ch == '\n' {
                    break;
                }
            }
            continue;
        }
        let value = if c == '{' || c == '}' {
            c.to_string()
        } else if c == '"' {
            let mut out = String::new();
            let mut closed = false;
            while let Some(ch) = chars.next() {
                if ch == '"' {
                    closed = true;
                    break;
                }
                if ch == '\\' {
                    match chars.next() {
                        Some(escaped @ ('"' | '\\')) => out.push(escaped),
                        Some(other) => {
                            out.push('\\');
                            out.push(other);
                        }
                        None => break,
                    }
                } else {
                    out.push(ch);
                }
                if out.len() > 4_000 {
                    return Err("VDF token too long".into());
                }
            }
            if !closed {
                return Err("Unclosed VDF quoted string".into());
            }
            out
        } else {
            let mut out = c.to_string();
            while let Some(next) = chars.peek().copied() {
                if next.is_whitespace() || matches!(next, '{' | '}' | '"') {
                    break;
                }
                out.push(next);
                chars.next();
                if out.len() > 4_000 {
                    return Err("VDF token too long".into());
                }
            }
            out
        };
        tokens.push(value);
        if tokens.len() > 100_000 {
            return Err("VDF token limit exceeded".into());
        }
    }
    Ok(tokens)
}

fn vdf_object(tokens: &[String], index: &mut usize, depth: usize) -> Result<Value, String> {
    if depth > 32 {
        return Err("VDF nesting limit exceeded".into());
    }
    let mut map = serde_json::Map::new();
    while *index < tokens.len() {
        let key = &tokens[*index];
        *index += 1;
        if key == "}" {
            break;
        }
        if key == "{" {
            continue;
        }
        let Some(token) = tokens.get(*index) else {
            break;
        };
        *index += 1;
        if token == "}" {
            break;
        }
        let value = if token == "{" {
            vdf_object(tokens, index, depth + 1)?
        } else {
            Value::String(token.clone())
        };
        if !matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
            map.insert(key.clone(), value);
        }
    }
    Ok(Value::Object(map))
}

fn read_vdf(path: &Path) -> Result<Value, String> {
    let tokens = vdf_tokens(&small_text(path)?)?;
    vdf_object(&tokens, &mut 0, 0)
}

fn steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("STEAM_COMPAT_CLIENT_INSTALL_PATH") {
        add_root(&mut roots, PathBuf::from(path));
    }
    #[cfg(windows)]
    {
        for var in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(prefix) = std::env::var_os(var) {
                add_root(&mut roots, PathBuf::from(prefix).join("Steam"));
            }
        }
        add_root(&mut roots, PathBuf::from(r"C:\Program Files (x86)\Steam"));
        add_root(&mut roots, PathBuf::from(r"C:\Program Files\Steam"));
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        #[cfg(target_os = "macos")]
        add_root(&mut roots, home.join("Library/Application Support/Steam"));
        #[cfg(not(target_os = "macos"))]
        for path in [".steam/steam", ".steam/root", ".local/share/Steam"] {
            add_root(&mut roots, home.join(path));
        }
    }
    roots
}

fn discover_steam() -> (Vec<Value>, Vec<String>) {
    let mut roots = steam_roots();
    let mut warnings = Vec::new();
    let mut budget = MAX_ENTRIES;
    for root in roots.clone() {
        if !root.is_dir() {
            continue;
        }
        for file in ["steamapps/libraryfolders.vdf", "config/libraryfolders.vdf"] {
            let path = root.join(file);
            if !path.is_file() {
                continue;
            }
            match read_vdf(&path) {
                Ok(vdf) => {
                    if let Some(libs) = vdf
                        .get("libraryfolders")
                        .and_then(Value::as_object)
                        .or_else(|| vdf.get("LibraryFolders").and_then(Value::as_object))
                    {
                        for (key, value) in libs {
                            if !key.bytes().all(|c| c.is_ascii_digit()) {
                                continue;
                            }
                            let library = value
                                .as_str()
                                .or_else(|| value.get("path").and_then(Value::as_str));
                            if let Some(path) = library {
                                if safe_text(path, 4_000) {
                                    add_root(&mut roots, PathBuf::from(path));
                                }
                            }
                        }
                    }
                }
                Err(error) => warnings.push(format!("Steam library index: {error}")),
            }
        }
    }
    let mut games = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        if budget == 0 {
            break;
        }
        let appdir = root.join("steamapps");
        let Ok((entries, truncated)) = entries_at(&appdir, budget) else {
            continue;
        };
        budget -= entries.len();
        if truncated {
            warnings.push("Steam scan reached its metadata entry limit.".into());
        }
        for item in entries {
            let filename = filename(&item.path());
            let Some(id) = filename
                .strip_prefix("appmanifest_")
                .and_then(|s| s.strip_suffix(".acf"))
            else {
                continue;
            };
            if id.is_empty() || id.len() > 15 || !id.bytes().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if !item.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let state = match read_vdf(&item.path()) {
                Ok(v) => v.get("AppState").cloned().unwrap_or(Value::Null),
                Err(error) => {
                    warnings.push(format!("Steam {filename}: {error}"));
                    continue;
                }
            };
            let (name, install, appid) = (
                field(&state, "name"),
                field(&state, "installdir"),
                field(&state, "appid"),
            );
            if !valid_title(name)
                || !safe_text(install, 255)
                || appid != id
                || seen.contains(id)
                || install == "."
                || install == ".."
                || install.contains('/')
                || install.contains('\\')
                || install.contains(':')
            {
                continue;
            }
            if let Some(flags) = state.get("StateFlags").and_then(Value::as_str) {
                if flags.parse::<u32>().map_or(true, |f| f & 4 == 0) {
                    continue;
                }
            }
            let common = appdir.join("common");
            let directory = common.join(install);
            let is_contained = fs::canonicalize(&common)
                .ok()
                .zip(fs::canonicalize(&directory).ok())
                .is_some_and(|(base, actual)| actual.starts_with(&base) && actual != base);
            if !directory.is_dir() || !is_contained {
                continue;
            }
            seen.insert(id.to_string());
            games.push(json!({"name":name,"source":"steam","source_id":id,
                "install_path":directory,"launch_uri":format!("steam://rungameid/{id}"),
                "genre":"","tags":[]}));
        }
    }
    (games, warnings)
}

fn epic_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        add_root(
            &mut roots,
            program_data.join("Epic/EpicGamesLauncher/Data/Manifests"),
        );
    }
    roots
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn discover_epic() -> (Vec<Value>, Vec<String>) {
    let mut games = HashMap::<String, Value>::new();
    let mut warnings = Vec::new();
    let mut budget = MAX_ENTRIES;
    for root in epic_roots() {
        if budget == 0 {
            break;
        }
        let Ok((entries, truncated)) = entries_at(&root, budget) else {
            continue;
        };
        budget -= entries.len();
        if truncated {
            warnings.push("Epic scan reached its metadata entry limit.".into());
        }
        for item in entries {
            if extension(&item.path()) != "item" || !item.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let metadata: Value = match small_text(&item.path())
                .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            {
                Ok(data) => data,
                Err(error) => {
                    warnings.push(format!("Epic {}: {error}", filename(&item.path())));
                    continue;
                }
            };
            let (id, name, install) = (
                field(&metadata, "AppName"),
                field(&metadata, "DisplayName"),
                field(&metadata, "InstallLocation"),
            );
            if !valid_app_id(id) || !valid_title(name) {
                continue;
            }
            let Some(directory) = safe_installed_dir(install) else {
                continue;
            };
            if ["bIsIncompleteInstall", "bNeedsValidation", "bIsDlc"]
                .iter()
                .any(|key| metadata.get(key).and_then(Value::as_bool) == Some(true))
            {
                continue;
            }
            let parent = field(&metadata, "MainGameAppName");
            if !parent.is_empty() && parent != id {
                continue;
            }
            let executable = contained_file(&directory, field(&metadata, "LaunchExecutable"));
            let (namespace, item_id) = (
                field(&metadata, "CatalogNamespace"),
                field(&metadata, "CatalogItemId"),
            );
            let launch_id = if valid_app_id(namespace) && valid_app_id(item_id) {
                format!("{namespace}:{item_id}:{id}")
            } else {
                id.to_string()
            };
            let uri = format!(
                "com.epicgames.launcher://apps/{}?action=launch&silent=true",
                percent_encode(&launch_id)
            );
            let game = json!({"name":name,"source":"epic","source_id":id,"install_path":directory,
                "executable":executable,"launch_uri":uri,"tags":[]});
            match games.get_mut(id) {
                Some(existing) => {
                    if existing.get("executable").map_or(true, Value::is_null)
                        && executable.is_some()
                    {
                        *existing = game;
                    }
                }
                None => {
                    games.insert(id.to_string(), game);
                }
            }
        }
    }
    (games.into_values().collect(), warnings)
}

fn gog_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        for var in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(prefix) = std::env::var_os(var) {
                add_root(&mut roots, PathBuf::from(prefix).join("GOG Galaxy/Games"));
            }
        }
        add_root(&mut roots, PathBuf::from(r"C:\GOG Games"));
    }
    roots
}

fn gog_from_dir(dir: &Path, items: &[DirEntry], warnings: &mut Vec<String>) -> Vec<Value> {
    let manifests = items
        .iter()
        .filter(|item| {
            let name = filename(&item.path()).to_ascii_lowercase();
            name.starts_with("goggame-")
                && name.ends_with(".info")
                && item
                    .file_type()
                    .is_ok_and(|t| t.is_file() && !t.is_symlink())
        })
        .collect::<Vec<_>>();
    if manifests.len() > 256 {
        warnings.push(format!(
            "GOG manifest limit reached in {} (256 files).",
            dir.display()
        ));
    }
    let mut games = Vec::new();
    let mut ids = HashSet::new();
    for manifest in manifests.into_iter().take(256) {
        if let Some(game) = gog_from_manifest(dir, manifest, warnings) {
            if ids.insert(field(&game, "source_id").to_ascii_lowercase()) {
                games.push(game);
            }
        }
    }
    games
}

fn gog_from_manifest(dir: &Path, manifest: &DirEntry, warnings: &mut Vec<String>) -> Option<Value> {
    // The filename is the product identity. Never let stale or forged
    // metadata reassign goggame-900.info to a distinct product ID 901.
    // The prefix/extension are case-insensitive; the digit sequence is exact,
    // including any leading zeroes.
    let file_name = filename(&manifest.path()).to_ascii_lowercase();
    let filename_id = file_name.strip_prefix("goggame-")?.strip_suffix(".info")?;
    if filename_id.is_empty()
        || filename_id.len() > 20
        || !filename_id.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let doc: Value = match small_text(&manifest.path())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(doc) => doc,
        Err(error) => {
            warnings.push(format!("GOG {}: {error}", filename(&manifest.path())));
            return None;
        }
    };
    let id = doc
        .get("gameId")
        .map(|id| {
            id.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| id.to_string())
        })
        .unwrap_or_else(|| filename_id.to_string());
    if id != filename_id {
        return None;
    }
    let name = field(&doc, "name");
    let title = if valid_title(name) {
        name.to_string()
    } else {
        clean_name(&filename(dir))
    };
    let tasks = doc.get("playTasks")?.as_array()?;
    let mut possible = tasks
        .iter()
        .take(80)
        .filter(|task| {
            let task_type = field(task, "type");
            task_type.is_empty() || task_type == "FileTask"
        })
        .collect::<Vec<_>>();
    possible.sort_by_key(|item| {
        !item
            .get("isPrimary")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    for task in possible {
        let Some(exe) = contained_file(dir, field(task, "path")) else {
            continue;
        };
        if extension(&exe) != "exe" || score_executable(&exe, &title, dir, 0) < 0 {
            continue;
        }
        return Some(json!({"name":title,"source":"gog","source_id":id,
            "install_path":dir,"executable":exe,"tags":[]}));
    }
    None
}

fn discover_gog() -> (Vec<Value>, Vec<String>) {
    let mut games = Vec::new();
    let mut warnings = Vec::new();
    let mut ids = HashSet::new();
    let mut budget = MAX_ENTRIES;
    for root in gog_roots() {
        if budget == 0 {
            break;
        }
        let Ok((entries, truncated)) = entries_at(&root, budget) else {
            continue;
        };
        budget -= entries.len();
        if truncated {
            warnings.push("GOG scan reached its metadata entry limit.".into());
        }
        let root_games = gog_from_dir(&root, &entries, &mut warnings);
        if !root_games.is_empty() {
            for game in root_games {
                let id = field(&game, "source_id").to_ascii_lowercase();
                if ids.insert(id) {
                    games.push(game);
                }
            }
            continue;
        }
        for item in entries {
            if budget == 0 {
                break;
            }
            if !item.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let location = item.path();
            let Ok((items, truncated)) = entries_at(&location, budget) else {
                continue;
            };
            budget -= items.len();
            if truncated {
                warnings.push(format!(
                    "GOG metadata scan reached its entry limit in {}",
                    location.display()
                ));
            }
            for game in gog_from_dir(&location, &items, &mut warnings) {
                let id = field(&game, "source_id").to_ascii_lowercase();
                if ids.insert(id) {
                    games.push(game);
                }
            }
        }
    }
    (games, warnings)
}

// Battle.net's Agent product.db is a protobuf wire stream, not JSON/SQLite.
// Read only the three documented fields needed for installed products; reject
// malformed lengths, unlimited nesting and unknown wire types. Never run the
// Agent or guess a launcher URI from a product code.
fn protobuf_varint(bytes: &[u8], offset: &mut usize) -> Result<u64, String> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.get(*offset).ok_or("Truncated protobuf varint")?;
        *offset += 1;
        if shift == 63 && byte > 1 {
            return Err("Protobuf varint overflow".into());
        }
        value |= ((byte & 0x7f) as u64)
            .checked_shl(shift)
            .ok_or("Protobuf varint overflow")?;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("Protobuf varint too long".into())
}

fn protobuf_fields<'a>(bytes: &'a [u8]) -> Result<Vec<(u32, &'a [u8])>, String> {
    let mut fields = Vec::new();
    let mut at = 0;
    let mut count = 0usize;
    while at < bytes.len() {
        count += 1;
        if count > MAX_STORE_RECORDS * 20 {
            return Err("Too many protobuf fields".into());
        }
        let key = protobuf_varint(bytes, &mut at)?;
        if key >> 3 == 0 || key >> 3 > u32::MAX as u64 {
            return Err("Invalid protobuf field number".into());
        }
        let field = (key >> 3) as u32;
        match key & 7 {
            0 => {
                let _ = protobuf_varint(bytes, &mut at)?;
            }
            1 | 5 => {
                at = at
                    .checked_add(if key & 7 == 1 { 8 } else { 4 })
                    .filter(|end| *end <= bytes.len())
                    .ok_or("Truncated protobuf fixed field")?;
            }
            2 => {
                let len = usize::try_from(protobuf_varint(bytes, &mut at)?)
                    .map_err(|_| "Protobuf length overflow")?;
                let end = at
                    .checked_add(len)
                    .filter(|end| *end <= bytes.len())
                    .ok_or("Truncated protobuf bytes")?;
                fields.push((field, &bytes[at..end]));
                at = end;
            }
            _ => return Err("Unsupported protobuf wire type".into()),
        }
    }
    Ok(fields)
}

fn battlenet_products(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    if bytes.len() > MANIFEST_BYTES as usize {
        return Err("Battle.net database exceeds metadata size limit".into());
    }
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for (field, product) in protobuf_fields(bytes)? {
        if field != 1 {
            continue;
        }
        if found.len() >= MAX_STORE_RECORDS {
            break;
        }
        let mut code = None;
        let mut path = None;
        for (key, data) in protobuf_fields(product)? {
            match key {
                2 => code = std::str::from_utf8(data).ok(),
                3 => {
                    for (setting, value) in protobuf_fields(data)? {
                        if setting == 1 {
                            path = std::str::from_utf8(value).ok();
                        }
                    }
                }
                _ => {}
            }
        }
        let (Some(code), Some(path)) = (code, path) else {
            continue;
        };
        if code.len() < 2
            || code.len() > 48
            || !code.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || ["agent", "bna"].contains(&code.to_ascii_lowercase().as_str())
            || !safe_text(path, 4_000)
        {
            continue;
        }
        if seen.insert(code.to_ascii_lowercase()) {
            found.push((code.to_string(), path.to_string()));
        }
    }
    Ok(found)
}

fn battlenet_executable(dir: &Path, code: &str, title: &str) -> Option<PathBuf> {
    // Product codes only select a small list of known conventional binaries;
    // each candidate MUST exist within the installed product directory.
    let known: &[&str] = match code.to_ascii_lowercase().as_str() {
        "wow" => &["_retail_/Wow.exe", "Wow.exe"],
        "wow_classic" => &["_classic_/WowClassic.exe"],
        "wow_classic_era" => &["_classic_era_/WowClassic.exe"],
        "d3" => &["Diablo III.exe", "Diablo III/Diablo III.exe"],
        "fenris" => &["Diablo IV.exe"],
        "osi" => &["_retail_/Overwatch.exe", "Overwatch.exe"],
        _ => &[],
    };
    for relative in known {
        if let Some(file) = contained_file(dir, relative) {
            if extension(&file) == "exe" && !ignored_executable(&file) {
                return Some(file);
            }
        }
    }
    // For unknown codes, accept an EXACT title-to-executable match only.
    // Other helper binaries, storefront launchers and heuristic guesses are
    // not safe to publish as a runnable launch target.
    let expected = normalized_name(title);
    if expected.len() < 4 {
        return None;
    }
    let mut queue = VecDeque::from([(dir.to_path_buf(), 0usize)]);
    let mut remaining = 256usize;
    let mut matches = Vec::new();
    while let Some((folder, depth)) = queue.pop_front() {
        if remaining == 0 {
            return None; // An incomplete scan cannot claim a unique owner.
        }
        let Ok((items, truncated)) = entries_at(&folder, remaining) else {
            return None;
        };
        remaining -= items.len();
        if truncated {
            return None;
        }
        for entry in items {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() && depth < 3 && !ignored_dir(&path) {
                queue.push_back((path, depth + 1));
            } else if kind.is_file() && extension(&path) == "exe" && !ignored_executable(&path) {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if normalized_name(stem) == expected {
                    let relative = path.strip_prefix(dir).ok()?.to_str()?;
                    if let Some(verified) = contained_file(dir, relative) {
                        matches.push(verified);
                        if matches.len() > 1 {
                            return None;
                        }
                    }
                }
            }
        }
    }
    matches.pop()
}

fn discover_battlenet_at(database: &Path) -> (Vec<Value>, Vec<String>) {
    let mut games = Vec::new();
    let mut warnings = Vec::new();
    if !database.is_file() {
        return (games, warnings);
    }
    let bytes = (|| -> Result<Vec<u8>, String> {
        let metadata = fs::metadata(database).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > MANIFEST_BYTES {
            return Err("Battle.net product.db exceeds metadata size limit".into());
        }
        // Bound actual bytes read even if the Agent replaces its file after
        // the metadata check. Never follow a product entry to read content.
        let mut file = fs::File::open(database)
            .map_err(|e| e.to_string())?
            .take(MANIFEST_BYTES + 1);
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MANIFEST_BYTES {
            return Err("Battle.net product.db exceeds metadata size limit".into());
        }
        Ok(bytes)
    })();
    let products = bytes.and_then(|bytes| battlenet_products(&bytes));
    match products {
        Ok(products) => {
            for (code, install) in products {
                let Some(directory) = safe_installed_dir(&install) else {
                    continue;
                };
                // Cached Agent records can outlive uninstallations. An
                // existing folder alone is insufficient proof of a game.
                if !directory.join(".build.info").is_file() {
                    continue;
                }
                let title = clean_name(&filename(&directory));
                if !valid_title(&title)
                    || ["battle net", "agent", "cache", "battle.net"]
                        .contains(&title.to_ascii_lowercase().as_str())
                {
                    continue;
                }
                let Some(executable) = battlenet_executable(&directory, &code, &title) else {
                    warnings.push(format!(
                        "Battle.net {} requires manual executable selection; no unique verified game binary found.",
                        code
                    ));
                    continue;
                };
                // Launch URI formats vary by product. A verified executable
                // may still require the Battle.net client for authentication.
                games.push(json!({"name":title,"source":"battlenet","source_id":code,
                    "install_path":directory,"executable":executable,"tags":[]}));
            }
            if !games.is_empty() {
                warnings.push("Battle.net executables were verified on disk, but online titles can still require Battle.net authentication or launcher activation.".into());
            }
        }
        Err(error) => warnings.push(format!("Battle.net Agent product database: {error}")),
    }
    (games, warnings)
}

fn discover_battlenet() -> (Vec<Value>, Vec<String>) {
    #[cfg(windows)]
    {
        let root = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        return discover_battlenet_at(&root.join("Battle.net/Agent/product.db"));
    }
    #[cfg(not(windows))]
    (Vec::new(), Vec::new())
}

// Strict, bounded XML structure+attribute reader for MicrosoftGame.config.
// No DTD, CDATA, external entities, XInclude or remote resource processing.
// Unlike a start-tag regex, it rejects unmatched/misnested closing tags,
// duplicate XML attributes and a second root. Every requested field is only
// returned after the ENTIRE manifest has passed structure validation.
fn xbox_xml_tags(source: &str, wanted: &str) -> Option<Vec<HashMap<String, String>>> {
    if source.len() > 128 * 1024 {
        return None;
    }
    let mut tags = Vec::new();
    let mut remaining = source.trim_start_matches('\u{feff}');
    let mut visits = 0;
    let mut stack: Vec<&str> = Vec::new();
    let mut roots = 0;
    loop {
        let Some(start) = remaining.find('<') else {
            if !stack.is_empty()
                || !xml_text_valid(remaining)
                || (roots > 0 && !remaining.trim().is_empty())
            {
                return None;
            }
            break;
        };
        if !xml_text_valid(&remaining[..start])
            || (stack.is_empty() && !remaining[..start].trim().is_empty())
        {
            return None;
        }
        visits += 1;
        if visits > MAX_STORE_RECORDS {
            return None;
        }
        remaining = &remaining[start + 1..];
        if remaining.starts_with("!--") {
            let end = remaining.find("-->")?;
            if remaining[3..end].contains("--") {
                return None;
            }
            remaining = &remaining[end + 3..];
            continue;
        }
        if remaining.starts_with('?') {
            let end = remaining.find("?>")?;
            if end > 8_192 {
                return None;
            }
            remaining = &remaining[end + 2..];
            continue;
        }
        if remaining.starts_with('!') {
            return None;
        }
        // A '>' inside an XML quoted attribute isn't a tag terminator.
        // A raw '<' inside a tag is never valid.
        let mut quote = None;
        let mut end = None;
        for (index, byte) in remaining.bytes().enumerate() {
            match (quote, byte) {
                (Some(current), value) if value == current => quote = None,
                (None, b'\'' | b'"') => quote = Some(byte),
                (None, b'<') => return None,
                (None, b'>') => {
                    end = Some(index);
                    break;
                }
                _ => {}
            }
            if index > 8_192 {
                return None;
            }
        }
        let end = end?;
        if end > 8_192 {
            return None;
        }
        let body = remaining[..end].trim();
        remaining = &remaining[end + 1..];
        if let Some(close) = body.strip_prefix('/') {
            let close = close.trim();
            if !xml_name_valid(close) || stack.pop() != Some(close) {
                return None;
            }
            continue;
        }
        let (body, self_closing) = match body.strip_suffix('/') {
            Some(tag) => (tag.trim_end(), true),
            None => (body, false),
        };
        let name_len = body.find(char::is_whitespace).unwrap_or(body.len());
        let name = &body[..name_len];
        if !xml_name_valid(name) {
            return None;
        }
        if stack.is_empty() {
            roots += 1;
            if roots != 1 || name != "Game" {
                return None;
            }
        }
        if !self_closing && stack.len() >= 32 {
            return None;
        }
        let mut attrs = HashMap::new();
        let mut rest = &body[name_len..];
        while !rest.trim_start().is_empty() {
            rest = rest.trim_start();
            let key_len = rest
                .find(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '_' | ':' | '-' | '.'))
                .unwrap_or(rest.len());
            if key_len == 0 || !xml_name_valid(&rest[..key_len]) || attrs.len() >= 64 {
                return None;
            }
            let key = &rest[..key_len];
            rest = rest[key_len..].trim_start();
            rest = rest.strip_prefix('=')?.trim_start();
            let quote = rest.chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            rest = &rest[1..];
            let stop = rest.find(quote)?;
            let value = &rest[..stop];
            if value.contains('<') {
                return None;
            }
            let decoded = xml_unescape_attribute(value)?;
            if attrs.insert(key.to_string(), decoded).is_some() {
                return None;
            }
            rest = &rest[stop + 1..];
            // XML attributes require whitespace separators; a sequence like
            // Name="x"Id="y" must not be accepted as a valid start tag.
            if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
                return None;
            }
        }
        // Well-formed XML alone does not establish trusted GDK semantics:
        // metadata elements must occupy their documented structural parent.
        // A nested/relocated Identity, ShellVisuals or Executable cannot
        // authorize a different product's executable.
        let valid_parent = match name {
            "Identity" | "ShellVisuals" | "ExecutableList" => stack.as_slice() == ["Game"],
            "Executable" => stack.as_slice() == ["Game", "ExecutableList"],
            _ => true,
        };
        if !valid_parent {
            return None;
        }
        if name == wanted {
            tags.push(attrs);
        }
        if !self_closing {
            stack.push(name);
        }
    }
    (roots == 1 && stack.is_empty()).then_some(tags)
}

fn xml_text_valid(text: &str) -> bool {
    if text.contains("]]>")
        || text
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return false;
    }
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        rest = &rest[start..];
        let Some(end) = rest.find(';').filter(|end| *end <= 13) else {
            return false;
        };
        if xml_unescape_attribute(&rest[..=end]).is_none() {
            return false;
        }
        rest = &rest[end + 1..];
    }
    true
}

fn xml_name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.bytes().enumerate().all(|(i, byte)| {
            byte.is_ascii_alphabetic()
                || byte == b'_'
                || byte == b':'
                || (i > 0 && (byte.is_ascii_digit() || byte == b'-' || byte == b'.'))
        })
}

fn xml_unescape_attribute(raw: &str) -> Option<String> {
    let mut result = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(index) = rest.find('&') {
        result.push_str(&rest[..index]);
        let escaped = &rest[index + 1..];
        let end = escaped.find(';').filter(|end| *end <= 12)?;
        let entity = &escaped[..end];
        let ch = match entity {
            "amp" => '&',
            "quot" => '"',
            "apos" => '\'',
            "lt" => '<',
            "gt" => '>',
            _ if entity.starts_with("#x") => {
                char::from_u32(u32::from_str_radix(&entity[2..], 16).ok()?)?
            }
            _ if entity.starts_with('#') => char::from_u32(entity[1..].parse::<u32>().ok()?)?,
            _ => return None,
        };
        if ch.is_control() {
            return None;
        }
        result.push(ch);
        rest = &escaped[end + 1..];
        if result.len() > 4_000 {
            return None;
        }
    }
    result.push_str(rest);
    if result.len() > 4_000 || result.chars().any(char::is_control) {
        return None;
    }
    Some(result)
}

fn xbox_from_manifest(root: &Path, file: &Path) -> Option<Value> {
    if fs::metadata(file).ok()?.len() > 128 * 1024 {
        return None;
    }
    let doc = small_text(file).ok()?;
    if xbox_xml_tags(&doc, "Game")?.len() != 1 || xbox_xml_tags(&doc, "ExecutableList")?.len() != 1
    {
        return None;
    }
    let identities = xbox_xml_tags(&doc, "Identity")?;
    if identities.len() != 1 {
        return None;
    }
    let identity = identities.into_iter().next()?;
    let id = identity.get("Name")?;
    let publisher = identity.get("Publisher")?;
    if !valid_app_id(id) || !safe_text(publisher, 256) {
        return None;
    }
    // Most Gaming Services installations keep the manifest/executable in
    // <title>/Content. Keep the title-level root for identity and dedup.
    let owner = if filename(root).eq_ignore_ascii_case("Content") {
        root.parent().unwrap_or(root)
    } else {
        root
    };
    let visuals = xbox_xml_tags(&doc, "ShellVisuals")?;
    if visuals.len() != 1 {
        return None;
    }
    let title = visuals
        .into_iter()
        .next()
        .and_then(|shell| shell.get("DefaultDisplayName").cloned())
        .filter(|name| valid_title(name) && !name.starts_with("ms-resource:"))
        .unwrap_or_else(|| clean_name(&filename(owner)));
    if !valid_title(&title) {
        return None;
    }
    let entries = xbox_xml_tags(&doc, "Executable")?;
    if entries.len() != 1 {
        return None;
    }
    let entry = entries.first()?;
    if entry
        .get("IsDevOnly")
        .is_some_and(|v| v.eq_ignore_ascii_case("true"))
        || entry
            .get("TargetDeviceFamily")
            .is_some_and(|v| !v.eq_ignore_ascii_case("PC"))
    {
        return None;
    }
    let executable = entry
        .get("Name")
        .and_then(|name| contained_file(root, name))
        .filter(|file| extension(file) == "exe" && !ignored_executable(file))?;
    Some(json!({"name":title,"source":"xbox","source_id":id,
        "install_path":owner,"executable":executable,"tags":[]}))
}

/// Resolve official Microsoft GDK logo assets from the installed package's
/// MicrosoftGame.config. These are *icons*, not portrait store covers.
/// Resolve paths only after verifying the same package identity + executable
/// that our Xbox discovery accepted, and never escape the package directory.
pub(crate) fn xbox_logo_paths(game: &Value) -> Vec<PathBuf> {
    if game["source"] != "xbox" {
        return vec![];
    }
    let Some(source_id) = game["source_id"].as_str() else {
        return vec![];
    };
    let Some(install_path) = game["install_path"].as_str() else {
        return vec![];
    };
    let owner = Path::new(install_path);
    if !owner.is_absolute() || owner.as_os_str().len() > 4_000 {
        return vec![];
    }
    let Some(owner_canonical) = fs::canonicalize(owner).ok() else {
        return vec![];
    };
    let mut images = Vec::new();
    for root in [owner.to_path_buf(), owner.join("Content")] {
        let manifest = root.join("MicrosoftGame.config");
        if !manifest.is_file()
            || !fs::canonicalize(&manifest).is_ok_and(|path| path.starts_with(&owner_canonical))
        {
            continue;
        }
        let Some(discovered) = xbox_from_manifest(&root, &manifest) else {
            continue;
        };
        if discovered["source_id"] != source_id
            || !discovered["install_path"]
                .as_str()
                .and_then(|path| fs::canonicalize(path).ok())
                .is_some_and(|path| path == owner_canonical)
        {
            continue;
        }
        // A manually reassigned executable must not inherit artwork from a
        // different game merely because the old Xbox identity was retained.
        if let Some(saved) = game["executable"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            let verified = discovered["executable"]
                .as_str()
                .and_then(|value| fs::canonicalize(value).ok());
            if fs::canonicalize(saved).ok() != verified {
                continue;
            }
        }
        let Ok(document) = small_text(&manifest) else {
            continue;
        };
        let Some(shell) = xbox_xml_tags(&document, "ShellVisuals")
            .and_then(|items| (items.len() == 1).then_some(items))
            .and_then(|mut items| items.pop())
        else {
            continue;
        };
        let executable = xbox_xml_tags(&document, "Executable")
            .and_then(|items| (items.len() == 1).then_some(items))
            .and_then(|mut items| items.pop())
            .unwrap_or_default();
        let visual_keys = [
            ("OverrideSquare480x480Logo", true),
            ("OverrideLogo", true),
            ("OverrideSquare44x44Logo", true),
            ("Square480x480Logo", false),
            ("Square150x150Logo", false),
            ("Square44x44Logo", false),
            ("StoreLogo", false),
        ];
        for (key, override_asset) in visual_keys {
            let relative = if override_asset {
                executable.get(key)
            } else {
                shell.get(key)
            };
            let Some(relative) = relative else { continue };
            if !relative.to_ascii_lowercase().ends_with(".png") {
                continue;
            }
            let Some(path) = contained_file(&root, relative) else {
                continue;
            };
            if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_file()) {
                continue;
            }
            // Returning the already-resolved regular file rather than a path
            // through a junction avoids re-traversing an untrusted path when
            // the artwork layer reads and hashes the PNG.
            let Some(canonical) = fs::canonicalize(path).ok() else {
                continue;
            };
            if !canonical.starts_with(&owner_canonical) {
                continue;
            }
            if !images.contains(&canonical) {
                images.push(canonical);
            }
        }
        // One verified config is sufficient; never mix identities or roots.
        break;
    }
    images
}

fn discover_xbox_roots(roots: &[PathBuf]) -> (Vec<Value>, Vec<String>) {
    let mut games = Vec::new();
    let mut warnings = Vec::new();
    let mut seen = HashSet::new();
    let mut budget = MAX_ENTRIES;
    let mut manifests_left = 512usize;
    for root in roots.iter().take(MAX_ROOTS) {
        if !root.is_dir() || budget == 0 || manifests_left == 0 {
            continue;
        }
        let mut candidates = vec![root.to_path_buf()];
        if let Ok((items, truncated)) = entries_at(root, budget) {
            budget -= items.len();
            if truncated {
                warnings.push("Xbox metadata scan reached its entry limit.".into());
            }
            for item in items {
                if item
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                {
                    candidates.push(item.path());
                }
            }
        }
        for game_root in candidates {
            for dir in [game_root.clone(), game_root.join("Content")] {
                if manifests_left == 0 {
                    break;
                }
                let manifest = dir.join("MicrosoftGame.config");
                let safe = fs::canonicalize(&game_root)
                    .ok()
                    .zip(fs::canonicalize(&manifest).ok())
                    .is_some_and(|(parent, file)| file.starts_with(&parent))
                    && fs::symlink_metadata(&manifest).is_ok_and(|meta| meta.is_file());
                if !safe {
                    continue;
                }
                manifests_left -= 1;
                if let Some(game) = xbox_from_manifest(&dir, &manifest) {
                    let id = field(&game, "source_id").to_ascii_lowercase();
                    if seen.insert(id) {
                        games.push(game);
                    }
                } else {
                    warnings.push(format!("Xbox GDK manifest is inaccessible, incomplete, or lacks a verified PC executable: {}", manifest.display()));
                }
            }
        }
    }
    if manifests_left == 0 {
        warnings.push("Xbox manifest scan reached its metadata processing limit.".into());
    }
    if !games.is_empty() {
        warnings.push("Xbox GDK metadata verifies an installed PC executable, but packaged games may require Gaming Services identity activation; direct executable launch is not guaranteed.".into());
    }
    (games, warnings)
}

fn discover_xbox(settings: &Value) -> (Vec<Value>, Vec<String>) {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        let drive = std::env::var("SystemDrive")
            .ok()
            .filter(|drive| {
                drive.len() == 2
                    && drive.ends_with(':')
                    && drive.as_bytes()[0].is_ascii_alphabetic()
            })
            .unwrap_or_else(|| "C:".to_string());
        add_root(&mut roots, PathBuf::from(format!(r"{}\XboxGames", drive)));
    }
    if let Some(folders) = settings.get("libraryFolders").and_then(Value::as_array) {
        for folder in folders.iter().take(60).filter_map(Value::as_str) {
            if !safe_text(folder, 4_000) {
                continue;
            }
            let root = PathBuf::from(folder);
            add_root(&mut roots, root.clone());
            add_root(&mut roots, root.join("XboxGames"));
        }
    }
    discover_xbox_roots(&roots)
}

/// Storefront IDs are the identity of separately launchable products, even
/// when two editions or an expansion share a single executable. File-path
/// suppression applies only to untrusted folder/manual discoveries. This
/// matches Electron discovery's authoritative-store-first policy.
fn append_discovered_game(
    game: Value,
    all: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    seen_files: &mut HashSet<String>,
    store_dirs: &mut HashSet<String>,
) -> bool {
    let source = field(&game, "source");
    let source_id = field(&game, "source_id");
    let file = field(&game, "executable").to_ascii_lowercase();
    let folder = field(&game, "install_path").to_ascii_lowercase();
    let uri = field(&game, "launch_uri");
    let key = if !source_id.is_empty() {
        format!("{source}:{source_id}").to_ascii_lowercase()
    } else if !file.is_empty() {
        format!("file:{file}")
    } else {
        format!("uri:{uri}")
    };
    let untrusted = matches!(source, "folder" | "manual");
    if seen.contains(&key)
        || (untrusted && !file.is_empty() && seen_files.contains(&file))
        || (source == "folder" && store_dirs.contains(&folder))
    {
        return false;
    }
    seen.insert(key);
    if !file.is_empty() {
        seen_files.insert(file);
    }
    if !untrusted && !folder.is_empty() {
        store_dirs.insert(folder);
    }
    all.push(game);
    true
}

/// Store metadata and only explicitly configured library folders are scanned.
pub fn discover_games(settings: &Value) -> Result<Value, String> {
    let mut all = Vec::new();
    let mut warnings = Vec::new();
    let mut diagnostics = Vec::new();
    let mut seen = HashSet::new();
    let mut seen_files = HashSet::new();
    let mut store_dirs = HashSet::new();
    let mut append = |provider: &str,
                      path: Option<&Path>,
                      games: Vec<Value>,
                      notes: Vec<String>,
                      ms: u128| {
        let count = games.len();
        let num_warnings = notes.len();
        warnings.extend(notes);
        for game in games {
            append_discovered_game(game, &mut all, &mut seen, &mut seen_files, &mut store_dirs);
        }
        let mut diag = json!({"provider":provider,"status":if num_warnings>0 {"warning"}else{"ok"},
            "games":count,"warnings":num_warnings,"durationMs":ms.min(u64::MAX as u128) as u64});
        if let Some(path) = path {
            diag["path"] = json!(path);
        }
        diagnostics.push(diag);
    };
    for (provider, discover) in [
        ("steam", discover_steam as fn() -> (Vec<Value>, Vec<String>)),
        ("epic", discover_epic),
        ("gog", discover_gog),
        ("battlenet", discover_battlenet),
    ] {
        let tick = Instant::now();
        let (games, notes) = discover();
        append(provider, None, games, notes, tick.elapsed().as_millis());
    }
    let tick = Instant::now();
    let (games, notes) = discover_xbox(settings);
    append("xbox", None, games, notes, tick.elapsed().as_millis());
    let mut roots = Vec::new();
    if let Some(folders) = settings.get("libraryFolders").and_then(Value::as_array) {
        if folders.len() > 60 {
            return Err("Too many library folders (maximum 60).".into());
        }
        for path in folders {
            if let Some(path) = path.as_str() {
                if safe_text(path, 4_000) {
                    add_root(&mut roots, PathBuf::from(path));
                }
            }
        }
    }
    for root in roots {
        let tick = Instant::now();
        let (games, notes) = scan_folder(&root, MAX_ENTRIES, 5);
        append(
            "folder",
            Some(&root),
            games,
            notes,
            tick.elapsed().as_millis(),
        );
    }
    Ok(json!({"games":all,"warnings":warnings,"diagnostics":diagnostics}))
}

fn validate_uri(raw: &str) -> Result<(), String> {
    if !safe_text(raw, 2_048) || raw.chars().any(char::is_whitespace) {
        return Err("Invalid launch URI. Use a supported game-launcher link.".into());
    }
    let parsed = url::Url::parse(raw)
        .map_err(|_| "Invalid launch URI. Use a supported game-launcher link.".to_string())?;
    if ![
        "steam",
        "com.epicgames.launcher",
        "goggalaxy",
        "heroic",
        "uplay",
        "ubisoftconnect",
        "origin",
        "ea",
        "battlenet",
    ]
    .contains(&parsed.scheme())
    {
        return Err("Unsupported launch URI scheme.".into());
    }
    Ok(())
}

struct DirectSession {
    child: Child,
    clock: SessionClock,
}

struct SessionClock {
    started: u64,
    paused_at: Option<u64>,
    paused_total: u64,
}

// Windows QueryUnbiasedInterruptTime excludes time spent suspended, unlike
// elapsed wall time. Ticks are in 100 ns units. On other systems use monotonic
// time; suspend_sessions/resume_sessions can exclude sleep when invoked.
#[cfg(windows)]
fn awake_ticks() -> u64 {
    #[link(name = "kernel32")]
    extern "system" {
        fn QueryUnbiasedInterruptTime(ticks: *mut u64) -> i32;
    }
    let mut ticks = 0_u64;
    if unsafe { QueryUnbiasedInterruptTime(&mut ticks) } != 0 {
        ticks
    } else {
        0
    }
}

#[cfg(not(windows))]
fn awake_ticks() -> u64 {
    static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
    CLOCK_ORIGIN
        .get_or_init(Instant::now)
        .elapsed()
        .as_nanos()
        .checked_div(100)
        .unwrap_or(0)
        .min(u64::MAX as u128) as u64
}

impl SessionClock {
    fn new() -> Self {
        Self {
            started: awake_ticks(),
            paused_at: None,
            paused_total: 0,
        }
    }
    fn seconds(&self) -> u64 {
        let until = self.paused_at.unwrap_or_else(awake_ticks);
        (until
            .saturating_sub(self.started)
            .saturating_sub(self.paused_total)
            / 10_000_000)
            .min(7 * 24 * 3_600)
    }
    fn pause(&mut self) {
        if self.paused_at.is_none() {
            self.paused_at = Some(awake_ticks());
        }
    }
    fn resume(&mut self) {
        if let Some(at) = self.paused_at.take() {
            self.paused_total = self
                .paused_total
                .saturating_add(awake_ticks().saturating_sub(at));
        }
    }
}

static DIRECT: OnceLock<Mutex<HashMap<String, DirectSession>>> = OnceLock::new();
fn direct() -> &'static Mutex<HashMap<String, DirectSession>> {
    DIRECT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Launches a validated URI in the system's registered protocol handler or
/// starts an executable directly without a shell. The caller persists sessions.
pub fn launch_game(game: &Value) -> Result<Value, String> {
    let id = field(game, "id");
    if id.is_empty() || id.len() > 256 {
        return Err("Invalid game identifier.".into());
    }
    let uri = field(game, "launch_uri");
    if !uri.is_empty() {
        validate_uri(uri)?;
        open_external(uri)?;
        return Ok(
            json!({"mode":"external","tracked":false,"message":"Opened in the linked game launcher."}),
        );
    }
    let executable = field(game, "executable");
    if executable.is_empty() {
        return Err("Select a game executable in Edit Game before launching.".into());
    }
    let exe = require_absolute_file(executable)?;
    let fallback = exe
        .parent()
        .ok_or("Executable parent directory is unavailable.")?;
    let working = if field(game, "working_dir").is_empty() {
        fallback.to_path_buf()
    } else {
        PathBuf::from(field(game, "working_dir"))
    };
    if !working.is_absolute() || !working.is_dir() {
        return Err("Working directory is missing or invalid.".into());
    }
    let args = game
        .get("launch_args")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let args = args.as_array().ok_or("Launch arguments are invalid.")?;
    if args.len() > 80
        || args.iter().any(|v| {
            v.as_str()
                .map_or(true, |s| s.len() > 1024 || s.contains('\0'))
        })
    {
        return Err("Launch arguments are invalid.".into());
    }
    let mut active = direct()
        .lock()
        .map_err(|_| "Process tracker unavailable.")?;
    if active.contains_key(id) {
        return Err("This game already has a tracked session running.".into());
    }
    if active.len() >= MAX_SESSIONS {
        return Err("Too many tracked game sessions.".into());
    }
    let child = Command::new(&exe)
        .args(args.iter().filter_map(Value::as_str))
        .current_dir(working)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not launch {}: {error}", field(game, "name")))?;
    let pid = child.id();
    active.insert(
        id.to_owned(),
        DirectSession {
            child,
            clock: SessionClock::new(),
        },
    );
    Ok(json!({"mode":"process","pid":pid,"tracked":true,"message":"Game launched."}))
}

pub fn poll_sessions() -> Result<Value, String> {
    let mut active = direct()
        .lock()
        .map_err(|_| "Process tracker unavailable.")?;
    let mut completed = Vec::new();
    let mut running = Vec::new();
    let mut checkpoints = Vec::new();
    for (id, session) in active.iter_mut() {
        match session.child.try_wait() {
            Ok(None) => {
                running.push(id.clone());
                checkpoints.push(json!({"game_id":id,"seconds":session.clock.seconds()}));
            }
            Ok(Some(status)) => completed.push(
                json!({"game_id":id,"seconds":session.clock.seconds(),"exitCode":status.code()}),
            ),
            Err(error) => return Err(format!("Unable to check game process: {error}")),
        }
    }
    for result in &completed {
        active.remove(field(result, "game_id"));
    }
    Ok(json!({"completed":completed,"runningIds":running,"checkpoints":checkpoints}))
}

pub fn suspend_sessions() -> Result<Value, String> {
    for session in direct()
        .lock()
        .map_err(|_| "Process tracker unavailable.")?
        .values_mut()
    {
        session.clock.pause();
    }
    if let Ok(mut state) = activity().lock() {
        for session in state.values_mut() {
            session.clock.pause();
        }
    }
    Ok(json!(true))
}

pub fn resume_sessions() -> Result<Value, String> {
    for session in direct()
        .lock()
        .map_err(|_| "Process tracker unavailable.")?
        .values_mut()
    {
        session.clock.resume();
    }
    if let Ok(mut state) = activity().lock() {
        for session in state.values_mut() {
            session.clock.resume();
        }
    }
    Ok(json!(true))
}

/// Called on app shutdown. The processes remain alive; the returned durations
/// must be committed to SQLite before the backend closes its connection.
pub fn stop_sessions() -> Result<Value, String> {
    let mut finished = Vec::new();
    let mut direct = direct()
        .lock()
        .map_err(|_| "Process tracker unavailable.")?;
    for (id, session) in direct.drain() {
        finished.push(json!({"game_id":id,"seconds":session.clock.seconds()}));
    }
    let mut activity = activity()
        .lock()
        .map_err(|_| "Activity tracker unavailable.")?;
    for (id, session) in activity.drain() {
        finished.push(json!({"game_id":id,"seconds":session.clock.seconds()}));
    }
    Ok(json!({"completed":finished}))
}

pub fn inspect_game_file(executable: &str) -> Result<Value, String> {
    let file = require_absolute_file(executable)?;
    let parent = file.parent().ok_or("Game directory unavailable.")?;
    let product = read_windows_product_name(&file);
    let (name, fallback, kind) = game_file_title(&file, product.as_deref());
    let local_artwork = find_nearby_artwork(&file, &name);
    Ok(
        json!({"executable":file,"name":name,"suggested_name":fallback,
        "recognized":matches!(kind, "executable" | "metadata" | "folder"),
        "name_source":kind,"working_dir":parent,
        "cover":"","icon":"","cover_source":"","local_artwork":local_artwork}),
    )
}

fn find_nearby_artwork(executable: &Path, game_name: &str) -> Option<PathBuf> {
    let root = executable.parent()?;
    let norm = |s: &str| {
        s.chars()
            .filter(char::is_ascii_alphanumeric)
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let key = norm(game_name);
    let mut candidates = Vec::new();
    for (dir, penalty) in [("", 0), ("artwork", 2), ("art", 3), ("images", 4)] {
        let location = root.join(dir);
        let Ok((items, excess)) = entries_at(&location, 5_001) else {
            continue;
        };
        if excess || items.len() > 5_000 {
            continue;
        }
        for item in items {
            let path = item.path();
            if !item.file_type().is_ok_and(|t| t.is_file())
                || !["png", "jpg", "jpeg", "webp"].contains(&extension(&path).as_str())
            {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let normalized = norm(stem);
            let mut score = match normalized.as_str() {
                "cover" => 100,
                "poster" => 99,
                "boxart" => 98,
                "keyart" => 97,
                "library600x900" => 95,
                "verticalcover" => 94,
                "folder" => 90,
                "artwork" => 85,
                "capsule" => 75,
                _ => 0,
            };
            if normalized == key
                || normalized == format!("{key}cover")
                || normalized == format!("{key}poster")
            {
                score = score.max(82);
            }
            if score > penalty {
                candidates.push((path, score - penalty));
            }
        }
    }
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    candidates.into_iter().take(16).find_map(|(path, _)| {
        let size = fs::metadata(&path).ok()?.len();
        if size == 0 || size > 15 * 1024 * 1024 {
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        if is_portrait_image(&bytes) {
            Some(path)
        } else {
            None
        }
    })
}

fn is_portrait_image(bytes: &[u8]) -> bool {
    let Some((width, height)) = image_dimensions(bytes) else {
        return false;
    };
    width >= 80
        && height >= 120
        && width <= 4096
        && height <= 4096
        && (width as f64) / (height as f64) >= 0.5
        && (width as f64) / (height as f64) <= 0.85
}

fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) && bytes.len() >= 24 {
        return Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
        ));
    }
    if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let kind = &bytes[12..16];
        if kind == b"VP8X" {
            let width = 1
                + u32::from(bytes[24])
                + (u32::from(bytes[25]) << 8)
                + (u32::from(bytes[26]) << 16);
            let height = 1
                + u32::from(bytes[27])
                + (u32::from(bytes[28]) << 8)
                + (u32::from(bytes[29]) << 16);
            return Some((width, height));
        }
        if kind == b"VP8 " && bytes[23..26] == [0x9d, 0x01, 0x2a] {
            let width = u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff;
            let height = u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff;
            return Some((width as u32, height as u32));
        }
        if kind == b"VP8L" && bytes.len() >= 25 && bytes[20] == 0x2f {
            let width = 1 + (((bytes[22] as u32 & 0x3f) << 8) | bytes[21] as u32);
            let height = 1
                + (((bytes[24] as u32 & 0x0f) << 10)
                    | ((bytes[23] as u32) << 2)
                    | ((bytes[22] as u32 & 0xc0) >> 6));
            return Some((width, height));
        }
    }
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut at = 2_usize;
    while at + 3 < bytes.len() {
        if bytes[at] != 0xff {
            return None;
        }
        at += 1;
        while at < bytes.len() && bytes[at] == 0xff {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if at + 2 > bytes.len() {
            return None;
        }
        let size = u16::from_be_bytes([bytes[at], bytes[at + 1]]) as usize;
        if size < 2 || at + size > bytes.len() {
            return None;
        }
        if matches!(marker,0xc0..=0xc3|0xc5..=0xc7|0xc9..=0xcb|0xcd..=0xcf) {
            if size < 7 {
                return None;
            }
            let height = u16::from_be_bytes([bytes[at + 3], bytes[at + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]) as u32;
            return Some((width, height));
        }
        at += size;
    }
    None
}

pub fn open_game_folder(game: &Value) -> Result<Value, String> {
    let install = field(game, "install_path");
    let executable = field(game, "executable");
    let path = if !install.is_empty() {
        PathBuf::from(install)
    } else if !executable.is_empty() {
        PathBuf::from(executable)
            .parent()
            .ok_or("Installation folder is unavailable.")?
            .to_path_buf()
    } else {
        return Err("Installation folder is unavailable.".into());
    };
    open_path(&path.to_string_lossy())
}

pub fn open_path(path: &str) -> Result<Value, String> {
    if !safe_text(path, 4_000) {
        return Err("Installation folder is unavailable.".into());
    }
    let path = Path::new(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err("Installation folder is unavailable.".into());
    }
    open_directory(path)?;
    Ok(json!(true))
}

#[cfg(windows)]
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn shell_open(target: &std::ffi::OsStr) -> Result<(), String> {
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            operation: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }
    let command = wide(std::ffi::OsStr::new("open"));
    let file = wide(target);
    let status = unsafe {
        ShellExecuteW(
            0,
            command.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if status <= 32 {
        Err(format!(
            "Windows could not open the selected target (ShellExecute code {status})."
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn open_external(uri: &str) -> Result<(), String> {
    shell_open(std::ffi::OsStr::new(uri))
}
#[cfg(not(windows))]
fn open_external(_uri: &str) -> Result<(), String> {
    Err("Opening linked launcher protocols is unsupported on this platform.".into())
}
#[cfg(windows)]
fn open_directory(path: &Path) -> Result<(), String> {
    shell_open(path.as_os_str())
}
#[cfg(not(windows))]
fn open_directory(_path: &Path) -> Result<(), String> {
    Err("Opening folders is unsupported on this platform.".into())
}

#[cfg(windows)]
fn list_running_executables() -> Result<Vec<PathBuf>, String> {
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module_id: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        name: [u16; 260],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(handle: isize, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(handle: isize, entry: *mut ProcessEntry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn QueryFullProcessImageNameW(
            handle: isize,
            flags: u32,
            path: *mut u16,
            length: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const SNAP_PROCESS: u32 = 0x00000002;
    const QUERY_LIMITED: u32 = 0x1000;
    let snapshot = unsafe { CreateToolhelp32Snapshot(SNAP_PROCESS, 0) };
    if snapshot == -1 {
        return Err(format!(
            "Cannot enumerate Windows processes: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut result = Vec::new();
    let mut item = ProcessEntry {
        size: std::mem::size_of::<ProcessEntry>() as u32,
        usage: 0,
        pid: 0,
        heap: 0,
        module_id: 0,
        threads: 0,
        parent: 0,
        priority: 0,
        flags: 0,
        name: [0; 260],
    };
    let mut more = unsafe { Process32FirstW(snapshot, &mut item) };
    if more == 0 {
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(snapshot) };
        return Err(format!("Cannot read Windows process inventory: {error}"));
    }
    while more != 0 && result.len() < 10_000 {
        let handle = unsafe { OpenProcess(QUERY_LIMITED, 0, item.pid) };
        if handle != 0 {
            let mut path = [0u16; 32_768];
            let mut length = path.len() as u32;
            if unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut length) } != 0
            {
                if let Ok(name) = String::from_utf16(&path[..length as usize]) {
                    if name.to_ascii_lowercase().ends_with(".exe") {
                        result.push(PathBuf::from(name));
                    }
                }
            }
            unsafe { CloseHandle(handle) };
        }
        more = unsafe { Process32NextW(snapshot, &mut item) };
    }
    unsafe { CloseHandle(snapshot) };
    Ok(result)
}

#[cfg(not(windows))]
fn list_running_executables() -> Result<Vec<PathBuf>, String> {
    Err("Windows process inventory is unsupported on this platform.".into())
}

fn normalize_windows_path(value: &str) -> String {
    value
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
        .trim_start_matches(r"\\?\")
        .to_string()
}

fn activity_title_key(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn store_and_manual_alias(store: &Value, alias: &Value) -> bool {
    if !["steam", "epic"].contains(&field(store, "source"))
        || !["manual", "folder"].contains(&field(alias, "source"))
        || !Path::new(field(store, "install_path")).is_absolute()
    {
        return false;
    }
    let folder = normalize_windows_path(field(store, "install_path"));
    let executable = normalize_windows_path(field(alias, "executable"));
    let title = activity_title_key(field(store, "name"));
    !folder.is_empty()
        && !executable.is_empty()
        && !title.is_empty()
        && title == activity_title_key(field(alias, "name"))
        && executable.starts_with(&format!("{folder}\\"))
}

pub fn installation_alias_ids(games: &Value, requested_id: &str) -> HashSet<String> {
    let Some(entries) = games.as_array() else {
        return HashSet::new();
    };
    let Some(requested) = entries
        .iter()
        .find(|game| field(game, "id") == requested_id)
    else {
        return HashSet::new();
    };
    entries
        .iter()
        .filter(|game| {
            field(game, "id") != requested_id
                && (store_and_manual_alias(game, requested)
                    || store_and_manual_alias(requested, game))
        })
        .map(|game| field(game, "id").to_owned())
        .collect()
}

fn suppress_store_for_direct_alias(
    games: &Value,
    found: &mut HashSet<String>,
    direct: &HashSet<String>,
) {
    let Some(entries) = games.as_array() else {
        return;
    };
    for store in entries {
        let id = field(store, "id");
        if found.contains(id)
            && entries.iter().any(|alias| {
                direct.contains(field(alias, "id")) && store_and_manual_alias(store, alias)
            })
        {
            found.remove(id);
        }
    }
}

fn match_game_processes(games: &Value, inventory: &[PathBuf]) -> HashSet<String> {
    let mut exact: HashMap<String, HashSet<String>> = HashMap::new();
    let mut folders: HashMap<String, HashSet<String>> = HashMap::new();
    let Some(games) = games.as_array() else {
        return HashSet::new();
    };
    for game in games {
        let id = field(game, "id");
        if id.is_empty() {
            continue;
        }
        let executable = field(game, "executable");
        if !executable.is_empty()
            && Path::new(executable).is_absolute()
            && (!ignored_executable(Path::new(executable))
                || ["manual", "folder"].contains(&field(game, "source")))
        {
            exact
                .entry(normalize_windows_path(executable))
                .or_default()
                .insert(id.to_string());
        }
        let source = field(game, "source");
        let folder = field(game, "install_path");
        if !["steam", "epic"].contains(&source) || !Path::new(folder).is_absolute() {
            continue;
        }
        let path = Path::new(folder);
        let generic = [
            "games",
            "program files",
            "program files (x86)",
            "users",
            "downloads",
            "steamapps",
            "common",
            "epic games",
        ];
        if path.parent().is_none()
            || generic.contains(&filename(path).to_ascii_lowercase().as_str())
        {
            continue;
        }
        folders
            .entry(normalize_windows_path(folder))
            .or_default()
            .insert(id.to_string());
    }
    let mut found = HashSet::new();
    for file in inventory {
        if extension(file) != "exe" || !file.is_absolute() {
            continue;
        }
        let key = normalize_windows_path(&file.to_string_lossy());
        if let Some(ids) = exact.get(&key) {
            if ids.len() == 1 {
                found.extend(ids.iter().cloned());
            }
            continue;
        }
        if ignored_executable(file) {
            continue;
        }
        let mut parent = file.parent();
        while let Some(dir) = parent {
            if let Some(ids) = folders.get(&normalize_windows_path(&dir.to_string_lossy())) {
                if ids.len() == 1 {
                    found.extend(ids.iter().cloned());
                }
                break;
            }
            parent = dir.parent();
        }
    }
    // Only confidently identical titles coalesce. A separate game or DLC can
    // legitimately be installed beneath the same root, and must retain time.
    for store in games {
        let store_id = field(store, "id");
        if !found.contains(store_id) || !["steam", "epic"].contains(&field(store, "source")) {
            continue;
        }
        for alias in games {
            let alias_id = field(alias, "id");
            if found.contains(alias_id) && store_and_manual_alias(store, alias) {
                found.remove(alias_id);
            }
        }
    }
    found
}

struct ActivitySession {
    clock: SessionClock,
    misses: u8,
    first_miss: Option<u64>,
    registered: bool,
}

static ACTIVITY: OnceLock<Mutex<HashMap<String, ActivitySession>>> = OnceLock::new();
fn activity() -> &'static Mutex<HashMap<String, ActivitySession>> {
    ACTIVITY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn discard_activity_for_direct(
    sessions: &mut HashMap<String, ActivitySession>,
    direct_ids: &HashSet<String>,
) {
    // A direct child is authoritative over provisional detection. Never
    // discard an already-registered activity session; its SQLite record
    // still needs its own completion. The launch reservation prevents
    // registered activity and direct launch from overlapping.
    for id in direct_ids {
        if sessions.get(id).is_some_and(|session| !session.registered) {
            sessions.remove(id);
        }
    }
}

fn observe_activity_session(sessions: &mut HashMap<String, ActivitySession>, id: &str) -> bool {
    if let Some(active) = sessions.get_mut(id) {
        active.misses = 0;
        active.first_miss = None;
        // An unsuccessful DB start must be attempted again on the next
        // observation, not quietly marked tracked only in native memory.
        return !active.registered;
    }
    if sessions.len() >= MAX_SESSIONS {
        return false;
    }
    sessions.insert(
        id.to_string(),
        ActivitySession {
            clock: SessionClock::new(),
            misses: 0,
            first_miss: None,
            registered: false,
        },
    );
    true
}

pub fn running_games(games: &Value) -> Result<Value, String> {
    let inventory = list_running_executables()?;
    let mut running = match_game_processes(games, &inventory);
    let mut direct = direct()
        .lock()
        .map_err(|_| "Process tracker unavailable.")?;
    for (id, session) in direct.iter_mut() {
        if session
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            running.insert(id.clone());
        }
    }
    let direct_ids = direct.keys().cloned().collect::<HashSet<_>>();
    suppress_store_for_direct_alias(games, &mut running, &direct_ids);
    let mut sorted = running.into_iter().collect::<Vec<_>>();
    sorted.sort();
    Ok(json!(sorted))
}

/// Process observation for launcher URI games. Two missing inventories are
/// required before a session is finished, and query errors leave state intact.
/// `started` and `finished` belong to the DB integration layer.
pub fn poll_activity(games: &Value) -> Result<Value, String> {
    let inventory = list_running_executables()?;
    let mut found = match_game_processes(games, &inventory);
    let direct_ids = direct()
        .lock()
        .map_err(|_| "Process tracker unavailable.")?
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    suppress_store_for_direct_alias(games, &mut found, &direct_ids);
    let eligible = games
        .as_array()
        .ok_or("Expected a game list.")?
        .iter()
        .filter_map(|g| g.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let mut state = activity()
        .lock()
        .map_err(|_| "Activity tracker unavailable.")?;
    discard_activity_for_direct(&mut state, &direct_ids);
    let mut started = Vec::new();
    let mut finished = Vec::new();
    for id in found
        .iter()
        .filter(|id| !direct_ids.contains(*id) && eligible.contains(*id))
    {
        if observe_activity_session(&mut state, id) {
            started.push(id.clone());
        }
    }
    let mut remove = Vec::new();
    for (id, active) in state.iter_mut() {
        if found.contains(id) && eligible.contains(id) {
            continue;
        }
        if active.misses == 0 {
            active.first_miss = Some(active.clock.seconds());
        }
        active.misses += 1;
        if active.misses >= 2 || !eligible.contains(id) {
            finished.push(json!({"game_id":id,"seconds":active.first_miss.unwrap_or_else(||active.clock.seconds())}));
            remove.push(id.clone());
        }
    }
    for id in remove {
        state.remove(&id);
    }
    let mut running = state.keys().cloned().collect::<Vec<_>>();
    running.sort();
    let checkpoints = state
        .iter()
        .map(|(id, session)| json!({"game_id":id,"seconds":session.clock.seconds()}))
        .collect::<Vec<_>>();
    Ok(
        json!({"started":started,"finished":finished,"runningIds":running,"checkpoints":checkpoints}),
    )
}

/// The native tracker must only consider a session registered after its
/// corresponding SQLite row has been durably created.
pub fn acknowledge_activity_session(id: &str) {
    if let Ok(mut sessions) = activity().lock() {
        if let Some(session) = sessions.get_mut(id) {
            session.registered = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_store_ids_can_share_an_executable_without_losing_expansions() {
        let exe = r"C:\Games\Example\SharedLauncher.exe";
        let install = r"C:\Games\Example";
        let mut all = Vec::new();
        let mut seen = HashSet::new();
        let mut seen_files = HashSet::new();
        let mut store_dirs = HashSet::new();
        let mut append = |game| {
            append_discovered_game(game, &mut all, &mut seen, &mut seen_files, &mut store_dirs)
        };
        assert!(append(json!({
            "name":"Example","source":"epic","source_id":"base",
            "install_path":install,"executable":exe
        })));
        assert!(append(json!({
            "name":"Example Expansion","source":"epic","source_id":"expansion",
            "install_path":install,"executable":exe
        })));
        assert!(!append(json!({
            "name":"Example duplicate","source":"epic","source_id":"BASE",
            "install_path":install,"executable":exe
        })));
        assert!(!append(json!({
            "name":"Folder alias","source":"folder","install_path":install,
            "executable":exe
        })));
        assert!(!append(json!({
            "name":"Folder install alias","source":"folder","install_path":install,
            "executable":r"C:\Games\Example\Other.exe"
        })));
        assert!(append(json!({
            "name":"Independent Title","source":"epic","source_id":"other",
            "install_path":r"C:\Games\Other","executable":r"C:\Games\Other\Other.exe"
        })));
        assert_eq!(all.len(), 3);
        assert_eq!(all[0]["source_id"], "base");
        assert_eq!(all[1]["source_id"], "expansion");
        assert_eq!(all[2]["source_id"], "other");
        let verified = json!([
            {"id":"base","name":"Example","source":"epic","source_id":"base",
                "install_path":install,"executable":exe},
            {"id":"expansion","name":"Example Expansion","source":"epic",
                "source_id":"expansion","install_path":install,"executable":exe}
        ]);
        assert!(installation_alias_ids(&verified, "base").is_empty());
        assert!(installation_alias_ids(&verified, "expansion").is_empty());
        #[cfg(windows)]
        assert!(
            match_game_processes(&verified, &[PathBuf::from(exe)]).is_empty(),
            "same-executable store IDs are ambiguous for background detection"
        );
        let store_records = json!([
            {"id":"base","name":"Example","source":"epic","source_id":"base",
                "install_path":install,"executable":exe},
            {"id":"expansion","name":"Example Expansion","source":"epic",
                "source_id":"expansion","install_path":install,"executable":exe}
        ]);
        assert!(installation_alias_ids(&store_records, "base").is_empty());
        assert!(installation_alias_ids(&store_records, "expansion").is_empty());
        #[cfg(windows)]
        assert!(
            match_game_processes(&store_records, &[PathBuf::from(exe)]).is_empty(),
            "an ambiguous shared executable must not create two background sessions"
        );
    }

    #[test]
    fn gog_shared_folder_manifests_keep_two_real_store_ids() {
        let root = std::env::temp_dir().join(format!("orbit-gog-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("GameMain.exe"), b"fixture; do not execute").unwrap();
        for (manifest, id, title) in [
            ("goggame-111.info", "111", "Example Game"),
            ("goggame-222.info", "222", "Independent Expansion"),
            ("goggame-333.info", "111", "Duplicate Record"),
        ] {
            fs::write(
                root.join(manifest),
                json!({
                    "gameId":id,"name":title,
                    "playTasks":[{"type":"FileTask","path":"GameMain.exe","isPrimary":true}]
                })
                .to_string(),
            )
            .unwrap();
        }
        let entries = entries_at(&root, 32).unwrap().0;
        let mut warnings = Vec::new();
        let games = gog_from_dir(&root, &entries, &mut warnings);
        let ids = games
            .iter()
            .map(|game| field(game, "source_id").to_string())
            .collect::<HashSet<_>>();
        assert_eq!(ids, HashSet::from(["111".to_string(), "222".to_string()]));
        assert_eq!(games.len(), 2, "distinct launchable IDs must be preserved");
        assert!(games.iter().all(|game| field(game, "source") == "gog"));
        assert!(games
            .iter()
            .all(|game| field(game, "executable").ends_with("GameMain.exe")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gog_filename_and_embedded_product_identity_must_match_exactly() {
        let root = std::env::temp_dir().join(format!("orbit-gog-id-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("GameMain.exe"), b"fixture; never executed").unwrap();
        for (file, embedded) in [
            ("goggame-900.info", "901"),
            ("goggame-0901.info", "901"),
            ("GOGGAME-0900.INFO", "0900"),
        ] {
            fs::write(
                root.join(file),
                json!({
                    "gameId":embedded,
                    "name":"Sample Expansion",
                    "playTasks":[{"type":"FileTask","path":"GameMain.exe","isPrimary":true}]
                })
                .to_string(),
            )
            .unwrap();
        }
        let entries = entries_at(&root, 32).unwrap().0;
        let mut warnings = Vec::new();
        let games = gog_from_dir(&root, &entries, &mut warnings);
        assert_eq!(
            games.len(),
            1,
            "mismatched GOG product IDs must fail closed"
        );
        assert_eq!(games[0]["source_id"], "0900");
        fs::remove_dir_all(root).unwrap();
    }

    fn pb_chunk(field: u64, payload: &[u8]) -> Vec<u8> {
        fn put_varint(out: &mut Vec<u8>, mut value: u64) {
            while value >= 0x80 {
                out.push((value as u8 & 0x7f) | 0x80);
                value >>= 7;
            }
            out.push(value as u8);
        }
        let mut out = Vec::new();
        put_varint(&mut out, (field << 3) | 2);
        put_varint(&mut out, payload.len() as u64);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn battlenet_protobuf_discovers_only_installed_game_records() {
        let settings = pb_chunk(1, b"C:/Games/Diablo IV");
        let mut product = pb_chunk(2, b"fenris");
        product.extend(pb_chunk(3, &settings));
        let mut agent = pb_chunk(2, b"agent");
        agent.extend(pb_chunk(3, &settings));
        let mut bytes = pb_chunk(1, &product);
        bytes.extend(pb_chunk(1, &agent));
        bytes.extend(pb_chunk(1, &product));
        assert_eq!(
            battlenet_products(&bytes).unwrap(),
            vec![("fenris".into(), "C:/Games/Diablo IV".into())]
        );
        assert!(battlenet_products(&[0x0a, 0x7f, 0x01]).is_err());
        assert!(
            battlenet_products(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02])
                .is_err()
        );
        assert!(battlenet_products(&vec![0; MANIFEST_BYTES as usize + 1]).is_err());
    }

    #[test]
    fn battlenet_scan_skips_stale_directory_without_install_metadata() {
        let root =
            std::env::temp_dir().join(format!("orbit-bnet-fixture-{}", uuid::Uuid::new_v4()));
        let directory = root.join("Diablo IV");
        fs::create_dir_all(&directory).unwrap();
        let file = root.join("product.db");
        let path = directory.to_str().unwrap();
        let settings = pb_chunk(1, path.as_bytes());
        let mut product = pb_chunk(2, b"fenris");
        product.extend(pb_chunk(3, &settings));
        fs::write(&file, pb_chunk(1, &product)).unwrap();
        assert!(discover_battlenet_at(&file).0.is_empty());
        fs::write(directory.join(".build.info"), b"fixture, not executed").unwrap();
        assert!(
            discover_battlenet_at(&file).0.is_empty(),
            "metadata alone must not import an unlaunchable record"
        );
        let executable = directory.join("Diablo IV.exe");
        fs::write(&executable, b"fixture, not executed").unwrap();
        let discovered = discover_battlenet_at(&file).0;
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0]["source"], "battlenet");
        assert_eq!(discovered[0]["source_id"], "fenris");
        assert_eq!(discovered[0]["name"], "Diablo IV");
        assert_eq!(discovered[0]["executable"], json!(executable));
        assert!(discovered[0].get("launch_uri").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn xbox_gdk_manifest_accepts_only_verified_contained_pc_exe() {
        let root =
            std::env::temp_dir().join(format!("orbit-xbox-fixture-{}", uuid::Uuid::new_v4()));
        let game = root.join("Sample Game");
        let content = game.join("Content");
        fs::create_dir_all(&content).unwrap();
        let exe = content.join("Sample.exe");
        fs::write(&exe, b"fixture, not executed").unwrap();
        let manifest = content.join("MicrosoftGame.config");
        let sample = r#"<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
 <Identity Name="ExamplePublisher.SampleGame" Publisher="CN=Valid"/>
 <ExecutableList><Executable Name="Sample.exe" Id="Game" TargetDeviceFamily="PC"/></ExecutableList>
 <ShellVisuals DefaultDisplayName="Sample Game"/>
</Game>"#;
        fs::write(&manifest, sample).unwrap();
        let discovered = xbox_from_manifest(&content, &manifest).unwrap();
        assert_eq!(discovered["source"], "xbox");
        assert_eq!(discovered["source_id"], "ExamplePublisher.SampleGame");
        assert_eq!(discovered["name"], "Sample Game");
        assert_eq!(discovered["executable"], json!(exe));
        let (list, warnings) = discover_xbox_roots(&[root.clone()]);
        assert!(warnings
            .iter()
            .any(|message| message.contains("Gaming Services")));
        assert_eq!(list.len(), 1);
        fs::write(&manifest, sample.replace("Sample.exe", "../../Outside.exe")).unwrap();
        assert!(xbox_from_manifest(&content, &manifest).is_none());
        fs::write(
            &manifest,
            format!("<!DOCTYPE Game [<!ENTITY x SYSTEM \"file:///secret\">]>{sample}"),
        )
        .unwrap();
        assert!(xbox_from_manifest(&content, &manifest).is_none());
        for invalid in [
            sample.replace("</ExecutableList>", "</Wrong>"),
            sample.replace("</Game>", "</NotGame>"),
            sample.replace("</Game>", "</Game><Game></Game>"),
            sample.replace("<ExecutableList>", "<ExecutableList><Executable>"),
            sample.replace(
                "<Identity Name=\"ExamplePublisher.SampleGame\" Publisher=\"CN=Valid\"/>",
                "<Metadata><Identity Name=\"ExamplePublisher.SampleGame\" Publisher=\"CN=Valid\"/></Metadata>",
            ),
            sample.replace(
                "<ShellVisuals DefaultDisplayName=\"Sample Game\"/>",
                "<Nested><ShellVisuals DefaultDisplayName=\"Sample Game\"/></Nested>",
            ),
            sample.replace(
                "<ExecutableList>",
                "<Extra><ExecutableList>",
            ).replace("</ExecutableList>", "</ExecutableList></Extra>"),
            sample.replace(
                "<ExecutableList><Executable",
                "<ExecutableList><Group><Executable",
            ).replace("/></ExecutableList>", "/></Group></ExecutableList>"),
            sample.replace(
                "<Identity Name=\"ExamplePublisher.SampleGame\" Publisher=\"CN=Valid\"/>",
                "<Identity Name=\"ExamplePublisher.SampleGame\" Publisher=\"CN=Valid\"/><Identity Name=\"Other.Game\" Publisher=\"CN=Other\"/>",
            ),
            sample.replace(
                "<ShellVisuals DefaultDisplayName=\"Sample Game\"/>",
                "<ShellVisuals DefaultDisplayName=\"Sample Game\"/><ShellVisuals DefaultDisplayName=\"Other Game\"/>",
            ),
            sample.replace(
                "<ExecutableList><Executable",
                "<ExecutableList><Executable Name=\"Sample.exe\"/><Executable",
            ),
            sample.replace(
                "Name=\"Sample.exe\"",
                "Name=\"Sample.exe\" Name=\"Sample.exe\"",
            ),
            sample.replace("Name=\"Sample.exe\" Id=", "Name=\"Sample.exe\"Id="),
            sample.replace("Sample Game", "Sample &broken Game"),
            sample.replace("</Game>", "<!-- unfinished </Game>"),
        ] {
            fs::write(&manifest, invalid).unwrap();
            assert!(
                xbox_from_manifest(&content, &manifest).is_none(),
                "malformed XML must never produce a trusted Xbox record"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn xbox_xml_ignores_fake_identity_inside_comments() {
        let doc = r#"<Game><!-- <Identity Name="fake" Publisher="CN=Fake"/> -->
          <Identity Name="real.game" Publisher="CN=Real"/>
          <ShellVisuals DefaultDisplayName="Real Game"/></Game>"#;
        let identities = xbox_xml_tags(doc, "Identity").unwrap();
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0]["Name"], "real.game");
        assert!(xbox_xml_tags("<Game><!ENTITY evil SYSTEM 'secret'></Game>", "Game").is_none());
        assert_eq!(
            xml_unescape_attribute("A &amp; B &#x26; C").as_deref(),
            Some("A & B & C")
        );
        assert!(xml_unescape_attribute("&secret;").is_none());
    }

    #[test]
    fn direct_launch_cancels_stale_activity_without_emitting_a_finish() {
        let id = "direct-overrides-activity".to_string();
        let mut state = HashMap::new();
        state.insert(
            id.clone(),
            ActivitySession {
                clock: SessionClock::new(),
                misses: 1,
                first_miss: Some(10),
                registered: false,
            },
        );
        discard_activity_for_direct(&mut state, &HashSet::from([id]));
        assert!(
            state.is_empty(),
            "a provisional activity tracker must never outlive a direct launch"
        );
    }

    #[test]
    fn direct_handoff_preserves_registered_activity_records() {
        let id = "already-registered".to_string();
        let mut state = HashMap::new();
        state.insert(
            id.clone(),
            ActivitySession {
                clock: SessionClock::new(),
                misses: 0,
                first_miss: None,
                registered: true,
            },
        );
        discard_activity_for_direct(&mut state, &HashSet::from([id]));
        assert_eq!(
            state.len(),
            1,
            "persisted activity still needs its own completion"
        );
    }

    #[test]
    fn activity_retries_registration_until_database_acknowledges() {
        let mut sessions = HashMap::new();
        assert!(observe_activity_session(&mut sessions, "game"));
        assert!(
            observe_activity_session(&mut sessions, "game"),
            "failed database start needs another attempt"
        );
        sessions.get_mut("game").unwrap().registered = true;
        assert!(
            !observe_activity_session(&mut sessions, "game"),
            "registered games do not create duplicate sessions"
        );
        assert_eq!(sessions.len(), 1);
    }

    #[test]
    fn vdf_parses_nested_steam_metadata_and_escapes() {
        let text = r#""AppState" {
            "appid" "730"
            "name" "Counter-Strike 2"
            "installdir" "Counter-Strike 2"
            "StateFlags" "4"
            "info" { "quoted" "Say \"hello\"" }
        }"#;
        let tokens = vdf_tokens(text).expect("valid Valve metadata");
        let vdf = vdf_object(&tokens, &mut 0, 0).expect("valid metadata tree");
        let state = &vdf["AppState"];
        assert_eq!(field(state, "appid"), "730");
        assert_eq!(field(state, "name"), "Counter-Strike 2");
        assert_eq!(state["info"]["quoted"], "Say \"hello\"");
    }

    #[test]
    fn launch_uris_reject_web_schemes_and_whitespace() {
        assert!(validate_uri("steam://rungameid/730").is_ok());
        assert!(validate_uri("com.epicgames.launcher://apps/Test?action=launch").is_ok());
        assert!(validate_uri("https://example.com").is_err());
        assert!(validate_uri("javascript:alert(1)").is_err());
        assert!(validate_uri("steam://rungameid/730\nmalicious").is_err());
        assert!(validate_uri(&format!("steam://{}", "a".repeat(2_049))).is_err());
    }

    #[test]
    fn rejects_installers_and_untrusted_relative_files() {
        assert!(ignored_executable(Path::new("C:/Games/setup.exe")));
        assert!(ignored_executable(Path::new("C:/Games/CrashReporter.exe")));
        assert!(ignored_executable(Path::new("C:/Games/GameLauncher.exe")));
        assert!(ignored_executable(Path::new("C:/Games/Launcher64.exe")));
        assert!(ignored_executable(Path::new(
            "C:/Epic Games/rocketleague/Binaries/Win64/RocketLeague_EAC.exe"
        )));
        assert!(ignored_executable(Path::new(
            "C:/Games/AnotherGame-EAC.exe"
        )));
        assert!(!ignored_executable(Path::new("C:/Games/RocketLeague.exe")));
        assert!(!ignored_executable(Path::new("C:/Games/HollowKnight.exe")));
        let root = std::env::temp_dir();
        assert!(contained_file(&root, "../outside.exe").is_none());
        assert!(contained_file(&root, "C:/Windows/System32/cmd.exe").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn rocket_league_eac_helper_alone_does_not_keep_epic_game_running() {
        let install = r"C:\Program Files\Epic Games\rocketleague";
        let main = PathBuf::from(format!(r"{install}\Binaries\Win64\RocketLeague.exe"));
        let eac = PathBuf::from(format!(r"{install}\Binaries\Win64\RocketLeague_EAC.exe"));
        let game = json!([{
            "id": "rocket",
            "source": "epic",
            "name": "Rocket League",
            "install_path": install,
            "executable": main.to_string_lossy()
        }]);
        assert_eq!(
            match_game_processes(&game, &[main.clone(), eac.clone()]),
            HashSet::from(["rocket".to_string()]),
            "the real game still owns a normal session"
        );
        assert!(
            match_game_processes(&game, &[eac.clone()]).is_empty(),
            "the anti-cheat wrapper alone must not extend playtime after exit"
        );
        assert!(
            match_game_processes(
                &json!([{"id": "rocket", "source": "epic", "install_path": install, "executable": eac.to_string_lossy()}]),
                &[eac.clone()]
            ).is_empty(),
            "a storefront manifest's helper executable is not authoritative for activity"
        );
        assert_eq!(
            match_game_processes(
                &json!([{"id": "explicit", "source": "manual", "executable": eac.to_string_lossy()}]),
                &[eac]
            ),
            HashSet::from(["explicit".to_string()]),
            "an explicitly linked manual executable retains the existing direct-match contract"
        );
    }

    #[cfg(windows)]
    #[test]
    fn duplicate_storefront_and_manual_alias_have_one_background_owner() {
        let store = r"D:\SteamLibrary\steamapps\common\Example";
        let alias = format!(r"{store}\Binaries\Win64\Example-Win64-Shipping.exe");
        let games = json!([
            {"id":"steam-A","name":"Example","source":"steam","install_path":store},
            {"id":"manual-B","name":"Example","source":"manual","executable":alias},
            {"id":"other","name":"Other Game","source":"steam","install_path":r"D:\SteamLibrary\steamapps\common\Other Game"}
        ]);
        let inventory = vec![
            PathBuf::from(format!(r"{store}\ExampleClient.exe")),
            PathBuf::from(&alias),
            PathBuf::from(r"D:\SteamLibrary\steamapps\common\Other Game\OtherGame.exe"),
        ];
        let owners = match_game_processes(&games, &inventory);
        assert_eq!(
            owners,
            HashSet::from(["steam-A".to_string(), "other".to_string()])
        );
        // A helper is not a real game process: when only the helper and
        // explicitly linked shipping executable run, the manual record owns
        // the session instead of inventing a store-folder session.
        let helper_only = vec![
            PathBuf::from(format!(r"{store}\GameBootstrapHelper.exe")),
            PathBuf::from(&alias),
        ];
        assert_eq!(
            match_game_processes(&games, &helper_only),
            HashSet::from(["manual-B".to_string()])
        );
        let manual_only = json!([games[1].clone()]);
        assert_eq!(
            match_game_processes(&manual_only, &[PathBuf::from(alias)]),
            HashSet::from(["manual-B".to_string()])
        );
        let mut automatic = HashSet::from(["steam-A".to_string()]);
        suppress_store_for_direct_alias(
            &games,
            &mut automatic,
            &HashSet::from(["manual-B".to_string()]),
        );
        assert!(
            automatic.is_empty(),
            "direct manual launch must suppress the store background record"
        );
        assert_eq!(
            installation_alias_ids(&games, "manual-B"),
            HashSet::from(["steam-A".to_string()])
        );
        let distinct = json!([
            {"id":"main","name":"Main Game","source":"steam","install_path":store},
            {"id":"bonus","name":"Independent Bonus Game","source":"manual","executable":format!(r"{store}\DLC\BonusGame.exe")}
        ]);
        let matches = match_game_processes(
            &distinct,
            &[
                PathBuf::from(format!(r"{store}\Main.exe")),
                PathBuf::from(format!(r"{store}\DLC\BonusGame.exe")),
            ],
        );
        assert_eq!(
            matches,
            HashSet::from(["main".to_string(), "bonus".to_string()])
        );
        assert!(installation_alias_ids(&distinct, "bonus").is_empty());
        let launcher = PathBuf::from(format!(r"{store}\GameLauncher.exe"));
        let linked_only = json!([{"id":"linked","name":"Example","source":"manual","executable":launcher.to_string_lossy()}]);
        assert_eq!(
            match_game_processes(&linked_only, &[launcher.clone()]),
            HashSet::from(["linked".to_string()]),
            "explicitly linked local launchers must remain trackable"
        );
        let store_only = json!([games[0].clone()]);
        assert!(
            match_game_processes(&store_only, &[launcher]).is_empty(),
            "persistent helper cannot keep a store folder session running"
        );
    }

    #[test]
    fn game_title_normalization_is_bounded() {
        assert_eq!(clean_name("Some_Game-Name"), "Some Game Name");
        assert!(clean_name(&"x".repeat(500)).chars().count() <= 140);
        assert!(!valid_title("Title\r\nInjected"));
        assert!(!valid_app_id("../outside"));
    }

    #[test]
    fn local_game_identity_prefers_full_folder_title_over_technical_executables() {
        let parcel =
            Path::new("/Downloads/Parcel-Simulator-AnkerGames/Parcel Simulator/parcel.exe");
        let (name, suggested, source) = game_file_title(parcel, Some("BootstrapPackagedGame"));
        assert_eq!(
            (name.as_str(), suggested.as_str(), source),
            ("Parcel Simulator", "Parcel Simulator", "folder")
        );

        let bodycam = Path::new("/Downloads/Bodycam-SteamRIP.com/Bodycam/Bodycam.exe");
        let (name, suggested, _) = game_file_title(bodycam, Some("BootstrapPackagedGame"));
        assert_eq!((name.as_str(), suggested.as_str()), ("Bodycam", "Bodycam"));

        let shipping = Path::new("/Downloads/Bodycam-SteamRIP.com/Bodycam/Binaries/Win64/BootstrapPackagedGame-Win64-Shipping.exe");
        let (name, suggested, source) = game_file_title(shipping, Some("BootstrapPackagedGame"));
        assert_eq!(
            (name.as_str(), suggested.as_str(), source),
            ("Bodycam", "Bodycam", "folder")
        );
        assert!(!sensible_product_name("BootstrapPackagedGame"));
        assert!(!sensible_product_name("Game-Win64-Shipping"));

        let creed = Path::new("/Downloads/Assassins-Creed-Mirage/Creed/Creed.exe");
        let (name, suggested, source) = game_file_title(creed, Some("Creed"));
        assert_eq!(
            (name.as_str(), suggested.as_str(), source),
            ("Assassins Creed Mirage", "Assassins Creed Mirage", "folder")
        );

        let creed_abbreviated = Path::new("/Games/Assassins-Creed-Shadows/ACShadows.exe");
        let (name, suggested, source) = game_file_title(creed_abbreviated, None);
        assert_eq!(
            (name.as_str(), suggested.as_str(), source),
            (
                "Assassins Creed Shadows",
                "Assassins Creed Shadows",
                "folder"
            )
        );

        let explicit = Path::new("/Games/HollowKnight.exe");
        let (name, suggested, source) = game_file_title(explicit, None);
        assert_eq!(
            (name.as_str(), suggested.as_str(), source),
            ("Hollow Knight", "HollowKnight", "executable")
        );

        let unknown = Path::new("/Downloads/Win64/Shipping.exe");
        let (name, suggested, source) = game_file_title(unknown, None);
        assert_eq!(
            (name.as_str(), suggested.as_str(), source),
            ("Untitled game", "Untitled game", "filename")
        );
        for path in [
            "/Users/Alice/Downloads/BootstrapPackagedGame.exe",
            "/Users/Alice/BootstrapPackagedGame.exe",
            "/Temp/BootstrapPackagedGame.exe",
        ] {
            let (name, _, source) = game_file_title(Path::new(path), None);
            assert_eq!(name, "Untitled game", "account/root leaked: {path}");
            assert_eq!(source, "filename");
        }
        let (title, _, source) = game_file_title(
            Path::new("/Users/Alice/Downloads/Bodycam/Binaries/Win64/BootstrapPackagedGame.exe"),
            None,
        );
        assert_eq!(title, "Bodycam");
        assert_eq!(source, "folder");
        let (title, _, source) = game_file_title(
            Path::new(
                "/Temp/orbit-inspect-long-random-name/UnrealGame/Binaries/Win64/BootstrapPackagedGame-Win64-Shipping.exe",
            ),
            None,
        );
        assert_eq!(title, "UnrealGame");
        assert_eq!(source, "folder-unverified");
        let (title, _, source) = game_file_title(
            Path::new(
                "/Games/Parcel Simulator/ParcelSimulator/Binaries/Win64/BootstrapPackagedGame.exe",
            ),
            None,
        );
        assert_eq!(title, "Parcel Simulator");
        assert_eq!(source, "folder");
        let (title, _, source) = game_file_title(
            Path::new(
                "/Games/Long Display Game Title/InternalProject/Binaries/Win64/BootstrapPackagedGame.exe",
            ),
            None,
        );
        assert_eq!(title, "InternalProject");
        assert_eq!(source, "folder-unverified");
    }

    #[cfg(windows)]
    #[test]
    fn inspected_manual_executables_expose_repaired_title_and_suggestion() {
        let sandbox = std::env::temp_dir().join(format!("orbit-inspect-{}", std::process::id()));
        let root = sandbox.join("Games");
        let cases = [
            (
                "Parcel-Simulator-AnkerGames/Parcel Simulator/parcel.exe",
                "Parcel Simulator",
            ),
            ("Bodycam-SteamRIP.com/Bodycam/Bodycam.exe", "Bodycam"),
            ("Assassins-Creed-Mirage/Creed.exe", "Assassins Creed Mirage"),
            (
                "UnrealGame/Binaries/Win64/BootstrapPackagedGame-Win64-Shipping.exe",
                "UnrealGame",
            ),
        ];
        for (relative, expected) in cases {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"not a PE; metadata lookup must be optional").unwrap();
            let result = inspect_game_file(path.to_str().unwrap()).unwrap();
            assert_eq!(result["name"], expected, "failed inspecting {relative}");
            assert_eq!(
                result["suggested_name"], expected,
                "failed suggesting {relative}"
            );
            assert_eq!(result["name_source"], "folder");
        }
        std::fs::remove_dir_all(&sandbox).unwrap();
    }

    #[test]
    fn only_portrait_artwork_passes_local_cover_selection() {
        let mut png = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        png[16..20].copy_from_slice(&600_u32.to_be_bytes());
        png[20..24].copy_from_slice(&900_u32.to_be_bytes());
        assert!(is_portrait_image(&png));
        png[16..20].copy_from_slice(&1920_u32.to_be_bytes());
        png[20..24].copy_from_slice(&1080_u32.to_be_bytes());
        assert!(!is_portrait_image(&png));
        png[16..20].copy_from_slice(&4100_u32.to_be_bytes());
        png[20..24].copy_from_slice(&6200_u32.to_be_bytes());
        assert!(!is_portrait_image(&png));
        assert!(!is_portrait_image(b"not really a JPEG"));
    }
}

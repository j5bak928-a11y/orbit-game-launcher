//! Orbit's local game and operating-system operations.
//! The database owns session records. This module owns only process handles and
//! reports completed sessions/checkpoints for the database to persist.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, DirEntry};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAX_ENTRIES: usize = 6_000;
const MAX_ROOTS: usize = 64;
const MANIFEST_BYTES: u64 = 3 * 1024 * 1024;
const MAX_SESSIONS: usize = 128;

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
        // If the parent is an unrelated project/container name, the guess
        // remains unverified and must never trigger an automatic DB rename.
        folders.first().map(|closest| {
            folders
                .iter()
                .skip(1)
                .filter(|outer| normalized_name(outer) == normalized_name(closest))
                .max_by_key(|outer| outer.chars().count())
                .cloned()
                .or_else(|| {
                    folders
                        .iter()
                        .skip(1)
                        .filter(|outer| {
                            outer.split_whitespace().count() >= 3
                                && outer.chars().count() > closest.chars().count()
                                && !outer.split_whitespace().any(|word| {
                                    word.chars().all(|character| character.is_ascii_digit())
                                })
                        })
                        .max_by_key(|outer| outer.chars().count())
                        .cloned()
                })
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

fn gog_from_dir(dir: &Path, items: &[DirEntry], warnings: &mut Vec<String>) -> Option<Value> {
    let manifest = items.iter().find(|item| {
        let name = filename(&item.path()).to_ascii_lowercase();
        name.starts_with("goggame-")
            && name.ends_with(".info")
            && item.file_type().is_ok_and(|t| t.is_file())
    })?;
    let doc: Value = match small_text(&manifest.path())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(doc) => doc,
        Err(error) => {
            warnings.push(format!("GOG {}: {error}", filename(&manifest.path())));
            return None;
        }
    };
    let fallback_id = filename(&manifest.path())
        .trim_start_matches("goggame-")
        .trim_end_matches(".info")
        .to_string();
    let id = doc
        .get("gameId")
        .map(|id| {
            id.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| id.to_string())
        })
        .unwrap_or(fallback_id);
    if id.is_empty() || id.len() > 20 || !id.bytes().all(|c| c.is_ascii_digit()) {
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
        if let Some(game) = gog_from_dir(&root, &entries, &mut warnings) {
            let id = field(&game, "source_id").to_string();
            if ids.insert(id) {
                games.push(game);
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
            if let Some(game) = gog_from_dir(&location, &items, &mut warnings) {
                let id = field(&game, "source_id").to_string();
                if ids.insert(id) {
                    games.push(game);
                }
            }
        }
    }
    (games, warnings)
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
            let source = field(&game, "source");
            let source_id = field(&game, "source_id");
            let file = field(&game, "executable").to_ascii_lowercase();
            let folder = field(&game, "install_path").to_ascii_lowercase();
            let uri = field(&game, "launch_uri");
            let key = if !source_id.is_empty() {
                format!("{source}:{source_id}")
            } else if !file.is_empty() {
                format!("file:{file}")
            } else {
                format!("uri:{uri}")
            };
            if seen.contains(&key)
                || (!file.is_empty() && seen_files.contains(&file))
                || (source == "folder" && store_dirs.contains(&folder))
            {
                continue;
            }
            seen.insert(key);
            if !file.is_empty() {
                seen_files.insert(file);
            }
            if !matches!(source, "folder" | "manual") && !folder.is_empty() {
                store_dirs.insert(folder);
            }
            all.push(game);
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
    ] {
        let tick = Instant::now();
        let (games, notes) = discover();
        append(provider, None, games, notes, tick.elapsed().as_millis());
    }
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
            && !ignored_executable(Path::new(executable))
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
        if extension(file) != "exe" || ignored_executable(file) || !file.is_absolute() {
            continue;
        }
        let key = normalize_windows_path(&file.to_string_lossy());
        if let Some(ids) = exact.get(&key) {
            if ids.len() == 1 {
                found.extend(ids.iter().cloned());
            }
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
    found
}

struct ActivitySession {
    clock: SessionClock,
    misses: u8,
    first_miss: Option<u64>,
}

static ACTIVITY: OnceLock<Mutex<HashMap<String, ActivitySession>>> = OnceLock::new();
fn activity() -> &'static Mutex<HashMap<String, ActivitySession>> {
    ACTIVITY.get_or_init(|| Mutex::new(HashMap::new()))
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
    let mut sorted = running.into_iter().collect::<Vec<_>>();
    sorted.sort();
    Ok(json!(sorted))
}

/// Process observation for launcher URI games. Two missing inventories are
/// required before a session is finished, and query errors leave state intact.
/// `started` and `finished` belong to the DB integration layer.
pub fn poll_activity(games: &Value) -> Result<Value, String> {
    let inventory = list_running_executables()?;
    let found = match_game_processes(games, &inventory);
    let direct_ids = direct()
        .lock()
        .map_err(|_| "Process tracker unavailable.")?
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
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
    let mut started = Vec::new();
    let mut finished = Vec::new();
    for id in found
        .iter()
        .filter(|id| !direct_ids.contains(*id) && eligible.contains(*id))
    {
        if let Some(active) = state.get_mut(id) {
            active.misses = 0;
            active.first_miss = None;
        } else if state.len() < MAX_SESSIONS {
            state.insert(
                id.clone(),
                ActivitySession {
                    clock: SessionClock::new(),
                    misses: 0,
                    first_miss: None,
                },
            );
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!ignored_executable(Path::new("C:/Games/HollowKnight.exe")));
        let root = std::env::temp_dir();
        assert!(contained_file(&root, "../outside.exe").is_none());
        assert!(contained_file(&root, "C:/Windows/System32/cmd.exe").is_none());
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
        assert_eq!(title, "Long Display Game Title");
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

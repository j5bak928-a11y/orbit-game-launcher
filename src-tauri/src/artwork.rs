//! Native Steam artwork. The caller must gate every network-enabled entry point
//! with the useSteamArtwork setting and Performance Guard state.
use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;
use url::Url;

const IMAGE_LIMIT: usize = 5 * 1024 * 1024;
const ICON_LIMIT: usize = 2 * 1024 * 1024;
const SEARCH_LIMIT: usize = 256 * 1024;
const JSON_LIMIT: usize = 1024 * 1024;
const REPAIR_LIMIT: usize = 300;
const ONLINE_LIMIT: usize = 8;
const REPAIR_TIME: Duration = Duration::from_secs(40);
const CDN: &str = "https://shared.fastly.steamstatic.com/store_item_assets/";
const ASSETS: [&str; 4] = [
    "library_capsule_2x.jpg",
    "library_capsule.jpg",
    "library_600x900_2x.jpg",
    "library_600x900.jpg",
];

fn valid_id(id: &str) -> bool {
    (1..=15).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
        && id.bytes().any(|b| b != b'0')
}
fn key(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '™' | '℠' | '®' | '©'))
        .collect::<String>()
        .nfkd()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}
fn valid_title(s: &str) -> bool {
    (3..=140).contains(&s.chars().count()) && !s.chars().any(char::is_control) && key(s).len() >= 4
}
fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .redirect(Policy::none())
        .user_agent("OrbitLauncher/0.2.4")
        .build()
        .map_err(|e| e.to_string())
}
fn approved_url(raw: &str) -> bool {
    let Ok(u) = Url::parse(raw) else { return false };
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.fragment().is_some()
    {
        return false;
    }
    matches!(
        (u.host_str(), u.path()),
        (Some("store.steampowered.com"), "/api/storesearch/")
            | (
                Some("api.steampowered.com"),
                "/IStoreBrowseService/GetItems/v1/"
            )
    ) || (u.host_str() == Some("shared.fastly.steamstatic.com")
        && u.path().starts_with("/store_item_assets/steam/apps/"))
}
fn read_response(response: Response, limit: usize, image: bool) -> Result<Option<Vec<u8>>, String> {
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("Steam artwork returned HTTP {}", response.status()));
    }
    let media = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let valid = if image {
        media.starts_with("image/jpeg") || media.starts_with("image/pjpeg")
    } else {
        media.starts_with("application/json") || media.starts_with("text/javascript")
    };
    if !valid {
        return Err("Steam artwork returned an unexpected content type".into());
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|size| size > limit)
    {
        return Ok(None);
    }
    let mut bytes = vec![];
    response
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok((bytes.len() <= limit).then_some(bytes))
}
fn require_online(allowed: &dyn Fn() -> bool) -> Result<(), String> {
    if allowed() {
        Ok(())
    } else {
        Err("Online Steam artwork was disabled or paused during the request.".into())
    }
}
fn request(
    http: &Client,
    url: &str,
    max: usize,
    image: bool,
    allowed: &dyn Fn() -> bool,
) -> Result<Option<Vec<u8>>, String> {
    require_online(allowed)?;
    if !approved_url(url) {
        return Err("Blocked unapproved Steam artwork endpoint".into());
    }
    let response = http
        .get(url)
        .send()
        .map_err(|e| format!("Steam request failed: {e}"))?;
    read_response(response, max, image)
}
fn json_request(
    http: &Client,
    url: &str,
    max: usize,
    allowed: &dyn Fn() -> bool,
) -> Result<Option<Value>, String> {
    let Some(bytes) = request(http, url, max, false, allowed)? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Steam returned invalid JSON".into())
}
fn exact_app(
    http: &Client,
    name: &str,
    allowed: &dyn Fn() -> bool,
) -> Result<Option<(String, String)>, String> {
    if !valid_title(name) {
        return Ok(None);
    }
    let mut url =
        Url::parse("https://store.steampowered.com/api/storesearch/").map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("term", name)
        .append_pair("l", "english")
        .append_pair("cc", "US");
    let Some(data) = json_request(http, url.as_str(), SEARCH_LIMIT, allowed)? else {
        return Ok(None);
    };
    let items = data["items"]
        .as_array()
        .ok_or("Steam search returned no items list")?;
    for item in items.iter().take(20) {
        if item["type"] != "app" {
            continue;
        }
        let Some(id) = item["id"].as_u64() else {
            continue;
        };
        let id = id.to_string();
        if !valid_id(&id) {
            continue;
        }
        let Some(found) = item["name"].as_str() else {
            continue;
        };
        if key(found) == key(name) {
            return Ok(Some((found.to_owned(), id)));
        }
    }
    Ok(None)
}
fn hash_part(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn approved_asset(name: &str) -> bool {
    let parts: Vec<&str> = name.split('/').collect();
    match parts.as_slice() {
        [file] => ASSETS.contains(file),
        [hash, file] => hash_part(hash) && ASSETS.contains(file),
        _ => false,
    }
}
fn official_urls(id: &str, assets: &Value) -> Vec<String> {
    let Some(template) = assets["asset_url_format"].as_str() else {
        return vec![];
    };
    let (path, query) = template
        .split_once('?')
        .map_or((template, None), |(p, q)| (p, Some(q)));
    if query.is_some_and(|q| {
        !q.starts_with("t=") || q.len() <= 2 || !q[2..].bytes().all(|b| b.is_ascii_digit())
    }) {
        return vec![];
    }
    let Some(tail) = path.strip_prefix(&format!("steam/apps/{id}/")) else {
        return vec![];
    };
    let Some(prefix) = tail.strip_suffix("${FILENAME}") else {
        return vec![];
    };
    if !prefix.is_empty() && !(prefix.ends_with('/') && hash_part(&prefix[..prefix.len() - 1])) {
        return vec![];
    }
    ["library_capsule_2x", "library_capsule"]
        .iter()
        .filter_map(|key| {
            let name = assets.get(*key)?.as_str()?;
            if !approved_asset(name) {
                return None;
            }
            let url = format!("{CDN}{}", template.replace("${FILENAME}", name));
            approved_url(&url).then_some(url)
        })
        .collect()
}
fn metadata_urls(
    http: &Client,
    id: &str,
    allowed: &dyn Fn() -> bool,
) -> Result<Vec<String>, String> {
    let input = json!({"ids":[{"appid":id.parse::<u64>().map_err(|e|e.to_string())?}],
        "context":{"country_code":"US","language":"english"},
        "data_request":{"include_assets":true}});
    let mut url = Url::parse("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/")
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("input_json", &input.to_string());
    let Some(data) = json_request(http, url.as_str(), JSON_LIMIT, allowed)? else {
        return Ok(vec![]);
    };
    if let Some(items) = data
        .pointer("/response/store_items")
        .and_then(Value::as_array)
    {
        for item in items.iter().take(20) {
            if item["appid"].as_u64().is_some_and(|n| n.to_string() == id) {
                return Ok(official_urls(id, &item["assets"]));
            }
        }
    }
    Ok(vec![])
}

// Inspect bounded JPEG SOF markers without allocating decoded pixels.
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return None;
    }
    let mut pos = 2usize;
    while pos + 3 < bytes.len() {
        if bytes[pos] != 0xff {
            return None;
        }
        pos += 1;
        while pos < bytes.len() && bytes[pos] == 0xff {
            pos += 1;
        }
        let marker = *bytes.get(pos)?;
        pos += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if pos + 2 > bytes.len() {
            return None;
        }
        let len = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
        if len < 2 || pos.checked_add(len)? > bytes.len() {
            return None;
        }
        if matches!(marker,0xc0..=0xc3|0xc5..=0xc7|0xc9..=0xcb|0xcd..=0xcf) {
            if len < 7 {
                return None;
            }
            let h = u16::from_be_bytes([bytes[pos + 3], bytes[pos + 4]]) as u32;
            let w = u16::from_be_bytes([bytes[pos + 5], bytes[pos + 6]]) as u32;
            return (w > 0 && h > 0).then_some((w, h));
        }
        pos += len;
    }
    None
}
fn portrait(bytes: &[u8]) -> bool {
    jpeg_dimensions(bytes).is_some_and(|(w, h)| {
        (80..=4096).contains(&w)
            && (120..=4096).contains(&h)
            && (0.5..=0.85).contains(&(w as f64 / h as f64))
    })
}
fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if jpeg_dimensions(bytes).is_some_and(|(w, h)| w <= 4096 && h <= 4096) {
        return Some("jpg");
    }
    if bytes.len() >= 24 && bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        if (1..=4096).contains(&w) && (1..=4096).contains(&h) {
            return Some("png");
        }
    }
    None
}
fn read_capped(path: &Path, max: usize) -> Result<Option<Vec<u8>>, String> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() || meta.len() < 8 || meta.len() > max as u64 {
        return Ok(None);
    }
    let mut bytes = vec![];
    File::open(path)
        .map_err(|e| e.to_string())?
        .take((max + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok((bytes.len() <= max).then_some(bytes))
}

// Stable SHA-256 prefix in the legacy UUID-style artwork token.
fn store(bytes: &[u8], ext: &str, dir: &Path) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > IMAGE_LIMIT || image_ext(bytes) != Some(ext) {
        return Err("Invalid artwork format, dimensions or size".into());
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    let name = format!(
        "{}-{}-{}-{}-{}.{}",
        &digest[..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32],
        ext
    );
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    match OpenOptions::new().create_new(true).write(true).open(&path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                let _ = fs::remove_file(&path);
                return Err(format!("Cannot save artwork: {e}"));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if read_capped(&path, IMAGE_LIMIT)?.as_deref() != Some(bytes) {
                return Err("Artwork token collision or damaged image".into());
            }
        }
        Err(e) => return Err(e.to_string()),
    }
    Ok(name)
}
fn add_root(roots: &mut Vec<PathBuf>, root: PathBuf) {
    if roots.len() < 12 && !roots.contains(&root) {
        roots.push(root);
    }
}
fn steam_roots(install: Option<&str>) -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Some(path) = install.filter(|s| s.len() <= 4096).map(Path::new) {
        if path.is_absolute() {
            if let Some(common) = path.parent() {
                if common
                    .file_name()
                    .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("common"))
                {
                    if let Some(apps) = common.parent() {
                        if apps
                            .file_name()
                            .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("steamapps"))
                        {
                            if let Some(root) = apps.parent() {
                                add_root(&mut roots, root.to_path_buf());
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(root) = std::env::var_os("STEAM_COMPAT_CLIENT_INSTALL_PATH") {
        add_root(&mut roots, PathBuf::from(root));
    }
    #[cfg(windows)]
    for var in ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"] {
        if let Some(root) = std::env::var_os(var) {
            add_root(&mut roots, PathBuf::from(root).join("Steam"));
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        #[cfg(target_os = "macos")]
        add_root(&mut roots, home.join("Library/Application Support/Steam"));
        #[cfg(not(target_os = "macos"))]
        for name in [".steam/steam", ".steam/root", ".local/share/Steam"] {
            add_root(&mut roots, home.join(name));
        }
    }
    roots
}
fn hashed_dirs(path: &Path) -> Vec<PathBuf> {
    let mut found = vec![];
    if let Ok(entries) = fs::read_dir(path) {
        for item in entries.take(100).flatten() {
            if found.len() >= 40 {
                break;
            }
            if hash_part(&item.file_name().to_string_lossy())
                && item.file_type().is_ok_and(|t| t.is_dir())
            {
                found.push(item.path());
            }
        }
    }
    found
}
fn local_cover(id: &str, install: Option<&str>) -> Option<Vec<u8>> {
    if !valid_id(id) {
        return None;
    }
    for root in steam_roots(install) {
        let cache = root.join("appcache/librarycache");
        let app = cache.join(id);
        let mut paths = vec![
            cache.join(format!("{id}_library_600x900.jpg")),
            cache.join(format!("{id}_library_capsule.jpg")),
        ];
        for name in ASSETS {
            paths.push(app.join(name));
        }
        for dir in hashed_dirs(&app) {
            for name in ASSETS {
                paths.push(dir.join(name));
            }
        }
        for path in paths {
            if let Ok(Some(bytes)) = read_capped(&path, IMAGE_LIMIT) {
                if portrait(&bytes) {
                    return Some(bytes);
                }
            }
        }
    }
    None
}
fn local_icon(id: &str, install: Option<&str>) -> Option<(Vec<u8>, &'static str)> {
    if !valid_id(id) {
        return None;
    }
    for root in steam_roots(install) {
        let cache = root.join("appcache/librarycache");
        let app = cache.join(id);
        let mut paths = vec![
            cache.join(format!("{id}_icon.jpg")),
            cache.join(format!("{id}_icon.png")),
            app.join("icon.jpg"),
            app.join("library_icon.jpg"),
            app.join("library_icon.png"),
        ];
        for dir in hashed_dirs(&app) {
            for name in ["library_icon.jpg", "library_icon.png"] {
                paths.push(dir.join(name));
            }
        }
        for path in paths {
            if let Ok(Some(bytes)) = read_capped(&path, ICON_LIMIT) {
                if let Some(ext) = image_ext(&bytes) {
                    return Some((bytes, ext));
                }
            }
        }
    }
    None
}

fn online_cover(http: &Client, id: &str) -> Result<Option<Vec<u8>>, String> {
    online_cover_with_deadline(http, id, None, &|| true)
}

fn online_cover_with_deadline(
    http: &Client,
    id: &str,
    deadline: Option<Instant>,
    allowed: &dyn Fn() -> bool,
) -> Result<Option<Vec<u8>>, String> {
    if !valid_id(id) {
        return Err("Invalid Steam app ID".into());
    }
    if deadline.is_some_and(|end| Instant::now() >= end) {
        return Err("Steam artwork repair time budget reached".into());
    }
    // Metadata can fail while official direct CDN paths remain available.
    let (mut urls, mut error) = match metadata_urls(http, id, allowed) {
        Ok(urls) => (urls, None),
        Err(e) => (vec![], Some(e)),
    };
    let extra = match id {
        "252950" => Some("cc030d5cf1de6d485d41685bf2aac8ae4ca8ab8e/library_capsule_2x.jpg"),
        "4435490" => Some("c71bc2cb60e440d1a0d2435d0c06c4d4a4050edf/library_capsule_2x.jpg"),
        _ => None,
    };
    if let Some(name) = extra {
        urls.push(format!("{CDN}steam/apps/{id}/{name}"));
    }
    for name in ASSETS {
        urls.push(format!("{CDN}steam/apps/{id}/{name}"));
    }
    let mut seen = HashSet::new();
    for url in urls
        .into_iter()
        .filter(|url| seen.insert(url.clone()))
        .take(6)
    {
        if deadline.is_some_and(|end| Instant::now() >= end) {
            return Err("Steam artwork repair time budget reached".into());
        }
        // Permission is evaluated before *every* HTTP request, including
        // fallback CDN attempts following a failed metadata response.
        match request(http, &url, IMAGE_LIMIT, true, allowed) {
            Ok(Some(bytes)) if portrait(&bytes) => return Ok(Some(bytes)),
            Ok(_) => (),
            Err(e) => error = Some(e),
        }
    }
    if let Some(e) = error {
        return Err(e);
    }
    Ok(None)
}

/// Lookup a manually entered title through an exact Steam search match.
/// Caller MUST check useSteamArtwork and Performance Guard before invoking.
/// Returns {cover, matchedName?, message}; failures return Err.
pub fn find_online_cover(title: &str, artwork_dir: &Path) -> Result<Value, String> {
    find_online_cover_guarded(title, artwork_dir, &|| true)
}

/// Recheck opt-in and Performance Guard immediately before each network call.
/// The caller must supply a fresh settings/running-session check.
pub fn find_online_cover_guarded(
    title: &str,
    artwork_dir: &Path,
    allowed: &dyn Fn() -> bool,
) -> Result<Value, String> {
    require_online(allowed)?;
    let title = title.trim();
    if !valid_title(title) {
        return Err("Enter a valid game title (3–140 characters).".into());
    }
    let http = client()?;
    let Some((name, id)) = exact_app(&http, title, allowed)? else {
        return Ok(json!({"cover":"",
            "message":"No exact Steam title match. Check the title or choose an image manually."}));
    };
    let Some(bytes) = online_cover_with_deadline(&http, &id, None, allowed)? else {
        return Ok(json!({"cover":"","matchedName":name,
            "message":"No portrait cover found for the exact Steam title."}));
    };
    require_online(allowed)?;
    let cover = store(&bytes, "jpg", artwork_dir)?;
    Ok(json!({"cover":cover,"matchedName":name,"message":"Cover found on Steam."}))
}

/// Fetch a Steam app by known ID. Offline Steam cache is always tried first.
/// When online=true, the caller must have verified the opt-in setting.
pub fn steam_cover_for_id(
    id: &str,
    artwork_dir: &Path,
    install_path: Option<&str>,
    online: bool,
) -> Result<Option<String>, String> {
    if !valid_id(id) {
        return Ok(None);
    }
    if let Some(bytes) = local_cover(id, install_path) {
        return store(&bytes, "jpg", artwork_dir).map(Some);
    }
    if !online {
        return Ok(None);
    }
    let Some(bytes) = online_cover(&client()?, id)? else {
        return Ok(None);
    };
    store(&bytes, "jpg", artwork_dir).map(Some)
}

fn artwork_token(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 36
        && matches!(ext, "jpg" | "jpeg" | "png" | "webp")
        && stem.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn needs_cover(game: &Value, dir: &Path) -> bool {
    let cover = game["cover"].as_str().unwrap_or("");
    if cover.is_empty() {
        return true;
    }
    if !artwork_token(cover) {
        return false;
    }
    let Some(bytes) = read_capped(&dir.join(cover), IMAGE_LIMIT).ok().flatten() else {
        return true;
    };
    // Preserve user's chosen PNG/WebP assets. Repair identifiable landscape JPEG.
    cover.ends_with(".jpg") && jpeg_dimensions(&bytes).is_some() && !portrait(&bytes)
}

/// Default repair uses local Steam artwork only; never performs HTTP.
pub fn repair_artwork(games: &[Value], artwork_dir: &Path) -> Result<Value, String> {
    repair_artwork_with_options(games, artwork_dir, false, false)
}

/// Explicitly opted-in repair, capped to 300 games, 8 online candidates and 40s.
/// Returns {found,attempted,icons,onlineEnabled,paused,updates,failures,truncated}.
/// updates contains proposed {id,cover?,icon?}; caller must verify DB revision
/// and original cover/icon to prevent overwriting concurrent user edits.
pub fn repair_artwork_with_options(
    games: &[Value],
    artwork_dir: &Path,
    online_enabled: bool,
    paused: bool,
) -> Result<Value, String> {
    repair_artwork_guarded(games, artwork_dir, online_enabled, paused, &|| true)
}

/// Supports opt-out while repair is running. Offline Steam cache inspection
/// remains available, but each new network fetch checks the live permissions.
pub fn repair_artwork_guarded(
    games: &[Value],
    artwork_dir: &Path,
    online_enabled: bool,
    paused: bool,
    allowed: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let started = Instant::now();
    let mut found = 0usize;
    let mut icons = 0usize;
    let mut attempted = 0usize;
    let mut online_count = 0usize;
    let mut updates = vec![];
    let mut failures = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    let mut truncated = false;
    let http = if online_enabled && !paused {
        Some(client()?)
    } else {
        None
    };
    for game in games {
        if attempted >= REPAIR_LIMIT || started.elapsed() >= REPAIR_TIME {
            truncated = true;
            break;
        }
        let Some(id) = game["id"].as_str() else {
            continue;
        };
        if id.len() > 100 || !seen.insert(id.to_owned()) {
            continue;
        }
        let need_cover = needs_cover(game, artwork_dir);
        let need_icon = game["icon"].as_str().unwrap_or("").is_empty();
        if !need_cover && !need_icon {
            continue;
        }
        let steam_id = game["source_id"]
            .as_str()
            .filter(|_| game["source"] == "steam")
            .filter(|id| valid_id(id));
        if steam_id.is_none() && (!need_cover || http.is_none()) {
            continue;
        }
        attempted += 1;
        let install = game["install_path"].as_str();
        let mut patch = serde_json::Map::new();
        patch.insert("id".into(), json!(id));
        if need_cover {
            let mut bytes = steam_id.and_then(|s| local_cover(s, install));
            if bytes.is_none()
                && http.is_some()
                && online_count < ONLINE_LIMIT
                && started.elapsed() < REPAIR_TIME
                && allowed()
            {
                online_count += 1;
                let http = http.as_ref().unwrap();
                let deadline = Some(started + REPAIR_TIME);
                let result = if let Some(steam_id) = steam_id {
                    online_cover_with_deadline(http, steam_id, deadline, allowed)
                } else {
                    match exact_app(http, game["name"].as_str().unwrap_or(""), allowed) {
                        Ok(Some((_, steam_id))) => {
                            online_cover_with_deadline(http, &steam_id, deadline, allowed)
                        }
                        Ok(None) => Ok(None),
                        Err(e) => Err(e),
                    }
                };
                match result {
                    Ok(result) if allowed() => bytes = result,
                    Ok(_) => (),
                    Err(e) => {
                        if failures.len() < 10 {
                            failures.push(format!("{id}: {e}"))
                        }
                    }
                }
            }
            if let Some(bytes) = bytes {
                match store(&bytes, "jpg", artwork_dir) {
                    Ok(cover) => {
                        patch.insert("cover".into(), json!(cover));
                        found += 1;
                    }
                    Err(e) => {
                        if failures.len() < 10 {
                            failures.push(format!("{id}: {e}"))
                        }
                    }
                }
            }
        }
        if need_icon {
            if let Some((bytes, ext)) = steam_id.and_then(|s| local_icon(s, install)) {
                match store(&bytes, ext, artwork_dir) {
                    Ok(icon) => {
                        patch.insert("icon".into(), json!(icon));
                        icons += 1;
                    }
                    Err(e) => {
                        if failures.len() < 10 {
                            failures.push(format!("{id}: {e}"))
                        }
                    }
                }
            }
        }
        if patch.len() > 1 {
            updates.push(Value::Object(patch));
        }
    }
    Ok(json!({"found":found,"attempted":attempted,"icons":icons,
        "onlineEnabled":online_enabled,"paused":online_enabled&&paused,
        "updates":updates,"failures":failures,"truncated":truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0, 11, 8];
        bytes.extend_from_slice(&h.to_be_bytes());
        bytes.extend_from_slice(&w.to_be_bytes());
        bytes.extend_from_slice(&[1, 1, 0x11, 0, 0xff, 0xd9]);
        bytes
    }
    #[test]
    fn exact_title_and_ids() {
        assert_eq!(key("Hollow Knight®"), key("Hollow Knight"));
        assert_ne!(key("Hollow Knight"), key("Hollow Knight 2"));
        assert!(!valid_title("CS\n2"));
        assert!(!valid_id("../../730"));
        assert!(valid_id("730"));
    }
    #[test]
    fn metadata_cannot_redirect_to_external_assets() {
        let assets = json!({"asset_url_format":"steam/apps/730/${FILENAME}?t=123",
            "library_capsule":"library_capsule.jpg","library_capsule_2x":"../../evil.jpg"});
        let urls = official_urls("730", &assets);
        assert_eq!(urls.len(), 1);
        assert!(urls[0].starts_with(CDN));
        assert!(official_urls(
            "730",
            &json!({"asset_url_format":"https://evil.test/${FILENAME}",
            "library_capsule":"library_capsule.jpg"})
        )
        .is_empty());
        assert!(!approved_url(
            "http://shared.fastly.steamstatic.com/store_item_assets/steam/apps/730/a.jpg"
        ));
    }
    #[test]
    fn dimensions_and_format_are_checked() {
        assert!(portrait(&jpeg(600, 900)));
        assert!(!portrait(&jpeg(900, 600)));
        assert!(!portrait(&jpeg(4096, 100)));
        assert_eq!(image_ext(b"invalid"), None);
    }
    #[test]
    fn content_addressed_dedup_and_corruption_detection() {
        let dir = std::env::temp_dir().join(format!("orbit-art-test-{}", uuid::Uuid::new_v4()));
        let bytes = jpeg(600, 900);
        let name = store(&bytes, "jpg", &dir).unwrap();
        assert_eq!(store(&bytes, "jpg", &dir).unwrap(), name);
        assert!(artwork_token(&name));
        fs::write(dir.join(&name), b"corrupt").unwrap();
        assert!(store(&bytes, "jpg", &dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn offline_repair_does_not_lookup_non_steam_games() {
        let dir = std::env::temp_dir().join(format!("orbit-art-offline-{}", uuid::Uuid::new_v4()));
        let game =
            json!({"id":"game-1","source":"manual","name":"Example Game","cover":"","icon":""});
        let result = repair_artwork(&[game], &dir).unwrap();
        assert_eq!(result["onlineEnabled"], false);
        assert_eq!(result["attempted"], 0);
        assert_eq!(result["updates"], json!([]));
        assert!(!dir.exists());
    }

    #[test]
    fn online_opt_out_is_rechecked_before_each_request() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let enabled = AtomicBool::new(true);
        let allowed = || enabled.load(Ordering::SeqCst);
        assert!(require_online(&allowed).is_ok());
        enabled.store(false, Ordering::SeqCst);
        assert!(require_online(&allowed).is_err());
        let http = client().unwrap();
        let url = "https://store.steampowered.com/api/storesearch/?term=Test";
        assert!(request(&http, url, SEARCH_LIMIT, false, &allowed).is_err());
        let dir = std::env::temp_dir().join(format!("orbit-art-revoked-{}", uuid::Uuid::new_v4()));
        assert!(find_online_cover_guarded("Example Game", &dir, &allowed).is_err());
        assert!(!dir.exists());
    }

    #[test]
    fn offline_repair_imports_local_steam_cover_and_preserves_token() {
        let dir =
            std::env::temp_dir().join(format!("orbit-steam-fixture-{}", uuid::Uuid::new_v4()));
        let root = dir.join("SteamLibrary");
        let installed = root.join("steamapps/common/TestGame");
        let library_cache = root.join("appcache/librarycache");
        fs::create_dir_all(&installed).unwrap();
        fs::create_dir_all(&library_cache).unwrap();
        fs::write(
            library_cache.join("730_library_600x900.jpg"),
            jpeg(600, 900),
        )
        .unwrap();
        let artwork = dir.join("artwork");
        let game = json!({"id":"11111111-1111-4111-8111-111111111111",
            "source":"steam","source_id":"730","name":"TestGame",
            "install_path":installed,"cover":"","icon":""});
        let result = repair_artwork(&[game], &artwork).unwrap();
        assert_eq!(result["onlineEnabled"], false);
        assert_eq!(result["attempted"], 1);
        assert_eq!(result["found"], 1);
        let token = result["updates"][0]["cover"].as_str().unwrap();
        assert!(artwork_token(token));
        assert_eq!(fs::read(artwork.join(token)).unwrap(), jpeg(600, 900));
        fs::remove_dir_all(dir).unwrap();
    }
}

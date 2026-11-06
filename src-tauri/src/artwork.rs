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
// An individual Epic lookup can use at most two metadata and six image
// requests; the existing eight-games/40-second global repair cap still applies.
const EPIC_REQUEST_LIMIT: usize = 8;
const EPIC_IMAGES_LIMIT: usize = 5;
const CDN: &str = "https://shared.fastly.steamstatic.com/store_item_assets/";
const FORTNITE_PORTRAIT: &str =
    "https://cdn1.epicgames.com/item/fn/FNBR_42-30_Fortnitemares_KeyArt_Fortnitemares_EGS_Launcher_Blade_1200x1600_1200x1600-af4593ae7f114b21aa0dc08449063141";
const ASSETS: [&str; 4] = [
    "library_capsule_2x.jpg",
    "library_capsule.jpg",
    "library_600x900_2x.jpg",
    "library_600x900.jpg",
];

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}

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
        .user_agent("OrbitLauncher/0.2.6")
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
            | (Some("www.epicgames.com"), "/graphql")
            | (Some("store.epicgames.com"), "/graphql")
    ) || (u.host_str() == Some("shared.fastly.steamstatic.com")
        && u.path().starts_with("/store_item_assets/steam/apps/"))
        || (matches!(
            u.host_str(),
            Some("cdn1.epicgames.com" | "cdn2.epicgames.com" | "cdn2.unrealengine.com")
        ) && u.path().starts_with('/')
            && u.path().len() <= 1024
            && u.query().is_none_or(|q| q.len() <= 256))
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
    if webp_dimensions(bytes).is_some() {
        return Some("webp");
    }
    None
}

fn portrait_image(bytes: &[u8]) -> bool {
    let dimensions = match image_ext(bytes) {
        Some("jpg") => jpeg_dimensions(bytes),
        Some("png") => Some((
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        )),
        Some("webp") => webp_dimensions(bytes),
        _ => None,
    };
    dimensions.is_some_and(|(w, h)| {
        (80..=4096).contains(&w)
            && (120..=4096).contains(&h)
            && (0.5..=0.85).contains(&(w as f64 / h as f64))
    })
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 30 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let kind = &bytes[12..16];
    let (w, h) = if kind == b"VP8X" {
        let w = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
        let h = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
        (w, h)
    } else if kind == b"VP8 " && bytes[23..26] == [0x9d, 0x01, 0x2a] {
        (
            (u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff) as u32,
            (u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff) as u32,
        )
    } else if kind == b"VP8L" && bytes[20] == 0x2f {
        (
            1 + (((bytes[22] & 0x3f) as u32) << 8) + bytes[21] as u32,
            1 + (((bytes[24] & 0x0f) as u32) << 10)
                + ((bytes[23] as u32) << 2)
                + (((bytes[22] & 0xc0) as u32) >> 6),
        )
    } else {
        return None;
    };
    (w > 0 && h > 0 && w <= 4096 && h <= 4096).then_some((w, h))
}

// Only inspect small, immediate directories of installed games. Never follow
// symlinks, recurse through binary trees, or fetch local paths from the network.
fn local_nonsteam_portrait(game: &Value) -> Option<(Vec<u8>, &'static str)> {
    if game["source"] == "steam" {
        return None;
    }
    let mut roots = Vec::new();
    for root in [
        game["install_path"].as_str().map(PathBuf::from),
        game["executable"]
            .as_str()
            .and_then(|exe| Path::new(exe).parent().map(Path::to_path_buf)),
    ]
    .into_iter()
    .flatten()
    {
        if root.is_absolute()
            && root.as_os_str().len() <= 4096
            && !roots.contains(&root)
            && roots.len() < 2
        {
            roots.push(root);
        }
    }
    let game_key = key(field(game, "name"));
    let exe_key = game["executable"]
        .as_str()
        .and_then(|v| Path::new(v).file_stem())
        .map(|v| key(&v.to_string_lossy()))
        .unwrap_or_default();
    let mut candidates = Vec::new();
    for root in roots {
        for (subdir, penalty) in [("", 0), ("artwork", 2), ("art", 3), ("images", 4)] {
            let dir = root.join(subdir);
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            let mut count = 0;
            let mut found = Vec::new();
            for entry in entries {
                count += 1;
                if count > 500 {
                    break;
                }
                let Ok(entry) = entry else { continue };
                if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    continue;
                }
                let path = entry.path();
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
                    continue;
                }
                let stem = key(path.file_stem().and_then(|s| s.to_str()).unwrap_or(""));
                let score = match stem.as_str() {
                    "cover" => 100,
                    "poster" => 99,
                    "boxart" => 98,
                    "keyart" => 97,
                    "library600x900" => 95,
                    "verticalcover" => 94,
                    "folder" => 90,
                    "artwork" => 85,
                    "capsule" => 75,
                    _ => {
                        if [game_key.as_str(), exe_key.as_str()]
                            .iter()
                            .filter(|v| !v.is_empty())
                            .any(|v| {
                                stem == *v
                                    || stem == format!("{v}cover")
                                    || stem == format!("{v}poster")
                                    || stem == format!("{v}boxart")
                            })
                        {
                            82
                        } else {
                            0
                        }
                    }
                };
                if score > penalty {
                    found.push((path, score - penalty));
                }
            }
            // A huge unrelated assets directory must not cause unbounded work.
            if count <= 500 {
                candidates.extend(found);
            }
        }
    }
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for (path, _) in candidates.into_iter().take(16) {
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.file_type().is_file() || !(24..=IMAGE_LIMIT as u64).contains(&metadata.len()) {
            continue;
        }
        if let Ok(Some(bytes)) = read_capped(&path, IMAGE_LIMIT) {
            if portrait_image(&bytes) {
                if let Some(ext) = image_ext(&bytes) {
                    return Some((bytes, ext));
                }
            }
        }
    }
    None
}

fn valid_epic_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn decode_percent(value: &str) -> Option<String> {
    if value.len() > 512 {
        return None;
    }
    let bytes = value.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = bytes.get(i + 1)?.to_ascii_lowercase();
            let lo = bytes.get(i + 2)?.to_ascii_lowercase();
            let hex = |n: u8| match n {
                b'0'..=b'9' => Some(n - b'0'),
                b'a'..=b'f' => Some(n - b'a' + 10),
                _ => None,
            };
            result.push((hex(hi)? << 4) | hex(lo)?);
            i += 3;
        } else {
            result.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(result).ok()
}

fn epic_identity(game: &Value) -> Option<(String, String)> {
    if game["source"] != "epic" {
        return None;
    }
    let uri = Url::parse(field(game, "launch_uri")).ok()?;
    if uri.scheme() != "com.epicgames.launcher" || uri.host_str() != Some("apps") {
        return None;
    }
    let id = decode_percent(uri.path().trim_start_matches('/'))?;
    let parts = id.split(':').collect::<Vec<_>>();
    if parts.len() != 3
        || parts[2] != field(game, "source_id")
        || !parts.iter().all(|part| valid_epic_id(part))
    {
        return None;
    }
    Some((parts[0].to_string(), parts[1].to_string()))
}

fn epic_image_urls(images: &Value) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    if let Some(images) = images.as_array() {
        for item in images.iter().take(30) {
            if !matches!(
                field(item, "type"),
                "DieselGameBoxTall" | "OfferImageTall" | "Thumbnail"
            ) {
                continue;
            }
            let url = field(item, "url");
            let epic_cdn = Url::parse(url).ok().is_some_and(|url| {
                matches!(
                    url.host_str(),
                    Some("cdn1.epicgames.com" | "cdn2.epicgames.com" | "cdn2.unrealengine.com")
                )
            });
            if epic_cdn && approved_url(url) && seen.insert(url.to_string()) {
                result.push(url.to_string());
            }
        }
    }
    result
}

fn epic_exact_search_images(response: &Value, title: &str) -> Vec<String> {
    let matches = response
        .pointer("/data/Catalog/searchStore/elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(20)
        .filter(|item| key(field(item, "title")) == key(title))
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return vec![];
    }
    epic_image_urls(&matches[0]["keyImages"])
}

fn epic_graphql_url(host: &str, query: &str, variables: &Value) -> Result<String, String> {
    let mut url = Url::parse(&format!("https://{host}/graphql")).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("query", query)
        .append_pair("variables", &variables.to_string());
    Ok(url.to_string())
}

fn epic_request_budget(
    remaining: &mut usize,
    allowed: &dyn Fn() -> bool,
    deadline: Option<Instant>,
) -> Result<bool, String> {
    require_online(allowed)?;
    if deadline.is_some_and(|end| Instant::now() >= end) || *remaining == 0 {
        return Ok(false);
    }
    *remaining -= 1;
    Ok(true)
}

fn epic_json(
    http: &Client,
    url: &str,
    remaining: &mut usize,
    allowed: &dyn Fn() -> bool,
    deadline: Option<Instant>,
) -> Result<Option<Value>, String> {
    if !epic_request_budget(remaining, allowed, deadline)? {
        return Ok(None);
    }
    json_request(http, url, JSON_LIMIT, allowed)
}

fn epic_image(
    http: &Client,
    url: &str,
    remaining: &mut usize,
    allowed: &dyn Fn() -> bool,
    deadline: Option<Instant>,
) -> Result<Option<(Vec<u8>, &'static str)>, String> {
    if !epic_request_budget(remaining, allowed, deadline)? || !approved_url(url) {
        return Ok(None);
    }
    require_online(allowed)?;
    let response = http.get(url).send().map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let media = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let expected = if media.starts_with("image/png") {
        "png"
    } else if media.starts_with("image/jpeg") {
        "jpg"
    } else {
        return Ok(None);
    };
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|len| len > IMAGE_LIMIT)
    {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    response
        .take((IMAGE_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() <= IMAGE_LIMIT && image_ext(&bytes) == Some(expected) && portrait_image(&bytes) {
        Ok(Some((bytes, expected)))
    } else {
        Ok(None)
    }
}

fn epic_portrait(
    http: &Client,
    game: &Value,
    allowed: &dyn Fn() -> bool,
    deadline: Option<Instant>,
) -> Result<Option<(Vec<u8>, &'static str)>, String> {
    let mut remaining = EPIC_REQUEST_LIMIT;
    let title = field(game, "name").trim();
    let mut image_urls = Vec::new();
    if let Some((namespace, id)) = epic_identity(game) {
        let query = r#"query OrbitItem($namespace:String!,$id:String!){Catalog{catalogItem(namespace:$namespace,id:$id,locale:"en-US"){id namespace keyImages{type url}}}}"#;
        let url = epic_graphql_url(
            "www.epicgames.com",
            query,
            &json!({"namespace":namespace,"id":id}),
        )?;
        if let Ok(Some(data)) = epic_json(http, &url, &mut remaining, allowed, deadline) {
            let item = &data["data"]["Catalog"]["catalogItem"];
            if field(item, "id") == id && field(item, "namespace") == namespace {
                image_urls.extend(epic_image_urls(&item["keyImages"]));
            }
        }
    }
    // An exact title is required: no fuzzy search/first-result guessing.
    if valid_title(title) {
        let query = r#"query OrbitSearch($keywords:String!){Catalog{searchStore(keywords:$keywords,country:"US",locale:"en-US",count:20,start:0){elements{title id namespace keyImages{type url}}}}}"#;
        let url = epic_graphql_url("store.epicgames.com", query, &json!({"keywords":title}))?;
        if let Ok(Some(data)) = epic_json(http, &url, &mut remaining, allowed, deadline) {
            image_urls.extend(epic_exact_search_images(&data, title));
        }
    }
    // Official Epic asset for Fortnite when the keyless catalog is unavailable.
    // Never infer Fortnite from a misleading source_id or similar title.
    if game["source"] == "epic" && key(title) == "fortnite" {
        image_urls.push(FORTNITE_PORTRAIT.to_string());
    }
    let mut seen = HashSet::new();
    for url in image_urls
        .into_iter()
        .filter(|url| seen.insert(url.clone()))
        .take(EPIC_IMAGES_LIMIT)
    {
        match epic_image(http, &url, &mut remaining, allowed, deadline) {
            Ok(Some(image)) if allowed() => return Ok(Some(image)),
            Ok(_) | Err(_) => {}
        }
    }
    Ok(None)
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

/// Lookup a manually entered title through exact Steam and Epic store matches.
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
    if let Ok(Some((name, id))) = exact_app(&http, title, allowed) {
        if let Ok(Some(bytes)) = online_cover_with_deadline(&http, &id, None, allowed) {
            require_online(allowed)?;
            let cover = store(&bytes, "jpg", artwork_dir)?;
            return Ok(json!({"cover":cover,"matchedName":name,"message":"Cover found on Steam."}));
        }
    }
    require_online(allowed)?;
    let lookup = json!({"source":"epic","name":title});
    if let Some((bytes, ext)) = epic_portrait(&http, &lookup, allowed, None)? {
        require_online(allowed)?;
        let cover = store(&bytes, ext, artwork_dir)?;
        return Ok(
            json!({"cover":cover,"matchedName":title,"message":"Cover found on Epic Games."}),
        );
    }
    // Rocket League was delisted from the Steam storefront, so its old app
    // ID is used only for this one exact, verified title as a final fallback.
    if key(title) == "rocketleague" {
        if let Ok(Some(bytes)) = online_cover_with_deadline(&http, "252950", None, allowed) {
            require_online(allowed)?;
            let cover = store(&bytes, "jpg", artwork_dir)?;
            return Ok(
                json!({"cover":cover,"matchedName":"Rocket League","message":"Cover found on Steam."}),
            );
        }
    }
    require_online(allowed)?;
    Ok(json!({"cover":"",
        "message":"No exact portrait cover found on Steam or Epic Games. Check the title or choose an image manually."}))
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

// Automatic background enrichment is deliberately conservative: a user-chosen
// cover is not an invitation to replace its orientation or appearance.
// Manual "Repair Library Covers" retains the legacy landscape replacement.
fn needs_auto_cover(game: &Value, dir: &Path) -> bool {
    let cover = game["cover"].as_str().unwrap_or("");
    cover.is_empty() || (artwork_token(cover) && !dir.join(cover).is_file())
}

/// Default repair uses local Steam and adjacent installed-game artwork only;
/// never performs HTTP.
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
    repair_artwork_impl(games, artwork_dir, online_enabled, paused, allowed, false)
}

/// Conservative background scan. Never replaces an existing readable cover,
/// including a landscape JPEG selected by the user; missing/missing-file
/// covers are still repaired. Shared request and privacy limits are unchanged.
///
/// Use this instead of repair_artwork_guarded for automatic startup/import
/// scans. Keep repair_artwork_guarded for explicit user-triggered repair.
pub fn repair_artwork_auto_guarded(
    games: &[Value],
    artwork_dir: &Path,
    online_enabled: bool,
    paused: bool,
    allowed: &dyn Fn() -> bool,
) -> Result<Value, String> {
    repair_artwork_impl(games, artwork_dir, online_enabled, paused, allowed, true)
}

fn repair_artwork_impl(
    games: &[Value],
    artwork_dir: &Path,
    online_enabled: bool,
    paused: bool,
    allowed: &dyn Fn() -> bool,
    automatic: bool,
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
        let need_cover = if automatic {
            needs_auto_cover(game, artwork_dir)
        } else {
            needs_cover(game, artwork_dir)
        };
        let need_icon = game["icon"].as_str().unwrap_or("").is_empty();
        if !need_cover && !need_icon {
            continue;
        }
        let steam_id = game["source_id"]
            .as_str()
            .filter(|_| game["source"] == "steam")
            .filter(|id| valid_id(id));
        let local = if need_cover && steam_id.is_none() {
            local_nonsteam_portrait(game)
        } else {
            None
        };
        if steam_id.is_none() && local.is_none() && (!need_cover || http.is_none()) {
            continue;
        }
        attempted += 1;
        let install = game["install_path"].as_str();
        let mut patch = serde_json::Map::new();
        patch.insert("id".into(), json!(id));
        if need_cover {
            let mut selected = local.or_else(|| {
                steam_id
                    .and_then(|s| local_cover(s, install))
                    .map(|bytes| (bytes, "jpg"))
            });
            if selected.is_none()
                && http.is_some()
                && online_count < ONLINE_LIMIT
                && started.elapsed() < REPAIR_TIME
                && allowed()
            {
                online_count += 1;
                let http = http.as_ref().unwrap();
                let deadline = Some(started + REPAIR_TIME);
                let result: Result<Option<(Vec<u8>, &'static str)>, String> =
                    if let Some(steam_id) = steam_id {
                        online_cover_with_deadline(http, steam_id, deadline, allowed)
                            .map(|bytes| bytes.map(|bytes| (bytes, "jpg")))
                    } else if game["source"] == "epic" {
                        // Manifest/catalog identity first, then unique exact-title
                        // Epic search. A Rocket League Steam fallback is permitted
                        // only with its precise title, never a vague substring.
                        match epic_portrait(http, game, allowed, deadline) {
                            Ok(Some(image)) => Ok(Some(image)),
                            Ok(None) if key(field(game, "name")) == "rocketleague" => {
                                online_cover_with_deadline(http, "252950", deadline, allowed)
                                    .map(|bytes| bytes.map(|bytes| (bytes, "jpg")))
                            }
                            other => other,
                        }
                    } else {
                        match exact_app(http, game["name"].as_str().unwrap_or(""), allowed) {
                            Ok(Some((_, steam_id))) => {
                                online_cover_with_deadline(http, &steam_id, deadline, allowed)
                                    .map(|bytes| bytes.map(|bytes| (bytes, "jpg")))
                            }
                            Ok(None) => Ok(None),
                            Err(e) => Err(e),
                        }
                    };
                match result {
                    Ok(result) if allowed() => selected = result,
                    Ok(_) => (),
                    Err(e) => {
                        if failures.len() < 10 {
                            failures.push(format!("{id}: {e}"))
                        }
                    }
                }
            }
            if let Some((bytes, ext)) = selected {
                match store(&bytes, ext, artwork_dir) {
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
    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
        bytes.extend_from_slice(&w.to_be_bytes());
        bytes.extend_from_slice(&h.to_be_bytes());
        bytes.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }
    fn webp(w: u32, h: u32) -> Vec<u8> {
        let mut bytes = vec![0_u8; 30];
        bytes[..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"WEBP");
        bytes[12..16].copy_from_slice(b"VP8X");
        bytes[24..27].copy_from_slice(&(w - 1).to_le_bytes()[..3]);
        bytes[27..30].copy_from_slice(&(h - 1).to_le_bytes()[..3]);
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

    #[test]
    fn background_scan_preserves_user_landscape_jpeg_without_network_requests() {
        let root =
            std::env::temp_dir().join(format!("orbit-auto-preserve-{}", uuid::Uuid::new_v4()));
        let install = root.join("SteamLibrary/steamapps/common/Example");
        let cache = root.join("SteamLibrary/appcache/librarycache");
        let artwork = root.join("artwork");
        fs::create_dir_all(&install).unwrap();
        fs::create_dir_all(&cache).unwrap();
        let chosen_bytes = jpeg(900, 600);
        let chosen = store(&chosen_bytes, "jpg", &artwork).unwrap();
        fs::write(cache.join("730_library_600x900.jpg"), jpeg(600, 900)).unwrap();
        let game = json!({"id":"11111111-1111-4111-8111-111111111111",
            "source":"steam","source_id":"730","name":"Example","install_path":install,
            "cover":chosen,"icon":"already-selected-icon"});
        // An enabled online setting must not cause any permission checks or
        // network activity for a game with an existing valid cover and icon.
        let auto = repair_artwork_auto_guarded(&[game.clone()], &artwork, true, false, &|| {
            panic!("A complete game must never request online permission")
        })
        .unwrap();
        assert_eq!(auto["attempted"], 0);
        assert_eq!(auto["updates"], json!([]));
        assert_eq!(fs::read(artwork.join(&chosen)).unwrap(), chosen_bytes);

        // User-initiated repair keeps the old replace-landscape behavior.
        let manual = repair_artwork_guarded(&[game], &artwork, false, false, &|| false).unwrap();
        assert_eq!(manual["found"], 1);
        assert_ne!(manual["updates"][0]["cover"], chosen);
        assert_eq!(fs::read(artwork.join(&chosen)).unwrap(), chosen_bytes);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn background_scan_repairs_only_missing_cover_without_touching_existing_one() {
        let root =
            std::env::temp_dir().join(format!("orbit-auto-missing-{}", uuid::Uuid::new_v4()));
        let install = root.join("Installed Game");
        let artwork = root.join("artwork");
        fs::create_dir_all(&install).unwrap();
        fs::write(install.join("poster.png"), png(600, 900)).unwrap();
        let missing = "11111111-1111-4111-8111-111111111111.jpg";
        let game = json!({"id":"22222222-2222-4222-8222-222222222222",
            "source":"manual","name":"Installed Game","install_path":install,
            "cover":missing,"icon":""});
        let result = repair_artwork_auto_guarded(&[game], &artwork, false, false, &|| {
            panic!("Offline enrichment must not check network permission")
        })
        .unwrap();
        assert_eq!(result["attempted"], 1);
        assert_eq!(result["found"], 1);
        assert!(artwork_token(
            result["updates"][0]["cover"].as_str().unwrap()
        ));
        assert_ne!(result["updates"][0]["cover"], missing);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn background_icon_only_scan_never_downloads_a_new_cover() {
        let root =
            std::env::temp_dir().join(format!("orbit-auto-icon-only-{}", uuid::Uuid::new_v4()));
        let install = root.join("SteamLibrary/steamapps/common/Example");
        let artwork = root.join("artwork");
        fs::create_dir_all(&install).unwrap();
        let chosen = store(&jpeg(900, 600), "jpg", &artwork).unwrap();
        let game = json!({"id":"33333333-3333-4333-8333-333333333333",
            "source":"steam","source_id":"730","name":"Example",
            "install_path":install,"cover":chosen,"icon":""});
        let result = repair_artwork_auto_guarded(&[game], &artwork, true, false, &|| {
            panic!("Searching a missing local icon must never request a replacement cover")
        })
        .unwrap();
        assert_eq!(result["found"], 0);
        assert_eq!(result["updates"], json!([]));
        assert_eq!(fs::read(artwork.join(&chosen)).unwrap(), jpeg(900, 600));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn offline_manual_and_epic_repair_find_local_portraits_without_network() {
        let root =
            std::env::temp_dir().join(format!("orbit-local-nonsteam-{}", uuid::Uuid::new_v4()));
        let install = root.join("Parcel Simulator");
        let art = install.join("artwork");
        fs::create_dir_all(&art).unwrap();
        fs::write(install.join("cover.jpg"), jpeg(900, 600)).unwrap();
        fs::write(art.join("poster.png"), png(600, 900)).unwrap();
        let games = vec![
            json!({"id":"11111111-1111-4111-8111-111111111111",
                "source":"manual","name":"Parcel Simulator",
                "executable":install.join("parcel.exe"),"cover":"","icon":""}),
            json!({"id":"22222222-2222-4222-8222-222222222222",
                "source":"epic","name":"Rocket League",
                "install_path":install,"cover":"","icon":""}),
        ];
        let output = root.join("orbit-artwork");
        let result = repair_artwork_guarded(&games, &output, false, false, &|| {
            panic!("Offline local artwork lookup must never check network permission")
        })
        .unwrap();
        assert_eq!(result["onlineEnabled"], false);
        assert_eq!(result["found"], 2);
        assert_eq!(result["attempted"], 2);
        for patch in result["updates"].as_array().unwrap() {
            let token = patch["cover"].as_str().unwrap();
            assert!(artwork_token(token));
            assert_eq!(fs::read(output.join(token)).unwrap(), png(600, 900));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn offline_local_art_rejects_landscape_and_unrelated_filenames() {
        let root =
            std::env::temp_dir().join(format!("orbit-local-filter-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("cover.jpg"), jpeg(900, 600)).unwrap();
        fs::write(root.join("random.png"), png(600, 900)).unwrap();
        let game = json!({"source":"manual","name":"Unrelated Game","install_path":root});
        assert!(local_nonsteam_portrait(&game).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_webp_portrait_is_recognized_without_network() {
        let root = std::env::temp_dir().join(format!("orbit-local-webp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bytes = webp(600, 900);
        fs::write(root.join("folder.webp"), &bytes).unwrap();
        assert_eq!(image_ext(&bytes), Some("webp"));
        assert_eq!(
            local_nonsteam_portrait(
                &json!({"source":"manual","install_path":root,"name":"WebP Game"})
            ),
            Some((bytes, "webp"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn epic_identity_only_accepts_valid_manifest_catalog_triplet() {
        let mut game = json!({"source":"epic","source_id":"Fortnite",
            "launch_uri":"com.epicgames.launcher://apps/fn%3Aabcd_12%3AFortnite?action=launch"});
        assert_eq!(
            epic_identity(&game),
            Some(("fn".to_string(), "abcd_12".to_string()))
        );
        game["source_id"] = json!("RocketLeague");
        assert!(epic_identity(&game).is_none());
        game["source_id"] = json!("Fortnite");
        game["launch_uri"] = json!("https://evil.example/apps/fn%3Aabcd_12%3AFortnite");
        assert!(epic_identity(&game).is_none());
        game["launch_uri"] = json!("com.epicgames.launcher://apps/fn%2Fbad%3Aabcd_12%3AFortnite");
        assert!(epic_identity(&game).is_none());
    }

    #[test]
    fn epic_exact_match_does_not_select_soundtracks_or_ambiguous_results() {
        let results = json!({"data":{"Catalog":{"searchStore":{"elements":[
            {"title":"Rocket League Soundtrack","keyImages":[{"type":"OfferImageTall","url":"https://cdn1.epicgames.com/unrelated.jpg"}]},
            {"title":"Rocket League®","keyImages":[
                {"type":"DieselGameBoxTall","url":"https://evil.example/forged.jpg"},
                {"type":"OfferImageTall","url":"https://cdn1.epicgames.com/rocket/cover.jpg"},
                {"type":"OfferImageTall","url":"https://cdn1.epicgames.com/rocket/cover.jpg"}]}
        ]}}}});
        assert_eq!(
            epic_exact_search_images(&results, "Rocket League"),
            vec!["https://cdn1.epicgames.com/rocket/cover.jpg"]
        );
        assert!(epic_exact_search_images(&results, "Rocket League 2").is_empty());
        let duplicated = json!({"data":{"Catalog":{"searchStore":{"elements":[
            {"title":"Fortnite","keyImages":[]},
            {"title":"Fortnite®","keyImages":[]}
        ]}}}});
        assert!(epic_exact_search_images(&duplicated, "Fortnite").is_empty());
        assert!(!approved_url(
            "https://cdn1.epicgames.com.evil.example/art.png"
        ));
        assert!(!approved_url("http://cdn1.epicgames.com/art.png"));
        assert!(approved_url(FORTNITE_PORTRAIT));
    }

    #[test]
    fn epic_request_budget_checks_live_opt_out_without_network() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let enabled = AtomicBool::new(true);
        let allowed = || enabled.load(Ordering::SeqCst);
        let mut remaining = EPIC_REQUEST_LIMIT;
        assert!(epic_request_budget(&mut remaining, &allowed, None).unwrap());
        assert_eq!(remaining, EPIC_REQUEST_LIMIT - 1);
        enabled.store(false, Ordering::SeqCst);
        assert!(epic_request_budget(&mut remaining, &allowed, None).is_err());
        assert_eq!(remaining, EPIC_REQUEST_LIMIT - 1);
        enabled.store(true, Ordering::SeqCst);
        assert!(!epic_request_budget(&mut remaining, &allowed, Some(Instant::now())).unwrap());
        assert_eq!(remaining, EPIC_REQUEST_LIMIT - 1);
    }
}

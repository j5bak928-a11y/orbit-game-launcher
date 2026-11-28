//! Native local/store artwork. The caller must gate every network-enabled
//! entry point with the useSteamArtwork setting and Performance Guard state.
use crate::native;
use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;
use url::Url;

const IMAGE_LIMIT: usize = 5 * 1024 * 1024;
const MAX_USER_IMAGE: usize = 15 * 1024 * 1024;
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
const BANNER_ASSETS: [&str; 4] = [
    "library_hero.jpg",
    "library_hero_2x.jpg",
    "header_2x.jpg",
    "header.jpg",
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
    (3..=140).contains(&s.chars().count()) && !s.chars().any(char::is_control) && key(s).len() >= 3
}

fn is_version_token(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix('v') else {
        return false;
    };
    let rest = rest.strip_prefix('.').unwrap_or(rest);
    rest.as_bytes().first().is_some_and(u8::is_ascii_digit)
        && rest.contains('.')
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn is_packaging_tag(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    if is_version_token(&lower) {
        return true;
    }
    if let Some(rest) = lower.strip_prefix("build") {
        let rest = rest.trim_start_matches([' ', '.', '-', '_']);
        if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) {
            return true;
        }
    }
    matches!(
        lower.as_str(),
        "pc" | "portable"
            | "repack"
            | "early access"
            | "early-access"
            | "early_access"
            | "win64"
            | "win32"
            | "x64"
            | "x86"
            | "64-bit"
            | "64bit"
            | "32-bit"
            | "32bit"
            | "online-fix"
            | "online fix"
    )
}

fn strip_title_noise(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    loop {
        let trimmed = text.trim_end_matches([' ', '-', '_']);
        let mut next = None;
        for (open, close) in [('(', ')'), ('[', ']')] {
            if let Some(inner_end) = trimmed.strip_suffix(close) {
                if let Some(open_idx) = inner_end.rfind(open) {
                    let inner = &inner_end[open_idx + 1..];
                    if is_packaging_tag(inner) {
                        let prefix = inner_end[..open_idx].trim_end_matches([' ', '-', '_', '.']);
                        if prefix.chars().count() >= 3 {
                            next = Some(prefix.to_string());
                            break;
                        }
                    }
                }
            }
        }
        if next.is_none() {
            if let Some(idx) = trimmed.rfind([' ', '-', '_']) {
                let tail = &trimmed[idx + 1..];
                let prefix = trimmed[..idx].trim_end_matches([' ', '-', '_', '.']);
                if prefix.chars().count() >= 3 && is_version_token(tail) {
                    next = Some(prefix.to_string());
                } else if prefix.chars().count() >= 3
                    && !tail.is_empty()
                    && tail.bytes().all(|b| b.is_ascii_digit())
                {
                    if let Some(build_sep) = prefix.rfind([' ', '-', '_']) {
                        if prefix[build_sep + 1..].eq_ignore_ascii_case("build") {
                            let before = prefix[..build_sep].trim_end_matches([' ', '-', '_', '.']);
                            if before.chars().count() >= 3 {
                                next = Some(before.to_string());
                            }
                        }
                    }
                }
            }
        }
        match next {
            Some(candidate) if candidate.len() < text.len() => text = candidate,
            _ => break,
        }
    }
    text
}

fn collapse_dotted_acronyms(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let prev_alnum = i > 0 && chars[i - 1].is_ascii_alphanumeric();
        if !prev_alnum
            && chars[i].is_ascii_alphabetic()
            && i + 2 < chars.len()
            && chars[i + 1] == '.'
            && chars[i + 2].is_ascii_alphabetic()
        {
            let mut j = i;
            let mut letters = Vec::new();
            while j < chars.len() && chars[j].is_ascii_alphabetic() {
                let next_is_dot = j + 1 < chars.len() && chars[j + 1] == '.';
                let after_dot_is_letter = j + 2 < chars.len() && chars[j + 2].is_ascii_alphabetic();
                let next_is_alnum = j + 1 < chars.len() && chars[j + 1].is_ascii_alphanumeric();
                if next_is_alnum {
                    letters.clear();
                    break;
                }
                letters.push(chars[j]);
                if next_is_dot {
                    j += 2;
                    if !after_dot_is_letter {
                        break;
                    }
                } else {
                    j += 1;
                    break;
                }
            }
            if letters.len() >= 2 {
                for ch in letters {
                    out.push(ch);
                }
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn split_alnum_segment(segment: &str) -> Vec<String> {
    let chars: Vec<char> = segment.chars().collect();
    let mut parts = Vec::new();
    let mut start = 0;
    for i in 1..chars.len() {
        if chars[i - 1].is_ascii_lowercase() && chars[i].is_ascii_uppercase() {
            parts.push(chars[start..i].iter().collect::<String>());
            start = i;
        }
    }
    if start < chars.len() {
        parts.push(chars[start..].iter().collect::<String>());
    }
    let mut out = Vec::new();
    for part in parts {
        let split_at = part.find(|c: char| c.is_ascii_digit());
        if let Some(idx) = split_at {
            let (prefix, suffix) = part.split_at(idx);
            if prefix.len() >= 3
                && prefix.bytes().all(|b| b.is_ascii_alphabetic())
                && !suffix.is_empty()
                && suffix.bytes().all(|b| b.is_ascii_digit())
            {
                if let Ok(num) = suffix.parse::<u32>() {
                    if (1..=20).contains(&num) || (1970..=2099).contains(&num) {
                        out.push(prefix.to_ascii_lowercase());
                        out.push(suffix.to_string());
                        continue;
                    }
                }
            }
        }
        out.push(part.to_ascii_lowercase());
    }
    out
}

fn tokenize_title(s: &str) -> Vec<String> {
    let collapsed = collapse_dotted_acronyms(s);
    let cleaned: String = collapsed
        .chars()
        .filter(|c| !matches!(c, '™' | '℠' | '®' | '©' | '\'' | '’' | '`'))
        .collect();
    let normalized: String = cleaned.nfkd().collect();
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch);
        } else {
            if !current.is_empty() {
                tokens.extend(split_alnum_segment(&current));
                current.clear();
            }
            if ch == '&' {
                tokens.push("and".to_string());
            }
        }
    }
    if !current.is_empty() {
        tokens.extend(split_alnum_segment(&current));
    }
    tokens
}

fn roman_to_arabic(token: &str) -> Option<&'static str> {
    match token {
        "i" => Some("1"),
        "ii" => Some("2"),
        "iii" => Some("3"),
        "iv" => Some("4"),
        "v" => Some("5"),
        "vi" => Some("6"),
        "vii" => Some("7"),
        "viii" => Some("8"),
        "ix" => Some("9"),
        "x" => Some("10"),
        "xi" => Some("11"),
        "xii" => Some("12"),
        "xiii" => Some("13"),
        "xiv" => Some("14"),
        "xv" => Some("15"),
        "xvi" => Some("16"),
        "xvii" => Some("17"),
        "xviii" => Some("18"),
        "xix" => Some("19"),
        "xx" => Some("20"),
        _ => None,
    }
}

fn arabic_to_roman(token: &str) -> Option<&'static str> {
    match token {
        "1" => Some("I"),
        "2" => Some("II"),
        "3" => Some("III"),
        "4" => Some("IV"),
        "5" => Some("V"),
        "6" => Some("VI"),
        "7" => Some("VII"),
        "8" => Some("VIII"),
        "9" => Some("IX"),
        "10" => Some("X"),
        "11" => Some("XI"),
        "12" => Some("XII"),
        "13" => Some("XIII"),
        "14" => Some("XIV"),
        "15" => Some("XV"),
        "16" => Some("XVI"),
        "17" => Some("XVII"),
        "18" => Some("XVIII"),
        "19" => Some("XIX"),
        "20" => Some("XX"),
        _ => None,
    }
}

fn canonical_tokens(s: &str) -> Vec<String> {
    let mut tokens = tokenize_title(s);
    if tokens.len() > 1 && tokens[0] == "the" {
        tokens.remove(0);
    }
    for (idx, tok) in tokens.iter_mut().enumerate() {
        // Keep leading single-letter pronouns/brand prefixes ("I Am Bread",
        // "V Rising", "X-COM") intact while normalizing sequel numerals.
        if idx > 0 {
            if let Some(num) = roman_to_arabic(tok) {
                *tok = num.to_string();
            }
        }
    }
    tokens
}

fn canonical_key(s: &str) -> String {
    canonical_tokens(s).concat()
}

fn is_non_base_item(candidate_tokens: &[String], query_tokens: &[String]) -> bool {
    const SINGLE_BANNED: &[&str] = &[
        "soundtrack",
        "soundtracks",
        "ost",
        "artbook",
        "demo",
        "prologue",
        "trial",
        "playtest",
        "beta",
        "sdk",
        "toolkit",
        "dlc",
        "addon",
        "addons",
        "upgrade",
        "pack",
        "bundle",
        "vr",
        "benchmark",
        "wallpaper",
        "cosmetic",
        "cosmetics",
        "skin",
        "skins",
        "pass",
        "points",
        "coins",
        "credits",
        "currency",
        "expansion",
        "server",
        "dedicated",
    ];
    for banned in SINGLE_BANNED {
        if candidate_tokens.iter().any(|t| t == banned) && !query_tokens.iter().any(|t| t == banned)
        {
            return true;
        }
    }
    const PHRASE_BANNED: &[(&str, &str)] = &[
        ("free", "sample"),
        ("art", "book"),
        ("mod", "tools"),
        ("songs", "of"),
        ("persona", "set"),
        ("costume", "set"),
        ("starter", "edition"),
    ];
    let has_pair =
        |tokens: &[String], a: &str, b: &str| tokens.windows(2).any(|w| w[0] == a && w[1] == b);
    for (a, b) in PHRASE_BANNED {
        if has_pair(candidate_tokens, a, b) && !has_pair(query_tokens, a, b) {
            return true;
        }
    }
    false
}

fn strip_parenthesized_year(s: &str) -> String {
    let trimmed = s.trim_end();
    if let Some(inner_end) = trimmed.strip_suffix(')') {
        if let Some(open_idx) = inner_end.rfind('(') {
            let year = inner_end[open_idx + 1..].trim();
            if year.len() == 4
                && year.bytes().all(|b| b.is_ascii_digit())
                && year
                    .parse::<u32>()
                    .is_ok_and(|y| (1970..=2035).contains(&y))
            {
                let prefix = inner_end[..open_idx].trim_end();
                if prefix.chars().count() >= 3 {
                    return prefix.to_string();
                }
            }
        }
    }
    s.to_string()
}

fn base_edition_key(s: &str) -> String {
    let without_year = strip_parenthesized_year(s);
    let mut tokens = canonical_tokens(&without_year);
    const CREATOR_PREFIXES: &[&[&str]] = &[
        &["sid", "meiers"],
        &["tom", "clancys"],
        &["clive", "barkers"],
        &["american", "mcgees"],
    ];
    for prefix in CREATOR_PREFIXES {
        if tokens.len() > prefix.len()
            && tokens
                .iter()
                .zip(prefix.iter())
                .all(|(t, p)| t.as_str() == *p)
        {
            tokens.drain(..prefix.len());
            break;
        }
    }
    const EDITION_SUFFIXES: &[&[&str]] = &[
        &["game", "of", "the", "year", "edition"],
        &["game", "of", "the", "year"],
        &["the", "complete", "edition"],
        &["enhanced", "edition"],
        &["special", "edition"],
        &["definitive", "edition"],
        &["complete", "edition"],
        &["ultimate", "edition"],
        &["deluxe", "edition"],
        &["anniversary", "edition"],
        &["standard", "edition"],
        &["goty", "edition"],
        &["directors", "cut"],
        &["hd", "remastered"],
        &["hd", "remaster"],
        &["remastered", "edition"],
        &["legacy", "edition"],
        &["remastered"],
        &["remaster"],
        &["enhanced"],
        &["definitive"],
        &["goty"],
        &["hd"],
    ];
    loop {
        let mut stripped = false;
        for suffix in EDITION_SUFFIXES {
            if tokens.len() > suffix.len() {
                let start = tokens.len() - suffix.len();
                if tokens[start..]
                    .iter()
                    .zip(suffix.iter())
                    .all(|(t, s)| t.as_str() == *s)
                {
                    tokens.truncate(start);
                    stripped = true;
                    break;
                }
            }
        }
        if !stripped {
            break;
        }
    }
    tokens.concat()
}

fn spaced_title(s: &str) -> String {
    let raw = s.replace('_', " ");
    let mut words = Vec::new();
    for word in raw.split_whitespace() {
        let chars: Vec<char> = word.chars().collect();
        let mut parts = Vec::new();
        let mut start = 0;
        for i in 1..chars.len() {
            if chars[i - 1].is_ascii_lowercase() && chars[i].is_ascii_uppercase() {
                parts.push(chars[start..i].iter().collect::<String>());
                start = i;
            }
        }
        if start < chars.len() {
            parts.push(chars[start..].iter().collect::<String>());
        }
        for part in parts {
            if let Some(idx) = part.find(|c: char| c.is_ascii_digit()) {
                let (prefix, suffix) = part.split_at(idx);
                if prefix.len() >= 3
                    && prefix.bytes().all(|b| b.is_ascii_alphabetic())
                    && !suffix.is_empty()
                    && suffix.bytes().all(|b| b.is_ascii_digit())
                    && suffix
                        .parse::<u32>()
                        .is_ok_and(|n| (1..=20).contains(&n) || (1970..=2099).contains(&n))
                {
                    words.push(prefix.to_string());
                    words.push(suffix.to_string());
                    continue;
                }
            }
            words.push(part);
        }
    }
    words.join(" ")
}

fn swap_numeral_query(s: &str) -> Option<String> {
    let words: Vec<&str> = s.split_whitespace().collect();
    if words.len() < 2 {
        return None;
    }
    let mut to_roman = Vec::with_capacity(words.len());
    let mut changed_roman = false;
    for (idx, word) in words.iter().enumerate() {
        if idx > 0 {
            let trimmed = word.trim_end_matches([':', '-', ',']);
            let punct = &word[trimmed.len()..];
            if let Some(roman) = arabic_to_roman(trimmed) {
                to_roman.push(format!("{roman}{punct}"));
                changed_roman = true;
                continue;
            }
        }
        to_roman.push((*word).to_string());
    }
    if changed_roman {
        return Some(to_roman.join(" "));
    }
    let mut to_arabic = Vec::with_capacity(words.len());
    let mut changed_arabic = false;
    for (idx, word) in words.iter().enumerate() {
        if idx > 0 {
            let trimmed = word.trim_end_matches([':', '-', ',']);
            let punct = &word[trimmed.len()..];
            if let Some(arabic) = roman_to_arabic(&trimmed.to_ascii_lowercase()) {
                to_arabic.push(format!("{arabic}{punct}"));
                changed_arabic = true;
                continue;
            }
        }
        to_arabic.push((*word).to_string());
    }
    changed_arabic.then(|| to_arabic.join(" "))
}

fn search_variants(title: &str) -> Vec<String> {
    let cleaned = strip_title_noise(title);
    let spaced = spaced_title(&cleaned);
    let mut variants = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |candidate: String| {
        let trimmed = candidate.trim();
        if valid_title(trimmed) && variants.len() < 3 && seen.insert(trimmed.to_ascii_lowercase()) {
            variants.push(trimmed.to_string());
        }
    };
    if let Some(known) = native::known_game(&cleaned).or_else(|| native::known_game(title)) {
        push(known.to_string());
    }
    if !spaced.eq_ignore_ascii_case(&cleaned) {
        push(spaced.clone());
        if let Some(swapped) = swap_numeral_query(&spaced) {
            push(swapped);
        }
        push(cleaned);
    } else {
        push(cleaned.clone());
        if let Some(swapped) = swap_numeral_query(&cleaned) {
            push(swapped);
        }
    }
    variants
}

fn select_steam_match(items: &[Value], targets: &[String]) -> Option<(String, String)> {
    let apps: Vec<(&str, String)> = items
        .iter()
        .take(20)
        .filter_map(|item| {
            if item["type"] != "app" {
                return None;
            }
            let id = item["id"].as_u64()?.to_string();
            if !valid_id(&id) {
                return None;
            }
            let found = item["name"].as_str()?;
            Some((found, id))
        })
        .collect();
    // Pass 1: exact literal alphanumeric match (keeps e.g. "Mega Man 10" vs "Mega Man X").
    for target in targets {
        let target_key = key(target);
        if target_key.len() < 3 {
            continue;
        }
        if let Some((found, id)) = apps.iter().find(|(found, _)| key(found) == target_key) {
            return Some(((*found).to_owned(), id.clone()));
        }
    }
    // Pass 2: canonical Roman/Arabic, punctuation, "&"/"and", and leading-"The" match.
    for target in targets {
        let target_canonical = canonical_key(target);
        if target_canonical.len() < 3 {
            continue;
        }
        let query_tokens = tokenize_title(target);
        if let Some((found, id)) = apps.iter().find(|(found, _)| {
            canonical_key(found) == target_canonical
                && !is_non_base_item(&tokenize_title(found), &query_tokens)
        }) {
            return Some(((*found).to_owned(), id.clone()));
        }
    }
    // Pass 3: official edition/remaster suffix or creator-prefix fallback
    // (e.g. GTA V -> GTA V Enhanced, Witcher 3: Wild Hunt -> Remastered, Civ 6 -> Sid Meier's).
    for target in targets {
        let target_base = base_edition_key(target);
        if target_base.len() < 3 {
            continue;
        }
        let query_tokens = tokenize_title(target);
        let mut matched: Vec<(&str, &String)> = apps
            .iter()
            .filter(|(found, _)| {
                !is_non_base_item(&tokenize_title(found), &query_tokens)
                    && base_edition_key(found) == target_base
            })
            .map(|(found, id)| (*found, id))
            .collect();
        if !matched.is_empty() {
            matched.sort_by_key(|(found, _)| {
                let lower = found.to_ascii_lowercase();
                let secondary = lower.contains("deluxe")
                    || lower.contains("ultimate")
                    || lower.contains("legacy");
                (secondary, found.len())
            });
            let (found, id) = matched[0];
            return Some((found.to_owned(), id.clone()));
        }
    }
    None
}
fn client() -> Result<Client, String> {
    static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(4))
                .redirect(Policy::none())
                .user_agent(concat!("OrbitLauncher/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| e.to_string())
        })
        .clone()
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
    let variants = search_variants(name);
    if variants.is_empty() {
        return Ok(None);
    }
    let mut last_error = None;
    for query in &variants {
        let mut url = Url::parse("https://store.steampowered.com/api/storesearch/")
            .map_err(|e| e.to_string())?;
        url.query_pairs_mut()
            .append_pair("term", query)
            .append_pair("l", "english")
            .append_pair("cc", "US");
        let data = match json_request(http, url.as_str(), SEARCH_LIMIT, allowed) {
            Ok(Some(data)) => data,
            Ok(None) => continue,
            Err(e) => {
                last_error = Some(e);
                continue;
            }
        };
        let Some(items) = data["items"].as_array() else {
            continue;
        };
        if let Some(found) = select_steam_match(items, &variants) {
            return Ok(Some(found));
        }
    }
    if let Some(e) = last_error {
        return Err(e);
    }
    Ok(None)
}
fn hash_part(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn valid_steam_jpg_name(file: &str, prefixes: &[&str]) -> bool {
    if file.len() > 96 {
        return false;
    }
    let Some(stem) = file.strip_suffix(".jpg") else {
        return false;
    };
    !stem.is_empty()
        && stem
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && prefixes.iter().any(|prefix| stem.starts_with(prefix))
}
fn approved_cover_asset(name: &str) -> bool {
    let parts: Vec<&str> = name.split('/').collect();
    match parts.as_slice() {
        [file] => valid_steam_jpg_name(file, &["library_capsule", "library_600x900"]),
        [hash, file] => {
            hash_part(hash) && valid_steam_jpg_name(file, &["library_capsule", "library_600x900"])
        }
        _ => false,
    }
}
fn approved_banner_asset(name: &str) -> bool {
    let parts: Vec<&str> = name.split('/').collect();
    match parts.as_slice() {
        [file] => valid_steam_jpg_name(file, &["library_hero", "header"]),
        [hash, file] => hash_part(hash) && valid_steam_jpg_name(file, &["library_hero", "header"]),
        _ => false,
    }
}
fn official_asset_urls(id: &str, assets: &Value) -> (Vec<String>, Vec<String>) {
    let Some(template) = assets["asset_url_format"].as_str() else {
        return (vec![], vec![]);
    };
    let (path, query) = template
        .split_once('?')
        .map_or((template, None), |(p, q)| (p, Some(q)));
    if query.is_some_and(|q| {
        !q.starts_with("t=") || q.len() <= 2 || !q[2..].bytes().all(|b| b.is_ascii_digit())
    }) {
        return (vec![], vec![]);
    }
    let Some(tail) = path.strip_prefix(&format!("steam/apps/{id}/")) else {
        return (vec![], vec![]);
    };
    let Some(prefix) = tail.strip_suffix("${FILENAME}") else {
        return (vec![], vec![]);
    };
    if !prefix.is_empty() && !(prefix.ends_with('/') && hash_part(&prefix[..prefix.len() - 1])) {
        return (vec![], vec![]);
    }
    let resolve = |keys: &[&str], validator: fn(&str) -> bool| -> Vec<String> {
        keys.iter()
            .filter_map(|key| {
                let name = assets.get(*key)?.as_str()?;
                if !validator(name) {
                    return None;
                }
                let url = format!("{CDN}{}", template.replace("${FILENAME}", name));
                approved_url(&url).then_some(url)
            })
            .collect()
    };
    let covers = resolve(
        &["library_capsule_2x", "library_capsule"],
        approved_cover_asset,
    );
    let banners = resolve(
        &["library_hero", "library_hero_2x", "header_2x", "header"],
        approved_banner_asset,
    );
    (covers, banners)
}
#[cfg(test)]
fn official_urls(id: &str, assets: &Value) -> Vec<String> {
    official_asset_urls(id, assets).0
}
fn metadata_asset_urls(
    http: &Client,
    id: &str,
    allowed: &dyn Fn() -> bool,
) -> Result<(Vec<String>, Vec<String>), String> {
    let input = json!({"ids":[{"appid":id.parse::<u64>().map_err(|e|e.to_string())?}],
        "context":{"country_code":"US","language":"english"},
        "data_request":{"include_assets":true}});
    let mut url = Url::parse("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/")
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("input_json", &input.to_string());
    let Some(data) = json_request(http, url.as_str(), JSON_LIMIT, allowed)? else {
        return Ok((vec![], vec![]));
    };
    if let Some(items) = data
        .pointer("/response/store_items")
        .and_then(Value::as_array)
    {
        for item in items.iter().take(20) {
            if item["appid"].as_u64().is_some_and(|n| n.to_string() == id) {
                return Ok(official_asset_urls(id, &item["assets"]));
            }
        }
    }
    Ok((vec![], vec![]))
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

fn landscape_banner(bytes: &[u8]) -> bool {
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
        (320..=4096).contains(&w)
            && (120..=4096).contains(&h)
            && (1.25..=4.5).contains(&(w as f64 / h as f64))
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

fn local_nonsteam_banner(game: &Value) -> Option<(Vec<u8>, &'static str)> {
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
                    "banner" => 100,
                    "hero" => 99,
                    "libraryhero" => 98,
                    "backdrop" => 96,
                    "background" => 94,
                    "header" => 92,
                    "keyartwide" => 90,
                    _ => {
                        if [game_key.as_str(), exe_key.as_str()]
                            .iter()
                            .filter(|v| !v.is_empty())
                            .any(|v| {
                                stem == format!("{v}banner")
                                    || stem == format!("{v}hero")
                                    || stem == format!("{v}header")
                            })
                        {
                            85
                        } else {
                            0
                        }
                    }
                };
                if score > penalty {
                    found.push((path, score - penalty));
                }
            }
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
            if landscape_banner(&bytes) {
                if let Some(ext) = image_ext(&bytes) {
                    return Some((bytes, ext));
                }
            }
        }
    }
    None
}

// Xbox GDK packages provide official square logos rather than portrait covers.
// Use these as a visible icon fallback, never stretch a square logo into a
// portrait cover or borrow art from a similarly named Steam product.
fn local_xbox_icon(game: &Value) -> Option<(Vec<u8>, &'static str)> {
    for path in native::xbox_logo_paths(game).into_iter().take(7) {
        let Some(bytes) = read_capped(&path, ICON_LIMIT).ok().flatten() else {
            continue;
        };
        if image_ext(&bytes) != Some("png") {
            continue;
        }
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        if !(44..=4096).contains(&w)
            || !(44..=4096).contains(&h)
            || !(0.75..=1.35).contains(&(w as f64 / h as f64))
        {
            continue;
        }
        return Some((bytes, "png"));
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

fn epic_filtered_urls(images: &Value, allowed_types: &[&str]) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    if let Some(images) = images.as_array() {
        for item in images.iter().take(30) {
            if !allowed_types.contains(&field(item, "type")) {
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

fn epic_image_urls(images: &Value) -> Vec<String> {
    epic_filtered_urls(
        images,
        &["DieselGameBoxTall", "OfferImageTall", "Thumbnail"],
    )
}

fn epic_banner_urls(images: &Value) -> Vec<String> {
    epic_filtered_urls(
        images,
        &["DieselGameBoxWide", "OfferImageWide", "FeaturedMedia"],
    )
}

fn epic_exact_match_element<'a>(response: &'a Value, title: &str) -> Option<&'a Value> {
    let elements: Vec<&Value> = response
        .pointer("/data/Catalog/searchStore/elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(20)
        .collect();
    let exact: Vec<&Value> = elements
        .iter()
        .copied()
        .filter(|item| key(field(item, "title")) == key(title))
        .collect();
    if exact.len() == 1 {
        return Some(exact[0]);
    }
    if exact.len() > 1 {
        return None;
    }
    let query_tokens = tokenize_title(title);
    let target_canonical = canonical_key(title);
    let canonical: Vec<&Value> = elements
        .iter()
        .copied()
        .filter(|item| {
            let item_title = field(item, "title");
            canonical_key(item_title) == target_canonical
                && !is_non_base_item(&tokenize_title(item_title), &query_tokens)
        })
        .collect();
    if canonical.len() == 1 {
        return Some(canonical[0]);
    }
    if canonical.len() > 1 {
        return None;
    }
    let target_base = base_edition_key(title);
    if target_base.len() < 3 {
        return None;
    }
    let edition: Vec<&Value> = elements
        .iter()
        .copied()
        .filter(|item| {
            let item_title = field(item, "title");
            base_edition_key(item_title) == target_base
                && !is_non_base_item(&tokenize_title(item_title), &query_tokens)
        })
        .collect();
    if edition.len() == 1 {
        Some(edition[0])
    } else {
        None
    }
}

fn epic_exact_search_images(response: &Value, title: &str) -> Vec<String> {
    epic_exact_match_element(response, title)
        .map(|item| epic_image_urls(&item["keyImages"]))
        .unwrap_or_default()
}

fn epic_exact_search_banners(response: &Value, title: &str) -> Vec<String> {
    epic_exact_match_element(response, title)
        .map(|item| epic_banner_urls(&item["keyImages"]))
        .unwrap_or_default()
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

fn epic_image_checked(
    http: &Client,
    url: &str,
    remaining: &mut usize,
    allowed: &dyn Fn() -> bool,
    deadline: Option<Instant>,
    validate: fn(&[u8]) -> bool,
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
    if bytes.len() <= IMAGE_LIMIT && image_ext(&bytes) == Some(expected) && validate(&bytes) {
        Ok(Some((bytes, expected)))
    } else {
        Ok(None)
    }
}

type StoredArtCandidate = (Vec<u8>, &'static str);

fn epic_artwork(
    http: &Client,
    game: &Value,
    want_banner: bool,
    allowed: &dyn Fn() -> bool,
    deadline: Option<Instant>,
) -> Result<(Option<StoredArtCandidate>, Option<StoredArtCandidate>), String> {
    let mut remaining = EPIC_REQUEST_LIMIT;
    let title = field(game, "name").trim();
    let mut image_urls = Vec::new();
    let mut banner_urls = Vec::new();
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
                if want_banner {
                    banner_urls.extend(epic_banner_urls(&item["keyImages"]));
                }
            }
        }
    }
    // An exact/canonical title is required: no fuzzy search/first-result guessing.
    if valid_title(title) && image_urls.is_empty() {
        let query = r#"query OrbitSearch($keywords:String!){Catalog{searchStore(keywords:$keywords,country:"US",locale:"en-US",count:20,start:0){elements{title id namespace keyImages{type url}}}}}"#;
        for variant in search_variants(title).into_iter().take(2) {
            let url = epic_graphql_url("store.epicgames.com", query, &json!({"keywords":variant}))?;
            if let Ok(Some(data)) = epic_json(http, &url, &mut remaining, allowed, deadline) {
                let covers = epic_exact_search_images(&data, &variant);
                let banners = if want_banner {
                    epic_exact_search_banners(&data, &variant)
                } else {
                    vec![]
                };
                if !covers.is_empty() || !banners.is_empty() {
                    image_urls.extend(covers);
                    banner_urls.extend(banners);
                    break;
                }
            }
        }
    }
    // Official Epic asset for Fortnite when the keyless catalog is unavailable.
    // Never infer Fortnite from a misleading source_id or similar title.
    if game["source"] == "epic" && key(title) == "fortnite" {
        image_urls.push(FORTNITE_PORTRAIT.to_string());
    }
    let mut seen = HashSet::new();
    let mut cover = None;
    for url in image_urls
        .into_iter()
        .filter(|url| seen.insert(url.clone()))
        .take(EPIC_IMAGES_LIMIT)
    {
        match epic_image_checked(
            http,
            &url,
            &mut remaining,
            allowed,
            deadline,
            portrait_image,
        ) {
            Ok(Some(image)) if allowed() => {
                cover = Some(image);
                break;
            }
            Ok(_) | Err(_) => {}
        }
    }
    let mut banner = None;
    if want_banner {
        let mut seen_banner = HashSet::new();
        for url in banner_urls
            .into_iter()
            .filter(|url| seen_banner.insert(url.clone()))
            .take(3)
        {
            match epic_image_checked(
                http,
                &url,
                &mut remaining,
                allowed,
                deadline,
                landscape_banner,
            ) {
                Ok(Some(image)) if allowed() => {
                    banner = Some(image);
                    break;
                }
                Ok(_) | Err(_) => {}
            }
        }
    }
    Ok((cover, banner))
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
    {
        for root in native::steam_registry_roots() {
            add_root(&mut roots, root);
        }
        for var in ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"] {
            if let Some(root) = std::env::var_os(var) {
                add_root(&mut roots, PathBuf::from(root).join("Steam"));
            }
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
fn local_banner(id: &str, install: Option<&str>) -> Option<Vec<u8>> {
    if !valid_id(id) {
        return None;
    }
    for root in steam_roots(install) {
        let cache = root.join("appcache/librarycache");
        let app = cache.join(id);
        let mut paths = vec![
            cache.join(format!("{id}_library_hero.jpg")),
            cache.join(format!("{id}_header.jpg")),
        ];
        for name in BANNER_ASSETS {
            paths.push(app.join(name));
        }
        for dir in hashed_dirs(&app) {
            for name in BANNER_ASSETS {
                paths.push(dir.join(name));
            }
        }
        for path in paths {
            if let Ok(Some(bytes)) = read_capped(&path, IMAGE_LIMIT) {
                if landscape_banner(&bytes) {
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

type OnlineArtworkPair = (Option<Vec<u8>>, Option<Vec<u8>>);

fn online_artwork_with_deadline(
    http: &Client,
    id: &str,
    deadline: Option<Instant>,
    want_cover: bool,
    want_banner: bool,
    allowed: &dyn Fn() -> bool,
) -> Result<OnlineArtworkPair, String> {
    if !valid_id(id) {
        return Err("Invalid Steam app ID".into());
    }
    if deadline.is_some_and(|end| Instant::now() >= end) {
        return Err("Steam artwork repair time budget reached".into());
    }
    // Metadata can fail while official direct CDN paths remain available.
    let (mut cover_urls, mut banner_urls, mut error) = match metadata_asset_urls(http, id, allowed)
    {
        Ok((covers, banners)) => (covers, banners, None),
        Err(e) => (vec![], vec![], Some(e)),
    };
    let mut cover = None;
    if want_cover {
        let extra = match id {
            "252950" => Some("cc030d5cf1de6d485d41685bf2aac8ae4ca8ab8e/library_capsule_2x.jpg"),
            "4435490" => Some("c71bc2cb60e440d1a0d2435d0c06c4d4a4050edf/library_capsule_2x.jpg"),
            _ => None,
        };
        if let Some(name) = extra {
            cover_urls.push(format!("{CDN}steam/apps/{id}/{name}"));
        }
        for name in ASSETS {
            cover_urls.push(format!("{CDN}steam/apps/{id}/{name}"));
        }
        let mut seen = HashSet::new();
        for url in cover_urls
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
                Ok(Some(bytes)) if portrait(&bytes) => {
                    cover = Some(bytes);
                    break;
                }
                Ok(_) => (),
                Err(e) => error = Some(e),
            }
        }
    }
    let mut banner = None;
    if want_banner && !deadline.is_some_and(|end| Instant::now() >= end) {
        for name in BANNER_ASSETS {
            banner_urls.push(format!("{CDN}steam/apps/{id}/{name}"));
        }
        let mut seen = HashSet::new();
        for url in banner_urls
            .into_iter()
            .filter(|url| seen.insert(url.clone()))
            .take(5)
        {
            if deadline.is_some_and(|end| Instant::now() >= end) {
                break;
            }
            match request(http, &url, IMAGE_LIMIT, true, allowed) {
                Ok(Some(bytes)) if landscape_banner(&bytes) => {
                    banner = Some(bytes);
                    break;
                }
                Ok(_) | Err(_) => (),
            }
        }
    }
    if cover.is_none() && banner.is_none() {
        if let Some(e) = error {
            return Err(e);
        }
    }
    Ok((cover, banner))
}

fn online_artwork_response(
    cover_bytes: Option<(&[u8], &str)>,
    banner_bytes: Option<(&[u8], &str)>,
    matched_name: &str,
    source: &str,
    store_label: &str,
    artwork_dir: &Path,
) -> Result<Option<Value>, String> {
    let cover = match cover_bytes {
        Some((bytes, ext)) => store(bytes, ext, artwork_dir)?,
        None => String::new(),
    };
    let banner = match banner_bytes {
        Some((bytes, ext)) => store(bytes, ext, artwork_dir).unwrap_or_default(),
        None => String::new(),
    };
    if cover.is_empty() && banner.is_empty() {
        return Ok(None);
    }
    let message = match (!cover.is_empty(), !banner.is_empty()) {
        (true, true) => format!("Cover and banner found on {store_label}."),
        (true, false) => format!("Cover found on {store_label}."),
        (false, true) => format!("Banner found on {store_label}."),
        (false, false) => unreachable!(),
    };
    Ok(Some(json!({
        "cover": cover,
        "banner": banner,
        "matchedName": matched_name,
        "source": source,
        "message": message,
    })))
}

/// Lookup a manually entered title through Steam and Epic store matches
/// (handling Roman/Arabic numerals and official store editions without fuzzy
/// wrong-game guessing). Rechecks opt-in and Performance Guard before each call.
/// Returns {cover, banner, matchedName?, source?, message}; failures return Err.
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
        if let Ok((cover_bytes, banner_bytes)) =
            online_artwork_with_deadline(&http, &id, None, true, true, allowed)
        {
            require_online(allowed)?;
            if let Some(found) = online_artwork_response(
                cover_bytes.as_deref().map(|b| (b, "jpg")),
                banner_bytes.as_deref().map(|b| (b, "jpg")),
                &name,
                "steam",
                "Steam",
                artwork_dir,
            )? {
                return Ok(found);
            }
        }
    }
    require_online(allowed)?;
    let lookup = json!({"source":"epic","name":title});
    let (epic_cover, epic_banner) = epic_artwork(&http, &lookup, true, allowed, None)?;
    if epic_cover.is_some() || epic_banner.is_some() {
        require_online(allowed)?;
        if let Some(found) = online_artwork_response(
            epic_cover.as_ref().map(|(b, e)| (b.as_slice(), *e)),
            epic_banner.as_ref().map(|(b, e)| (b.as_slice(), *e)),
            title,
            "epic",
            "Epic Games",
            artwork_dir,
        )? {
            return Ok(found);
        }
    }
    // Rocket League was delisted from the Steam storefront, so its old app
    // ID is used only for this one exact, verified title as a final fallback.
    if canonical_key(title) == "rocketleague" {
        if let Ok((cover_bytes, banner_bytes)) =
            online_artwork_with_deadline(&http, "252950", None, true, true, allowed)
        {
            require_online(allowed)?;
            if let Some(found) = online_artwork_response(
                cover_bytes.as_deref().map(|b| (b, "jpg")),
                banner_bytes.as_deref().map(|b| (b, "jpg")),
                "Rocket League",
                "steam",
                "Steam",
                artwork_dir,
            )? {
                return Ok(found);
            }
        }
    }
    require_online(allowed)?;
    Ok(json!({"cover":"","banner":"",
        "message":"No matching artwork found on Steam or Epic Games. Check the title or choose an image manually."}))
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
    let Some(bytes) = read_capped(&dir.join(cover), MAX_USER_IMAGE).ok().flatten() else {
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
#[cfg(test)]
pub fn repair_artwork(games: &[Value], artwork_dir: &Path) -> Result<Value, String> {
    repair_artwork_with_options(games, artwork_dir, false, false)
}

/// Explicitly opted-in repair, capped to 300 games, 8 online candidates and 40s.
/// Returns {found,attempted,icons,onlineEnabled,paused,updates,failures,truncated}.
/// updates contains proposed {id,cover?,icon?}; caller must verify DB revision
/// and original cover/icon to prevent overwriting concurrent user edits.
#[cfg(test)]
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
    let mut online_attempted = Vec::<String>::new();
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
        let local_xbox_icon = if need_icon {
            local_xbox_icon(game)
        } else {
            None
        };
        if steam_id.is_none()
            && local.is_none()
            && local_xbox_icon.is_none()
            && (!need_cover || http.is_none())
        {
            continue;
        }
        attempted += 1;
        let install = game["install_path"].as_str();
        let mut patch = serde_json::Map::new();
        patch.insert("id".into(), json!(id));
        if need_cover {
            let need_banner = game["banner"].as_str().unwrap_or("").is_empty();
            let mut selected = local.or_else(|| {
                steam_id
                    .and_then(|s| local_cover(s, install))
                    .map(|bytes| (bytes, "jpg"))
            });
            let mut selected_banner = if need_banner {
                local_nonsteam_banner(game).or_else(|| {
                    steam_id
                        .and_then(|s| local_banner(s, install))
                        .map(|bytes| (bytes, "jpg"))
                })
            } else {
                None
            };
            if selected.is_none()
                // Xbox lacks a verified Steam ID. Never consume the shared
                // eight-request online budget on a deliberate no-op.
                && game["source"] != "xbox"
                && http.is_some()
                && online_count < ONLINE_LIMIT
                && started.elapsed() < REPAIR_TIME
                && allowed()
            {
                let has_online_query = steam_id.is_some()
                    || (game["source"] == "epic"
                        && (epic_identity(game).is_some()
                            || valid_title(field(game, "name").trim())
                            || canonical_key(field(game, "name")) == "rocketleague"))
                    || valid_title(field(game, "name").trim());
                if has_online_query {
                    online_count += 1;
                    online_attempted.push(id.to_owned());
                }
                let http = http.as_ref().unwrap();
                let deadline = Some(started + REPAIR_TIME);
                let want_banner = need_banner && selected_banner.is_none();
                let result: Result<
                    (Option<StoredArtCandidate>, Option<StoredArtCandidate>),
                    String,
                > = if let Some(steam_id) = steam_id {
                    online_artwork_with_deadline(
                        http,
                        steam_id,
                        deadline,
                        true,
                        want_banner,
                        allowed,
                    )
                    .map(|(c, b)| (c.map(|bytes| (bytes, "jpg")), b.map(|bytes| (bytes, "jpg"))))
                } else if game["source"] == "epic" {
                    // Manifest/catalog identity first, then unique canonical-title
                    // Epic search. A Rocket League Steam fallback is permitted
                    // only with its precise title, never a vague substring.
                    match epic_artwork(http, game, want_banner, allowed, deadline) {
                        Ok((Some(c), b)) => Ok((Some(c), b)),
                        Ok((None, b)) if canonical_key(field(game, "name")) == "rocketleague" => {
                            online_artwork_with_deadline(
                                http,
                                "252950",
                                deadline,
                                true,
                                want_banner && b.is_none(),
                                allowed,
                            )
                            .map(|(c, sb)| {
                                (
                                    c.map(|bytes| (bytes, "jpg")),
                                    b.or_else(|| sb.map(|bytes| (bytes, "jpg"))),
                                )
                            })
                        }
                        other => other,
                    }
                } else {
                    let title = game["name"].as_str().unwrap_or("");
                    match exact_app(http, title, allowed) {
                        Ok(Some((_, steam_id))) => online_artwork_with_deadline(
                            http,
                            &steam_id,
                            deadline,
                            true,
                            want_banner,
                            allowed,
                        )
                        .map(|(c, b)| {
                            (c.map(|bytes| (bytes, "jpg")), b.map(|bytes| (bytes, "jpg")))
                        }),
                        Ok(None) => {
                            if valid_title(title.trim()) {
                                let lookup = json!({"source":"epic","name":title.trim()});
                                epic_artwork(http, &lookup, want_banner, allowed, deadline)
                            } else {
                                Ok((None, None))
                            }
                        }
                        Err(e) => Err(e),
                    }
                };
                match result {
                    Ok((cover_res, banner_res)) if allowed() => {
                        selected = cover_res;
                        if selected_banner.is_none() {
                            selected_banner = banner_res;
                        }
                    }
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
            if let Some((bytes, ext)) = selected_banner {
                if let Ok(banner) = store(&bytes, ext, artwork_dir) {
                    patch.insert("banner".into(), json!(banner));
                }
            }
        }
        if need_icon {
            if let Some((bytes, ext)) =
                local_xbox_icon.or_else(|| steam_id.and_then(|s| local_icon(s, install)))
            {
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
        "updates":updates,"onlineAttempted":online_attempted,"failures":failures,"truncated":truncated}))
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
    fn xbox_gdk_manifest_logos_fill_icon_offline_without_replacing_a_cover() {
        let root =
            std::env::temp_dir().join(format!("orbit-xbox-logo-fixture-{}", uuid::Uuid::new_v4()));
        // Real decodable PNG assets supplied with Orbit, not synthetic PNG
        // headers that can never be rendered by WebView2.
        let asset_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets");
        let primary_logo = fs::read(asset_root.join("icon.png")).unwrap();
        let override_logo = fs::read(asset_root.join("branding/orbit-mark-dark.png")).unwrap();
        let install = root.join("Xbox Games").join("Example Game");
        let content = install.join("Content");
        let assets = content.join("Graphics");
        let cache = root.join("orbit-cache");
        fs::create_dir_all(&assets).unwrap();
        fs::write(content.join("Example.exe"), b"not executed").unwrap();
        fs::write(assets.join("Logo.png"), &primary_logo).unwrap();
        fs::write(
            content.join("MicrosoftGame.config"),
            r#"<Game configVersion="1">
                <Identity Name="ExamplePublisher.ExampleGame" Publisher="CN=Example"/>
                <ExecutableList><Executable Name="Example.exe" Id="Game" TargetDeviceFamily="PC"/></ExecutableList>
                <ShellVisuals DefaultDisplayName="Example Game" Square480x480Logo="Graphics\Logo.png"
                    Square150x150Logo="Graphics\Logo.png" StoreLogo="Graphics\Logo.png"/>
                </Game>"#,
        )
        .unwrap();
        let original_cover = store(&png(600, 900), "png", &cache).unwrap();
        let game = json!({"id":"xbox-1","source":"xbox",
            "source_id":"ExamplePublisher.ExampleGame",
            "name":"Example Game","install_path":install,
            "executable":content.join("Example.exe"),
            "cover":original_cover,"icon":""});
        // Existing user art must remain untouched; icon-only repair must work
        // with online artwork disabled and a preserved cover.
        let result = repair_artwork(&[game.clone()], &cache).unwrap();
        assert_eq!(result["found"], 0);
        assert_eq!(result["icons"], 1);
        assert_eq!(result["updates"][0]["id"], "xbox-1");
        assert!(result["updates"][0].get("cover").is_none());
        let token = result["updates"][0]["icon"].as_str().unwrap();
        assert!(artwork_token(token));
        assert_eq!(fs::read(cache.join(token)).unwrap(), primary_logo);

        // Empty-cover Game Pass entries should show the package icon without
        // pretending the square logo is a portrait game cover.
        let mut blank = game.clone();
        blank["id"] = json!("xbox-blank");
        blank["cover"] = json!("");
        let fallback = repair_artwork(&[blank], &cache).unwrap();
        assert_eq!(fallback["found"], 0);
        assert_eq!(fallback["icons"], 1);
        assert!(fallback["updates"][0].get("cover").is_none());
        assert_eq!(fallback["updates"][0]["icon"], token);

        // A per-executable GDK override takes precedence over the shared
        // package logo, even when the latter has greater pixel dimensions.
        fs::write(assets.join("Override.png"), &override_logo).unwrap();
        fs::write(
            content.join("MicrosoftGame.config"),
            r#"<Game configVersion="1">
                <Identity Name="ExamplePublisher.ExampleGame" Publisher="CN=Example"/>
                <ExecutableList><Executable Name="Example.exe" Id="Game"
                    TargetDeviceFamily="PC" OverrideLogo="Graphics\Override.png"/></ExecutableList>
                <ShellVisuals Square480x480Logo="Graphics\Logo.png"/>
                </Game>"#,
        )
        .unwrap();
        let override_result = repair_artwork(&[game.clone()], &cache).unwrap();
        assert_eq!(override_result["icons"], 1);
        let override_token = override_result["updates"][0]["icon"].as_str().unwrap();
        assert_ne!(override_token, token);
        assert_eq!(fs::read(cache.join(override_token)).unwrap(), override_logo);

        // Existing custom icons always win, and replacing the executable
        // with an unrelated one must not associate the old Xbox logo.
        let mut custom = game.clone();
        custom["icon"] = json!("user-custom-icon.png");
        assert_eq!(
            repair_artwork(&[custom], &cache).unwrap()["updates"],
            json!([])
        );
        let mut reassigned = game.clone();
        fs::write(content.join("Other.exe"), b"not executed").unwrap();
        reassigned["executable"] = json!(content.join("Other.exe"));
        assert_eq!(repair_artwork(&[reassigned], &cache).unwrap()["icons"], 0);

        // Another Xbox product must never adopt this install's logo.
        let mut wrong = game.clone();
        wrong["source_id"] = json!("UnrelatedPublisher.OtherGame");
        let rejected = repair_artwork(&[wrong], &cache).unwrap();
        assert_eq!(rejected["icons"], 0);
        assert_eq!(rejected["updates"], json!([]));

        // Even if a manifest points outside the game, no logo is imported.
        fs::write(
            content.join("MicrosoftGame.config"),
            r#"<Game configVersion="1">
                <Identity Name="ExamplePublisher.ExampleGame" Publisher="CN=Example"/>
                <ExecutableList><Executable Name="Example.exe" Id="Game" TargetDeviceFamily="PC"/></ExecutableList>
                <ShellVisuals Square480x480Logo="../../OtherGame/Logo.png"/>
                </Game>"#,
        )
        .unwrap();
        assert!(native::xbox_logo_paths(&game).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn eight_missing_xbox_covers_do_not_starve_other_store_artwork_budget() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut games = (0..8)
            .map(|i| {
                json!({"id":format!("xbox-{i}"),"source":"xbox",
                    "name":format!("Missing GDK Game {i}"),"source_id":format!("Unavailable.GDK.{i}"),
                    "cover":"","icon":""})
            })
            .collect::<Vec<_>>();
        // The final manual title is deliberately invalid so an attempted
        // online lookup returns immediately without making HTTP requests.
        games.push(json!({"id":"manual-last","source":"manual","name":"a","cover":"","icon":""}));
        let calls = AtomicUsize::new(0);
        let allowed = || {
            calls.fetch_add(1, Ordering::SeqCst);
            true
        };
        let dir = std::env::temp_dir().join(format!(
            "orbit-xbox-budget-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        let result = repair_artwork_guarded(&games, &dir, true, false, &allowed).unwrap();
        assert_eq!(result["attempted"], 9);
        assert_eq!(result["updates"], json!([]));
        assert_eq!(calls.load(Ordering::SeqCst), 2,
            "Xbox should use no online budget; the following manual title must still reach the online guard");
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

    #[test]
    fn user_cover_above_5mb_within_15mb_is_preserved_by_needs_cover() {
        let dir = std::env::temp_dir().join(format!("orbit-art-large-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut big = jpeg(600, 900);
        big.resize(6 * 1024 * 1024, 0);
        let token = format!("{}.jpg", uuid::Uuid::new_v4());
        fs::write(dir.join(&token), &big).unwrap();
        assert!(!needs_cover(&json!({"cover": token}), &dir));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_short_title_does_not_consume_online_artwork_budget() {
        let dir = std::env::temp_dir().join(format!("orbit-art-short-{}", uuid::Uuid::new_v4()));
        let mut games = (0..8)
            .map(|i| json!({"id": format!("short-{i}"), "source": "manual", "name": "a", "cover": "", "icon": ""}))
            .collect::<Vec<_>>();
        games.push(json!({"id": "valid-short-follow", "source": "manual", "name": "ab", "cover": "", "icon": ""}));
        let result = repair_artwork_guarded(&games, &dir, true, false, &|| true).unwrap();
        assert_eq!(result["onlineAttempted"], json!([]));
        assert!(!dir.exists());
    }

    #[test]
    fn roman_and_arabic_title_matching_and_query_variants() {
        let schedule_variants = search_variants("schedule 1");
        assert!(schedule_variants
            .iter()
            .any(|v| v.eq_ignore_ascii_case("schedule 1")));
        assert!(schedule_variants.iter().any(|v| v == "schedule I"));

        let compact_variants = search_variants("Schedule1");
        assert!(compact_variants.iter().any(|v| v == "Schedule 1"));
        assert!(compact_variants.iter().any(|v| v == "Schedule I"));

        let noisy_variants = search_variants("Schedule 1 v0.3.4f8 [Portable]");
        assert_eq!(noisy_variants[0], "Schedule 1");
        assert!(noisy_variants.iter().any(|v| v == "Schedule I"));
        assert_eq!(strip_title_noise("Cyberpunk 2077"), "Cyberpunk 2077");

        // Steam search results for "Schedule I" include base game + Free Sample demo.
        let schedule_items = vec![
            json!({"type":"app","id":3205720,"name":"Schedule I: Free Sample"}),
            json!({"type":"app","id":3164500,"name":"Schedule I"}),
        ];
        assert_eq!(
            select_steam_match(&schedule_items, &schedule_variants),
            Some(("Schedule I".into(), "3164500".into()))
        );
        // Never match the Free Sample demo when the base game is absent.
        let demo_only = vec![json!({"type":"app","id":3205720,"name":"Schedule I: Free Sample"})];
        assert_eq!(select_steam_match(&demo_only, &schedule_variants), None);

        // Roman <-> Arabic & punctuation / ampersand matching.
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":2950840,"name":"Hades II Original Soundtrack"}),
                    json!({"type":"app","id":1145350,"name":"Hades II"}),
                ],
                &search_variants("Hades 2"),
            ),
            Some(("Hades II".into(), "1145350".into()))
        );
        assert_eq!(
            select_steam_match(
                &[json!({"type":"app","id":374320,"name":"DARK SOULS™ III"})],
                &search_variants("dark souls 3"),
            ),
            Some(("DARK SOULS™ III".into(), "374320".into()))
        );
        assert_eq!(
            select_steam_match(
                &[json!({"type":"app","id":3837340,"name":"FINAL FANTASY VII"})],
                &search_variants("final fantasy 7"),
            ),
            Some(("FINAL FANTASY VII".into(), "3837340".into()))
        );
        assert_eq!(
            select_steam_match(
                &[json!({"type":"app","id":1086940,"name":"Baldur's Gate 3"})],
                &search_variants("Baldur's Gate III"),
            ),
            Some(("Baldur's Gate 3".into(), "1086940".into()))
        );
        assert_eq!(
            select_steam_match(
                &[json!({"type":"app","id":1771300,"name":"Kingdom Come: Deliverance II"})],
                &search_variants("Kingdom Come Deliverance 2"),
            ),
            Some(("Kingdom Come: Deliverance II".into(), "1771300".into()))
        );
        assert_eq!(
            select_steam_match(
                &[json!({"type":"app","id":261550,"name":"Mount & Blade II: Bannerlord"})],
                &search_variants("Mount and Blade 2: Bannerlord"),
            ),
            Some(("Mount & Blade II: Bannerlord".into(), "261550".into()))
        );
        assert_eq!(
            select_steam_match(
                &[json!({"type":"app","id":3241660,"name":"R.E.P.O."})],
                &search_variants("REPO"),
            ),
            Some(("R.E.P.O.".into(), "3241660".into()))
        );

        // Dotted acronyms and leading single-letter words must not turn into numerals.
        assert_eq!(canonical_key("D.I.R.T."), "dirt");
        assert_eq!(canonical_key("I Am Bread"), "iambread");
        assert_eq!(canonical_key("V Rising"), "vrising");
        assert_eq!(canonical_key("X-COM"), "xcom");

        // Exact literal match beats Roman-normalized ambiguity (Mega Man 10 vs X).
        let mega_items = vec![
            json!({"type":"app","id":1,"name":"Mega Man X"}),
            json!({"type":"app","id":2,"name":"Mega Man 10"}),
        ];
        assert_eq!(
            select_steam_match(&mega_items, &search_variants("Mega Man 10")),
            Some(("Mega Man 10".into(), "2".into()))
        );

        // Edition / remaster / creator-prefix fallbacks match real store listings
        // while rejecting soundtracks, VR editions, upgrades, DLCs and spin-offs.
        assert_eq!(
            select_steam_match(
                &[json!({"type":"app","id":3240220,"name":"Grand Theft Auto V Enhanced"})],
                &search_variants("gta 5"),
            ),
            Some(("Grand Theft Auto V Enhanced".into(), "3240220".into()))
        );
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":12210,"name":"Grand Theft Auto IV: The Complete Edition"})
                ],
                &search_variants("gta 4"),
            ),
            Some((
                "Grand Theft Auto IV: The Complete Edition".into(),
                "12210".into()
            ))
        );
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":1229320,"name":"The Witcher 3: Wild Hunt — Remastered Soundtrack"}),
                    json!({"type":"app","id":292030,"name":"The Witcher 3: Wild Hunt — Remastered"}),
                ],
                &search_variants("The Witcher 3: Wild Hunt"),
            ),
            Some((
                "The Witcher 3: Wild Hunt — Remastered".into(),
                "292030".into()
            ))
        );
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":611670,"name":"The Elder Scrolls V: Skyrim VR"}),
                    json!({"type":"app","id":1746860,"name":"The Elder Scrolls V: Skyrim Anniversary Upgrade"}),
                    json!({"type":"app","id":489830,"name":"The Elder Scrolls V: Skyrim Special Edition"}),
                ],
                &search_variants("Elder Scrolls V Skyrim"),
            ),
            Some((
                "The Elder Scrolls V: Skyrim Special Edition".into(),
                "489830".into()
            ))
        );
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":947510,"name":"Sid Meier's Civilization® VI: Gathering Storm"}),
                    json!({"type":"app","id":289070,"name":"Sid Meier’s Civilization® VI"}),
                ],
                &search_variants("Civilization 6"),
            ),
            Some(("Sid Meier’s Civilization® VI".into(), "289070".into()))
        );
        assert_eq!(
            select_steam_match(
                &[json!({"type":"app","id":359550,"name":"Tom Clancy's Rainbow Six Siege"})],
                &search_variants("Rainbow Six Siege"),
            ),
            Some(("Tom Clancy's Rainbow Six Siege".into(), "359550".into()))
        );
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":435150,"name":"Divinity: Original Sin 2 - Definitive Edition"})
                ],
                &search_variants("Divinity Original Sin 2"),
            ),
            Some((
                "Divinity: Original Sin 2 - Definitive Edition".into(),
                "435150".into()
            ))
        );

        // Sequels and spin-offs must NEVER false-match.
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":1030300,"name":"Hollow Knight: Silksong"}),
                    json!({"type":"app","id":999,"name":"Hollow Knight 2"}),
                ],
                &search_variants("Hollow Knight"),
            ),
            None
        );
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":1672970,"name":"Minecraft Dungeons"}),
                    json!({"type":"app","id":1912410,"name":"Minecraft Dungeons II"}),
                ],
                &search_variants("Minecraft"),
            ),
            None
        );
        assert_eq!(
            select_steam_match(
                &[
                    json!({"type":"app","id":2622380,"name":"ELDEN RING NIGHTREIGN"}),
                    json!({"type":"app","id":2778580,"name":"ELDEN RING Shadow of the Erdtree"}),
                ],
                &search_variants("ELDEN RING"),
            ),
            None
        );
    }

    #[test]
    fn steam_banner_and_alt_assets_are_validated_safely() {
        let schedule_assets = json!({
            "asset_url_format": "steam/apps/3164500/${FILENAME}?t=1785744977",
            "library_capsule_2x": "83b75c1bc8ea91b7503d8816832188635ba75a72/library_600x900_2x.jpg",
            "library_capsule": "83b75c1bc8ea91b7503d8816832188635ba75a72/library_600x900.jpg",
            "library_hero": "library_hero.jpg",
            "library_hero_2x": "library_hero_2x.jpg",
            "header_2x": "48a93d6445a67520ea49833c93dae8f2e68fc540/header_alt_assets_9_2x.jpg",
            "header": "../../evil.jpg"
        });
        let (covers, banners) = official_asset_urls("3164500", &schedule_assets);
        assert_eq!(covers.len(), 2);
        assert!(
            covers[0].contains("83b75c1bc8ea91b7503d8816832188635ba75a72/library_600x900_2x.jpg")
        );
        assert_eq!(banners.len(), 3);
        assert!(banners[0].contains("/library_hero.jpg?t=1785744977"));
        assert!(banners[2].contains("header_alt_assets_9_2x.jpg"));
        assert!(landscape_banner(&jpeg(1920, 620)));
        assert!(landscape_banner(&jpeg(920, 430)));
        assert!(!landscape_banner(&jpeg(600, 900)));
        assert!(!landscape_banner(&jpeg(200, 100)));
    }

    #[test]
    fn offline_repair_imports_local_banners_alongside_covers() {
        let root =
            std::env::temp_dir().join(format!("orbit-banner-local-{}", uuid::Uuid::new_v4()));
        let install = root.join("Schedule I");
        let artwork = root.join("artwork");
        fs::create_dir_all(&install).unwrap();
        fs::write(install.join("poster.png"), png(600, 900)).unwrap();
        fs::write(install.join("banner.png"), png(1920, 620)).unwrap();
        let game = json!({
            "id": "manual-banner-1",
            "source": "manual",
            "name": "Schedule 1",
            "install_path": install,
            "cover": "",
            "banner": "",
            "icon": ""
        });
        let result = repair_artwork(&[game], &artwork).unwrap();
        assert_eq!(result["found"], 1);
        let patch = &result["updates"][0];
        let cover_tok = patch["cover"].as_str().unwrap();
        let banner_tok = patch["banner"].as_str().unwrap();
        assert!(artwork_token(cover_tok));
        assert!(artwork_token(banner_tok));
        assert_eq!(fs::read(artwork.join(cover_tok)).unwrap(), png(600, 900));
        assert_eq!(fs::read(artwork.join(banner_tok)).unwrap(), png(1920, 620));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Live Steam API verification; run explicitly with -- --ignored"]
    fn live_steam_lookup_finds_schedule_1_and_variant_covers_and_banners() {
        let dir = std::env::temp_dir().join(format!("orbit-live-art-{}", uuid::Uuid::new_v4()));
        for (query, expected_substr) in [
            ("schedule 1", "Schedule I"),
            ("Schedule1", "Schedule I"),
            ("Hades 2", "Hades II"),
            ("gta 5", "Grand Theft Auto V"),
            ("Civilization 6", "Civilization"),
            ("The Witcher 3: Wild Hunt", "Witcher 3"),
        ] {
            let found = find_online_cover_guarded(query, &dir, &|| true).unwrap();
            let cover = found["cover"].as_str().unwrap_or("");
            let banner = found["banner"].as_str().unwrap_or("");
            let matched = found["matchedName"].as_str().unwrap_or("");
            assert!(
                artwork_token(cover),
                "expected cover for '{query}', got {found}"
            );
            assert!(
                artwork_token(banner),
                "expected banner for '{query}', got {found}"
            );
            assert!(
                matched.contains(expected_substr),
                "expected matchedName containing '{expected_substr}' for '{query}', got '{matched}'"
            );
        }
        // Negative check: Minecraft is not on Steam (only Minecraft Dungeons is).
        let miss = find_online_cover_guarded("Minecraft", &dir, &|| true).unwrap();
        assert_eq!(miss["cover"], "");
        let _ = fs::remove_dir_all(dir);
    }
}

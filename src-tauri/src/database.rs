//! Persistent Orbit library. The on-disk SQLite schema and JSON property names
//! intentionally match the Electron database (src/core/database.cjs).
//! Opening this database migrates existing files in place; it never replaces them.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

const GAME_COLUMNS: &str = "id,name,source,source_id,executable,launch_uri,install_path,cover,banner,icon,genre,tags,favorite,total_play_seconds,last_played_at,created_at,updated_at,launch_args,working_dir,cover_fit,cover_position";
const GAME_FIELDS: [&str; 9] = [
    "source_id",
    "executable",
    "launch_uri",
    "install_path",
    "cover",
    "banner",
    "icon",
    "genre",
    "working_dir",
];
const SETTING_KEYS: [&str; 12] = [
    "theme",
    "accent",
    "reduceMotion",
    "autoScan",
    "useSteamArtwork",
    "libraryFolders",
    "view",
    "sort",
    "onboardingDone",
    "performanceGuard",
    "autoUpdates",
    "libraryDensity",
];
const SOURCES: [&str; 9] = [
    "manual",
    "steam",
    "epic",
    "gog",
    "ea",
    "ubisoft",
    "battlenet",
    "xbox",
    "folder",
];
const MAX_SESSION_SECONDS: i64 = 7 * 86_400;
const STATS_MAX_ROWS: i64 = 100_000;
type DbResult<T> = Result<T, String>;

#[derive(Clone)]
struct StatisticsRow {
    game_id: String,
    start: String,
    finish: String,
    seconds: Option<i64>,
    name: String,
    source: String,
    cover: String,
    icon: String,
}

#[derive(Clone, Copy)]
struct StatisticsEvent {
    at: i64,
    index: usize,
    rate: f64,
    opening: bool,
}

#[derive(Clone, Copy)]
struct StatisticsRate {
    rate: f64,
    index: usize,
}
impl PartialEq for StatisticsRate {
    fn eq(&self, other: &Self) -> bool {
        self.rate.to_bits() == other.rate.to_bits() && self.index == other.index
    }
}
impl Eq for StatisticsRate {}
impl PartialOrd for StatisticsRate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for StatisticsRate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.rate
            .total_cmp(&other.rate)
            .then_with(|| self.index.cmp(&other.index))
    }
}

struct StatisticsGame {
    id: String,
    name: String,
    source: String,
    cover: String,
    icon: String,
    last_played_at: String,
    last_time: i64,
    seconds: f64,
    events: Vec<StatisticsEvent>,
}

fn statistics_midnight_after(timestamp: i64) -> DbResult<i64> {
    let current = Local
        .timestamp_millis_opt(timestamp)
        .single()
        .ok_or("Invalid statistics timestamp.")?;
    let date = current
        .date_naive()
        .succ_opt()
        .ok_or("Statistics date out of range.")?;
    // Some time zones change UTC offset at midnight. Find the first real
    // local hour instead of assuming every local day lasts 24 hours.
    for hour in 0..24 {
        let naive = date
            .and_hms_opt(hour, 0, 0)
            .ok_or("Invalid calendar hour.")?;
        if let Some(next) = Local.from_local_datetime(&naive).earliest() {
            return Ok(next.timestamp_millis());
        }
    }
    Err("No valid local calendar boundary.".into())
}

fn statistics_allocate(
    mut from: i64,
    to: i64,
    rate: f64,
    game: &mut StatisticsGame,
    days: &mut BTreeMap<String, f64>,
    total: &mut f64,
) -> DbResult<()> {
    while from < to {
        let day = Local
            .timestamp_millis_opt(from)
            .single()
            .ok_or("Invalid statistics timestamp.")?
            .format("%Y-%m-%d")
            .to_string();
        let until = to.min(statistics_midnight_after(from)?);
        if until <= from {
            return Err("Statistics calendar cannot advance.".into());
        }
        let seconds = (until - from) as f64 * rate / 1000.0;
        *days.entry(day).or_default() += seconds;
        game.seconds += seconds;
        *total += seconds;
        from = until;
    }
    Ok(())
}

fn statistics_from_rows(
    rows: Vec<StatisticsRow>,
    open_sessions: i64,
    days: i64,
    as_of: DateTime<Local>,
) -> DbResult<Value> {
    let mut games: HashMap<String, StatisticsGame> = HashMap::new();
    let mut day_seconds: BTreeMap<String, f64> = BTreeMap::new();
    let mut invalid_sessions = 0_i64;
    let mut raw_seconds = 0_f64;
    let mut eligible_seconds = 0_f64;
    let mut credited = 0_f64;
    let now = as_of.timestamp_millis();
    for row in rows {
        let start = DateTime::parse_from_rfc3339(&row.start);
        let end = DateTime::parse_from_rfc3339(&row.finish);
        let Some((start, end, raw)) =
            start
                .ok()
                .zip(end.ok())
                .zip(row.seconds)
                .map(|((start, end), seconds)| {
                    (start.timestamp_millis(), end.timestamp_millis(), seconds)
                })
        else {
            invalid_sessions += 1;
            continue;
        };
        if raw < 0
            || end <= start
            || end - start > MAX_SESSION_SECONDS * 1000
            || end > now.saturating_add(300_000)
        {
            invalid_sessions += 1;
            continue;
        }
        let game = games
            .entry(row.game_id.clone())
            .or_insert_with(|| StatisticsGame {
                id: row.game_id,
                name: row.name,
                source: row.source,
                cover: row.cover,
                icon: row.icon,
                last_played_at: row.finish.clone(),
                last_time: i64::MIN,
                seconds: 0.0,
                events: Vec::new(),
            });
        if end > game.last_time {
            game.last_time = end;
            game.last_played_at = row.finish;
        }
        raw_seconds += raw as f64;
        let credit = (raw.min(MAX_SESSION_SECONDS) as f64).min((end - start) as f64 / 1000.0);
        eligible_seconds += credit;
        if credit <= 0.0 {
            continue;
        }
        let rate = credit * 1000.0 / (end - start) as f64;
        let index = game.events.len() / 2;
        game.events.push(StatisticsEvent {
            at: start,
            index,
            rate,
            opening: true,
        });
        game.events.push(StatisticsEvent {
            at: end,
            index,
            rate,
            opening: false,
        });
    }
    for game in games.values_mut() {
        game.events
            .sort_unstable_by(|a, b| a.at.cmp(&b.at).then_with(|| a.opening.cmp(&b.opening)));
        let events = std::mem::take(&mut game.events);
        let mut active: HashSet<usize> = HashSet::new();
        let mut heap: BinaryHeap<StatisticsRate> = BinaryHeap::new();
        let mut previous = None;
        let mut index = 0;
        while index < events.len() {
            let time = events[index].at;
            while heap.peek().is_some_and(|top| !active.contains(&top.index)) {
                heap.pop();
            }
            if let Some(from) = previous {
                if time > from {
                    if let Some(top) = heap.peek() {
                        statistics_allocate(
                            from,
                            time,
                            top.rate,
                            game,
                            &mut day_seconds,
                            &mut credited,
                        )?;
                    }
                }
            }
            while index < events.len() && events[index].at == time {
                let event = events[index];
                if event.opening {
                    active.insert(event.index);
                    heap.push(StatisticsRate {
                        rate: event.rate,
                        index: event.index,
                    });
                } else {
                    active.remove(&event.index);
                }
                index += 1;
            }
            previous = Some(time);
        }
    }
    let today = as_of.date_naive();
    let day_key = |back: i64| -> DbResult<String> {
        Ok(today
            .checked_sub_signed(chrono::Duration::days(back))
            .ok_or("Statistics calendar out of range.")?
            .format("%Y-%m-%d")
            .to_string())
    };
    let total_days = |count: i64| -> DbResult<i64> {
        let mut sum = 0_f64;
        for back in 0..count {
            sum += day_seconds.get(&day_key(back)?).copied().unwrap_or(0.0);
        }
        Ok(sum.round() as i64)
    };
    let mut daily = Vec::with_capacity(days as usize);
    for back in (0..days).rev() {
        let date = day_key(back)?;
        daily.push(json!({"date":date,"seconds":day_seconds.get(&date).copied().unwrap_or(0.0).round() as i64}));
    }
    let mut recent = games.into_values().collect::<Vec<_>>();
    recent.sort_unstable_by(|a, b| b.last_time.cmp(&a.last_time).then_with(|| a.id.cmp(&b.id)));
    let recent_games = recent
        .into_iter()
        .take(8)
        .map(|game| {
            json!({
                "id":game.id,"name":game.name,"source":game.source,"cover":game.cover,
                "icon":game.icon,"seconds":game.seconds.round() as i64,
                "lastPlayedAt":game.last_played_at
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "days":days,"daily":daily,
        "totals":{"week":total_days(7)?,"month":total_days(30)?,"allTime":credited.round() as i64},
        "recentGames":recent_games,
        "meta":{"openSessions":open_sessions,"invalidSessions":invalid_sessions,
                "overlapSeconds":(eligible_seconds - credited).max(0.0).round() as i64,
                "adjustedSeconds":(raw_seconds - eligible_seconds).max(0.0).round() as i64,
                "truncated":false}
    }))
}

fn error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn default_settings() -> Value {
    json!({
        "theme": "dark", "accent": "#8b7aff", "reduceMotion": false,
        "autoScan": false, "useSteamArtwork": true, "scanDownloads": false,
        "libraryFolders": [], "view": "grid", "sort": "name",
        "onboardingDone": false, "performanceGuard": true,
        "autoUpdates": true, "libraryDensity": "comfortable"
    })
}

fn string_length(s: &str) -> usize {
    // JavaScript measures the original values as UTF-16 string lengths.
    s.encode_utf16().count()
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(v) => v.clone(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Array(v) => v
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn picked<'a>(raw: &'a Value, previous: &'a Value, key: &str) -> Option<&'a Value> {
    raw.get(key)
        .filter(|v| !v.is_null())
        .or_else(|| previous.get(key).filter(|v| !v.is_null()))
}

fn string_field(raw: &Value, previous: &Value, key: &str) -> DbResult<String> {
    let val = raw.get(key).or_else(|| previous.get(key));
    match val {
        Some(Value::Null) | None => Ok(String::new()),
        Some(Value::String(s)) if string_length(s) <= 4000 => Ok(s.clone()),
        _ => Err(format!("Invalid {key}.")),
    }
}

/// Lexical normalization matches the duplicate detection used by the Electron
/// app, including case-insensitive Windows executable paths.
pub fn normalized_path(input: &str) -> String {
    let windows = cfg!(windows);
    let separator = if windows { '\\' } else { '/' };
    let text = if windows {
        input.replace('/', "\\")
    } else {
        input.to_owned()
    };
    let prefix = if windows && text.len() >= 2 && text.as_bytes()[1] == b':' {
        &text[..2]
    } else {
        ""
    };
    let remainder = &text[prefix.len()..];
    let is_unc = windows && remainder.starts_with("\\\\");
    let rooted = remainder.starts_with(separator);
    // A UNC server and share constitute the Windows volume root. `..` may
    // remove directories within a share, but must never remove the share.
    let protected_parts = if is_unc { 2 } else { 0 };
    let mut parts: Vec<&str> = Vec::new();
    for part in remainder.split(separator) {
        match part {
            "" | "." => {}
            ".." if parts.len() > protected_parts && parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            ".." if !rooted => parts.push(".."),
            ".." => {}
            _ => parts.push(part),
        }
    }
    let mut result = String::from(prefix);
    if rooted {
        if is_unc {
            result.push(separator);
        }
        result.push(separator);
    }
    result.push_str(&parts.join(&separator.to_string()));
    if result.is_empty() {
        result.push('.');
    }
    if windows {
        result.to_lowercase()
    } else {
        result
    }
}

/// Public so launch/discovery callers can apply the same validation as writes.
pub fn clean_game(raw: &Value, previous: Option<&Value>) -> DbResult<Value> {
    if !raw.is_object() {
        return Err("Invalid game data.".into());
    }
    let empty = json!({});
    let previous = previous.unwrap_or(&empty);
    let name = picked(raw, previous, "name")
        .map(js_string)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if name.is_empty() || string_length(&name) > 140 {
        return Err("Game name must contain 1–140 characters.".into());
    }
    let source = picked(raw, previous, "source")
        .map(js_string)
        .unwrap_or_else(|| "manual".into());
    if !SOURCES.contains(&source.as_str()) {
        return Err("Unsupported game source.".into());
    }
    let mut result = Map::new();
    for key in GAME_FIELDS {
        let mut s = string_field(raw, previous, key)?;
        if key == "executable" && Path::new(&s).is_absolute() {
            // Preserve the case of the stored path. Only duplicate keys fold case.
            s = normalized_executable(&s);
        }
        result.insert(key.into(), Value::String(s));
    }
    let mut args = picked(raw, previous, "launch_args")
        .cloned()
        .unwrap_or_else(|| json!([]));
    if let Some(text) = args.as_str() {
        args = serde_json::from_str(text)
            .map_err(|_| "Launch arguments must be a JSON array.".to_string())?;
    }
    match args.as_array() {
        Some(items)
            if items.len() <= 80
                && items
                    .iter()
                    .all(|a| a.as_str().is_some_and(|s| string_length(s) <= 1024)) => {}
        _ => return Err("Launch arguments must be an array of short strings.".into()),
    }
    let raw_tags = picked(raw, previous, "tags")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let tags = if let Some(raw) = raw_tags.as_str() {
        raw.split(',')
            .map(|s| Value::String(s.to_owned()))
            .collect::<Vec<_>>()
    } else {
        raw_tags
            .as_array()
            .ok_or_else(|| "Invalid tags.".to_string())?
            .clone()
    };
    if tags.len() > 40 {
        return Err("Invalid tags.".into());
    }
    let mut unique = HashSet::new();
    let mut clean_tags = Vec::new();
    for tag in tags {
        let tag = js_string(&tag).trim().to_owned();
        if !tag.is_empty() && unique.insert(tag.clone()) {
            if string_length(&tag) > 36 {
                return Err("Tags must be 36 characters or shorter.".into());
            }
            clean_tags.push(Value::String(tag));
        }
    }
    let fit = picked(raw, previous, "cover_fit")
        .map(js_string)
        .unwrap_or_else(|| "cover".into());
    let position = picked(raw, previous, "cover_position")
        .map(js_string)
        .unwrap_or_else(|| "center".into());
    if !["cover", "contain"].contains(&fit.as_str())
        || !["top", "center", "bottom"].contains(&position.as_str())
    {
        return Err("Invalid cover presentation.".into());
    }
    result.insert("name".into(), json!(name));
    result.insert("source".into(), json!(source));
    result.insert("tags".into(), Value::Array(clean_tags));
    result.insert("launch_args".into(), args);
    result.insert("cover_fit".into(), json!(fit));
    result.insert("cover_position".into(), json!(position));
    result.insert(
        "favorite".into(),
        json!(js_truthy(raw.get("favorite").unwrap_or_else(|| {
            previous.get("favorite").unwrap_or(&Value::Null)
        }))),
    );
    Ok(Value::Object(result))
}

fn normalized_executable(s: &str) -> String {
    if !cfg!(windows) {
        return normalized_path(s);
    }
    // Windows path.normalize preserves casing; case folding is only for keys.
    let normalized = normalized_path(s);
    if normalized == s.to_lowercase() {
        return s.replace('/', "\\");
    }
    // Resolve dot segments without modifying the remaining stored component case.
    let prefix = if s.len() >= 2 && s.as_bytes()[1] == b':' {
        &s[..2]
    } else {
        ""
    };
    let remainder = s[prefix.len()..].replace('/', "\\");
    let rooted = remainder.starts_with('\\');
    let unc = remainder.starts_with("\\\\");
    let protected_parts = if unc { 2 } else { 0 };
    let mut parts = Vec::new();
    for component in remainder.split('\\') {
        match component {
            "" | "." => {}
            ".." if parts.len() > protected_parts && parts.last().is_some_and(|v| *v != "..") => {
                parts.pop();
            }
            ".." if !rooted => parts.push(".."),
            ".." => {}
            _ => parts.push(component),
        }
    }
    format!(
        "{prefix}{}{}",
        if unc {
            "\\\\"
        } else if rooted {
            "\\"
        } else {
            ""
        },
        parts.join("\\")
    )
}

pub fn duplicate_key(game: &Value) -> String {
    let val = |key| game.get(key).and_then(Value::as_str).unwrap_or("");
    let source = val("source");
    let source_id = val("source_id");
    if !source_id.is_empty() && !source.is_empty() && !["manual", "folder"].contains(&source) {
        return format!("{source}:{source_id}").to_lowercase();
    }
    if !val("executable").is_empty() {
        return format!("file:{}", normalized_path(val("executable")));
    }
    if !val("launch_uri").is_empty() {
        return format!("uri:{}", val("launch_uri").to_lowercase());
    }
    String::new()
}

fn game_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut game = Map::new();
    for field in [
        "id",
        "name",
        "source",
        "source_id",
        "executable",
        "launch_uri",
        "install_path",
        "cover",
        "banner",
        "icon",
        "genre",
        "created_at",
        "updated_at",
        "working_dir",
        "cover_fit",
        "cover_position",
    ] {
        game.insert(field.into(), json!(row.get::<_, String>(field)?));
    }
    game.insert(
        "favorite".into(),
        json!(row.get::<_, i64>("favorite")? != 0),
    );
    game.insert(
        "total_play_seconds".into(),
        json!(row.get::<_, i64>("total_play_seconds")?),
    );
    game.insert(
        "last_played_at".into(),
        json!(row.get::<_, Option<String>>("last_played_at")?),
    );
    for field in ["tags", "launch_args"] {
        let value = row.get::<_, String>(field)?;
        game.insert(
            field.into(),
            serde_json::from_str(&value).unwrap_or_else(|_| json!([])),
        );
    }
    Ok(Value::Object(game))
}

fn column_names(tx: &Transaction<'_>, table: &str) -> DbResult<HashSet<String>> {
    let mut stmt = tx
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(error)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(error)?;
    rows.collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(error)
}

fn migrate(conn: &mut Connection) -> DbResult<()> {
    let tx = conn.transaction().map_err(error)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS games (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
            source_id TEXT NOT NULL DEFAULT '', executable TEXT NOT NULL DEFAULT '',
            launch_uri TEXT NOT NULL DEFAULT '', install_path TEXT NOT NULL DEFAULT '',
            cover TEXT NOT NULL DEFAULT '', banner TEXT NOT NULL DEFAULT '',
            icon TEXT NOT NULL DEFAULT '', genre TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]', favorite INTEGER NOT NULL DEFAULT 0,
            total_play_seconds INTEGER NOT NULL DEFAULT 0, last_played_at TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            launch_args TEXT NOT NULL DEFAULT '[]', working_dir TEXT NOT NULL DEFAULT '',
            cover_fit TEXT NOT NULL DEFAULT 'cover', cover_position TEXT NOT NULL DEFAULT 'center',
            duplicate_key TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
            started_at TEXT NOT NULL, finished_at TEXT, seconds INTEGER NOT NULL DEFAULT 0,
            heartbeat_seconds INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT
        );",
    )
    .map_err(error)?;
    let columns = column_names(&tx, "games")?;
    // All additions are non-destructive and have defaults for old rows. This
    // also supports files which predate more than one optional column.
    for (name, definition) in [
        ("source", "source TEXT NOT NULL DEFAULT 'manual'"),
        ("source_id", "source_id TEXT NOT NULL DEFAULT ''"),
        ("executable", "executable TEXT NOT NULL DEFAULT ''"),
        ("launch_uri", "launch_uri TEXT NOT NULL DEFAULT ''"),
        ("install_path", "install_path TEXT NOT NULL DEFAULT ''"),
        ("cover", "cover TEXT NOT NULL DEFAULT ''"),
        ("banner", "banner TEXT NOT NULL DEFAULT ''"),
        ("icon", "icon TEXT NOT NULL DEFAULT ''"),
        ("genre", "genre TEXT NOT NULL DEFAULT ''"),
        ("tags", "tags TEXT NOT NULL DEFAULT '[]'"),
        ("favorite", "favorite INTEGER NOT NULL DEFAULT 0"),
        (
            "total_play_seconds",
            "total_play_seconds INTEGER NOT NULL DEFAULT 0",
        ),
        ("last_played_at", "last_played_at TEXT"),
        ("created_at", "created_at TEXT NOT NULL DEFAULT ''"),
        ("updated_at", "updated_at TEXT NOT NULL DEFAULT ''"),
        ("launch_args", "launch_args TEXT NOT NULL DEFAULT '[]'"),
        ("working_dir", "working_dir TEXT NOT NULL DEFAULT ''"),
        ("cover_fit", "cover_fit TEXT NOT NULL DEFAULT 'cover'"),
        (
            "cover_position",
            "cover_position TEXT NOT NULL DEFAULT 'center'",
        ),
        ("duplicate_key", "duplicate_key TEXT NOT NULL DEFAULT ''"),
    ] {
        if !columns.contains(name) {
            tx.execute_batch(&format!("ALTER TABLE games ADD COLUMN {definition}"))
                .map_err(error)?;
        }
    }
    let columns = column_names(&tx, "sessions")?;
    for (name, definition) in [
        ("finished_at", "finished_at TEXT"),
        ("seconds", "seconds INTEGER NOT NULL DEFAULT 0"),
        (
            "heartbeat_seconds",
            "heartbeat_seconds INTEGER NOT NULL DEFAULT 0",
        ),
        ("last_seen_at", "last_seen_at TEXT"),
    ] {
        if !columns.contains(name) {
            tx.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {definition}"))
                .map_err(error)?;
        }
    }
    // Rebuild only the derived uniqueness key where absent. If an old library
    // already contains duplicate entries, keep ALL user records and leave
    // the later conflicting key blank, so the unique index can be installed.
    let existing = {
        let mut stmt = tx.prepare("SELECT id,source,source_id,executable,launch_uri,duplicate_key FROM games ORDER BY rowid").map_err(error)?;
        let items = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(error)?;
        items.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?
    };
    let mut assigned = HashSet::new();
    let mut rewrites = Vec::new();
    for (id, source, source_id, executable, launch_uri, stored_key) in existing {
        let key = duplicate_key(&json!({
            "source": source, "source_id": source_id,
            "executable": executable, "launch_uri": launch_uri
        }));
        let valid_key = if !key.is_empty() && assigned.insert(key.clone()) {
            key
        } else {
            String::new()
        };
        if stored_key != valid_key {
            rewrites.push((id, valid_key));
        }
    }
    // Clear changed keys before assigning replacements: the original unique
    // index may already exist, and changing keys in place could conflict
    // temporarily even if the final set is unique.
    for (id, _) in &rewrites {
        tx.execute("UPDATE games SET duplicate_key='' WHERE id=?1", [id])
            .map_err(error)?;
    }
    for (id, key) in rewrites {
        if !key.is_empty() {
            tx.execute(
                "UPDATE games SET duplicate_key=?1 WHERE id=?2",
                params![key, id],
            )
            .map_err(error)?;
        }
    }
    tx.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_games_duplicate ON games(duplicate_key) WHERE duplicate_key != '';
         CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);
         CREATE INDEX IF NOT EXISTS idx_games_executable ON games(executable) WHERE executable != '';
         CREATE INDEX IF NOT EXISTS idx_games_uri ON games(launch_uri COLLATE NOCASE) WHERE launch_uri != '';
         CREATE INDEX IF NOT EXISTS idx_games_executable_nocase ON games(executable COLLATE NOCASE) WHERE executable != '';
         CREATE INDEX IF NOT EXISTS idx_games_recent ON games(last_played_at);"
    ).map_err(error)?;
    tx.commit().map_err(error)
}

pub struct LibraryDatabase {
    conn: Connection,
}

impl LibraryDatabase {
    pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        if let Some(parent) = path.as_ref().parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(error)?;
        }
        let mut conn = Connection::open(path).map_err(error)?;
        conn.busy_timeout(Duration::from_millis(3000))
            .map_err(error)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(error)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(error)?;
        migrate(&mut conn)?;
        Ok(Self { conn })
    }

    pub fn new(path: impl AsRef<Path>) -> DbResult<Self> {
        Self::open(path)
    }

    pub fn get_settings(&self) -> DbResult<Value> {
        let mut settings = default_settings();
        let mut stmt = self
            .conn
            .prepare("SELECT key,value FROM settings")
            .map_err(error)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(error)?;
        for row in rows {
            let (key, text) = row.map_err(error)?;
            if settings.get(&key).is_none() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if !valid_setting(&key, &value) {
                continue;
            }
            if let Some(map) = settings.as_object_mut() {
                map.insert(key, value);
            }
        }
        settings["scanDownloads"] = json!(false);
        Ok(settings)
    }

    pub fn save_settings(&mut self, input: &Value) -> DbResult<Value> {
        let current = self.get_settings()?;
        let mut next = current.clone();
        for key in SETTING_KEYS {
            if let Some(value) = input.get(key) {
                next[key] = value.clone();
            }
        }
        if !["dark", "light", "system"].contains(&next["theme"].as_str().unwrap_or("")) {
            return Err("Invalid theme.".into());
        }
        if !valid_accent(&next["accent"]) {
            return Err("Invalid accent color.".into());
        }
        if !valid_preferences(&next) {
            return Err("Invalid library preferences.".into());
        }
        if !valid_folders(&next["libraryFolders"]) {
            return Err("Invalid library folders.".into());
        }
        for key in [
            "reduceMotion",
            "autoScan",
            "useSteamArtwork",
            "onboardingDone",
            "performanceGuard",
            "autoUpdates",
        ] {
            next[key] = json!(js_truthy(&next[key]));
        }
        let tx = self.conn.transaction().map_err(error)?;
        for key in SETTING_KEYS {
            if current[key] != next[key] {
                tx.execute(
                    "INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![key, next[key].to_string()],
                ).map_err(error)?;
            }
        }
        tx.commit().map_err(error)?;
        Ok(next)
    }

    pub fn list(&self, sort: &str) -> DbResult<Value> {
        let order = sort_order(sort);
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT {GAME_COLUMNS} FROM games ORDER BY {order}"
            ))
            .map_err(error)?;
        let games = stmt
            .query_map([], game_from_row)
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        Ok(Value::Array(games))
    }

    /// Reporting only: reads completed session rows and never updates historical
    /// playtime, counters, checkpoints, or session ownership.
    pub fn get_statistics(&self, days: i64) -> DbResult<Value> {
        self.get_statistics_at(days, Local::now())
    }

    fn get_statistics_at(&self, days: i64, as_of: DateTime<Local>) -> DbResult<Value> {
        if !(7..=90).contains(&days) {
            return Err("Statistics days must be an integer from 7 to 90.".into());
        }
        let open_sessions: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE finished_at IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.game_id,s.started_at,s.finished_at,s.seconds,g.name,g.source,g.cover,g.icon
                 FROM sessions s INNER JOIN games g ON g.id=s.game_id
                 WHERE s.finished_at IS NOT NULL
                 ORDER BY s.game_id,s.started_at,s.id LIMIT ?1",
            )
            .map_err(error)?;
        let rows = stmt
            .query_map([STATS_MAX_ROWS + 1], |row| {
                Ok(StatisticsRow {
                    game_id: row.get(0)?,
                    start: row.get::<_, String>(1).unwrap_or_default(),
                    finish: row.get::<_, String>(2).unwrap_or_default(),
                    seconds: row.get::<_, i64>(3).ok(),
                    name: row.get(4)?,
                    source: row.get(5)?,
                    cover: row.get(6)?,
                    icon: row.get(7)?,
                })
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        if rows.len() > STATS_MAX_ROWS as usize {
            return Err("Statistics history exceeds the safe 100000-session read limit.".into());
        }
        statistics_from_rows(rows, open_sessions, days, as_of)
    }

    pub fn list_activity_games(&self) -> DbResult<Value> {
        let mut stmt = self.conn.prepare(
            "SELECT id,name,source,install_path,executable,launch_uri FROM games
             WHERE executable != '' OR (install_path != '' AND (source IN ('steam','epic') OR launch_uri != ''))"
        ).map_err(error)?;
        let entries = stmt
            .query_map([], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "source": row.get::<_, String>(2)?,
                    "install_path": row.get::<_, String>(3)?,
                    "executable": row.get::<_, String>(4)?,
                    "launch_uri": row.get::<_, String>(5)?
                }))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        Ok(Value::Array(entries))
    }

    pub fn get(&self, id: &str) -> DbResult<Value> {
        Self::get_on(&self.conn, id)
    }

    fn get_on(conn: &Connection, id: &str) -> DbResult<Value> {
        conn.query_row(
            &format!("SELECT {GAME_COLUMNS} FROM games WHERE id=?1"),
            [id],
            game_from_row,
        )
        .optional()
        .map_err(error)
        .map(|v| v.unwrap_or(Value::Null))
    }

    pub fn count(&self) -> DbResult<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))
            .map_err(error)
    }
}

fn valid_accent(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    })
}

fn valid_folders(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.len() <= 60
            && items
                .iter()
                .all(|v| v.as_str().is_some_and(|s| string_length(s) <= 4000))
    })
}

fn valid_preferences(v: &Value) -> bool {
    ["grid", "list"].contains(&v["view"].as_str().unwrap_or(""))
        && ["name", "recent", "added", "time"].contains(&v["sort"].as_str().unwrap_or(""))
        && ["comfortable", "compact"].contains(&v["libraryDensity"].as_str().unwrap_or(""))
}

fn valid_setting(key: &str, value: &Value) -> bool {
    match key {
        "theme" => ["dark", "light", "system"].contains(&value.as_str().unwrap_or("")),
        "accent" => valid_accent(value),
        "view" => ["grid", "list"].contains(&value.as_str().unwrap_or("")),
        "sort" => ["name", "recent", "added", "time"].contains(&value.as_str().unwrap_or("")),
        "libraryDensity" => ["comfortable", "compact"].contains(&value.as_str().unwrap_or("")),
        "libraryFolders" => valid_folders(value),
        "reduceMotion" | "autoScan" | "useSteamArtwork" | "scanDownloads" | "onboardingDone"
        | "performanceGuard" | "autoUpdates" => value.is_boolean(),
        _ => false,
    }
}

fn sort_order(sort: &str) -> &'static str {
    match sort {
        "recent" => "last_played_at DESC, name COLLATE NOCASE ASC",
        "added" => "created_at DESC",
        "time" => "total_play_seconds DESC, name COLLATE NOCASE ASC",
        _ => "name COLLATE NOCASE ASC",
    }
}

fn field<'a>(game: &'a Value, key: &str) -> &'a str {
    game.get(key).and_then(Value::as_str).unwrap_or("")
}

fn has_store_identity(game: &Value) -> bool {
    !field(game, "source_id").is_empty()
        && !field(game, "source").is_empty()
        && !["manual", "folder"].contains(&field(game, "source"))
}

fn find_executable_duplicate_on(
    conn: &Connection,
    executable: &str,
    except: &str,
) -> DbResult<Option<String>> {
    find_executable_duplicate_for(conn, executable, except, false)
}

fn find_executable_duplicate_for(
    conn: &Connection,
    executable: &str,
    except: &str,
    alias_only: bool,
) -> DbResult<Option<String>> {
    if executable.is_empty() {
        return Ok(None);
    }
    let comparison = if cfg!(windows) {
        "executable=?1 COLLATE NOCASE"
    } else {
        "executable=?1"
    };
    // Verified store product identities remain distinct even when they share
    // an installed executable. Unkeyed/manual entries remain deduplicated.
    let filter = if alias_only {
        " AND (source IN ('manual','folder') OR source_id = '')"
    } else {
        ""
    };
    conn.query_row(
        &format!("SELECT id FROM games WHERE executable != '' AND {comparison} AND id != ?2{filter} ORDER BY rowid LIMIT 1"),
        params![normalized_executable(executable), except],
        |r| r.get(0),
    )
    .optional()
    .map_err(error)
}

fn find_uri_duplicate_on(conn: &Connection, uri: &str, except: &str) -> DbResult<Option<String>> {
    find_uri_duplicate_for(conn, uri, except, false)
}

fn find_uri_duplicate_for(
    conn: &Connection,
    uri: &str,
    except: &str,
    alias_only: bool,
) -> DbResult<Option<String>> {
    if uri.is_empty() {
        return Ok(None);
    }
    let filter = if alias_only {
        " AND (source IN ('manual','folder') OR source_id = '')"
    } else {
        ""
    };
    conn.query_row(
        &format!("SELECT id FROM games WHERE launch_uri != '' AND launch_uri=?1 COLLATE NOCASE AND id != ?2{filter} ORDER BY rowid LIMIT 1"),
        params![uri, except],
        |r| r.get(0),
    ).optional().map_err(error)
}

fn find_duplicate_on(
    conn: &Connection,
    game: &Value,
    key: &str,
    except: &str,
) -> DbResult<Option<String>> {
    if !key.is_empty() {
        if let Some(id) = conn
            .query_row(
                "SELECT id FROM games WHERE duplicate_key=?1 AND id != ?2 LIMIT 1",
                params![key, except],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?
        {
            return Ok(Some(id));
        }
    }
    let alias_only = has_store_identity(game);
    if let Some(id) =
        find_executable_duplicate_for(conn, field(game, "executable"), except, alias_only)?
    {
        return Ok(Some(id));
    }
    find_uri_duplicate_for(conn, field(game, "launch_uri"), except, alias_only)
}

fn insert_on(conn: &Connection, game: &Value, key: &str) -> DbResult<Value> {
    let id = Uuid::new_v4().to_string();
    let date = stamp();
    let tags = game["tags"].to_string();
    let args = game["launch_args"].to_string();
    let favorite = i64::from(js_truthy(&game["favorite"]));
    conn.execute(
        "INSERT INTO games (
            id,name,source,source_id,executable,launch_uri,install_path,cover,banner,icon,
            genre,tags,favorite,total_play_seconds,last_played_at,created_at,updated_at,
            launch_args,working_dir,cover_fit,cover_position,duplicate_key
        ) VALUES (
            ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,NULL,?14,?15,
            ?16,?17,?18,?19,?20
        )",
        params![
            id,
            field(game, "name"),
            field(game, "source"),
            field(game, "source_id"),
            field(game, "executable"),
            field(game, "launch_uri"),
            field(game, "install_path"),
            field(game, "cover"),
            field(game, "banner"),
            field(game, "icon"),
            field(game, "genre"),
            tags,
            favorite,
            date,
            date,
            args,
            field(game, "working_dir"),
            field(game, "cover_fit"),
            field(game, "cover_position"),
            key
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "This game is already in your library.".into()
        } else {
            error(e)
        }
    })?;
    LibraryDatabase::get_on(conn, &id)
}

fn update_on(conn: &Connection, id: &str, patch: &Value) -> DbResult<Value> {
    let previous = LibraryDatabase::get_on(conn, id)?;
    if previous.is_null() {
        return Err("Game not found.".into());
    }
    let game = clean_game(patch, Some(&previous))?;
    if find_executable_duplicate_for(
        conn,
        field(&game, "executable"),
        id,
        has_store_identity(&game),
    )?
    .is_some()
    {
        return Err("This executable is already in your library.".into());
    }
    if find_uri_duplicate_for(
        conn,
        field(&game, "launch_uri"),
        id,
        has_store_identity(&game),
    )?
    .is_some()
    {
        return Err("This launcher link is already in your library.".into());
    }
    let key = duplicate_key(&game);
    if !key.is_empty()
        && conn
            .query_row(
                "SELECT 1 FROM games WHERE duplicate_key=?1 AND id!=?2 LIMIT 1",
                params![key, id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(error)?
            .is_some()
    {
        return Err("This game is already in your library.".into());
    }
    let date = stamp();
    let tags = game["tags"].to_string();
    let args = game["launch_args"].to_string();
    conn.execute(
        "UPDATE games SET
            name=?1,source=?2,source_id=?3,executable=?4,launch_uri=?5,install_path=?6,
            cover=?7,banner=?8,icon=?9,genre=?10,tags=?11,favorite=?12,
            launch_args=?13,working_dir=?14,cover_fit=?15,cover_position=?16,
            duplicate_key=?17,updated_at=?18 WHERE id=?19",
        params![
            field(&game, "name"),
            field(&game, "source"),
            field(&game, "source_id"),
            field(&game, "executable"),
            field(&game, "launch_uri"),
            field(&game, "install_path"),
            field(&game, "cover"),
            field(&game, "banner"),
            field(&game, "icon"),
            field(&game, "genre"),
            tags,
            i64::from(js_truthy(&game["favorite"])),
            args,
            field(&game, "working_dir"),
            field(&game, "cover_fit"),
            field(&game, "cover_position"),
            key,
            date,
            id
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "This game is already in your library.".into()
        } else {
            error(e)
        }
    })?;
    LibraryDatabase::get_on(conn, id)
}

fn upsert_on(conn: &Connection, raw: &Value, update_existing: bool) -> DbResult<Value> {
    let game = clean_game(raw, None)?;
    let key = duplicate_key(&game);
    if let Some(id) = find_duplicate_on(conn, &game, &key, "")? {
        let existing = if update_existing {
            update_on(conn, &id, raw)?
        } else {
            LibraryDatabase::get_on(conn, &id)?
        };
        return Ok(json!({"game": existing, "added": false}));
    }
    Ok(json!({"game": insert_on(conn, &game, &key)?, "added": true}))
}

fn iso_date(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    if string_length(s) > 50 {
        return None;
    }
    if let Ok(date) = DateTime::parse_from_rfc3339(s) {
        return Some(
            date.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        );
    }
    if let Ok(date) = DateTime::parse_from_rfc2822(s) {
        return Some(
            date.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        );
    }
    if let Ok(date) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Some(date.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    if let Ok(date) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|d| d.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    None
}

impl LibraryDatabase {
    pub fn find_executable_duplicate(&self, executable: &str, except_id: &str) -> DbResult<Value> {
        find_executable_duplicate_on(&self.conn, executable, except_id)
            .map(|id| id.map_or(Value::Null, |id| json!({"id": id})))
    }

    pub fn find_uri_duplicate(&self, uri: &str, except_id: &str) -> DbResult<Value> {
        find_uri_duplicate_on(&self.conn, uri, except_id)
            .map(|id| id.map_or(Value::Null, |id| json!({"id": id})))
    }

    pub fn upsert(&mut self, raw: &Value) -> DbResult<Value> {
        upsert_on(&self.conn, raw, false)
    }

    pub fn upsert_with_option(&mut self, raw: &Value, update_existing: bool) -> DbResult<Value> {
        upsert_on(&self.conn, raw, update_existing)
    }

    pub fn upsert_batch(&mut self, items: &[Value]) -> DbResult<Value> {
        if items.len() > 100 {
            return Err("Import batch must contain at most 100 games.".into());
        }
        let tx = self.conn.transaction().map_err(error)?;
        let (mut imported, mut skipped) = (0, 0);
        let mut errors = Vec::new();
        let mut added_games = Vec::new();
        for item in items {
            match upsert_on(&tx, item, false) {
                Ok(result) if result["added"] == true => {
                    imported += 1;
                    added_games.push(result["game"].clone());
                }
                Ok(_) => skipped += 1,
                Err(e) => {
                    let name = item
                        .get("name")
                        .filter(|v| js_truthy(v))
                        .map(js_string)
                        .unwrap_or_else(|| "Entry".into());
                    errors.push(format!(
                        "{}: {e}",
                        name.chars().take(100).collect::<String>()
                    ));
                }
            }
        }
        tx.commit().map_err(error)?;
        Ok(json!({"imported":imported,"skipped":skipped,"errors":errors,"addedGames":added_games}))
    }

    /// Imports the metadata from a JSON backup without reusing untrusted IDs.
    /// The app's backup handler should validate/copy artwork before invoking it.
    pub fn restore_game(&mut self, raw: &Value) -> DbResult<Value> {
        // Number.isSafeInteger in the old JavaScript importer also accepts
        // JSON numbers such as 12500.0, provided their value is integral.
        let seconds = raw
            .get("total_play_seconds")
            .and_then(Value::as_f64)
            .filter(|n| {
                n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0
            })
            .map(|n| n.min((100_i64 * 365 * 24 * 3600) as f64) as i64)
            .unwrap_or(0);
        let last_played = raw.get("last_played_at").and_then(iso_date);
        let created = raw.get("created_at").and_then(iso_date);
        let tx = self.conn.transaction().map_err(error)?;
        let mut result = upsert_on(&tx, raw, false)?;
        if result["added"] == true {
            let id = field(&result["game"], "id").to_owned();
            let created =
                created.unwrap_or_else(|| field(&result["game"], "created_at").to_owned());
            tx.execute(
                "UPDATE games SET total_play_seconds=?1,last_played_at=?2,created_at=?3 WHERE id=?4",
                params![seconds, last_played, created, id],
            ).map_err(error)?;
            result["game"] = Self::get_on(&tx, &id)?;
        }
        tx.commit().map_err(error)?;
        Ok(result)
    }

    pub fn update(&mut self, id: &str, patch: &Value) -> DbResult<Value> {
        update_on(&self.conn, id, patch)
    }

    pub fn toggle_favorite(&mut self, id: &str) -> DbResult<Value> {
        let existing = self.get(id)?;
        if existing.is_null() {
            return Err("Game not found.".into());
        }
        update_on(
            &self.conn,
            id,
            &json!({"favorite": !js_truthy(&existing["favorite"])}),
        )
    }

    pub fn remove(&mut self, id: &str) -> DbResult<bool> {
        self.conn
            .execute("DELETE FROM games WHERE id=?1", [id])
            .map(|count| count > 0)
            .map_err(error)
    }

    pub fn start_session(&mut self, game_id: &str) -> DbResult<String> {
        if self.get(game_id)?.is_null() {
            return Err("Game not found.".into());
        }
        let id = Uuid::new_v4().to_string();
        let date = stamp();
        // Serialize the check and insertion across SQLite connections, not
        // only this process's in-memory active map. A second Orbit instance
        // must never credit a parallel interval for the same game.
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let active: i64 = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE game_id=?1 AND finished_at IS NULL)",
                [game_id],
                |row| row.get(0),
            )
            .map_err(error)?;
        if active != 0 {
            return Err("This game already has an unfinished playtime session.".into());
        }
        tx.execute(
            "INSERT INTO sessions(id,game_id,started_at) VALUES (?1,?2,?3)",
            params![id, game_id, date],
        )
        .map_err(error)?;
        tx.execute(
            "UPDATE games SET last_played_at=?1,updated_at=?1 WHERE id=?2",
            params![date, game_id],
        )
        .map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(id)
    }

    /// Record a successful launcher URI/open operation when there is no
    /// trackable child process. This marks the game recently played without
    /// inventing a duration or leaving a dangling session to recover.
    pub fn record_external_launch(&mut self, id: &str) -> DbResult<()> {
        if self.get(id)?.is_null() {
            return Err("Game not found.".into());
        }
        let date = stamp();
        self.conn
            .execute(
                "UPDATE games SET last_played_at=?1,updated_at=?1 WHERE id=?2",
                params![date, id],
            )
            .map_err(error)?;
        Ok(())
    }

    pub fn checkpoint_sessions(&mut self, entries: &[Value]) -> DbResult<usize> {
        if entries.is_empty() {
            return Ok(0);
        }
        let date = stamp();
        let tx = self.conn.transaction().map_err(error)?;
        let mut changed = 0;
        for entry in entries {
            let Some(id) = entry.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(seconds) = entry
                .get("seconds")
                .and_then(Value::as_f64)
                .filter(|s| s.is_finite())
            else {
                continue;
            };
            let seconds = seconds.floor().max(0.0).min(MAX_SESSION_SECONDS as f64) as i64;
            changed += tx
                .execute(
                    "UPDATE sessions SET heartbeat_seconds=?1,last_seen_at=?2
                 WHERE id=?3 AND finished_at IS NULL AND heartbeat_seconds<=?1",
                    params![seconds, date, id],
                )
                .map_err(error)?;
        }
        tx.commit().map_err(error)?;
        Ok(changed)
    }

    /// Close unfinished sessions using only the last durable checkpoint.
    /// Repeated recovery is idempotent; playtime is never credited twice.
    pub fn recover_interrupted_sessions(&mut self) -> DbResult<usize> {
        let tx = self.conn.transaction().map_err(error)?;
        let stale = {
            let mut stmt = tx
                .prepare(
                    "SELECT id,game_id,heartbeat_seconds FROM sessions WHERE finished_at IS NULL",
                )
                .map_err(error)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .map_err(error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?
        };
        let date = stamp();
        let mut count = 0;
        for (id, game_id, heartbeat) in stale {
            let seconds = heartbeat.clamp(0, MAX_SESSION_SECONDS);
            if tx.execute(
                "UPDATE sessions SET finished_at=?1,seconds=?2 WHERE id=?3 AND finished_at IS NULL",
                params![date, seconds, id],
            ).map_err(error)? > 0 {
                tx.execute(
                    "UPDATE games SET total_play_seconds=total_play_seconds+?1,updated_at=?2 WHERE id=?3",
                    params![seconds, date, game_id],
                ).map_err(error)?;
                count += 1;
            }
        }
        tx.commit().map_err(error)?;
        Ok(count)
    }

    pub fn finish_session(&mut self, session_id: &str, seconds: i64) -> DbResult<bool> {
        let tx = self.conn.transaction().map_err(error)?;
        let game_id: Option<String> = tx
            .query_row(
                "SELECT game_id FROM sessions WHERE id=?1 AND finished_at IS NULL",
                [session_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        let Some(game_id) = game_id else {
            return Ok(false);
        };
        let seconds = seconds.clamp(0, MAX_SESSION_SECONDS);
        let date = stamp();
        tx.execute(
            "UPDATE sessions SET finished_at=?1,seconds=?2 WHERE id=?3 AND finished_at IS NULL",
            params![date, seconds, session_id],
        )
        .map_err(error)?;
        tx.execute(
            "UPDATE games SET total_play_seconds=total_play_seconds+?1,updated_at=?2 WHERE id=?3",
            params![seconds, date, game_id],
        )
        .map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(true)
    }

    /// Metadata-only JSON export. The .orbit gzip archive and safe artwork
    /// installation are handled by the separate backup/packaging layer.
    pub fn export_json(&self) -> DbResult<Value> {
        Ok(json!({
            "format": "orbit.library.v1",
            "exported_at": stamp(),
            "settings": self.get_settings()?,
            "games": self.list("name")?
        }))
    }

    /// Accepts the exact JSON shape exported by Electron's exportLibrary.
    /// Per-item failures are reported and the remaining valid games imported.
    /// Callers must validate artwork file names/files before database insertion.
    pub fn restore_json(&mut self, payload: &Value) -> DbResult<Value> {
        if payload.get("format").and_then(Value::as_str) != Some("orbit.library.v1") {
            return Err("Unrecognized Orbit backup format.".into());
        }
        let games = payload
            .get("games")
            .and_then(Value::as_array)
            .ok_or_else(|| "Unrecognized Orbit backup format.".to_string())?;
        if games.len() > 100_000 {
            return Err("Unrecognized Orbit backup format.".into());
        }
        let games = games.clone();
        let settings = payload.get("settings").cloned();
        let (mut imported, mut skipped) = (0, 0);
        let mut errors = Vec::new();
        for game in games {
            match self.restore_game(&game) {
                Ok(result) if result["added"] == true => imported += 1,
                Ok(_) => skipped += 1,
                Err(message) => {
                    let name = game
                        .get("name")
                        .filter(|v| js_truthy(v))
                        .map(js_string)
                        .unwrap_or_else(|| "Entry".into());
                    errors.push(format!(
                        "{}: {message}",
                        name.chars().take(80).collect::<String>()
                    ));
                }
            }
        }
        let mut settings_restored = false;
        if let Some(value) = settings.filter(Value::is_object) {
            match self.save_settings(&value) {
                Ok(_) => settings_restored = true,
                Err(message) => errors.push(format!("Settings: {message}")),
            }
        }
        Ok(json!({
            "imported": imported, "skipped": skipped, "errors": errors,
            "settingsRestored": settings_restored
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // Keep tests independent of tempfile and always close SQLite handles
    // before removing the isolated test folder on Windows.
    fn with_database(test: impl FnOnce(&mut LibraryDatabase, &Path)) {
        let root = std::env::temp_dir().join(format!("orbit-rust-db-{}", Uuid::new_v4()));
        let file = root.join("data").join("library.sqlite");
        let mut db = LibraryDatabase::open(&file).unwrap();
        test(&mut db, &file);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn statistics_split_local_midnight_deduplicate_and_ignore_open_sessions_without_writes() {
        with_database(|db, _| {
            let main = db
                .upsert(&json!({"name":"Main","source":"steam","source_id":"stats-main"}))
                .unwrap();
            let bonus = db
                .upsert(&json!({"name":"Bonus","source":"epic","source_id":"stats-bonus"}))
                .unwrap();
            let main_id = field(&main["game"], "id");
            let bonus_id = field(&bonus["game"], "id");
            let local_time = |day, hour, minute| {
                Local
                    .with_ymd_and_hms(2026, 11, day, hour, minute, 0)
                    .single()
                    .unwrap()
                    .to_rfc3339()
            };
            for (id, game_id, start, finish, seconds) in [
                (
                    "main",
                    main_id,
                    local_time(3, 23, 50),
                    local_time(4, 0, 10),
                    1200,
                ),
                (
                    "overlap",
                    main_id,
                    local_time(3, 23, 55),
                    local_time(4, 0, 5),
                    600,
                ),
                (
                    "bonus",
                    bonus_id,
                    local_time(4, 0, 0),
                    local_time(4, 0, 30),
                    1800,
                ),
            ] {
                db.conn.execute(
                    "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES (?1,?2,?3,?4,?5)",
                    params![id, game_id, start, finish, seconds],
                ).unwrap();
            }
            db.conn.execute(
                "INSERT INTO sessions(id,game_id,started_at,heartbeat_seconds) VALUES (?1,?2,?3,?4)",
                params!["open",main_id,local_time(5,8,0),9000]
            ).unwrap();
            db.conn.execute(
                "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES (?1,?2,?3,?4,?5)",
                params!["corrupt",main_id,"1900-01-01T00:00:00Z","2026-11-03T00:00:00Z",300]
            ).unwrap();
            let now = Local
                .with_ymd_and_hms(2026, 11, 5, 12, 0, 0)
                .single()
                .unwrap();
            let stats = db.get_statistics_at(7, now).unwrap();
            assert_eq!(
                stats["totals"],
                json!({"week":3000,"month":3000,"allTime":3000})
            );
            assert_eq!(stats["meta"]["overlapSeconds"], 600);
            assert_eq!(stats["meta"]["openSessions"], 1);
            assert_eq!(stats["meta"]["invalidSessions"], 1);
            assert_eq!(
                stats["daily"][4],
                json!({"date":"2026-11-03","seconds":600})
            );
            assert_eq!(
                stats["daily"][5],
                json!({"date":"2026-11-04","seconds":2400})
            );
            assert_eq!(db.get(main_id).unwrap()["total_play_seconds"], 0);
            assert!(db.get_statistics(91).is_err());
        });
    }

    #[cfg(windows)]
    #[test]
    fn windows_network_share_root_survives_dot_dot_and_stored_path_keeps_case() {
        let path = r"\\Server\Share\Folder\..\..\Game.exe";
        assert_eq!(normalized_path(path), r"\\server\share\game.exe");
        assert_eq!(normalized_executable(path), r"\\Server\Share\Game.exe");
        assert_eq!(
            normalized_path(r"\\Server\Share\..\..\Game.exe"),
            r"\\server\share\game.exe"
        );
        assert_eq!(
            normalized_executable(r"C:\Games\Sub\..\Orbit.exe"),
            r"C:\Games\Orbit.exe"
        );
        let stored = clean_game(&json!({"name":"Network game","executable":path}), None).unwrap();
        assert_eq!(stored["executable"], r"\\Server\Share\Game.exe");
        assert_eq!(duplicate_key(&stored), "file:\\\\server\\share\\game.exe");
    }

    #[test]
    fn game_fields_dedupe_favorites_and_edit_validation() {
        with_database(|db, _| {
            let first = db
                .upsert(&json!({
                    "name": "A Store Game", "source": "steam", "source_id": "100",
                    "executable": "C:\\Games\\Orbit.exe", "launch_uri": "steam://rungameid/100",
                    "tags": ["RPG", "RPG", "Adventure"], "launch_args": ["-fullscreen"]
                }))
                .unwrap();
            assert_eq!(first["added"], true);
            assert_eq!(first["game"]["tags"], json!(["RPG", "Adventure"]));
            assert_eq!(first["game"]["launch_args"], json!(["-fullscreen"]));
            let id = field(&first["game"], "id").to_owned();
            let repeated = db.upsert(&json!({
                "name": "Duplicate by URI", "source": "manual", "launch_uri": "STEAM://RUNGAMEID/100"
            })).unwrap();
            assert_eq!(repeated["added"], false);
            assert_eq!(repeated["game"]["id"], id);
            assert_eq!(db.count().unwrap(), 1);

            let edited = db
                .update(&id, &json!({"name":"New Title","tags":"One, Two, One"}))
                .unwrap();
            assert_eq!(edited["name"], "New Title");
            assert_eq!(edited["tags"], json!(["One", "Two"]));
            assert_eq!(db.toggle_favorite(&id).unwrap()["favorite"], true);

            let another = db
                .upsert(&json!({"name":"Independent","launch_uri":"orbit://other"}))
                .unwrap();
            let other_id = field(&another["game"], "id");
            assert!(db
                .update(other_id, &json!({"launch_uri":"steam://rungameid/100"}))
                .unwrap_err()
                .contains("launcher link is already"));
            assert_eq!(db.get(other_id).unwrap()["launch_uri"], "orbit://other");
            assert!(db.update(&id, &json!({"source":"unknown"})).is_err());
            assert_eq!(db.remove(&id).unwrap(), true);
            assert_eq!(db.count().unwrap(), 1);
        });
    }

    #[test]
    fn distinct_verified_store_products_can_share_executable_and_uri_without_losing_user_data() {
        with_database(|db, _| {
            let executable = r"C:\Orbit\Shared\Game.exe";
            let uri = "com.epicgames.launcher://apps/shared?action=launch";
            let first = db
                .upsert(&json!({
                    "name":"Epic 125","source":"epic","source_id":"125",
                    "executable":executable,"launch_uri":uri,"install_path":r"C:\Orbit\Shared"
                }))
                .unwrap();
            let first_id = field(&first["game"], "id").to_string();
            db.update(&first_id, &json!({"favorite":true})).unwrap();
            let started = db.start_session(&first_id).unwrap();
            assert!(db.finish_session(&started, 59).unwrap());
            let second = db
                .upsert(&json!({
                    "name":"Epic 126","source":"epic","source_id":"126",
                    "executable":executable,"launch_uri":uri,"install_path":r"C:\Orbit\Shared"
                }))
                .unwrap();
            assert_eq!(second["added"], true);
            let second_id = field(&second["game"], "id").to_owned();
            assert_ne!(second_id, first_id);
            let gog = db
                .upsert(&json!({
                    "name":"GOG independent product","source":"gog","source_id":"126",
                    "executable":executable,"launch_uri":uri
                }))
                .unwrap();
            assert_eq!(gog["added"], true);
            assert_ne!(gog["game"]["id"], second["game"]["id"]);
            assert_eq!(db.count().unwrap(), 3);
            assert_eq!(db.get(&first_id).unwrap()["favorite"], true);
            assert_eq!(db.get(&first_id).unwrap()["total_play_seconds"], 59);
            let batch = db.upsert_batch(&[
                json!({"name":"Epic 127","source":"epic","source_id":"127","executable":executable}),
                json!({"name":"Epic 126 again","source":"epic","source_id":"126","executable":executable}),
            ]).unwrap();
            assert_eq!(batch["imported"], 1);
            assert_eq!(batch["skipped"], 1);
            assert_eq!(
                db.upsert(&json!({
                    "name":"Repeat same store product","source":"epic","source_id":"126",
                    "executable":executable
                }))
                .unwrap()["game"]["id"],
                second_id
            );
            assert_eq!(
                db.upsert(&json!({
                    "name":"Manual alias","source":"manual","executable":executable
                }))
                .unwrap()["added"],
                false
            );
            assert_eq!(
                db.upsert(&json!({
                    "name":"Folder alias","source":"folder","executable":executable
                }))
                .unwrap()["added"],
                false
            );
            assert_eq!(db.count().unwrap(), 4);
            assert_eq!(
                db.update(&second_id, &json!({"executable":executable}))
                    .unwrap()["id"],
                second_id
            );
            assert!(db.update(&second_id, &json!({"source_id":"125"})).is_err());
            assert_eq!(db.get(&second_id).unwrap()["source_id"], "126");
        });
    }

    #[test]
    fn store_source_ids_are_case_insensitive_and_unkeyed_manual_aliases_still_coalesce() {
        with_database(|db, _| {
            let path = r"C:\Orbit\Shared\Other.exe";
            let first = db
                .upsert(&json!({
                    "name":"Epic DLC","source":"epic","source_id":"DLC-XYZ",
                    "executable":path
                }))
                .unwrap();
            let repeated = db
                .upsert(&json!({
                    "name":"Epic DLC case variant","source":"epic","source_id":"dlc-xyz",
                    "executable":path
                }))
                .unwrap();
            assert_eq!(repeated["added"], false);
            assert_eq!(repeated["game"]["id"], first["game"]["id"]);
            assert_eq!(db.count().unwrap(), 1);
            let manual_path = r"C:\Orbit\Shared\ManualFirst.exe";
            let manual = db
                .upsert(&json!({
                    "name":"Previously linked","source":"manual","executable":manual_path
                }))
                .unwrap();
            assert_eq!(
                db.upsert(&json!({
                    "name":"Store on existing manual alias","source":"epic","source_id":"new-id",
                    "executable":manual_path
                }))
                .unwrap()["game"]["id"],
                manual["game"]["id"]
            );
            assert_eq!(db.count().unwrap(), 2);
        });
    }

    #[test]
    fn settings_are_validated_and_malformed_saved_values_fall_back() {
        with_database(|db, _| {
            assert_eq!(db.get_settings().unwrap()["scanDownloads"], false);
            let settings = db.save_settings(&json!({
                "theme":"light", "accent":"#66AABB", "autoScan":true, "libraryFolders":["D:\\Games"]
            })).unwrap();
            assert_eq!(settings["theme"], "light");
            assert_eq!(settings["autoScan"], true);
            assert!(db.save_settings(&json!({"theme":"neon"})).is_err());
            assert!(db.save_settings(&json!({"sort":"__proto__"})).is_err());
            assert!(db.save_settings(&json!({"libraryFolders":[5]})).is_err());
            db.conn
                .execute("UPDATE settings SET value='123' WHERE key='theme'", [])
                .unwrap();
            db.conn
                .execute(
                    "UPDATE settings SET value='\"broken\"' WHERE key='accent'",
                    [],
                )
                .unwrap();
            let recovered = db.get_settings().unwrap();
            assert_eq!(recovered["theme"], "dark");
            assert_eq!(recovered["accent"], "#8b7aff");
            assert_eq!(recovered["autoScan"], true);
            assert_eq!(recovered["libraryFolders"], json!(["D:\\Games"]));
        });
    }

    #[test]
    fn batch_uses_savepoint_like_per_entry_errors_and_keeps_valid_games() {
        with_database(|db, _| {
            let steam = json!({"name":"Steam Game","source":"steam","source_id":"451"});
            let report = db
                .upsert_batch(&[
                    steam.clone(),
                    json!({"name":"  "}),
                    steam,
                    json!({"name":"Local","executable":"C:\\Games\\local.exe"}),
                ])
                .unwrap();
            assert_eq!(report["imported"], 2);
            assert_eq!(report["skipped"], 1);
            assert_eq!(report["errors"].as_array().unwrap().len(), 1);
            assert_eq!(report["addedGames"].as_array().unwrap().len(), 2);
            assert_eq!(db.count().unwrap(), 2);
            let overflow = vec![json!({"name":"Game"}); 101];
            assert!(db
                .upsert_batch(&overflow)
                .unwrap_err()
                .contains("at most 100"));
            let integrity: String = db
                .conn
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .unwrap();
            assert_eq!(integrity, "ok");
        });
    }

    #[test]
    fn interrupted_session_recovers_checkpoint_exactly_once() {
        with_database(|db, file| {
            let game = db.upsert(&json!({"name":"Crash Recovery"})).unwrap()["game"].clone();
            let id = field(&game, "id").to_owned();
            let session = db.start_session(&id).unwrap();
            assert_eq!(
                db.checkpoint_sessions(&[json!({"id": session, "seconds": 121.9})])
                    .unwrap(),
                1
            );
            assert_eq!(
                db.checkpoint_sessions(&[json!({"id": session, "seconds": 1})])
                    .unwrap(),
                0
            );
            // Reopen the same SQLite file while preserving the old user record.
            let mut reopened = LibraryDatabase::open(file).unwrap();
            assert_eq!(reopened.recover_interrupted_sessions().unwrap(), 1);
            assert_eq!(reopened.recover_interrupted_sessions().unwrap(), 0);
            assert_eq!(reopened.get(&id).unwrap()["total_play_seconds"], 121);
            assert!(!reopened.finish_session(&session, 999).unwrap());
            let second = reopened.start_session(&id).unwrap();
            assert!(reopened.finish_session(&second, 97).unwrap());
            assert!(!reopened.finish_session(&second, 97).unwrap());
            assert_eq!(reopened.get(&id).unwrap()["total_play_seconds"], 218);
        });
    }

    #[test]
    fn two_database_connections_cannot_double_count_one_running_game() {
        with_database(|first, file| {
            let game = first.upsert(&json!({"name":"One running game"})).unwrap()["game"].clone();
            let game_id = field(&game, "id").to_string();
            let first_session = first.start_session(&game_id).unwrap();
            // A second launcher instance holds a distinct SQLite connection.
            // Opening the DB without invoking startup recovery models the
            // point after both processes had already started.
            let mut second = LibraryDatabase::open(file).unwrap();
            assert!(second
                .start_session(&game_id)
                .unwrap_err()
                .contains("unfinished playtime session"));
            assert_eq!(first.get(&game_id).unwrap()["total_play_seconds"], 0);
            assert!(first.finish_session(&first_session, 120).unwrap());
            let next = second.start_session(&game_id).unwrap();
            assert!(second.finish_session(&next, 60).unwrap());
            assert!(!first.finish_session(&first_session, 900).unwrap());
            assert_eq!(first.get(&game_id).unwrap()["total_play_seconds"], 180);
        });
    }

    #[test]
    fn external_launcher_marks_recent_without_creating_session_or_playtime() {
        with_database(|db, _| {
            let game = db
                .upsert(&json!({"name":"URI game","launch_uri":"orbit://example"}))
                .unwrap()["game"]
                .clone();
            let id = field(&game, "id");
            assert!(game["last_played_at"].is_null());
            db.record_external_launch(id).unwrap();
            assert!(db.get(id).unwrap()["last_played_at"].is_string());
            assert_eq!(db.get(id).unwrap()["total_play_seconds"], 0);
            assert_eq!(db.recover_interrupted_sessions().unwrap(), 0);
            assert!(db.record_external_launch("absent").is_err());
        });
    }

    #[test]
    fn json_backup_restores_playtime_dates_and_settings_without_duplicate_credit() {
        with_database(|db, _| {
            let raw = json!({
                "name":"Restored Favorite", "source":"gog", "source_id":"700",
                "favorite": true, "tags":["RPG"], "total_play_seconds":12500,
                "last_played_at":"2025-07-20T10:25:00Z",
                "created_at":"2024-01-03T12:00:00Z"
            });
            let payload = json!({
                "format":"orbit.library.v1", "games":[raw.clone()],
                "settings":{"theme":"light","accent":"#567abc"}
            });
            let result = db.restore_json(&payload).unwrap();
            assert_eq!(result["imported"], 1);
            assert_eq!(result["settingsRestored"], true);
            let listing = db.list("name").unwrap();
            let game = &listing[0];
            assert_eq!(game["last_played_at"], "2025-07-20T10:25:00.000Z");
            assert_eq!(game["created_at"], "2024-01-03T12:00:00.000Z");
            assert_eq!(game["total_play_seconds"], 12500);
            assert_eq!(game["favorite"], true);
            let exported = db.export_json().unwrap();
            assert_eq!(exported["format"], "orbit.library.v1");
            assert_eq!(exported["games"][0]["tags"], json!(["RPG"]));
            assert_eq!(exported["settings"]["theme"], "light");
            assert_eq!(db.restore_json(&payload).unwrap()["skipped"], 1);
            assert_eq!(db.list("name").unwrap()[0]["total_play_seconds"], 12500);
            assert_eq!(db.restore_game(&json!({"name":"Invalid Clock","total_play_seconds":-42,"last_played_at":"invalid"})).unwrap()["game"]["total_play_seconds"], 0);
            assert_eq!(
                db.restore_game(&json!({"name":"Integral Float","total_play_seconds":12500.0}))
                    .unwrap()["game"]["total_play_seconds"],
                12500
            );
            assert!(db
                .restore_json(&json!({"format":"unknown","games":[]}))
                .is_err());
        });
    }

    #[test]
    fn migrates_old_sqlite_schema_without_discarding_games_or_sessions() {
        let root: PathBuf = std::env::temp_dir().join(format!("orbit-legacy-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("library.sqlite");
        {
            let conn = Connection::open(&file).unwrap();
            conn.execute_batch(
                "CREATE TABLE games (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
                    source_id TEXT NOT NULL DEFAULT '', executable TEXT NOT NULL DEFAULT '',
                    launch_uri TEXT NOT NULL DEFAULT '', install_path TEXT NOT NULL DEFAULT '',
                    cover TEXT NOT NULL DEFAULT '', banner TEXT NOT NULL DEFAULT '',
                    genre TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                    favorite INTEGER NOT NULL DEFAULT 0, total_play_seconds INTEGER NOT NULL DEFAULT 0,
                    last_played_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    launch_args TEXT NOT NULL DEFAULT '[]', working_dir TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE sessions (id TEXT PRIMARY KEY,game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                    started_at TEXT NOT NULL, finished_at TEXT, seconds INTEGER NOT NULL DEFAULT 0);
                INSERT INTO games(id,name,source,source_id,created_at,updated_at)
                    VALUES ('old-game','Legacy title','gog','old-123','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z');
                INSERT INTO sessions(id,game_id,started_at,seconds)
                    VALUES ('old-session','old-game','2025-01-02T00:00:00Z',0);"
            ).unwrap();
        }
        {
            let mut db = LibraryDatabase::open(&file).unwrap();
            let legacy = db.get("old-game").unwrap();
            assert_eq!(legacy["name"], "Legacy title");
            assert_eq!(legacy["icon"], "");
            assert_eq!(legacy["cover_fit"], "cover");
            assert_eq!(legacy["cover_position"], "center");
            assert_eq!(db.recover_interrupted_sessions().unwrap(), 1);
            assert_eq!(db.count().unwrap(), 1);
            assert_eq!(
                db.upsert(&json!({"name":"Duplicate","source":"gog","source_id":"old-123"}))
                    .unwrap()["added"],
                false
            );
            assert_eq!(db.get("old-game").unwrap()["total_play_seconds"], 0);
            assert_eq!(
                db.conn
                    .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

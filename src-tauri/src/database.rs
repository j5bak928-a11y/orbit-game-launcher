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

const GAME_COLUMNS: &str = "id,name,source,source_id,executable,launch_uri,install_path,cover,banner,icon,genre,tags,favorite,total_play_seconds,last_played_at,created_at,updated_at,launch_args,working_dir,cover_fit,cover_position,play_status,hidden,launch_env,launch_profiles,notes,rating";
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
const PLAY_STATUSES: [&str; 5] = ["", "playing", "backlog", "completed", "on_hold"];
const COLLECTION_ICONS: [&str; 8] = [
    "folder",
    "sparkles",
    "heart",
    "trophy",
    "gamepad",
    "clock",
    "lightning",
    "library",
];
const MAX_COLLECTIONS: usize = 100;
const MAX_LAUNCH_ENV: usize = 40;
const MAX_LAUNCH_PROFILES: usize = 12;
const MAX_BULK_IDS: usize = 5_000;
const SETTING_KEYS: [&str; 18] = [
    "theme",
    "accent",
    "reduceMotion",
    "autoScan",
    "useSteamArtwork",
    "libraryFolders",
    "discoveryIgnored",
    "view",
    "sort",
    "onboardingDone",
    "performanceGuard",
    "autoUpdates",
    "libraryDensity",
    "language",
    "controllerAutoEnter",
    "controllerAudio",
    "controllerHaptics",
    "steamGridDbApiKey",
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
const SESSION_PAGE_SIZE: i64 = 40;
const STATS_MAX_ROWS: i64 = 100_000;
const BACKUP_MAX_GAMES: usize = 100_000;
const BACKUP_MAX_SESSIONS: usize = 100_000;
type DbResult<T> = Result<T, String>;

#[derive(Clone, Debug)]
struct BackupSession {
    id: String,
    game_id: String,
    started_at: String,
    finished_at: String,
    seconds: i64,
}

#[derive(Clone, Debug)]
struct BackupCollection {
    id: String,
    name: String,
    icon: String,
    color: String,
    position: i64,
    game_ids: Vec<String>,
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    key.len() <= 128
        && (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn clean_launch_env(value: &Value) -> DbResult<Value> {
    let parsed = if value.is_null() {
        json!({})
    } else if let Some(text) = value.as_str() {
        if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(text)
                .map_err(|_| "Environment variables must be a JSON object.".to_string())?
        }
    } else {
        value.clone()
    };
    let obj = parsed
        .as_object()
        .ok_or("Environment variables must be an object.")?;
    if obj.len() > MAX_LAUNCH_ENV {
        return Err("At most 40 environment variables are allowed per game.".into());
    }
    let mut out = Map::new();
    for (k, v) in obj {
        let key = k.trim();
        if !valid_env_key(key) {
            return Err(format!("Invalid environment variable name: {key}"));
        }
        let val = v
            .as_str()
            .ok_or_else(|| format!("Environment variable {key} must be a string."))?;
        if string_length(val) > 2_048 || val.chars().any(|c| c == '\0' || c == '\r' || c == '\n') {
            return Err(format!("Environment variable {key} value is invalid."));
        }
        out.insert(key.to_owned(), Value::String(val.to_owned()));
    }
    Ok(Value::Object(out))
}

fn clean_launch_args_value(value: &Value) -> DbResult<Value> {
    let mut args = if value.is_null() {
        json!([])
    } else {
        value.clone()
    };
    if let Some(text) = args.as_str() {
        args = serde_json::from_str(text)
            .map_err(|_| "Launch arguments must be a JSON array.".to_string())?;
    }
    match args.as_array() {
        Some(items)
            if items.len() <= 80
                && items.iter().all(|a| {
                    a.as_str()
                        .is_some_and(|s| string_length(s) <= 1024 && !s.contains('\0'))
                }) =>
        {
            Ok(args)
        }
        _ => Err("Launch arguments must be an array of short strings.".into()),
    }
}

fn clean_launch_profiles(value: &Value) -> DbResult<Value> {
    let parsed = if value.is_null() {
        json!([])
    } else if let Some(text) = value.as_str() {
        if text.trim().is_empty() {
            json!([])
        } else {
            serde_json::from_str(text)
                .map_err(|_| "Launch profiles must be a JSON array.".to_string())?
        }
    } else {
        value.clone()
    };
    let items = parsed
        .as_array()
        .ok_or("Launch profiles must be an array.")?;
    if items.len() > MAX_LAUNCH_PROFILES {
        return Err("At most 12 alternative launch profiles are allowed per game.".into());
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let obj = item
            .as_object()
            .ok_or("Each launch profile must be an object.")?;
        let raw_id = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let id = if raw_id.is_empty() {
            Uuid::new_v4().to_string()
        } else if valid_backup_id(raw_id) {
            raw_id.to_owned()
        } else {
            return Err("Invalid launch profile identifier.".into());
        };
        if !seen.insert(id.clone()) {
            return Err("Duplicate launch profile identifier.".into());
        }
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if name.is_empty() || string_length(name) > 80 || name.chars().any(char::is_control) {
            return Err("Launch profile name must contain 1–80 characters.".into());
        }
        let mut executable = obj
            .get("executable")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_owned();
        if string_length(&executable) > 4_000 || executable.chars().any(char::is_control) {
            return Err("Launch profile executable path is invalid.".into());
        }
        if Path::new(&executable).is_absolute() {
            executable = normalized_executable(&executable);
        }
        let launch_uri = obj
            .get("launch_uri")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_owned();
        if string_length(&launch_uri) > 2_048 || launch_uri.chars().any(char::is_control) {
            return Err("Launch profile URI is invalid.".into());
        }
        let working_dir = obj
            .get("working_dir")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_owned();
        if string_length(&working_dir) > 4_000 || working_dir.chars().any(char::is_control) {
            return Err("Launch profile working directory is invalid.".into());
        }
        let launch_args = clean_launch_args_value(obj.get("launch_args").unwrap_or(&Value::Null))?;
        let launch_env = clean_launch_env(obj.get("launch_env").unwrap_or(&Value::Null))?;
        out.push(json!({
            "id": id,
            "name": name,
            "executable": executable,
            "launch_uri": launch_uri,
            "working_dir": working_dir,
            "launch_args": launch_args,
            "launch_env": launch_env,
        }));
    }
    Ok(Value::Array(out))
}

fn validate_backup_collections(payload: &Value) -> DbResult<Option<Vec<BackupCollection>>> {
    let Some(raw) = payload.get("collections") else {
        return Ok(None);
    };
    let items = raw
        .as_array()
        .ok_or("Backup collections must be an array.")?;
    if items.len() > MAX_COLLECTIONS {
        return Err("Backup exceeds the 100-collection safety limit.".into());
    }
    let mut seen = HashSet::new();
    let mut validated = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let obj = item
            .as_object()
            .ok_or_else(|| format!("Invalid backup collection at index {index}."))?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_backup_id(id))
            .ok_or_else(|| format!("Invalid backup collection ID at index {index}."))?;
        if !seen.insert(id) {
            return Err(format!("Duplicate backup collection ID: {id}."));
        }
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty() && string_length(n) <= 60 && !n.chars().any(char::is_control))
            .ok_or_else(|| format!("Invalid backup collection name at index {index}."))?;
        let icon = obj
            .get("icon")
            .and_then(Value::as_str)
            .filter(|i| COLLECTION_ICONS.contains(i))
            .unwrap_or("folder");
        let color = obj
            .get("color")
            .filter(|c| c.as_str() == Some("") || valid_accent(c))
            .and_then(Value::as_str)
            .unwrap_or("");
        let position = obj
            .get("position")
            .and_then(Value::as_i64)
            .unwrap_or(index as i64)
            .clamp(0, 10_000);
        let raw_game_ids = obj
            .get("game_ids")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("Backup collection {id} game_ids must be an array."))?;
        if raw_game_ids.len() > BACKUP_MAX_GAMES {
            return Err(format!("Backup collection {id} exceeds game limit."));
        }
        let mut game_ids = Vec::with_capacity(raw_game_ids.len());
        let mut seen_games = HashSet::new();
        for gid in raw_game_ids {
            let gid = gid
                .as_str()
                .filter(|s| valid_backup_id(s))
                .ok_or_else(|| format!("Backup collection {id} has an invalid game ID."))?;
            if seen_games.insert(gid) {
                game_ids.push(gid.to_owned());
            }
        }
        validated.push(BackupCollection {
            id: id.to_owned(),
            name: name.to_owned(),
            icon: icon.to_owned(),
            color: color.to_owned(),
            position,
            game_ids,
        });
    }
    Ok(Some(validated))
}

/// Stable IDs in old Orbit libraries may predate UUIDs. Use the original
/// backup contract for every API that accepts a game ID. These are opaque
/// SQLite parameter values, never filesystem paths or SQL statements.
pub(crate) fn valid_backup_id(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= 128
        && !value.chars().any(char::is_control)
}

fn backup_timestamp(value: &Value, field: &str) -> DbResult<(String, DateTime<Utc>)> {
    let timestamp = value
        .as_str()
        .filter(|text| !text.is_empty() && string_length(text) <= 50)
        .ok_or_else(|| format!("Invalid backup session {field}."))?;
    let parsed = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| format!("Invalid backup session {field}."))?;
    Ok((timestamp.to_owned(), parsed.with_timezone(&Utc)))
}

fn validate_backup_sessions(payload: &Value) -> DbResult<Option<Vec<BackupSession>>> {
    let Some(sessions) = payload.get("sessions") else {
        return Ok(None); // Older orbit.library.v1 exports did not contain sessions.
    };
    let sessions = sessions
        .as_array()
        .ok_or("Backup sessions must be an array.")?;
    if sessions.len() > BACKUP_MAX_SESSIONS {
        return Err("Backup exceeds the 100000-session safety limit.".into());
    }
    let mut seen = HashSet::with_capacity(sessions.len());
    let mut validated = Vec::with_capacity(sessions.len());
    for (index, raw) in sessions.iter().enumerate() {
        let fields = raw.as_object().filter(|fields| {
            fields.len() == 5
                && ["id", "game_id", "started_at", "finished_at", "seconds"]
                    .iter()
                    .all(|key| fields.contains_key(*key))
        });
        if fields.is_none() {
            return Err(format!("Invalid backup session fields at index {index}."));
        }
        let id = raw
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_backup_id(id))
            .ok_or_else(|| format!("Invalid backup session ID at index {index}."))?;
        let game_id = raw
            .get("game_id")
            .and_then(Value::as_str)
            .filter(|id| valid_backup_id(id))
            .ok_or_else(|| format!("Invalid backup session game ID at index {index}."))?;
        if !seen.insert(id) {
            return Err(format!("Duplicate backup session ID: {id}."));
        }
        let (started_at, start) = backup_timestamp(&raw["started_at"], "started_at")?;
        let (finished_at, finish) = backup_timestamp(&raw["finished_at"], "finished_at")?;
        // A completed zero-second play session can have identical start and
        // finish timestamps. Preserve it during archival even if statistics
        // later exclude the zero-duration interval from playtime charts.
        if finish < start {
            return Err(format!("Backup session {id} has an invalid time interval."));
        }
        let seconds = raw
            .get("seconds")
            .and_then(Value::as_f64)
            .filter(|value| {
                value.is_finite()
                    && value.fract() == 0.0
                    && *value >= 0.0
                    && *value <= MAX_SESSION_SECONDS as f64
            })
            .ok_or_else(|| format!("Backup session {id} has invalid playtime."))?
            as i64;
        validated.push(BackupSession {
            id: id.to_owned(),
            game_id: game_id.to_owned(),
            started_at,
            finished_at,
            seconds,
        });
    }
    Ok(Some(validated))
}

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
    genre: String,
    play_status: String,
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
    genre: String,
    play_status: String,
    last_played_at: String,
    last_time: i64,
    seconds: f64,
    events: Vec<StatisticsEvent>,
}

#[derive(Clone, Copy, Default)]
struct LocalDayCache {
    start_ms: i64,
    end_ms: i64,
    date: Option<NaiveDate>,
}

impl LocalDayCache {
    fn day_bounds(&mut self, timestamp: i64) -> DbResult<(NaiveDate, i64)> {
        if let Some(date) = self.date {
            if timestamp >= self.start_ms && timestamp < self.end_ms {
                return Ok((date, self.end_ms));
            }
        }
        let current = Local
            .timestamp_millis_opt(timestamp)
            .single()
            .ok_or("Invalid statistics timestamp.")?;
        let date = current.date_naive();
        let next_date = date.succ_opt().ok_or("Statistics date out of range.")?;
        // Some time zones change UTC offset at midnight. Find the first real
        // local hour instead of assuming every local day lasts 24 hours.
        let mut day_start = None;
        for hour in 0..24 {
            let naive = date
                .and_hms_opt(hour, 0, 0)
                .ok_or("Invalid calendar hour.")?;
            if let Some(ts) = Local.from_local_datetime(&naive).earliest() {
                day_start = Some(ts.timestamp_millis());
                break;
            }
        }
        let mut next_midnight = None;
        for hour in 0..24 {
            let naive = next_date
                .and_hms_opt(hour, 0, 0)
                .ok_or("Invalid calendar hour.")?;
            if let Some(ts) = Local.from_local_datetime(&naive).earliest() {
                next_midnight = Some(ts.timestamp_millis());
                break;
            }
        }
        let end_ms = next_midnight.ok_or("No valid local calendar boundary.")?;
        let start_ms = day_start.unwrap_or(timestamp).min(timestamp);
        self.start_ms = start_ms;
        self.end_ms = end_ms;
        self.date = Some(date);
        Ok((date, end_ms))
    }
}

fn statistics_allocate(
    mut from: i64,
    to: i64,
    rate: f64,
    game: &mut StatisticsGame,
    days: &mut BTreeMap<NaiveDate, f64>,
    total: &mut f64,
    cache: &mut LocalDayCache,
) -> DbResult<()> {
    while from < to {
        let (date, next_midnight) = cache.day_bounds(from)?;
        let until = to.min(next_midnight);
        if until <= from {
            return Err("Statistics calendar cannot advance.".into());
        }
        let seconds = (until - from) as f64 * rate / 1000.0;
        *days.entry(date).or_default() += seconds;
        game.seconds += seconds;
        *total += seconds;
        from = until;
    }
    Ok(())
}

fn breakdown_entries(
    totals: HashMap<String, (f64, i64)>,
    total_seconds: f64,
    max_items: Option<usize>,
) -> Vec<Value> {
    let mut rows: Vec<(String, f64, i64)> = totals
        .into_iter()
        .filter(|(_, (secs, _))| *secs > 0.0)
        .map(|(k, (s, c))| (k, s, c))
        .collect();
    rows.sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    if let Some(limit) = max_items {
        if rows.len() > limit {
            let tail = rows.split_off(limit - 1);
            let other_secs: f64 = tail.iter().map(|(_, s, _)| *s).sum();
            let other_games: i64 = tail.iter().map(|(_, _, c)| *c).sum();
            rows.push(("__other__".to_string(), other_secs, other_games));
        }
    }
    rows.into_iter()
        .map(|(key, secs, games)| {
            let share = if total_seconds > 0.0 {
                ((secs / total_seconds) * 1000.0).round() / 1000.0
            } else {
                0.0
            };
            json!({
                "key": key,
                "seconds": secs.round() as i64,
                "games": games,
                "share": share
            })
        })
        .collect()
}

fn statistics_from_rows(
    rows: Vec<StatisticsRow>,
    open_sessions: i64,
    days: i64,
    as_of: DateTime<Local>,
) -> DbResult<Value> {
    let mut games: HashMap<String, StatisticsGame> = HashMap::new();
    let mut day_seconds: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    let mut day_sessions: HashMap<NaiveDate, i64> = HashMap::new();
    let mut cache = LocalDayCache::default();
    let mut invalid_sessions = 0_i64;
    let mut valid_session_count = 0_i64;
    let mut longest_session_seconds = 0_f64;
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
            || end < start
            || (end == start && raw > 0)
            || end - start > MAX_SESSION_SECONDS * 1000
            || end > now.saturating_add(300_000)
        {
            invalid_sessions += 1;
            continue;
        }
        if end == start && raw == 0 {
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
                genre: row.genre,
                play_status: row.play_status,
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
        valid_session_count += 1;
        if credit > longest_session_seconds {
            longest_session_seconds = credit;
        }
        if let Ok((start_date, _)) = cache.day_bounds(start) {
            *day_sessions.entry(start_date).or_default() += 1;
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
                            &mut cache,
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
    let date_back = |back: i64| -> DbResult<NaiveDate> {
        today
            .checked_sub_signed(chrono::Duration::days(back))
            .ok_or_else(|| "Statistics calendar out of range.".to_string())
    };
    let total_days = |count: i64| -> DbResult<i64> {
        let mut sum = 0_f64;
        for back in 0..count {
            let date = date_back(back)?;
            sum += day_seconds.get(&date).copied().unwrap_or(0.0);
        }
        Ok(sum.round() as i64)
    };
    let mut daily = Vec::with_capacity(days as usize);
    for back in (0..days).rev() {
        let date = date_back(back)?;
        daily.push(json!({
            "date": date.format("%Y-%m-%d").to_string(),
            "seconds": day_seconds.get(&date).copied().unwrap_or(0.0).round() as i64
        }));
    }

    // 12-month (365-day) calendar heatmap with dynamic intensity quartiles (0..=4).
    const HEATMAP_DAYS: i64 = 365;
    let mut heatmap_raw: Vec<(NaiveDate, i64, i64)> = Vec::with_capacity(HEATMAP_DAYS as usize);
    let mut nonzero_values: Vec<i64> = Vec::new();
    for back in (0..HEATMAP_DAYS).rev() {
        let date = date_back(back)?;
        let secs = day_seconds.get(&date).copied().unwrap_or(0.0).round() as i64;
        let sess = day_sessions.get(&date).copied().unwrap_or(0);
        if secs > 0 {
            nonzero_values.push(secs);
        }
        heatmap_raw.push((date, secs, sess));
    }
    nonzero_values.sort_unstable();
    let active_days_year = nonzero_values.len() as i64;
    let quantile = |num: usize, den: usize| -> i64 {
        if nonzero_values.is_empty() {
            return 0;
        }
        let idx = ((nonzero_values.len() - 1) * num) / den;
        nonzero_values[idx]
    };
    let q1 = quantile(1, 4).max(1);
    let q2 = quantile(2, 4).max(q1);
    let q3 = quantile(3, 4).max(q2);
    let min_nonzero = nonzero_values.first().copied().unwrap_or(0);
    let max_nonzero = nonzero_values.last().copied().unwrap_or(0);
    let uniform_nonzero = max_nonzero > 0 && min_nonzero == max_nonzero;
    let heatmap: Vec<Value> = heatmap_raw
        .into_iter()
        .map(|(date, secs, sess)| {
            let level = if secs <= 0 {
                0
            } else if uniform_nonzero {
                4
            } else if secs <= q1 {
                1
            } else if secs <= q2 {
                2
            } else if secs <= q3 {
                3
            } else {
                4
            };
            json!({
                "date": date.format("%Y-%m-%d").to_string(),
                "seconds": secs,
                "sessions": sess,
                "level": level
            })
        })
        .collect();

    // Play streaks across all active calendar days.
    let active_dates: Vec<NaiveDate> = day_seconds
        .iter()
        .filter(|(_, secs)| secs.round() as i64 > 0)
        .map(|(date, _)| *date)
        .collect();
    let total_active_days = active_dates.len() as i64;
    let mut longest_streak = 0_i64;
    let mut run = 0_i64;
    let mut prev_date: Option<NaiveDate> = None;
    for date in &active_dates {
        if prev_date.is_some_and(|p| p.succ_opt() == Some(*date)) {
            run += 1;
        } else {
            run = 1;
        }
        if run > longest_streak {
            longest_streak = run;
        }
        prev_date = Some(*date);
    }
    let active_set: HashSet<NaiveDate> = active_dates.into_iter().collect();
    let mut current_streak = 0_i64;
    let mut cursor = if active_set.contains(&today) {
        Some(today)
    } else {
        today.pred_opt().filter(|y| active_set.contains(y))
    };
    while let Some(d) = cursor {
        if active_set.contains(&d) {
            current_streak += 1;
            cursor = d.pred_opt();
        } else {
            break;
        }
    }

    // Playtime breakdowns by storefront, genre, and play status.
    let mut by_source: HashMap<String, (f64, i64)> = HashMap::new();
    let mut by_genre: HashMap<String, (f64, i64)> = HashMap::new();
    let mut by_status: HashMap<String, (f64, i64)> = HashMap::new();
    for game in games.values() {
        if game.seconds <= 0.0 {
            continue;
        }
        let s = by_source.entry(game.source.clone()).or_default();
        s.0 += game.seconds;
        s.1 += 1;
        let genre_key = game.genre.trim().to_string();
        let g = by_genre.entry(genre_key).or_default();
        g.0 += game.seconds;
        g.1 += 1;
        let st = by_status.entry(game.play_status.clone()).or_default();
        st.0 += game.seconds;
        st.1 += 1;
    }
    let breakdowns = json!({
        "bySource": breakdown_entries(by_source, credited, None),
        "byGenre": breakdown_entries(by_genre, credited, Some(8)),
        "byStatus": breakdown_entries(by_status, credited, None),
    });

    let average_session_seconds = if valid_session_count > 0 {
        (credited / valid_session_count as f64).round() as i64
    } else {
        0
    };

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
        "heatmap": heatmap,
        "streaks": {
            "current": current_streak,
            "longest": longest_streak,
            "activeDaysYear": active_days_year,
            "totalActiveDays": total_active_days
        },
        "sessions": {
            "count": valid_session_count,
            "averageSeconds": average_session_seconds,
            "longestSeconds": longest_session_seconds.round() as i64
        },
        "breakdowns": breakdowns,
        "totals":{"week":total_days(7)?,"month":total_days(30)?,"allTime":credited.round() as i64},
        "recentGames":recent_games,
        "meta":{"openSessions":open_sessions,"invalidSessions":invalid_sessions,
                "overlapSeconds":(eligible_seconds - credited).max(0.0).round() as i64,
                "adjustedSeconds":(raw_seconds - eligible_seconds).max(0.0).round() as i64,
                "truncated":false}
    }))
}

fn csv_escape_cell(raw: &str) -> String {
    let safe = match raw.bytes().next() {
        Some(b'=' | b'+' | b'-' | b'@' | b'\t' | b'\r') => format!("'{raw}"),
        _ => raw.to_string(),
    };
    if safe.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", safe.replace('"', "\"\""))
    } else {
        safe
    }
}

pub fn format_statistics_csv(stats: &Value) -> String {
    let mut lines = Vec::new();
    lines.push("section,key,label,seconds,count,share".to_string());
    let totals = &stats["totals"];
    let streaks = &stats["streaks"];
    let sessions = &stats["sessions"];
    for (key, label, val) in [
        ("week", "Last 7 days", totals["week"].as_i64().unwrap_or(0)),
        (
            "month",
            "Last 30 days",
            totals["month"].as_i64().unwrap_or(0),
        ),
        (
            "all_time",
            "All recorded time",
            totals["allTime"].as_i64().unwrap_or(0),
        ),
        (
            "average_session",
            "Average session",
            sessions["averageSeconds"].as_i64().unwrap_or(0),
        ),
        (
            "longest_session",
            "Longest session",
            sessions["longestSeconds"].as_i64().unwrap_or(0),
        ),
    ] {
        lines.push(format!(
            "summary,{},{},{},{},",
            csv_escape_cell(key),
            csv_escape_cell(label),
            val,
            if key == "all_time" {
                sessions["count"].as_i64().unwrap_or(0).to_string()
            } else {
                String::new()
            }
        ));
    }
    lines.push(format!(
        "streak,current,Current streak (days),,{},",
        streaks["current"].as_i64().unwrap_or(0)
    ));
    lines.push(format!(
        "streak,longest,Longest streak (days),,{},",
        streaks["longest"].as_i64().unwrap_or(0)
    ));
    lines.push(format!(
        "streak,active_days_year,Active days (last 12 months),,{},",
        streaks["activeDaysYear"].as_i64().unwrap_or(0)
    ));
    for (section, field_name) in [
        ("storefront", "bySource"),
        ("genre", "byGenre"),
        ("status", "byStatus"),
    ] {
        if let Some(items) = stats["breakdowns"][field_name].as_array() {
            for item in items {
                let key = item["key"].as_str().unwrap_or("");
                let secs = item["seconds"].as_i64().unwrap_or(0);
                let count = item["games"].as_i64().unwrap_or(0);
                let share = item["share"].as_f64().unwrap_or(0.0);
                lines.push(format!(
                    "{},{},{},{},{},{:.3}",
                    section,
                    csv_escape_cell(key),
                    csv_escape_cell(if key.is_empty() { "Unassigned" } else { key }),
                    secs,
                    count,
                    share
                ));
            }
        }
    }
    if let Some(recent) = stats["recentGames"].as_array() {
        for game in recent {
            let id = game["id"].as_str().unwrap_or("");
            let name = game["name"].as_str().unwrap_or("");
            let secs = game["seconds"].as_i64().unwrap_or(0);
            lines.push(format!(
                "recent_game,{},{},{},,",
                csv_escape_cell(id),
                csv_escape_cell(name),
                secs
            ));
        }
    }
    if let Some(heatmap) = stats["heatmap"].as_array() {
        for day in heatmap {
            let date = day["date"].as_str().unwrap_or("");
            let secs = day["seconds"].as_i64().unwrap_or(0);
            let sess = day["sessions"].as_i64().unwrap_or(0);
            lines.push(format!(
                "daily,{},{},{},{},",
                csv_escape_cell(date),
                csv_escape_cell(date),
                secs,
                sess
            ));
        }
    }
    lines.join("\n") + "\n"
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
        "libraryFolders": [], "discoveryIgnored": [], "view": "grid", "sort": "name",
        "onboardingDone": false, "performanceGuard": true,
        "autoUpdates": true, "libraryDensity": "comfortable", "language": "system",
        "controllerAutoEnter": false, "controllerAudio": false, "controllerHaptics": false,
        "steamGridDbApiKey": ""
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
    let args =
        clean_launch_args_value(picked(raw, previous, "launch_args").unwrap_or(&Value::Null))?;
    let play_status = picked(raw, previous, "play_status")
        .map(js_string)
        .unwrap_or_default();
    if !PLAY_STATUSES.contains(&play_status.as_str()) {
        return Err("Unsupported play status.".into());
    }
    let launch_env = clean_launch_env(picked(raw, previous, "launch_env").unwrap_or(&Value::Null))?;
    let launch_profiles =
        clean_launch_profiles(picked(raw, previous, "launch_profiles").unwrap_or(&Value::Null))?;
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
    let notes_raw = string_field(raw, previous, "notes")?;
    let notes = notes_raw.replace("\r\n", "\n").replace('\r', "\n");
    if notes
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err("Game notes contain invalid control characters.".into());
    }
    let rating = match raw.get("rating").or_else(|| previous.get("rating")) {
        None | Some(Value::Null) => 0_i64,
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                if (0..=5).contains(&i) {
                    i
                } else {
                    return Err("Game rating must be between 0 and 5.".into());
                }
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && (0.0..=5.0).contains(&f) {
                    f as i64
                } else {
                    return Err("Game rating must be between 0 and 5.".into());
                }
            } else {
                return Err("Game rating must be between 0 and 5.".into());
            }
        }
        Some(Value::String(s)) if s.trim().is_empty() => 0_i64,
        Some(Value::String(s)) => match s.trim().parse::<i64>() {
            Ok(i) if (0..=5).contains(&i) => i,
            _ => return Err("Game rating must be between 0 and 5.".into()),
        },
        _ => return Err("Game rating must be between 0 and 5.".into()),
    };
    result.insert("name".into(), json!(name));
    result.insert("source".into(), json!(source));
    result.insert("tags".into(), Value::Array(clean_tags));
    result.insert("launch_args".into(), args);
    result.insert("cover_fit".into(), json!(fit));
    result.insert("cover_position".into(), json!(position));
    result.insert("play_status".into(), json!(play_status));
    result.insert("launch_env".into(), launch_env);
    result.insert("launch_profiles".into(), launch_profiles);
    result.insert("notes".into(), json!(notes));
    result.insert("rating".into(), json!(rating));
    result.insert(
        "favorite".into(),
        json!(js_truthy(raw.get("favorite").unwrap_or_else(|| {
            previous.get("favorite").unwrap_or(&Value::Null)
        }))),
    );
    result.insert(
        "hidden".into(),
        json!(js_truthy(raw.get("hidden").unwrap_or_else(|| {
            previous.get("hidden").unwrap_or(&Value::Null)
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

/// Fast in-memory index mirroring `find_duplicate_on` semantics so `discoverGames`
/// accurately marks `alreadyAdded` according to `upsert` deduplication rules.
pub struct LibraryDuplicateIndex {
    keys: HashSet<String>,
    all_executables: HashSet<String>,
    alias_executables: HashSet<String>,
    all_uris: HashSet<String>,
    alias_uris: HashSet<String>,
}

impl LibraryDuplicateIndex {
    pub fn from_games(games: &[Value]) -> Self {
        let mut index = Self {
            keys: HashSet::with_capacity(games.len()),
            all_executables: HashSet::with_capacity(games.len()),
            alias_executables: HashSet::new(),
            all_uris: HashSet::with_capacity(games.len()),
            alias_uris: HashSet::new(),
        };
        for game in games {
            let key = duplicate_key(game);
            if !key.is_empty() {
                index.keys.insert(key);
            }
            let is_alias = !has_store_identity(game);
            let executable = field(game, "executable");
            if !executable.is_empty() {
                let norm = normalized_path(executable);
                index.all_executables.insert(norm.clone());
                if is_alias {
                    index.alias_executables.insert(norm);
                }
            }
            let uri = field(game, "launch_uri");
            if !uri.is_empty() {
                let norm = uri.to_ascii_lowercase();
                index.all_uris.insert(norm.clone());
                if is_alias {
                    index.alias_uris.insert(norm);
                }
            }
        }
        index
    }

    pub fn contains(&self, candidate: &Value) -> bool {
        let key = duplicate_key(candidate);
        if !key.is_empty() && self.keys.contains(&key) {
            return true;
        }
        let alias_only = has_store_identity(candidate);
        let executable = field(candidate, "executable");
        if !executable.is_empty() {
            let norm = normalized_path(executable);
            let matched = if alias_only {
                self.alias_executables.contains(&norm)
            } else {
                self.all_executables.contains(&norm)
            };
            if matched {
                return true;
            }
        }
        let uri = field(candidate, "launch_uri");
        if !uri.is_empty() {
            let norm = uri.to_ascii_lowercase();
            let matched = if alias_only {
                self.alias_uris.contains(&norm)
            } else {
                self.all_uris.contains(&norm)
            };
            if matched {
                return true;
            }
        }
        false
    }
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
        "play_status",
        "notes",
    ] {
        game.insert(field.into(), json!(row.get::<_, String>(field)?));
    }
    game.insert(
        "rating".into(),
        json!(row.get::<_, i64>("rating")?.clamp(0, 5)),
    );
    game.insert(
        "favorite".into(),
        json!(row.get::<_, i64>("favorite")? != 0),
    );
    game.insert("hidden".into(), json!(row.get::<_, i64>("hidden")? != 0));
    game.insert(
        "total_play_seconds".into(),
        json!(row.get::<_, i64>("total_play_seconds")?),
    );
    game.insert(
        "last_played_at".into(),
        json!(row.get::<_, Option<String>>("last_played_at")?),
    );
    for field in ["tags", "launch_args", "launch_profiles"] {
        let value = row.get::<_, String>(field)?;
        game.insert(
            field.into(),
            serde_json::from_str(&value).unwrap_or_else(|_| json!([])),
        );
    }
    let env_raw = row.get::<_, String>("launch_env")?;
    game.insert(
        "launch_env".into(),
        serde_json::from_str(&env_raw).unwrap_or_else(|_| json!({})),
    );
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
            play_status TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0,
            launch_env TEXT NOT NULL DEFAULT '{}', launch_profiles TEXT NOT NULL DEFAULT '[]',
            notes TEXT NOT NULL DEFAULT '', rating INTEGER NOT NULL DEFAULT 0,
            duplicate_key TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
            started_at TEXT NOT NULL, finished_at TEXT, seconds INTEGER NOT NULL DEFAULT 0,
            heartbeat_seconds INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT
        );
        CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY, name TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT 'folder', color TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collection_games (
            collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
            added_at TEXT NOT NULL,
            PRIMARY KEY (collection_id, game_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_game ON sessions(game_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_finished ON sessions(finished_at, game_id);
        CREATE INDEX IF NOT EXISTS idx_collection_games_game ON collection_games(game_id);",
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
        ("play_status", "play_status TEXT NOT NULL DEFAULT ''"),
        ("hidden", "hidden INTEGER NOT NULL DEFAULT 0"),
        ("launch_env", "launch_env TEXT NOT NULL DEFAULT '{}'"),
        (
            "launch_profiles",
            "launch_profiles TEXT NOT NULL DEFAULT '[]'",
        ),
        ("notes", "notes TEXT NOT NULL DEFAULT ''"),
        ("rating", "rating INTEGER NOT NULL DEFAULT 0"),
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

fn recovered_finished_at(
    started_at: &str,
    last_seen_at: Option<&str>,
    seconds: i64,
    fallback_now: &str,
) -> String {
    let Ok(started) = DateTime::parse_from_rfc3339(started_at) else {
        return fallback_now.to_owned();
    };
    let started_utc = started.with_timezone(&Utc);
    let max_end = started_utc + chrono::Duration::seconds(MAX_SESSION_SECONDS);
    let cap = DateTime::parse_from_rfc3339(fallback_now)
        .map(|now| now.with_timezone(&Utc).min(max_end))
        .unwrap_or(max_end);
    if let Some(seen) = last_seen_at.filter(|s| !s.is_empty()) {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(seen) {
            return parsed
                .with_timezone(&Utc)
                .min(cap)
                .max(started_utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true);
        }
    }
    let estimated = started_utc + chrono::Duration::seconds(seconds.clamp(0, MAX_SESSION_SECONDS));
    estimated
        .min(cap)
        .max(started_utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
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
        if !valid_language(&next["language"]) {
            return Err("Invalid language.".into());
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
        if !valid_discovery_ignored(&next["discoveryIgnored"]) {
            return Err("Invalid ignored discovery entries.".into());
        }
        if !valid_api_key(&next["steamGridDbApiKey"]) {
            return Err("Invalid SteamGridDB API key.".into());
        }
        if let Some(trimmed) = next["steamGridDbApiKey"].as_str().map(str::trim) {
            next["steamGridDbApiKey"] = json!(trimmed);
        }
        for key in [
            "reduceMotion",
            "autoScan",
            "useSteamArtwork",
            "onboardingDone",
            "performanceGuard",
            "autoUpdates",
            "controllerAutoEnter",
            "controllerAudio",
            "controllerHaptics",
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
                "SELECT s.game_id,s.started_at,s.finished_at,s.seconds,g.name,g.source,g.cover,g.icon,g.genre,g.play_status
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
                    genre: row.get::<_, String>(8).unwrap_or_default(),
                    play_status: row.get::<_, String>(9).unwrap_or_default(),
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

    #[cfg(any(target_os = "windows", test))]
    pub fn tray_games(&self, active_session_ids: &[String]) -> DbResult<Value> {
        let mut launchable = self.conn.prepare(
            "SELECT id,name FROM games WHERE favorite = ?1 AND (?1 = 1 OR last_played_at IS NOT NULL)
             AND (executable != '' OR launch_uri != '')
             ORDER BY last_played_at DESC,name COLLATE NOCASE,id LIMIT 5",
        ).map_err(error)?;
        let mut quick_games = |favorite: bool| {
            launchable
                .query_map([favorite], |row| {
                    Ok(json!({
                        "id":row.get::<_, String>(0)?,
                        "name":row.get::<_, String>(1)?
                    }))
                })
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)
        };
        let mut session = self
            .conn
            .prepare(
                "SELECT g.id,g.name,s.started_at FROM sessions s
             JOIN games g ON g.id=s.game_id WHERE s.id=?1 AND s.finished_at IS NULL",
            )
            .map_err(error)?;
        let mut active = Vec::new();
        for id in active_session_ids {
            let item = session
                .query_row([id], |row| {
                    Ok((
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                    ))
                })
                .optional()
                .map_err(error)?;
            active.extend(item);
        }
        active.sort();
        let active: Vec<Value> = active
            .into_iter()
            .map(|(started_at, id, name)| json!({"id":id,"name":name,"started_at":started_at}))
            .collect();
        Ok(json!({"active":active,"favorites":quick_games(true)?,"recent":quick_games(false)?}))
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

    // Used by unit tests and examples/benchmark.rs.
    #[allow(dead_code)]
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

fn valid_language(value: &Value) -> bool {
    ["system", "en", "nl", "de", "fr", "es"].contains(&value.as_str().unwrap_or(""))
}

fn valid_folders(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.len() <= 60
            && items
                .iter()
                .all(|v| v.as_str().is_some_and(|s| string_length(s) <= 4000))
    })
}

fn valid_api_key(value: &Value) -> bool {
    value.as_str().is_some_and(|raw| {
        let s = raw.trim();
        s.len() <= 128 && s.bytes().all(|b| b.is_ascii_graphic())
    })
}

fn valid_preferences(v: &Value) -> bool {
    ["grid", "list"].contains(&v["view"].as_str().unwrap_or(""))
        && ["name", "recent", "added", "time", "rating"].contains(&v["sort"].as_str().unwrap_or(""))
        && ["comfortable", "compact"].contains(&v["libraryDensity"].as_str().unwrap_or(""))
}

fn valid_discovery_ignored(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.len() <= 1000
            && items.iter().all(|item| {
                item.as_str().is_some_and(|key| {
                    key.len() == 64
                        && key
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                })
            })
    })
}

fn valid_setting(key: &str, value: &Value) -> bool {
    match key {
        "theme" => ["dark", "light", "system"].contains(&value.as_str().unwrap_or("")),
        "language" => valid_language(value),
        "accent" => valid_accent(value),
        "view" => ["grid", "list"].contains(&value.as_str().unwrap_or("")),
        "sort" => {
            ["name", "recent", "added", "time", "rating"].contains(&value.as_str().unwrap_or(""))
        }
        "libraryDensity" => ["comfortable", "compact"].contains(&value.as_str().unwrap_or("")),
        "libraryFolders" => valid_folders(value),
        "discoveryIgnored" => valid_discovery_ignored(value),
        "steamGridDbApiKey" => valid_api_key(value),
        "reduceMotion"
        | "autoScan"
        | "useSteamArtwork"
        | "scanDownloads"
        | "onboardingDone"
        | "performanceGuard"
        | "autoUpdates"
        | "controllerAutoEnter"
        | "controllerAudio"
        | "controllerHaptics" => value.is_boolean(),
        _ => false,
    }
}

fn sort_order(sort: &str) -> &'static str {
    match sort {
        "recent" => "last_played_at DESC, name COLLATE NOCASE ASC",
        "added" => "created_at DESC",
        "time" => "total_play_seconds DESC, name COLLATE NOCASE ASC",
        "rating" => "rating DESC, total_play_seconds DESC, name COLLATE NOCASE ASC",
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

fn insert_on(
    conn: &Connection,
    game: &Value,
    key: &str,
    backup_id: Option<&str>,
) -> DbResult<Value> {
    let id = backup_id
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let date = stamp();
    let tags = game["tags"].to_string();
    let args = game["launch_args"].to_string();
    let favorite = i64::from(js_truthy(&game["favorite"]));
    let hidden = i64::from(js_truthy(&game["hidden"]));
    let launch_env = game["launch_env"].to_string();
    let launch_profiles = game["launch_profiles"].to_string();
    let rating = game["rating"].as_i64().unwrap_or(0).clamp(0, 5);
    conn.execute(
        "INSERT INTO games (
            id,name,source,source_id,executable,launch_uri,install_path,cover,banner,icon,
            genre,tags,favorite,total_play_seconds,last_played_at,created_at,updated_at,
            launch_args,working_dir,cover_fit,cover_position,play_status,hidden,
            launch_env,launch_profiles,notes,rating,duplicate_key
        ) VALUES (
            ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,NULL,?14,?15,
            ?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26
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
            field(game, "play_status"),
            hidden,
            launch_env,
            launch_profiles,
            field(game, "notes"),
            rating,
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
    let launch_env = game["launch_env"].to_string();
    let launch_profiles = game["launch_profiles"].to_string();
    let rating = game["rating"].as_i64().unwrap_or(0).clamp(0, 5);
    conn.execute(
        "UPDATE games SET
            name=?1,source=?2,source_id=?3,executable=?4,launch_uri=?5,install_path=?6,
            cover=?7,banner=?8,icon=?9,genre=?10,tags=?11,favorite=?12,
            launch_args=?13,working_dir=?14,cover_fit=?15,cover_position=?16,
            play_status=?17,hidden=?18,launch_env=?19,launch_profiles=?20,
            notes=?21,rating=?22,duplicate_key=?23,updated_at=?24 WHERE id=?25",
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
            field(&game, "play_status"),
            i64::from(js_truthy(&game["hidden"])),
            launch_env,
            launch_profiles,
            field(&game, "notes"),
            rating,
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
    Ok(json!({"game": insert_on(conn, &game, &key, None)?, "added": true}))
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

fn restored_play_seconds(raw: &Value) -> i64 {
    // Number.isSafeInteger in the old JavaScript importer accepts 12500.0.
    raw.get("total_play_seconds")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0)
        .map(|n| n.min((100_i64 * 365 * 24 * 3600) as f64) as i64)
        .unwrap_or(0)
}

fn restore_metadata_on(conn: &Connection, raw: &Value, id: &str) -> DbResult<()> {
    let created = iso_date(&raw["created_at"]);
    let last_played = iso_date(&raw["last_played_at"]);
    let existing = LibraryDatabase::get_on(conn, id)?;
    let created = created.unwrap_or_else(|| field(&existing, "created_at").to_owned());
    conn.execute(
        "UPDATE games SET total_play_seconds=?1,last_played_at=?2,created_at=?3 WHERE id=?4",
        params![restored_play_seconds(raw), last_played, created, id],
    )
    .map_err(error)?;
    Ok(())
}

fn same_backup_game(existing: &Value, incoming: &Value) -> bool {
    let existing_store = has_store_identity(existing);
    let incoming_store = has_store_identity(incoming);
    if existing_store && incoming_store {
        return field(existing, "source").eq_ignore_ascii_case(field(incoming, "source"))
            && field(existing, "source_id").eq_ignore_ascii_case(field(incoming, "source_id"));
    }
    let old_key = duplicate_key(existing);
    let incoming_key = duplicate_key(incoming);
    if !old_key.is_empty() && !incoming_key.is_empty() {
        return old_key == incoming_key;
    }
    field(existing, "source") == field(incoming, "source")
        && field(existing, "name") == field(incoming, "name")
}

impl LibraryDatabase {
    pub fn upsert(&mut self, raw: &Value) -> DbResult<Value> {
        upsert_on(&self.conn, raw, false)
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

    pub fn list_collections(&self) -> DbResult<Value> {
        Self::list_collections_on(&self.conn)
    }

    fn list_collections_on(conn: &Connection) -> DbResult<Value> {
        let mut stmt = conn
            .prepare(
                "SELECT id,name,icon,color,position,created_at,updated_at
                 FROM collections ORDER BY position ASC, name COLLATE NOCASE ASC",
            )
            .map_err(error)?;
        let mut collections = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        let mut members: HashMap<String, Vec<String>> = HashMap::new();
        let mut mem_stmt = conn
            .prepare("SELECT collection_id, game_id FROM collection_games ORDER BY added_at ASC")
            .map_err(error)?;
        let rows = mem_stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?;
        for row in rows {
            let (cid, gid) = row.map_err(error)?;
            members.entry(cid).or_default().push(gid);
        }
        let result = collections
            .drain(..)
            .map(
                |(id, name, icon, color, position, created_at, updated_at)| {
                    let game_ids = members.remove(&id).unwrap_or_default();
                    json!({
                        "id": id,
                        "name": name,
                        "icon": icon,
                        "color": color,
                        "position": position,
                        "created_at": created_at,
                        "updated_at": updated_at,
                        "game_ids": game_ids,
                    })
                },
            )
            .collect::<Vec<_>>();
        Ok(Value::Array(result))
    }

    pub fn create_collection(&mut self, raw: &Value) -> DbResult<Value> {
        if !raw.is_object() {
            return Err("Invalid collection data.".into());
        }
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))
            .map_err(error)?;
        if count as usize >= MAX_COLLECTIONS {
            return Err("You can create at most 100 custom collections.".into());
        }
        let name = raw
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if name.is_empty() || string_length(name) > 60 || name.chars().any(char::is_control) {
            return Err("Collection name must contain 1–60 characters.".into());
        }
        let exists: i64 = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE name=?1 COLLATE NOCASE)",
                [name],
                |r| r.get(0),
            )
            .map_err(error)?;
        if exists != 0 {
            return Err("A collection with this name already exists.".into());
        }
        let icon = raw
            .get("icon")
            .and_then(Value::as_str)
            .filter(|i| COLLECTION_ICONS.contains(i))
            .unwrap_or("folder");
        let color = match raw.get("color") {
            None | Some(Value::Null) => "",
            Some(v) if v.as_str() == Some("") => "",
            Some(v) if valid_accent(v) => v.as_str().unwrap_or(""),
            _ => return Err("Invalid collection color.".into()),
        };
        let id = Uuid::new_v4().to_string();
        let date = stamp();
        let next_pos: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM collections",
                [],
                |r| r.get(0),
            )
            .map_err(error)?;
        self.conn
            .execute(
                "INSERT INTO collections (id,name,icon,color,position,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![id, name, icon, color, next_pos, date, date],
            )
            .map_err(error)?;
        Ok(json!({
            "id": id,
            "name": name,
            "icon": icon,
            "color": color,
            "position": next_pos,
            "created_at": date,
            "updated_at": date,
            "game_ids": [],
        }))
    }

    pub fn update_collection(&mut self, id: &str, patch: &Value) -> DbResult<Value> {
        if !valid_backup_id(id) || !patch.is_object() {
            return Err("Invalid collection update.".into());
        }
        let existing: Option<(String, String, String, i64, String)> = self
            .conn
            .query_row(
                "SELECT name,icon,color,position,created_at FROM collections WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(error)?;
        let Some((old_name, old_icon, old_color, old_pos, created_at)) = existing else {
            return Err("Collection not found.".into());
        };
        let name = if let Some(val) = patch.get("name") {
            let trimmed = val.as_str().map(str::trim).unwrap_or("");
            if trimmed.is_empty()
                || string_length(trimmed) > 60
                || trimmed.chars().any(char::is_control)
            {
                return Err("Collection name must contain 1–60 characters.".into());
            }
            let duplicate: i64 = self
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM collections WHERE name=?1 COLLATE NOCASE AND id!=?2)",
                    params![trimmed, id],
                    |r| r.get(0),
                )
                .map_err(error)?;
            if duplicate != 0 {
                return Err("A collection with this name already exists.".into());
            }
            trimmed.to_owned()
        } else {
            old_name
        };
        let icon = if let Some(val) = patch.get("icon") {
            let icon = val.as_str().unwrap_or("");
            if !COLLECTION_ICONS.contains(&icon) {
                return Err("Invalid collection icon.".into());
            }
            icon.to_owned()
        } else {
            old_icon
        };
        let color = if let Some(val) = patch.get("color") {
            if val.is_null() || val.as_str() == Some("") {
                String::new()
            } else if valid_accent(val) {
                val.as_str().unwrap_or("").to_owned()
            } else {
                return Err("Invalid collection color.".into());
            }
        } else {
            old_color
        };
        let position = patch
            .get("position")
            .and_then(Value::as_i64)
            .unwrap_or(old_pos)
            .clamp(0, 10_000);
        let date = stamp();
        self.conn
            .execute(
                "UPDATE collections SET name=?1,icon=?2,color=?3,position=?4,updated_at=?5 WHERE id=?6",
                params![name, icon, color, position, date, id],
            )
            .map_err(error)?;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT game_id FROM collection_games WHERE collection_id=?1 ORDER BY added_at ASC",
            )
            .map_err(error)?;
        let game_ids = stmt
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        Ok(json!({
            "id": id,
            "name": name,
            "icon": icon,
            "color": color,
            "position": position,
            "created_at": created_at,
            "updated_at": date,
            "game_ids": game_ids,
        }))
    }

    pub fn delete_collection(&mut self, id: &str) -> DbResult<bool> {
        if !valid_backup_id(id) {
            return Err("Invalid collection identifier.".into());
        }
        self.conn
            .execute("DELETE FROM collections WHERE id=?1", [id])
            .map(|count| count > 0)
            .map_err(error)
    }

    pub fn set_game_collections(
        &mut self,
        game_id: &str,
        collection_ids: &[String],
    ) -> DbResult<Value> {
        if !valid_backup_id(game_id) {
            return Err("Invalid game identifier.".into());
        }
        if collection_ids.len() > MAX_COLLECTIONS {
            return Err("Too many collections selected.".into());
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        if Self::get_on(&tx, game_id)?.is_null() {
            return Err("Game not found.".into());
        }
        tx.execute("DELETE FROM collection_games WHERE game_id=?1", [game_id])
            .map_err(error)?;
        let date = stamp();
        for cid in collection_ids {
            if !valid_backup_id(cid) {
                return Err("Invalid collection identifier.".into());
            }
            let exists: i64 = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
                    [cid],
                    |r| r.get(0),
                )
                .map_err(error)?;
            if exists != 0 {
                tx.execute(
                    "INSERT OR IGNORE INTO collection_games (collection_id, game_id, added_at) VALUES (?1,?2,?3)",
                    params![cid, game_id, date],
                )
                .map_err(error)?;
            }
        }
        let collections = Self::list_collections_on(&tx)?;
        tx.commit().map_err(error)?;
        Ok(collections)
    }

    pub fn bulk_update_games(&mut self, ids: &[String], action: &Value) -> DbResult<Value> {
        if ids.is_empty() {
            return Err("Select at least one game.".into());
        }
        if ids.len() > MAX_BULK_IDS {
            return Err("Bulk action limit is 5000 games.".into());
        }
        let Some(obj) = action.as_object() else {
            return Err("Invalid bulk action payload.".into());
        };
        let play_status = if let Some(val) = obj.get("play_status") {
            let status = val.as_str().ok_or("Invalid play status.")?;
            if !PLAY_STATUSES.contains(&status) {
                return Err("Unsupported play status.".into());
            }
            Some(status.to_owned())
        } else {
            None
        };
        let hidden = if let Some(val) = obj.get("hidden") {
            Some(val.as_bool().ok_or("Hidden value must be boolean.")?)
        } else {
            None
        };
        let add_tags = if let Some(val) = obj.get("add_tags") {
            let arr = val.as_array().ok_or("add_tags must be an array.")?;
            if arr.len() > 20 {
                return Err("At most 20 tags can be added at once.".into());
            }
            let mut parsed = Vec::new();
            for item in arr {
                let tag = item.as_str().map(str::trim).unwrap_or("");
                if !tag.is_empty() {
                    if string_length(tag) > 36 || tag.chars().any(char::is_control) {
                        return Err("Tags must be 36 characters or shorter.".into());
                    }
                    parsed.push(tag.to_owned());
                }
            }
            Some(parsed)
        } else {
            None
        };
        let remove_tags = if let Some(val) = obj.get("remove_tags") {
            let arr = val.as_array().ok_or("remove_tags must be an array.")?;
            let parsed = arr
                .iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect::<HashSet<_>>();
            Some(parsed)
        } else {
            None
        };
        let add_collection_id = obj
            .get("add_collection_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let remove_collection_id = obj
            .get("remove_collection_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if let Some(ref cid) = add_collection_id {
            if !valid_backup_id(cid) {
                return Err("Invalid collection identifier.".into());
            }
        }
        if let Some(ref cid) = remove_collection_id {
            if !valid_backup_id(cid) {
                return Err("Invalid collection identifier.".into());
            }
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        if let Some(ref cid) = add_collection_id {
            let exists: i64 = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
                    [cid],
                    |r| r.get(0),
                )
                .map_err(error)?;
            if exists == 0 {
                return Err("Collection not found.".into());
            }
        }
        let date = stamp();
        let mut seen = HashSet::with_capacity(ids.len());
        let mut updated_games = Vec::new();
        for id in ids {
            if !valid_backup_id(id) || !seen.insert(id.as_str()) {
                continue;
            }
            let existing = Self::get_on(&tx, id)?;
            if existing.is_null() {
                continue;
            }
            let mut changed_row = false;
            let next_status = if let Some(ref status) = play_status {
                changed_row = true;
                status.as_str()
            } else {
                field(&existing, "play_status")
            };
            let next_hidden = if let Some(flag) = hidden {
                changed_row = true;
                i64::from(flag)
            } else {
                i64::from(js_truthy(&existing["hidden"]))
            };
            let mut tags = existing["tags"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if let Some(ref removals) = remove_tags {
                let before = tags.len();
                tags.retain(|tag| !removals.contains(&tag.to_ascii_lowercase()));
                if tags.len() != before {
                    changed_row = true;
                }
            }
            if let Some(ref additions) = add_tags {
                let mut existing_lower: HashSet<String> =
                    tags.iter().map(|t| t.to_ascii_lowercase()).collect();
                for tag in additions {
                    if tags.len() >= 40 {
                        break;
                    }
                    if existing_lower.insert(tag.to_ascii_lowercase()) {
                        tags.push(tag.clone());
                        changed_row = true;
                    }
                }
            }
            if changed_row {
                let tags_json =
                    Value::Array(tags.into_iter().map(Value::String).collect()).to_string();
                tx.execute(
                    "UPDATE games SET play_status=?1, hidden=?2, tags=?3, updated_at=?4 WHERE id=?5",
                    params![next_status, next_hidden, tags_json, date, id],
                )
                .map_err(error)?;
            }
            if let Some(ref cid) = add_collection_id {
                tx.execute(
                    "INSERT OR IGNORE INTO collection_games (collection_id, game_id, added_at) VALUES (?1,?2,?3)",
                    params![cid, id, date],
                )
                .map_err(error)?;
            }
            if let Some(ref cid) = remove_collection_id {
                tx.execute(
                    "DELETE FROM collection_games WHERE collection_id=?1 AND game_id=?2",
                    params![cid, id],
                )
                .map_err(error)?;
            }
            updated_games.push(Self::get_on(&tx, id)?);
        }
        let collections = Self::list_collections_on(&tx)?;
        tx.commit().map_err(error)?;
        Ok(json!({
            "updatedCount": updated_games.len(),
            "updatedGames": updated_games,
            "collections": collections,
        }))
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
            "UPDATE games SET last_played_at=?1,updated_at=?1,play_status=CASE WHEN play_status='backlog' THEN 'playing' ELSE play_status END WHERE id=?2",
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
                "UPDATE games SET last_played_at=?1,updated_at=?1,play_status=CASE WHEN play_status='backlog' THEN 'playing' ELSE play_status END WHERE id=?2",
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
                    "SELECT id,game_id,started_at,heartbeat_seconds,last_seen_at FROM sessions WHERE finished_at IS NULL",
                )
                .map_err(error)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                })
                .map_err(error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?
        };
        let date = stamp();
        let mut count = 0;
        for (id, game_id, started_at, heartbeat, last_seen_at) in stale {
            let seconds = heartbeat.clamp(0, MAX_SESSION_SECONDS);
            let finished_at =
                recovered_finished_at(&started_at, last_seen_at.as_deref(), seconds, &date);
            if tx.execute(
                "UPDATE sessions SET finished_at=?1,seconds=?2 WHERE id=?3 AND finished_at IS NULL",
                params![finished_at, seconds, id],
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

    pub fn list_sessions(&self, game_id: &str, page: i64) -> DbResult<Value> {
        if !valid_backup_id(game_id) {
            return Err("Invalid game identifier.".into());
        }
        if !(0..=STATS_MAX_ROWS / SESSION_PAGE_SIZE).contains(&page) {
            return Err("Invalid session page.".into());
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,started_at,finished_at,seconds FROM sessions
                 WHERE game_id=?1 AND finished_at IS NOT NULL
                 ORDER BY julianday(started_at) DESC,id DESC LIMIT ?2 OFFSET ?3",
            )
            .map_err(error)?;
        let mut rows = stmt
            .query_map(
                params![game_id, SESSION_PAGE_SIZE + 1, page * SESSION_PAGE_SIZE],
                |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "started_at": row.get::<_, String>(1)?,
                        "finished_at": row.get::<_, String>(2)?,
                        "seconds": row.get::<_, i64>(3)?,
                    }))
                },
            )
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        let has_more = rows.len() > SESSION_PAGE_SIZE as usize;
        rows.truncate(SESSION_PAGE_SIZE as usize);
        Ok(json!({"rows":rows,"hasMore":has_more}))
    }

    pub fn correct_session(
        &mut self,
        game_id: &str,
        session_id: &str,
        seconds: i64,
    ) -> DbResult<Value> {
        if !valid_backup_id(game_id) || !valid_backup_id(session_id) {
            return Err("Invalid session identifier.".into());
        }
        if !(0..=MAX_SESSION_SECONDS).contains(&seconds) {
            return Err("Invalid session duration.".into());
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let (start, finish, previous): (String, String, i64) = tx
            .query_row(
                "SELECT started_at,finished_at,seconds FROM sessions WHERE game_id=?1 AND id=?2 AND finished_at IS NOT NULL",
                params![game_id, session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(error)?
            .ok_or("Completed session not found.")?;
        let elapsed = DateTime::parse_from_rfc3339(&start)
            .and_then(|start| {
                DateTime::parse_from_rfc3339(&finish)
                    .map(|end| end.timestamp_millis() - start.timestamp_millis())
            })
            .map_err(|_| "Invalid recorded session interval.")?;
        if seconds * 1000 > elapsed {
            return Err("Session duration exceeds the recorded interval.".into());
        }
        if previous < 0 {
            return Err("Invalid recorded session duration.".into());
        }
        if previous != seconds {
            tx.execute(
                "UPDATE sessions SET seconds=?1 WHERE id=?2",
                params![seconds, session_id],
            )
            .map_err(error)?;
            tx.execute(
                "UPDATE games SET total_play_seconds=MAX(0,total_play_seconds+?1),updated_at=?2 WHERE id=?3",
                params![seconds - previous, stamp(), game_id],
            )
            .map_err(error)?;
        }
        tx.commit().map_err(error)?;
        self.get(game_id)
    }

    /// Metadata and complete historical sessions. The .orbit gzip archive and
    /// safe artwork installation are handled by the backup/packaging layer.
    /// Unfinished or invalid sessions make a full-history export impossible;
    /// report that explicitly instead of silently producing a partial backup.
    pub fn export_json(&self) -> DbResult<Value> {
        let tx = self.conn.unchecked_transaction().map_err(error)?;
        let game_count: i64 = tx
            .query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
            .map_err(error)?;
        if game_count > BACKUP_MAX_GAMES as i64 {
            return Err("Cannot export more than 100000 games in an Orbit backup.".into());
        }
        let unfinished: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE finished_at IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(error)?;
        if unfinished > 0 {
            return Err(format!(
                "Cannot export full session history while {unfinished} session(s) remain unfinished. Finish or recover them first."
            ));
        }
        let games = self.list("name")?;
        if games
            .as_array()
            .map_or(true, |rows| rows.len() > BACKUP_MAX_GAMES)
        {
            return Err("Cannot export more than 100000 games in an Orbit backup.".into());
        }
        let game_ids: HashSet<&str> = games
            .as_array()
            .ok_or("Invalid library for backup.")?
            .iter()
            .filter_map(|game| game.get("id").and_then(Value::as_str))
            .collect();
        let sessions = {
            let mut statement = tx
                .prepare(
                    "SELECT id,game_id,started_at,finished_at,seconds FROM sessions ORDER BY started_at,id LIMIT ?1",
                )
                .map_err(error)?;
            let rows = statement
                .query_map([BACKUP_MAX_SESSIONS as i64 + 1], |row| {
                    Ok(json!({
                        "id":row.get::<_, String>(0)?,
                        "game_id":row.get::<_, String>(1)?,
                        "started_at":row.get::<_, String>(2)?,
                        "finished_at":row.get::<_, Option<String>>(3)?,
                        "seconds":row.get::<_, i64>(4)?
                    }))
                })
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?;
            rows
        };
        let validated = validate_backup_sessions(&json!({"sessions":sessions}))?
            .expect("sessions array is present");
        if validated
            .iter()
            .any(|session| !game_ids.contains(session.game_id.as_str()))
        {
            return Err("Session history contains a missing game reference.".into());
        }
        let collections = Self::list_collections_on(&tx)?;
        let mut settings = self.get_settings()?;
        // Never export user API keys in portable or JSON library backups.
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("steamGridDbApiKey");
        }
        let result = json!({
            "format": "orbit.library.v1",
            "exported_at": stamp(),
            "settings": settings,
            "games": games,
            "sessions": sessions,
            "collections": collections
        });
        tx.commit().map_err(error)?;
        Ok(result)
    }

    fn restore_collections_on(
        tx: &Transaction<'_>,
        collections: &[BackupCollection],
        id_map: &HashMap<String, String>,
    ) -> DbResult<usize> {
        let date = stamp();
        let mut restored = 0_usize;
        for col in collections {
            let existing_by_id: Option<String> = tx
                .query_row("SELECT id FROM collections WHERE id=?1", [&col.id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(error)?;
            let target_id = if let Some(id) = existing_by_id {
                id
            } else if let Some(existing_by_name) = tx
                .query_row(
                    "SELECT id FROM collections WHERE name=?1 COLLATE NOCASE",
                    [&col.name],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(error)?
            {
                existing_by_name
            } else {
                let count: i64 = tx
                    .query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))
                    .map_err(error)?;
                if count as usize >= MAX_COLLECTIONS {
                    continue;
                }
                tx.execute(
                    "INSERT INTO collections (id,name,icon,color,position,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![col.id, col.name, col.icon, col.color, col.position, date, date],
                )
                .map_err(error)?;
                restored += 1;
                col.id.clone()
            };
            for source_gid in &col.game_ids {
                if let Some(dest_gid) = id_map.get(source_gid) {
                    tx.execute(
                        "INSERT OR IGNORE INTO collection_games (collection_id, game_id, added_at) VALUES (?1,?2,?3)",
                        params![target_id, dest_gid, date],
                    )
                    .map_err(error)?;
                }
            }
        }
        Ok(restored)
    }

    fn restore_with_sessions(
        &mut self,
        games: &[Value],
        sessions: &[BackupSession],
        collections: Option<&[BackupCollection]>,
        settings: Option<&Value>,
        dry_run: bool,
    ) -> DbResult<Value> {
        // Validate all source IDs, game records and references before taking a
        // writer lock. A broken history must never import only some games.
        let mut source_ids = HashSet::with_capacity(games.len());
        let mut cleaned = Vec::with_capacity(games.len());
        for game in games {
            let source_id = game
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_backup_id(id))
                .ok_or("A game in a session-history backup has no valid ID.")?;
            if !source_ids.insert(source_id.to_owned()) {
                return Err(format!(
                    "Duplicate game ID in session-history backup: {source_id}."
                ));
            }
            cleaned.push(clean_game(game, None)?);
        }
        for session in sessions {
            if !source_ids.contains(&session.game_id) {
                return Err(format!(
                    "Backup session {} references a game absent from the backup.",
                    session.id
                ));
            }
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let mut id_map = HashMap::with_capacity(games.len());
        let mut target_ids = HashSet::with_capacity(games.len());
        let (mut imported, mut skipped) = (0_usize, 0_usize);
        for (raw, parsed) in games.iter().zip(cleaned.iter()) {
            let source_id = field(raw, "id");
            let key = duplicate_key(parsed);
            let by_id = Self::get_on(&tx, source_id)?;
            let destination = if !by_id.is_null() {
                // A matching ID with a different source/product is a collision.
                // Never attach the incoming history to that unrelated record.
                if !same_backup_game(&by_id, parsed)
                    || find_duplicate_on(&tx, parsed, &key, source_id)?.is_some()
                {
                    return Err(format!(
                        "Backup game ID {source_id} conflicts with an existing game."
                    ));
                }
                skipped += 1;
                source_id.to_owned()
            } else if let Some(existing_id) = find_duplicate_on(&tx, parsed, &key, "")? {
                skipped += 1;
                existing_id
            } else {
                let inserted = insert_on(&tx, parsed, &key, Some(source_id))?;
                let id = field(&inserted, "id").to_owned();
                restore_metadata_on(&tx, raw, &id)?;
                imported += 1;
                id
            };
            // Two different source games may use one executable. History must
            // never collapse into one destination game as a side effect of
            // duplicate detection or restore ordering.
            if !target_ids.insert(destination.clone()) {
                return Err(format!(
                    "Multiple backup games resolve to the same destination game: {destination}."
                ));
            }
            id_map.insert(source_id.to_owned(), destination);
        }

        let (mut sessions_imported, mut sessions_skipped) = (0_usize, 0_usize);
        for session in sessions {
            let destination = id_map
                .get(&session.game_id)
                .ok_or("Session game mapping is incomplete.")?;
            let existing: Option<(String, String, Option<String>, i64)> = tx
                .query_row(
                    "SELECT game_id,started_at,finished_at,seconds FROM sessions WHERE id=?1",
                    [&session.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(error)?;
            if let Some((game_id, started_at, finished_at, seconds)) = existing {
                let same_start = DateTime::parse_from_rfc3339(&started_at).ok()
                    == DateTime::parse_from_rfc3339(&session.started_at).ok();
                let same_finish = finished_at
                    .as_deref()
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    == DateTime::parse_from_rfc3339(&session.finished_at).ok();
                if game_id != *destination
                    || !same_start
                    || !same_finish
                    || seconds != session.seconds
                {
                    return Err(format!(
                        "Backup session ID {} conflicts with existing history.",
                        session.id
                    ));
                }
                sessions_skipped += 1;
            } else {
                tx.execute(
                    "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES (?1,?2,?3,?4,?5)",
                    params![session.id, destination, session.started_at, session.finished_at, session.seconds],
                )
                .map_err(error)?;
                // Backed-up games already contain aggregate playtime. Existing
                // destination games keep their own aggregate. No credit here.
                sessions_imported += 1;
            }
        }
        let collections_restored = if let Some(cols) = collections {
            Self::restore_collections_on(&tx, cols, &id_map)?
        } else {
            0
        };
        if dry_run {
            // Exercise the exact same game-ID remapping and session collision
            // checks as a real restore, but roll back every temporary write.
            // The portable decoder calls this BEFORE installing any artwork.
            tx.rollback().map_err(error)?;
            return Ok(Value::Null);
        }
        tx.commit().map_err(error)?;

        let mut errors = Vec::new();
        let mut settings_restored = false;
        if let Some(value) = settings.filter(|value| value.is_object()) {
            match self.save_settings(value) {
                Ok(_) => settings_restored = true,
                Err(message) => errors.push(format!("Settings: {message}")),
            }
        }
        Ok(json!({
            "imported":imported, "skipped":skipped, "errors":errors,
            "settingsRestored":settings_restored,
            "sessionsImported":sessions_imported,
            "sessionsSkipped":sessions_skipped,
            "collectionsRestored":collections_restored
        }))
    }

    /// Preflight an untrusted portable restore under a real rollback-only SQL
    /// transaction. This catches mapping and session-ID collisions *before*
    /// the portable decoder installs a single new artwork file.
    pub fn preflight_restore_json(&mut self, payload: &Value) -> DbResult<()> {
        if payload.get("format").and_then(Value::as_str) != Some("orbit.library.v1") {
            return Err("Unrecognized Orbit backup format.".into());
        }
        let games = payload
            .get("games")
            .and_then(Value::as_array)
            .ok_or("Unrecognized Orbit backup format.")?;
        if games.len() > BACKUP_MAX_GAMES {
            return Err("Backup game count exceeds the safe limit.".into());
        }
        for game in games {
            clean_game(game, None)?;
        }
        let collections = validate_backup_collections(payload)?;
        if let Some(sessions) = validate_backup_sessions(payload)? {
            self.restore_with_sessions(games, &sessions, collections.as_deref(), None, true)?;
        } else {
            // Old orbit.library.v1 files have no sessions property. Exercise
            // their actual game insert and metadata writes in a rollback-only
            // transaction before portable artwork is installed. Validation of
            // fields alone cannot detect a failing SQLite constraint/trigger.
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            let mut id_map = HashMap::new();
            for raw in games {
                let result = upsert_on(&tx, raw, false)?;
                let dest_id = field(&result["game"], "id").to_owned();
                if let Some(src_id) = raw.get("id").and_then(Value::as_str) {
                    id_map.insert(src_id.to_owned(), dest_id.clone());
                }
                if result["added"] == true {
                    restore_metadata_on(&tx, raw, &dest_id)?;
                }
            }
            if let Some(cols) = collections.as_deref() {
                Self::restore_collections_on(&tx, cols, &id_map)?;
            }
            tx.rollback().map_err(error)?;
        }
        Ok(())
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
        if games.len() > BACKUP_MAX_GAMES {
            return Err("Unrecognized Orbit backup format.".into());
        }
        let collections = validate_backup_collections(payload)?;
        let sessions = validate_backup_sessions(payload)?;
        if let Some(sessions) = sessions {
            return self.restore_with_sessions(
                games,
                &sessions,
                collections.as_deref(),
                payload.get("settings"),
                false,
            );
        }
        let games = games.clone();
        let settings = payload.get("settings").cloned();
        let (mut imported, mut skipped) = (0, 0);
        let mut errors = Vec::new();
        let mut id_map = HashMap::new();
        for game in games {
            let src_id = game.get("id").and_then(Value::as_str).map(str::to_owned);
            match self.restore_game(&game) {
                Ok(result) => {
                    if let Some(src) = src_id {
                        id_map.insert(src, field(&result["game"], "id").to_owned());
                    }
                    if result["added"] == true {
                        imported += 1;
                    } else {
                        skipped += 1;
                    }
                }
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
        if let Some(cols) = collections.as_deref() {
            let tx = self.conn.transaction().map_err(error)?;
            let _ = Self::restore_collections_on(&tx, cols, &id_map)?;
            tx.commit().map_err(error)?;
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
    fn tray_games_reports_only_owned_sessions_and_separate_launch_groups() {
        with_database(|db, _| {
            let first = db.upsert(&json!({
                "name":"Pinned game","source":"steam","source_id":"101","launch_uri":"steam://rungameid/101"
            })).unwrap();
            let recent = db.upsert(&json!({
                "name":"Recent game","source":"steam","source_id":"202","launch_uri":"steam://rungameid/202"
            })).unwrap();
            let first_id = field(&first["game"], "id");
            let recent_id = field(&recent["game"], "id");
            db.toggle_favorite(first_id).unwrap();
            let active = db.start_session(first_id).unwrap();
            let finished = db.start_session(recent_id).unwrap();
            db.finish_session(&finished, 25).unwrap();
            let tray = db.tray_games(&[active, finished]).unwrap();
            assert_eq!(tray["active"].as_array().unwrap().len(), 1);
            assert_eq!(tray["active"][0]["id"], first_id);
            assert!(DateTime::parse_from_rfc3339(
                tray["active"][0]["started_at"].as_str().unwrap()
            )
            .is_ok());
            assert_eq!(tray["favorites"][0]["id"], first_id);
            assert_eq!(tray["recent"][0]["id"], recent_id);
            assert!(db.tray_games(&[]).unwrap()["active"]
                .as_array()
                .unwrap()
                .is_empty());
        });
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
            assert_eq!(db.get_settings().unwrap()["language"], "system");
            let settings = db.save_settings(&json!({
                "theme":"light", "accent":"#66AABB", "autoScan":true, "libraryFolders":["D:\\Games"], "language":"nl"
            })).unwrap();
            assert_eq!(settings["theme"], "light");
            assert_eq!(settings["language"], "nl");
            assert_eq!(settings["autoScan"], true);
            for language in ["system", "en", "nl", "de", "fr", "es"] {
                assert_eq!(
                    db.save_settings(&json!({"language":language})).unwrap()["language"],
                    language
                );
            }
            for invalid in [
                json!("it"),
                json!("EN"),
                json!(""),
                json!(null),
                json!(2),
                json!({}),
            ] {
                assert!(db.save_settings(&json!({"language":invalid})).is_err());
                assert_eq!(db.get_settings().unwrap()["language"], "es");
            }
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
            db.conn
                .execute(
                    "UPDATE settings SET value='\"bogus\"' WHERE key='language'",
                    [],
                )
                .unwrap();
            let recovered = db.get_settings().unwrap();
            assert_eq!(recovered["theme"], "dark");
            assert_eq!(recovered["accent"], "#8b7aff");
            assert_eq!(recovered["autoScan"], true);
            assert_eq!(recovered["language"], "system");
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
    fn correct_session_preserves_unrelated_playtime_and_backup_dates() {
        with_database(|db, _| {
            let game = db.upsert(&json!({"name":"History"})).unwrap();
            let id = game["game"]["id"].as_str().unwrap();
            let start = "2026-11-10T18:00:00Z";
            let finish = "2026-11-10T18:05:00Z";
            db.conn
                .execute(
                    "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds)
                     VALUES ('saved-session',?1,?2,?3,137)",
                    params![id, start, finish],
                )
                .unwrap();
            db.conn
                .execute("UPDATE games SET total_play_seconds=437 WHERE id=?1", [id])
                .unwrap();
            let active = db.start_session(id).unwrap();
            assert_eq!(
                db.list_sessions(id, 0).unwrap(),
                json!({
                    "rows":[{"id":"saved-session","started_at":start,"finished_at":finish,"seconds":137}],
                    "hasMore":false
                })
            );
            assert!(db.correct_session(id, &active, 30).is_err());
            assert!(db.correct_session(id, "saved-session", 301).is_err());
            assert_eq!(
                db.correct_session(id, "saved-session", 80).unwrap()["total_play_seconds"],
                380
            );
            assert_eq!(
                db.correct_session(id, "saved-session", 80).unwrap()["total_play_seconds"],
                380
            );
            assert!(db.finish_session(&active, 0).unwrap());
            let exported = db.export_json().unwrap();
            let row = exported["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == "saved-session")
                .unwrap();
            assert_eq!(
                row,
                &json!({"id":"saved-session","game_id":id,"started_at":start,"finished_at":finish,"seconds":80})
            );
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
                "settings":{"theme":"light","accent":"#567abc","language":"de"}
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
            assert_eq!(exported["settings"]["language"], "de");
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
    fn completed_history_restores_multiple_games_same_executable_and_is_idempotent() {
        with_database(|destination, path| {
            let mut source = LibraryDatabase::open(path.with_file_name("source.sqlite")).unwrap();
            let executable = r"C:\Orbit\Shared\Game.exe";
            let first = source
                .upsert(&json!({
                    "name":"Shared edition A","source":"epic","source_id":"A",
                    "executable":executable
                }))
                .unwrap()["game"]
                .clone();
            let second = source
                .upsert(&json!({
                    "name":"Shared edition B","source":"epic","source_id":"B",
                    "executable":executable
                }))
                .unwrap()["game"]
                .clone();
            let first_id = field(&first, "id");
            let second_id = field(&second, "id");
            assert_ne!(first_id, second_id);
            for (session_id, game_id, start, end, seconds) in [
                (
                    "hist-1",
                    first_id,
                    "2025-01-02T10:00:00Z",
                    "2025-01-02T10:01:00Z",
                    60_i64,
                ),
                (
                    "hist-2",
                    second_id,
                    "2025-01-03T10:00:00Z",
                    "2025-01-03T10:02:00Z",
                    120_i64,
                ),
            ] {
                source.conn.execute(
                    "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES (?1,?2,?3,?4,?5)",
                    params![session_id, game_id, start, end, seconds],
                ).unwrap();
                source
                    .conn
                    .execute(
                        "UPDATE games SET total_play_seconds=?1,last_played_at=?2 WHERE id=?3",
                        params![seconds, end, game_id],
                    )
                    .unwrap();
            }
            let backup = source.export_json().unwrap();
            assert_eq!(backup["format"], "orbit.library.v1");
            assert_eq!(backup["sessions"].as_array().unwrap().len(), 2);
            assert_eq!(backup["sessions"][0]["id"], "hist-1");
            let first_report = destination.restore_json(&backup).unwrap();
            assert_eq!(first_report["imported"], 2);
            assert_eq!(first_report["sessionsImported"], 2);
            assert_eq!(first_report["sessionsSkipped"], 0);
            assert_eq!(destination.count().unwrap(), 2);
            assert_eq!(destination.get(first_id).unwrap()["total_play_seconds"], 60);
            assert_eq!(
                destination.get(second_id).unwrap()["total_play_seconds"],
                120
            );
            assert_eq!(
                destination.export_json().unwrap()["sessions"],
                backup["sessions"]
            );

            let repeat = destination.restore_json(&backup).unwrap();
            assert_eq!(repeat["imported"], 0);
            assert_eq!(repeat["skipped"], 2);
            assert_eq!(repeat["sessionsImported"], 0);
            assert_eq!(repeat["sessionsSkipped"], 2);
            assert_eq!(destination.count().unwrap(), 2);
            assert_eq!(destination.get(first_id).unwrap()["total_play_seconds"], 60);
            assert_eq!(
                destination.get(second_id).unwrap()["total_play_seconds"],
                120
            );

            let current = destination.start_session(first_id).unwrap();
            destination
                .checkpoint_sessions(&[json!({"id":current,"seconds":35})])
                .unwrap();
            assert!(destination.finish_session(&current, 35).unwrap());
            assert!(!destination.finish_session(&current, 35).unwrap());
            assert_eq!(destination.get(first_id).unwrap()["total_play_seconds"], 95);
            assert_eq!(
                destination.restore_json(&backup).unwrap()["sessionsSkipped"],
                2
            );
            assert_eq!(destination.get(first_id).unwrap()["total_play_seconds"], 95);
        });
    }

    #[test]
    fn history_merges_into_existing_store_identity_without_crediting_it_again() {
        with_database(|destination, _| {
            let existing = destination
                .upsert(&json!({
                    "name":"Existing Steam title","source":"steam","source_id":"S-10"
                }))
                .unwrap()["game"]
                .clone();
            let target_id = field(&existing, "id");
            let backup = json!({
                "format":"orbit.library.v1",
                "games":[{"id":"previous-machine-id","name":"Steam title",
                    "source":"steam","source_id":"s-10","total_play_seconds":999}],
                "sessions":[{"id":"previous-session","game_id":"previous-machine-id",
                    "started_at":"2025-01-02T11:00:00+01:00",
                    "finished_at":"2025-01-02T11:01:00+01:00","seconds":60}]
            });
            let result = destination.restore_json(&backup).unwrap();
            assert_eq!(result["skipped"], 1);
            assert_eq!(result["sessionsImported"], 1);
            assert_eq!(destination.count().unwrap(), 1);
            assert_eq!(destination.get(target_id).unwrap()["total_play_seconds"], 0);
            let mapped: String = destination
                .conn
                .query_row(
                    "SELECT game_id FROM sessions WHERE id='previous-session'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(mapped, target_id);
            assert_eq!(
                destination.restore_json(&backup).unwrap()["sessionsSkipped"],
                1
            );
            assert_eq!(destination.get(target_id).unwrap()["total_play_seconds"], 0);
        });
    }

    #[test]
    fn malformed_or_unmappable_history_rolls_back_entire_restore() {
        with_database(|db, _| {
            let base = json!({
                "format":"orbit.library.v1",
                "games":[{"id":"backup-game","name":"Backup game","source":"gog",
                          "source_id":"backup-game-id","total_play_seconds":80}],
                "settings":{"theme":"light"},
                "sessions":[{"id":"session-1","game_id":"backup-game",
                    "started_at":"2025-01-02T10:00:00Z",
                    "finished_at":"2025-01-02T10:01:00Z","seconds":60}]
            });
            let mut bad_cases = Vec::new();
            let mut open = base.clone();
            open["sessions"][0]["finished_at"] = Value::Null;
            bad_cases.push(open);
            let mut negative = base.clone();
            negative["sessions"][0]["seconds"] = json!(-1);
            bad_cases.push(negative);
            let mut reversed = base.clone();
            reversed["sessions"][0]["finished_at"] = json!("2025-01-02T09:00:00Z");
            bad_cases.push(reversed);
            let mut unknown = base.clone();
            unknown["sessions"][0]["game_id"] = json!("missing-game");
            bad_cases.push(unknown);
            let mut duplicated = base.clone();
            duplicated["sessions"]
                .as_array_mut()
                .unwrap()
                .push(base["sessions"][0].clone());
            bad_cases.push(duplicated);
            let mut bad_id = base.clone();
            bad_id["games"][0]["id"] = json!(" ");
            bad_cases.push(bad_id);
            let mut not_array = base.clone();
            not_array["sessions"] = json!({});
            bad_cases.push(not_array);
            let mut extra_field = base.clone();
            extra_field["sessions"][0]["unexpected"] = json!("not in portable contract");
            bad_cases.push(extra_field);
            for case in bad_cases {
                assert!(db.restore_json(&case).is_err());
                assert_eq!(db.count().unwrap(), 0);
                assert_eq!(db.get_settings().unwrap()["theme"], "dark");
            }

            // The session conflict happens after the new game was inserted.
            // The enclosing transaction must roll back that game as well.
            let other = db.upsert(&json!({"name":"Unrelated live game"})).unwrap();
            let other_id = field(&other["game"], "id");
            db.conn.execute(
                "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds) VALUES ('session-1',?1,'2025-01-02T10:00:00Z','2025-01-02T10:02:00Z',120)",
                [other_id]
            ).unwrap();
            assert!(db.restore_json(&base).unwrap_err().contains("conflicts"));
            assert_eq!(db.count().unwrap(), 1);
            assert!(db.get("backup-game").unwrap().is_null());
            assert_eq!(db.get_settings().unwrap()["theme"], "dark");
            let seconds: i64 = db
                .conn
                .query_row(
                    "SELECT seconds FROM sessions WHERE id='session-1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(seconds, 120);
        });
    }

    #[test]
    fn conflicting_game_ids_do_not_steal_history_or_overwrite_existing_records() {
        with_database(|db, _| {
            let existing = db
                .upsert(&json!({
                    "name":"Real Steam game","source":"steam","source_id":"real"
                }))
                .unwrap()["game"]
                .clone();
            let existing_id = field(&existing, "id");
            let incoming = json!({
                "format":"orbit.library.v1",
                "games":[{"id":existing_id,"name":"Imposter","source":"steam","source_id":"other"}],
                "sessions":[{"id":"stolen-history","game_id":existing_id,
                    "started_at":"2025-01-02T10:00:00Z",
                    "finished_at":"2025-01-02T10:01:00Z","seconds":60}]
            });
            assert!(db
                .restore_json(&incoming)
                .unwrap_err()
                .contains("conflicts"));
            assert_eq!(db.count().unwrap(), 1);
            assert_eq!(db.get(existing_id).unwrap()["name"], "Real Steam game");
            let count: i64 = db
                .conn
                .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0);
        });
    }

    #[test]
    fn portable_restore_preflight_rolls_back_every_temporary_write() {
        with_database(|db, _| {
            let archived = json!({
                "format":"orbit.library.v1",
                "games":[{"id":"archive-game","name":"Archived game","source":"manual"}],
                "sessions":[{"id":"archive-session","game_id":"archive-game",
                    "started_at":"2025-01-02T10:00:00Z",
                    "finished_at":"2025-01-02T10:01:00Z","seconds":60}]
            });
            db.preflight_restore_json(&archived).unwrap();
            assert_eq!(db.count().unwrap(), 0, "preflight must not add a game");
            let rows: i64 = db
                .conn
                .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
                .unwrap();
            assert_eq!(rows, 0, "preflight must not add a session");

            assert_eq!(db.restore_json(&archived).unwrap()["sessionsImported"], 1);
            db.preflight_restore_json(&archived).unwrap();
            assert_eq!(db.count().unwrap(), 1);

            let mut conflicting = archived.clone();
            conflicting["sessions"][0]["seconds"] = json!(42);
            assert!(db.preflight_restore_json(&conflicting).is_err());
            let elapsed: i64 = db
                .conn
                .query_row(
                    "SELECT seconds FROM sessions WHERE id='archive-session'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(elapsed, 60, "rejected archive cannot change a session");
        });
    }

    #[test]
    fn legacy_portable_preflight_checks_real_sql_writes_without_leaving_rows() {
        with_database(|db, _| {
            let legacy = json!({
                "format":"orbit.library.v1",
                "games":[{"name":"Legacy backup","source":"manual","total_play_seconds":65}]
            });
            db.conn
                .execute_batch(
                    "CREATE TRIGGER prevent_legacy_import BEFORE INSERT ON games
                 BEGIN SELECT RAISE(ABORT, 'intentional constraint failure'); END;",
                )
                .unwrap();
            assert!(db
                .preflight_restore_json(&legacy)
                .unwrap_err()
                .contains("constraint failure"));
            assert_eq!(db.count().unwrap(), 0);
            db.conn
                .execute_batch("DROP TRIGGER prevent_legacy_import")
                .unwrap();
            db.preflight_restore_json(&legacy).unwrap();
            assert_eq!(db.count().unwrap(), 0);
            assert_eq!(db.restore_json(&legacy).unwrap()["imported"], 1);
            assert_eq!(db.list("name").unwrap()[0]["total_play_seconds"], 65);
        });
    }

    #[test]
    fn json_export_fails_closed_for_more_than_100000_games() {
        with_database(|db, _| {
            // Keep the payload well below 128 MB: only the row count makes
            // this export unsafe for a restore into another Orbit instance.
            db.conn.execute_batch(
                "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 100001)
                 INSERT INTO games(id,name,source,created_at,updated_at)
                 SELECT 'bulk-'||n,'Game '||n,'manual','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z' FROM seq;"
            ).unwrap();
            assert_eq!(db.count().unwrap(), 100001);
            assert!(db.export_json().unwrap_err().contains("100000 games"));
            let count_after: i64 = db
                .conn
                .query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
                .unwrap();
            assert_eq!(
                count_after, 100001,
                "export refusal must never alter the library"
            );
        });
    }

    #[test]
    fn export_rejects_open_invalid_and_excessive_session_history() {
        with_database(|db, _| {
            let game = db.upsert(&json!({"name":"Export guards"})).unwrap()["game"].clone();
            let id = field(&game, "id");
            let running = db.start_session(id).unwrap();
            assert!(db.export_json().unwrap_err().contains("unfinished"));
            assert!(db.finish_session(&running, 0).unwrap());
            // A corrupt persisted row must not silently disappear from a backup.
            db.conn
                .execute(
                    "UPDATE sessions SET finished_at='bad timestamp' WHERE id=?1",
                    [&running],
                )
                .unwrap();
            assert!(db.export_json().is_err());
            db.conn.execute(
                "UPDATE sessions SET finished_at='2025-01-02T10:01:00Z',started_at='2025-01-02T10:00:00Z' WHERE id=?1",
                [&running]
            ).unwrap();
            assert!(db.export_json().is_ok());
            db.conn.execute(
                "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 100001)
                 INSERT INTO sessions(id,game_id,started_at,finished_at,seconds)
                 SELECT 'bulk-' || n,?1,'2025-01-02T10:00:00Z','2025-01-02T10:01:00Z',60 FROM seq",
                [id]
            ).unwrap();
            assert!(db.export_json().unwrap_err().contains("100000"));
        });
    }

    #[test]
    fn legacy_empty_backup_stays_compatible_without_session_array() {
        with_database(|db, _| {
            let result = db
                .restore_json(&json!({
                    "format":"orbit.library.v1","games":[],"settings":{"theme":"light"}
                }))
                .unwrap();
            assert_eq!(result["imported"], 0);
            assert_eq!(result["settingsRestored"], true);
            assert_eq!(db.get_settings().unwrap()["language"], "system");
            assert!(result.get("sessionsImported").is_none());
            assert_eq!(db.count().unwrap(), 0);
        });
    }

    #[test]
    fn zero_second_completed_session_with_equal_timestamps_is_archived() {
        with_database(|destination, path| {
            let mut source =
                LibraryDatabase::open(path.with_file_name("source-zero.sqlite")).unwrap();
            let game = source
                .upsert(&json!({
                    "name":"Zero-second historic session","source":"steam","source_id":"zero"
                }))
                .unwrap()["game"]
                .clone();
            let id = field(&game, "id");
            source
                .conn
                .execute(
                    "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds)
                 VALUES ('zero-session',?1,'2025-03-01T12:00:00Z','2025-03-01T12:00:00Z',0)",
                    [id],
                )
                .unwrap();
            let backup = source.export_json().unwrap();
            assert_eq!(backup["sessions"][0]["seconds"], 0);
            assert_eq!(
                backup["sessions"][0]["started_at"],
                backup["sessions"][0]["finished_at"]
            );
            assert_eq!(
                destination.restore_json(&backup).unwrap()["sessionsImported"],
                1
            );
            assert_eq!(
                destination.restore_json(&backup).unwrap()["sessionsSkipped"],
                1
            );
            assert_eq!(
                destination.export_json().unwrap()["sessions"],
                backup["sessions"]
            );
            assert_eq!(destination.get(id).unwrap()["total_play_seconds"], 0);
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

    #[test]
    fn interrupted_session_recovers_using_last_seen_at_even_after_eight_days() {
        with_database(|db, _| {
            let game = db.upsert(&json!({"name":"Long Away"})).unwrap()["game"].clone();
            let id = field(&game, "id").to_owned();
            let start = "2026-11-01T18:00:00.000Z";
            let last_seen = "2026-11-01T19:00:00.000Z";
            db.conn
                .execute(
                    "INSERT INTO sessions(id,game_id,started_at,heartbeat_seconds,last_seen_at)
                     VALUES ('crash-old',?1,?2,3600,?3)",
                    params![id, start, last_seen],
                )
                .unwrap();
            assert_eq!(db.recover_interrupted_sessions().unwrap(), 1);
            let finished: String = db
                .conn
                .query_row(
                    "SELECT finished_at FROM sessions WHERE id='crash-old'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(finished, last_seen);
            let now = Local
                .with_ymd_and_hms(2026, 11, 10, 12, 0, 0)
                .single()
                .unwrap();
            let stats = db.get_statistics_at(30, now).unwrap();
            assert_eq!(stats["meta"]["invalidSessions"], 0);
            assert_eq!(stats["totals"]["allTime"], 3600);
        });
    }

    #[test]
    fn zero_second_completed_session_is_not_counted_as_invalid_in_statistics() {
        with_database(|db, _| {
            let game = db.upsert(&json!({"name":"Quick Exit"})).unwrap()["game"].clone();
            let id = field(&game, "id");
            let ts = "2026-11-04T10:00:00.000Z";
            db.conn
                .execute(
                    "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds)
                     VALUES ('zero-ok',?1,?2,?2,0)",
                    params![id, ts],
                )
                .unwrap();
            let now = Local
                .with_ymd_and_hms(2026, 11, 5, 12, 0, 0)
                .single()
                .unwrap();
            let stats = db.get_statistics_at(7, now).unwrap();
            assert_eq!(stats["meta"]["invalidSessions"], 0);
            assert_eq!(stats["totals"]["allTime"], 0);
            assert!(stats["recentGames"].as_array().unwrap().is_empty());
        });
    }

    #[test]
    fn library_duplicate_index_matches_store_and_manual_alias_deduplication() {
        let existing = vec![
            json!({
                "id":"m1","name":"Hollow Knight","source":"manual",
                "executable":r"C:\Games\Hollow Knight\hollow_knight.exe"
            }),
            json!({
                "id":"s1","name":"Shared A","source":"epic","source_id":"epic-a",
                "executable":r"C:\Games\Shared\Game.exe","launch_uri":"com.epicgames.launcher://apps/a"
            }),
        ];
        let index = LibraryDuplicateIndex::from_games(&existing);
        // A discovered store game sharing an executable with an existing manual entry matches upsert deduplication.
        assert!(index.contains(&json!({
            "name":"Hollow Knight","source":"gog","source_id":"1450711444",
            "executable":r"C:/Games/Hollow Knight/Sub/../hollow_knight.exe"
        })));
        // A distinct verified store product sharing a storefront executable does not falsely coalesce.
        assert!(!index.contains(&json!({
            "name":"Shared B","source":"epic","source_id":"epic-b",
            "executable":r"C:\Games\Shared\Game.exe","launch_uri":"com.epicgames.launcher://apps/a"
        })));
        // A discovered folder entry pointing at an existing store game's executable is marked added.
        assert!(index.contains(&json!({
            "name":"Shared Folder","source":"folder",
            "executable":r"C:\Games\Shared\Game.exe"
        })));
    }

    #[test]
    fn custom_collections_crud_membership_and_duplicate_rejection() {
        with_database(|db, _| {
            let g1 = db
                .upsert(&json!({"name":"Hades","source":"manual","executable":r"C:\Games\hades.exe","play_status":"backlog"}))
                .unwrap()["game"]
                .clone();
            let g2 = db
                .upsert(&json!({"name":"Celeste","source":"manual","executable":r"C:\Games\celeste.exe"}))
                .unwrap()["game"]
                .clone();
            let id1 = field(&g1, "id").to_owned();
            let id2 = field(&g2, "id").to_owned();

            let col = db
                .create_collection(
                    &json!({"name":"Weekend Picks","color":"#9c73ff","icon":"sparkles"}),
                )
                .unwrap();
            let col_id = field(&col, "id").to_owned();
            assert_eq!(col["name"], "Weekend Picks");
            assert_eq!(col["icon"], "sparkles");

            // Case-insensitive duplicate collection names must be rejected.
            assert!(db
                .create_collection(&json!({"name":"weekend picks"}))
                .is_err());

            let updated = db
                .update_collection(
                    &col_id,
                    &json!({"name":"Co-op Night","color":"#34d399","icon":"heart"}),
                )
                .unwrap();
            assert_eq!(updated["name"], "Co-op Night");

            let cols = db.set_game_collections(&id1, &[col_id.clone()]).unwrap();
            assert_eq!(cols.as_array().unwrap().len(), 1);
            assert_eq!(cols[0]["game_ids"], json!([id1]));

            // Bulk update assigns collection, tags, status, and hidden atomically.
            let bulk = db
                .bulk_update_games(
                    &[id1.clone(), id2.clone()],
                    &json!({
                        "play_status": "on_hold",
                        "hidden": true,
                        "add_tags": ["Indie", "Deck"],
                        "add_collection_id": col_id
                    }),
                )
                .unwrap();
            assert_eq!(bulk["updatedCount"], 2);
            let loaded2 = db.get(&id2).unwrap();
            assert_eq!(loaded2["play_status"], "on_hold");
            assert_eq!(loaded2["hidden"], true);
            assert_eq!(loaded2["tags"], json!(["Indie", "Deck"]));
            let listed = db.list_collections().unwrap();
            let members = listed[0]["game_ids"].as_array().unwrap();
            assert_eq!(members.len(), 2);

            // Bulk tag removal and collection removal work cleanly.
            db.bulk_update_games(
                &[id2.clone()],
                &json!({"remove_tags": ["indie"], "remove_collection_id": col_id, "hidden": false}),
            )
            .unwrap();
            let loaded2 = db.get(&id2).unwrap();
            assert_eq!(loaded2["tags"], json!(["Deck"]));
            assert_eq!(loaded2["hidden"], false);
            assert_eq!(db.list_collections().unwrap()[0]["game_ids"], json!([id1]));

            // Deleting a collection removes it without removing games.
            db.delete_collection(&col_id).unwrap();
            assert!(db
                .list_collections()
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty());
            assert!(db.get(&id1).is_ok());
        });
    }

    #[test]
    fn launching_a_backlog_game_auto_promotes_status_to_playing() {
        with_database(|db, _| {
            let g1 = db
                .upsert(&json!({"name":"Backlog Title","source":"manual","executable":r"C:\Games\b.exe","play_status":"backlog"}))
                .unwrap()["game"]
                .clone();
            let id1 = field(&g1, "id").to_owned();
            assert_eq!(g1["play_status"], "backlog");
            db.start_session(&id1).unwrap();
            assert_eq!(db.get(&id1).unwrap()["play_status"], "playing");

            let g2 = db
                .upsert(&json!({"name":"Completed Title","source":"manual","executable":r"C:\Games\c.exe","play_status":"completed"}))
                .unwrap()["game"]
                .clone();
            let id2 = field(&g2, "id").to_owned();
            db.record_external_launch(&id2).unwrap();
            // Completed games must NOT be overwritten when replayed.
            assert_eq!(db.get(&id2).unwrap()["play_status"], "completed");

            let g3 = db
                .upsert(&json!({"name":"External Backlog","source":"steam","source_id":"999","launch_uri":"steam://rungameid/999","play_status":"backlog"}))
                .unwrap()["game"]
                .clone();
            let id3 = field(&g3, "id").to_owned();
            db.record_external_launch(&id3).unwrap();
            assert_eq!(db.get(&id3).unwrap()["play_status"], "playing");
        });
    }

    #[test]
    fn backup_export_and_restore_roundtrip_preserves_collections_status_env_and_profiles() {
        with_database(|source, _| {
            let g = source
                .upsert(&json!({
                    "name": "Modded RPG",
                    "source": "manual",
                    "executable": r"C:\Games\ModdedRPG\game.exe",
                    "play_status": "playing",
                    "hidden": true,
                    "launch_env": {"DXVK_HUD": "fps", "MANGOHUD": "1"},
                    "launch_profiles": [{
                        "name": "Mod Loader",
                        "executable": r"C:\Games\ModdedRPG\skse_loader.exe",
                        "launch_args": ["--modded"],
                        "working_dir": r"C:\Games\ModdedRPG",
                        "launch_env": {"MOD_DEBUG": "1"}
                    }]
                }))
                .unwrap()["game"]
                .clone();
            let gid = field(&g, "id").to_owned();
            let col = source
                .create_collection(
                    &json!({"name":"Modded Favorites","color":"#f472b6","icon":"lightning"}),
                )
                .unwrap();
            let cid = field(&col, "id").to_owned();
            source.set_game_collections(&gid, &[cid]).unwrap();

            let exported = source.export_json().unwrap();
            assert_eq!(exported["collections"].as_array().unwrap().len(), 1);

            with_database(|target, _| {
                let res = target.restore_json(&exported).unwrap();
                assert_eq!(res["imported"], 1);
                let restored_games = target.list("name").unwrap();
                let games_arr = restored_games.as_array().unwrap();
                assert_eq!(games_arr.len(), 1);
                let rg = &games_arr[0];
                assert_eq!(rg["play_status"], "playing");
                assert_eq!(rg["hidden"], true);
                assert_eq!(rg["launch_env"]["DXVK_HUD"], "fps");
                assert_eq!(rg["launch_profiles"].as_array().unwrap().len(), 1);
                assert_eq!(rg["launch_profiles"][0]["name"], "Mod Loader");

                let restored_cols = target.list_collections().unwrap();
                assert_eq!(restored_cols.as_array().unwrap().len(), 1);
                assert_eq!(restored_cols[0]["name"], "Modded Favorites");
                assert_eq!(restored_cols[0]["game_ids"], json!([rg["id"]]));
            });
        });
    }

    #[test]
    fn controller_mode_settings_default_false_and_roundtrip() {
        with_database(|db, _| {
            let defaults = db.get_settings().unwrap();
            assert_eq!(defaults["controllerAutoEnter"], json!(false));
            assert_eq!(defaults["controllerAudio"], json!(false));
            assert_eq!(defaults["controllerHaptics"], json!(false));

            let updated = db
                .save_settings(&json!({
                    "controllerAutoEnter": true,
                    "controllerAudio": true,
                    "controllerHaptics": true
                }))
                .unwrap();
            assert_eq!(updated["controllerAutoEnter"], json!(true));
            assert_eq!(updated["controllerAudio"], json!(true));
            assert_eq!(updated["controllerHaptics"], json!(true));

            let reloaded = db.get_settings().unwrap();
            assert_eq!(reloaded["controllerAutoEnter"], json!(true));
            assert_eq!(reloaded["controllerAudio"], json!(true));
            assert_eq!(reloaded["controllerHaptics"], json!(true));
        });
    }

    #[test]
    fn notes_and_rating_crud_validation_and_rating_sort() {
        with_database(|db, _| {
            let a = db
                .upsert(&json!({
                    "name": "Alpha",
                    "source": "manual",
                    "executable": r"C:\Games\Alpha.exe",
                    "notes": "Line 1\r\nLine 2\tBuild A",
                    "rating": 3
                }))
                .unwrap()["game"]
                .clone();
            assert_eq!(a["notes"], "Line 1\nLine 2\tBuild A");
            assert_eq!(a["rating"], 3);

            let b = db
                .upsert(&json!({
                    "name": "Beta",
                    "source": "steam",
                    "source_id": "2002",
                    "launch_uri": "steam://rungameid/2002",
                    "rating": 5,
                    "notes": "Masterpiece co-op campaign"
                }))
                .unwrap()["game"]
                .clone();
            let c = db
                .upsert(&json!({
                    "name": "Gamma",
                    "source": "epic",
                    "source_id": "3003",
                    "launch_uri": "com.epicgames.launcher://apps/gamma?action=launch&silent=true"
                }))
                .unwrap()["game"]
                .clone();
            assert_eq!(c["rating"], 0);
            assert_eq!(c["notes"], "");

            // Validation guards
            assert!(db.update(field(&a, "id"), &json!({"rating": 6})).is_err());
            assert!(db.update(field(&a, "id"), &json!({"rating": -1})).is_err());
            assert!(db
                .update(field(&a, "id"), &json!({"notes": "bad\u{0007}bell"}))
                .is_err());
            assert!(db
                .update(field(&a, "id"), &json!({"notes": "x".repeat(4001)}))
                .is_err());

            let updated = db
                .update(
                    field(&a, "id"),
                    &json!({"rating": 4, "notes": "Updated note"}),
                )
                .unwrap();
            assert_eq!(updated["rating"], 4);
            assert_eq!(updated["notes"], "Updated note");

            let sorted = db.list("rating").unwrap();
            let ids: Vec<&str> = sorted
                .as_array()
                .unwrap()
                .iter()
                .map(|g| field(g, "id"))
                .collect();
            assert_eq!(ids, vec![field(&b, "id"), field(&a, "id"), field(&c, "id")]);
        });
    }

    #[test]
    fn steamgriddb_api_key_settings_roundtrip_and_excluded_from_export() {
        with_database(|db, _| {
            assert_eq!(db.get_settings().unwrap()["steamGridDbApiKey"], json!(""));
            let saved = db
                .save_settings(&json!({"steamGridDbApiKey": "  sgdb_live_token_12345  "}))
                .unwrap();
            assert_eq!(saved["steamGridDbApiKey"], json!("sgdb_live_token_12345"));
            assert!(db
                .save_settings(&json!({"steamGridDbApiKey": "bad\nkey"}))
                .is_err());
            assert!(db
                .save_settings(&json!({"steamGridDbApiKey": "a".repeat(129)}))
                .is_err());

            let exported = db.export_json().unwrap();
            assert!(
                exported["settings"].get("steamGridDbApiKey").is_none(),
                "API key must never be exported into backups"
            );
        });
    }

    #[test]
    fn statistics_10000_sessions_performance_heatmap_streaks_and_breakdowns() {
        with_database(|db, _| {
            let specs = [
                ("=HYPERLINK(\"evil\")", "steam", "RPG", "playing"),
                ("Apex Racer", "epic", "Racing", "completed"),
                ("Starship Command", "xbox", "Strategy", "backlog"),
                ("Indie Gem", "manual", "", "on_hold"),
            ];
            let mut game_ids = Vec::new();
            for (i, (name, source, genre, status)) in specs.iter().enumerate() {
                let g = db
                    .upsert(&json!({
                        "name": name,
                        "source": source,
                        "source_id": format!("g-{i}"),
                        "executable": format!(r"C:\Games\g{i}.exe"),
                        "genre": genre,
                        "play_status": status
                    }))
                    .unwrap()["game"]
                    .clone();
                game_ids.push(field(&g, "id").to_owned());
            }

            let now = Local::now();
            let base_utc = now.with_timezone(&Utc);
            {
                let tx = db.conn.transaction().unwrap();
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO sessions(id,game_id,started_at,finished_at,seconds)
                         VALUES(?1,?2,?3,?4,?5)",
                    )
                    .unwrap();
                // Insert 10,200 non-overlapping sessions spread over 340 local days
                // (30 per day across the 4 games), leaving a deterministic 10-day streak ending today.
                for idx in 0..10_200usize {
                    let day_offset = (idx / 30) as i64;
                    let slot = (idx % 30) as i64;
                    let gid = &game_ids[idx % game_ids.len()];
                    let dur = 120 + (slot % 5) * 60; // 2m..6m
                    let finish = base_utc
                        - chrono::Duration::days(day_offset)
                        - chrono::Duration::minutes(slot * 12);
                    let start = finish - chrono::Duration::seconds(dur);
                    stmt.execute(params![
                        format!("sess-{idx:05}"),
                        gid,
                        start.to_rfc3339_opts(SecondsFormat::Millis, true),
                        finish.to_rfc3339_opts(SecondsFormat::Millis, true),
                        dur
                    ])
                    .unwrap();
                }
                drop(stmt);
                tx.commit().unwrap();
            }

            let started = std::time::Instant::now();
            let stats = db.get_statistics_at(30, now).unwrap();
            let elapsed_ms = started.elapsed().as_millis();
            println!("10,200-session statistics query elapsed: {elapsed_ms} ms");
            #[cfg(not(debug_assertions))]
            assert!(
                elapsed_ms < 50,
                "10,200-session statistics query took {elapsed_ms}ms (must be < 50ms)"
            );
            assert!(
                elapsed_ms < 1500,
                "10,200-session statistics query unexpectedly slow: {elapsed_ms}ms"
            );

            assert_eq!(stats["heatmap"].as_array().unwrap().len(), 365);
            assert!(stats["heatmap"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["level"].as_u64().unwrap() == 4));
            assert!(stats["streaks"]["current"].as_u64().unwrap() >= 300);
            assert!(stats["streaks"]["longest"].as_u64().unwrap() >= 300);
            assert!(stats["streaks"]["activeDaysYear"].as_u64().unwrap() >= 335);
            assert_eq!(stats["sessions"]["count"].as_u64().unwrap(), 10_200);
            assert!(stats["sessions"]["averageSeconds"].as_u64().unwrap() > 0);
            assert_eq!(stats["sessions"]["longestSeconds"].as_u64().unwrap(), 360);

            let by_source = stats["breakdowns"]["bySource"].as_array().unwrap();
            assert_eq!(by_source.len(), 4);
            let by_genre = stats["breakdowns"]["byGenre"].as_array().unwrap();
            assert_eq!(by_genre.len(), 4);
            let by_status = stats["breakdowns"]["byStatus"].as_array().unwrap();
            assert_eq!(by_status.len(), 4);

            let csv = format_statistics_csv(&stats);
            assert!(csv.starts_with("section,key,label,seconds,count,share\n"));
            assert!(csv.contains("daily,"));
            assert!(csv.contains("storefront,steam,"));
            assert!(csv.contains("recent_game,"));
            assert!(
                csv.contains("'=HYPERLINK"),
                "CSV export must neutralize spreadsheet formula prefixes"
            );
            assert!(!csv.contains(",=HYPERLINK"));
        });
    }
}

use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const RELEASE_PAGE: &str = "https://github.com/j5bak928-a11y/orbit-game-launcher/releases";
const RELEASE_API: &str =
    "https://api.github.com/repos/j5bak928-a11y/orbit-game-launcher/releases/latest";
const ACCESS: &str = "GitHub access is required. Open Releases or configure a read-only token.";

fn version_parts(tag: &str) -> Option<[u32; 3]> {
    let mut parts = tag.strip_prefix('v').unwrap_or(tag).split('.');
    let mut numbers = [0; 3];
    for number in &mut numbers {
        let part = parts.next()?;
        if part.is_empty()
            || part.len() > 9
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        *number = part.parse().ok()?;
    }
    parts.next().is_none().then_some(numbers)
}

pub fn release_page(tag: Option<&str>) -> Result<String, String> {
    match tag {
        None => Ok(format!("{RELEASE_PAGE}/latest")),
        Some(tag) if version_parts(tag).is_some() => Ok(format!("{RELEASE_PAGE}/tag/{tag}")),
        Some(_) => Err("Invalid Orbit release.".into()),
    }
}

fn release_status(current: &str, release: &Value) -> Option<Value> {
    let current = version_parts(current.split('+').next()?)?;
    let tag = release["tag_name"].as_str()?;
    let next = version_parts(tag)?;
    if release["draft"] != false || release["prerelease"] != false {
        return None;
    }
    Some(if next > current {
        json!({
            "state":"available", "message":"Orbit {version} is available.",
            "version":tag.trim_start_matches('v'), "tag":tag
        })
    } else {
        json!({"state":"current", "message":"Orbit is up to date."})
    })
}

fn check_release(current: &str, data_dir: &Path) -> Option<Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Orbit Launcher")
        .build()
        .ok()?;
    let mut request = client
        .get(RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json");
    match std::fs::read_to_string(data_dir.join("github-update-token.txt")) {
        Ok(token) => {
            let token = token.trim();
            if !token.is_empty() {
                if token.len() > 512
                    || !token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                {
                    return Some(json!({"state":"access","message":ACCESS}));
                }
                request = request.bearer_auth(token);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    let response = request.send().ok()?;
    let rate_limited = response.headers().get("x-ratelimit-remaining").is_some_and(|v| v == "0");
    if !rate_limited && matches!(response.status().as_u16(), 401 | 403 | 404) {
        return Some(json!({"state":"access","message":ACCESS}));
    }
    if !response.status().is_success() {
        return None;
    }
    let mut body = Vec::new();
    response.take(1024 * 1024).read_to_end(&mut body).ok()?;
    release_status(current, &serde_json::from_slice(&body).ok()?)
}

pub fn check(current: &str, data_dir: &Path) -> Value {
    if !cfg!(windows) {
        return json!({"state":"unsupported","message":"Update checks are available in packaged Windows builds."});
    }
    check_release(current, data_dir)
        .unwrap_or_else(|| json!({"state":"error","message":"Could not check GitHub for updates."}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_newer_stable_versions_are_offered() {
        let mut release = json!({"tag_name":"v0.2.11","draft":false,"prerelease":false});
        assert_eq!(release_status("0.2.9", &release).unwrap()["state"], "available");
        assert_eq!(release_status("0.2.11", &release).unwrap()["state"], "current");
        assert_eq!(release_status("0.3.0", &release).unwrap()["state"], "current");
        release["prerelease"] = json!(true);
        assert!(release_status("0.2.9", &release).is_none());
    }

    #[test]
    fn release_handoff_accepts_only_a_version_under_the_official_repo() {
        assert_eq!(release_page(Some("v0.2.11")).unwrap(), format!("{RELEASE_PAGE}/tag/v0.2.11"));
        assert!(release_page(Some("https://example.com/setup.exe")).is_err());
    }
}

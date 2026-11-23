//! Port of src/features/quota.js.
use crate::core::data::DATA_DIR;
use crate::core::json::{num, parse, stringify, truthy};
use crate::core::time::{iso, now, now_ms};
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

static FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("quota.json"));
static WAIT_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("quota-wait.json"));
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const WINDOWS: [&str; 2] = ["five_hour", "seven_day"];

#[cfg(test)]
static API_OVERRIDE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn url(full: &str) -> String {
    #[cfg(test)]
    if let Some(base) = API_OVERRIDE.lock().unwrap().clone() {
        return full.replace("https://api.anthropic.com", &base);
    }
    full.to_string()
}

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(300))).build())
}

fn js_number(text: Option<&str>) -> f64 {
    match text {
        None => 0.0,
        Some(t) => {
            let t = t.trim();
            if t.is_empty() { 0.0 } else { t.parse::<f64>().unwrap_or(f64::NAN) }
        }
    }
}

pub fn read_quota() -> Option<Value> {
    let mut q = parse(&std::fs::read_to_string(&*FILE).ok()?)?;
    for k in WINDOWS {
        let legacy = q.get(k).filter(|w| truthy(Some(w))).and_then(|w| w.get("usado").map(|u| (u.clone(), w.get("renueva").cloned())));
        if let (Some((used, resets)), Some(o)) = (legacy, q.as_object_mut()) {
            let mut w = Map::new();
            w.insert("used".into(), used);
            if let Some(r) = resets {
                w.insert("resetsAt".into(), r);
            }
            o.insert(k.into(), Value::Object(w));
        }
    }
    Some(q)
}

fn read_credentials() -> Option<String> {
    let credentials = crate::agents::claude::credentials_file();
    if credentials.exists() {
        return std::fs::read_to_string(&credentials).ok();
    }
    if !cfg!(target_os = "macos") {
        return None;
    }
    let mut cmd = std::process::Command::new("/usr/bin/security");
    cmd.args(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    let out = crate::features::devservers::run_with_timeout(&mut cmd, None, 10000).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn wait_until() -> f64 {
    std::fs::read_to_string(&*WAIT_FILE).ok().and_then(|t| parse(&t)).and_then(|v| v.get("until").and_then(Value::as_f64)).unwrap_or(0.0)
}

pub fn login_token() -> Option<String> {
    let raw = read_credentials()?;
    let oauth = parse(&raw)?.get("claudeAiOauth").cloned()?;
    let token = oauth.get("accessToken").and_then(Value::as_str).filter(|t| !t.is_empty())?.to_string();
    let expired = oauth.get("expiresAt").filter(|e| truthy(Some(e))).and_then(Value::as_f64).is_some_and(|e| e < now_ms() as f64);
    (!expired).then_some(token)
}

fn save_quota(quota: Value) -> Result<Value, String> {
    let tmp = PathBuf::from(format!("{}.{}.tmp", FILE.display(), std::process::id()));
    std::fs::write(&tmp, stringify(&quota)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &*FILE).map_err(|e| e.to_string())?;
    Ok(quota)
}

pub fn ask_usage(token: &str) -> Result<Option<Value>, String> {
    let mut r = agent().get(url(USAGE_URL)).header("Authorization", format!("Bearer {token}")).header("anthropic-beta", "oauth-2025-04-20").call().map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    if status == 429 {
        let seconds = js_number(r.headers().get("retry-after").and_then(|h| h.to_str().ok()));
        let seconds = if seconds.is_nan() || seconds == 0.0 { 1800.0 } else { seconds };
        let until = now_ms() as f64 + (seconds + 60.0) * 1000.0;
        std::fs::write(&*WAIT_FILE, stringify(&json!({ "until": num(until) }))).map_err(|e| e.to_string())?;
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(format!("la consulta de cuota respondió {status}"));
    }
    let j: Value = r.body_mut().read_json().map_err(|e| e.to_string())?;
    let mut quota = Map::new();
    quota.insert("at".into(), Value::from(now()));
    for k in WINDOWS {
        if let Some(w) = j.get(k).filter(|w| truthy(Some(w))) {
            if let Some(u) = w.get("utilization").filter(|u| u.is_number()) {
                let resets = w.get("resets_at").filter(|r| truthy(Some(r))).cloned().unwrap_or(Value::Null);
                quota.insert(k.into(), json!({ "used": u, "resetsAt": resets }));
            }
        }
    }
    save_quota(Value::Object(quota)).map(Some)
}

fn quota_from_peer() -> Option<Value> {
    if !crate::cluster::cluster::cluster_enabled() {
        return None;
    }
    let theirs = crate::cluster::cluster::peer_get("/api/cluster/quota", Some(8000))?;
    let mine = read_quota();
    let their_at = theirs.get("at").and_then(Value::as_str).filter(|a| !a.is_empty())?.to_string();
    if let Some(m) = &mine {
        if m.get("at").and_then(Value::as_str).is_some_and(|a| a >= their_at.as_str()) {
            return None;
        }
    }
    save_quota(theirs).ok()
}

pub fn fetch_quota() -> Result<Option<Value>, String> {
    let primary = crate::cluster::cluster::is_primary();
    let login = login_token();
    if !primary && login.is_none() {
        return Ok(None);
    }
    if let Some(token) = &login {
        if now_ms() as f64 >= wait_until() {
            return ask_usage(token);
        }
    }
    if !primary {
        return Ok(None);
    }
    let fresh = quota_from_peer();
    if let Some(f) = &fresh {
        let at = f.get("at").and_then(Value::as_str).and_then(crate::core::time::parse);
        if at.is_some_and(|t| now_ms() - t < 30 * 60000) {
            return Ok(fresh);
        }
    }
    match crate::sessions::registry::session_token() {
        Some(backup) => quota_from_headers(&backup).map(Some),
        None => Ok(fresh),
    }
}

pub fn quota_from_headers(token: &str) -> Result<Value, String> {
    let body = json!({ "model": "claude-haiku-4-5", "max_tokens": 1, "system": "You are Claude Code, Anthropic's official CLI for Claude.", "messages": [{ "role": "user", "content": "ok" }] });
    let r = agent()
        .post(url(MESSAGES_URL))
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .send(stringify(&body))
        .map_err(|e| e.to_string())?;
    let mut quota = Map::new();
    quota.insert("at".into(), Value::from(now()));
    quota.insert("source".into(), Value::from("headers"));
    for (k, name) in [("seven_day", "7d"), ("five_hour", "5h")] {
        let header = |h: &str| r.headers().get(format!("anthropic-ratelimit-unified-{name}-{h}")).and_then(|v| v.to_str().ok()).map(str::to_string);
        let used_text = header("utilization");
        let used = js_number(used_text.as_deref());
        let reset = js_number(header("reset").as_deref());
        if used_text.is_some() && used.is_finite() {
            let resets = if reset != 0.0 && !reset.is_nan() { Value::from(iso((reset * 1000.0) as i64)) } else { Value::Null };
            quota.insert(k.into(), json!({ "used": num((used * 100.0 + 0.5).floor()), "resetsAt": resets }));
        }
    }
    if !quota.contains_key("seven_day") && !quota.contains_key("five_hour") {
        return Err(format!("la llamada de cuota respondió {} sin cabeceras de límite", r.status().as_u16()));
    }
    save_quota(Value::Object(quota))
}

#[cfg(test)]
pub(crate) mod fake_http {
    use std::sync::{Arc, Mutex};

    pub type Calls = Arc<Mutex<Vec<(String, String, Option<String>)>>>;

    pub fn serve(status: u16, body: &str, headers: &[(&str, &str)]) -> String {
        serve_many(move |_, _| (status, String::new()), Some((body.to_string(), headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())), 1).0
    }

    pub fn serve_many(answer: impl Fn(&str, &str) -> (u16, String) + Send + 'static, fixed: Option<(String, Vec<(String, String)>)>, count: usize) -> (String, Calls) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let calls: Calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        std::thread::spawn(move || {
            for _ in 0..count {
                let Ok(mut req) = server.recv() else { return };
                let mut sink = String::new();
                let _ = req.as_reader().read_to_string(&mut sink);
                let method = req.method().to_string();
                let url = req.url().to_string();
                let auth = req.headers().iter().find(|h| h.field.equiv("authorization")).map(|h| h.value.as_str().to_string());
                seen.lock().unwrap().push((method.clone(), url.clone(), auth));
                let res = match &fixed {
                    Some((body, headers)) => {
                        let (status, _) = answer(&method, &url);
                        let mut res = tiny_http::Response::from_string(body.clone()).with_status_code(status);
                        for (k, v) in headers {
                            res.add_header(tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap());
                        }
                        res
                    }
                    None => {
                        let (status, body) = answer(&method, &url);
                        tiny_http::Response::from_string(body).with_status_code(status)
                    }
                };
                let _ = req.respond(res);
            }
        });
        (format!("http://127.0.0.1:{port}"), calls)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{fresh, sandbox};

    fn fake(status: u16, body: &str, headers: &[(&str, &str)]) {
        *API_OVERRIDE.lock().unwrap() = Some(fake_http::serve(status, body, headers));
    }

    #[test]
    fn read_quota_converts_the_legacy_spanish_fields() {
        let _g = fresh();
        std::fs::write(sandbox().data.join("quota.json"), r#"{"at":"x","five_hour":{"usado":12,"renueva":"r1"},"seven_day":{"used":30,"resetsAt":"r2"}}"#).unwrap();
        assert_eq!(read_quota().unwrap(), json!({ "at": "x", "five_hour": { "used": 12, "resetsAt": "r1" }, "seven_day": { "used": 30, "resetsAt": "r2" } }));
    }

    #[test]
    fn ask_usage_saves_utilization_and_reset_times() {
        let _g = fresh();
        fake(200, r#"{"five_hour":{"utilization":41,"resets_at":"2026-11-09T15:00:00Z"},"seven_day":{"utilization":7},"other":{"utilization":1}}"#, &[]);
        let q = ask_usage("token").unwrap().unwrap();
        assert_eq!(q["five_hour"], json!({ "used": 41, "resetsAt": "2026-11-09T15:00:00Z" }));
        assert_eq!(q["seven_day"], json!({ "used": 7, "resetsAt": null }));
        assert!(q.get("other").is_none());
        assert_eq!(read_quota().unwrap(), q);
    }

    #[test]
    fn ask_usage_backs_off_for_retry_after_plus_a_minute_on_429() {
        let _g = fresh();
        fake(429, "{}", &[("retry-after", "100")]);
        let before = now_ms();
        assert_eq!(ask_usage("token").unwrap(), None);
        let until = wait_until() as i64;
        assert!(until >= before + 160000 && until <= now_ms() + 160000);
    }

    #[test]
    fn ask_usage_throws_on_other_errors() {
        let _g = fresh();
        fake(500, "{}", &[]);
        assert!(ask_usage("token").unwrap_err().contains("500"));
    }

    #[test]
    fn quota_from_headers_reads_the_unified_rate_limit_headers() {
        let _g = fresh();
        fake(200, "{}", &[("anthropic-ratelimit-unified-7d-utilization", "0.256"), ("anthropic-ratelimit-unified-7d-reset", "1794240000")]);
        let q = quota_from_headers("token").unwrap();
        assert_eq!(q["source"], "headers");
        assert_eq!(q["seven_day"], json!({ "used": 26, "resetsAt": iso(1794240000 * 1000) }));
        assert!(q.get("five_hour").is_none());
    }

    #[test]
    fn quota_from_headers_fails_when_there_are_no_limit_headers() {
        let _g = fresh();
        fake(401, "{}", &[]);
        assert!(quota_from_headers("token").unwrap_err().contains("401"));
    }

    #[test]
    fn login_token_uses_the_login_only_while_it_has_not_expired() {
        let _g = fresh();
        let file = sandbox().home.join(".claude").join(".credentials.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, stringify(&json!({ "claudeAiOauth": { "accessToken": "fake-access", "expiresAt": now_ms() + 60000 } }))).unwrap();
        assert_eq!(login_token().as_deref(), Some("fake-access"));
        std::fs::write(&file, stringify(&json!({ "claudeAiOauth": { "accessToken": "fake-access", "expiresAt": now_ms() - 1 } }))).unwrap();
        assert_eq!(login_token(), None);
    }
}

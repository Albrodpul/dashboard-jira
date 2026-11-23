use crate::core::json::truthy;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

pub static CLUSTER: LazyLock<Option<Value>> = LazyLock::new(|| crate::core::config::cluster().cloned());
pub static STATE_FILE: LazyLock<PathBuf> = LazyLock::new(|| crate::core::data::DATA_DIR.join("cluster.json"));
const STALE_STATE_MS: i64 = 5 * 60_000;
pub static ST: LazyLock<Mutex<Value>> = LazyLock::new(|| Mutex::new(read_state()));

pub fn st_get(key: &str) -> Value {
    ST.lock().unwrap_or_else(|p| p.into_inner()).get(key).cloned().unwrap_or(Value::Null)
}

pub fn st_set(key: &str, value: Value) {
    let mut st = ST.lock().unwrap_or_else(|p| p.into_inner());
    if !st.is_object() {
        *st = json!({});
    }
    st[key] = value;
}

pub fn cluster_field(key: &str) -> Option<String> {
    CLUSTER.as_ref().and_then(|c| c.get(key)).filter(|v| truthy(Some(v))).and_then(Value::as_str).map(str::to_string)
}

pub fn elapsed(iso: &str) -> i64 {
    match crate::core::time::parse(iso) {
        Some(t) => crate::core::time::now_ms() - t,
        None => i64::MIN,
    }
}

pub fn read_state() -> Value {
    let s = std::fs::read_to_string(&*STATE_FILE).ok().and_then(|t| crate::core::json::parse(&t));
    let now = crate::core::time::now();
    if CLUSTER.is_none() {
        return s.filter(|v| truthy(Some(v))).unwrap_or_else(|| json!({ "role": "primary", "since": now }));
    }
    let Some(s) = s.filter(|v| truthy(Some(v))) else { return json!({ "role": "follower", "since": now }) };
    let saved_at = s.get("savedAt").filter(|v| truthy(Some(v))).and_then(Value::as_str);
    if s.get("role").and_then(Value::as_str) == Some("primary") && saved_at.map_or(false, |a| elapsed(a) > STALE_STATE_MS) {
        let mut out = s.clone();
        out["role"] = json!("follower");
        out["since"] = json!(now);
        out["manual"] = json!(false);
        out["pendingPull"] = Value::Null;
        out["wokeStale"] = json!(true);
        return out;
    }
    s
}

pub fn save() {
    let text = {
        let mut st = ST.lock().unwrap_or_else(|p| p.into_inner());
        if !st.is_object() {
            *st = json!({});
        }
        st["savedAt"] = json!(crate::core::time::now());
        crate::core::json::stringify_pretty(&st, 1)
    };
    let _ = std::fs::write(&*STATE_FILE, text);
}

pub fn log(message: &str) {
    crate::core::logfile::append_log(&crate::core::data::DATA_DIR.join("cluster.log"), &format!("[{}] {message}\n", crate::core::time::now()));
}

pub fn is_primary() -> bool {
    CLUSTER.is_none() || st_get("role").as_str() == Some("primary")
}

pub fn primary_now() -> bool {
    CLUSTER.is_none() || read_state().get("role").and_then(Value::as_str) == Some("primary")
}

pub fn info() -> Value {
    let primary = is_primary();
    let st = ST.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let or_null = |k: &str| st.get(k).filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
    let cluster_value = |k: &str| CLUSTER.as_ref().map(|c| c.get(k).cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null);
    let label = CLUSTER.as_ref().map(|c| c.get("label").filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null);
    let mac_power = if cfg!(target_os = "macos") { crate::features::mac_power::status() } else { or_null("peerMacPower") };
    json!({
        "label": label,
        "role": if primary { "primary" } else { "follower" },
        "since": st.get("since").cloned().unwrap_or(Value::Null),
        "manual": primary && truthy(st.get("manual")),
        "lastSnapshot": or_null("lastSnapshot"),
        "lastTranscripts": or_null("lastTranscripts"),
        "pendingPull": or_null("pendingPull"),
        "host": crate::core::platform::hostname(),
        "sshUser": crate::core::platform::username(),
        "self": cluster_value("self"),
        "peer": cluster_value("peer"),
        "claudeToken": crate::features::claude_token::token_status(),
        "macPower": mac_power,
    })
}

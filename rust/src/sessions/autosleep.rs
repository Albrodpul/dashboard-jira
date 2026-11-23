//! Port of src/sessions/autosleep.js.
use crate::core::json::truthy;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const IDLE_MS: i64 = 30 * 60000;
const PENDING: [&str; 4] = ["approved", "sent", "waiting", "partial"];

fn log(message: &str) {
    crate::core::logfile::append_log(&crate::core::data::DATA_DIR.join("autosleep.log"), &format!("{} {message}\n", crate::core::time::now()));
}

fn text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => crate::core::json::stringify(other),
    }
}

fn list<'a>(v: Option<&'a Value>) -> impl Iterator<Item = &'a Value> {
    v.and_then(|x| x.as_array()).into_iter().flatten()
}

pub fn sleep_idle_sessions(now: bool) {
    if !crate::cluster::cluster::is_primary() {
        return;
    }
    if !now && crate::core::hours::overtime().is_some_and(|o| truthy(Some(&o))) {
        return;
    }
    let Ok(Value::Array(hosted)) = crate::sessions::host::host_request("GET", "/sessions", None) else { return };
    let s = crate::server::state::state();
    let area_conversation = |id: Option<&str>| -> Option<String> {
        let id = id.filter(|i| !i.is_empty())?;
        let a = list(s.get("areas")).find(|x| x.get("id").and_then(|i| i.as_str()) == Some(id))?;
        a.get("conversation").filter(|c| truthy(Some(c))).map(|c| text(Some(c)))
    };
    let mut keep: HashSet<String> = HashSet::new();
    for key in ["reporterRoute", "followUpStatus", "boardStatus"] {
        if let Some(r) = s.get(key).filter(|r| truthy(Some(r))) {
            keep.insert(text(r.get("conversation")));
        }
    }
    let errors_area = crate::core::config::main_project().errors_area.clone();
    for id in [s.get("deployerArea").and_then(|x| x.as_str()).map(String::from), errors_area] {
        if let Some(c) = area_conversation(id.as_deref()) {
            keep.insert(c);
        }
    }
    for a in list(s.get("areas")) {
        if truthy(a.get("keepOpen")) && truthy(a.get("conversation")) {
            keep.insert(text(a.get("conversation")));
        }
    }
    for t in list(s.get("tasks")) {
        if PENDING.contains(&t.get("status").and_then(|x| x.as_str()).unwrap_or(""))
            && let Some(c) = area_conversation(t.get("area").and_then(|x| x.as_str()))
        {
            keep.insert(c);
        }
    }
    for p in list(s.get("permissions").and_then(|p| p.get("pending"))) {
        if truthy(p.get("conversation")) {
            keep.insert(text(p.get("conversation")));
        }
    }
    let live: HashMap<String, &Value> = list(s.get("sessions").and_then(|x| x.get("list"))).map(|x| (text(x.get("conversation")), x)).collect();
    let now_ms = crate::core::time::now_ms();
    for h in &hosted {
        let conversation = text(h.get("conversation"));
        if !truthy(h.get("running")) || keep.contains(&conversation) {
            continue;
        }
        let Some(l) = live.get(&conversation) else { continue };
        if l.get("status").and_then(|x| x.as_str()) != Some("idle") || truthy(l.get("background")) || !truthy(l.get("statusSince")) {
            continue;
        }
        let since = l.get("statusSince").and_then(|x| x.as_str()).and_then(crate::core::time::parse);
        if since.is_some_and(|t| now_ms - t < if now { 0 } else { IDLE_MS }) {
            continue;
        }
        let _ = crate::sessions::host::host_request("POST", "/stop", Some(&json!({ "conversation": h.get("conversation").cloned().unwrap_or(Value::Null) })));
        crate::sessions::host::mark_on_demand(&conversation);
        log(&format!("duerme {}: parada desde {}", text(h.get("name")), text(l.get("statusSince"))));
    }
}

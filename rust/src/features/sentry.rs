//! Port of src/features/sentry.js.
use crate::core::config::{Project, main_project, projects};
use crate::core::data::{Doc, mutate, now};
use crate::core::json::{parse, stringify, truthy};
use crate::core::time::now_ms;
use serde_json::{Map, Value, json};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

const API: &str = "https://sentry.io/api/0";
const CACHE_MS: i64 = 60 * 1000;
const STATUSES: [&str; 2] = ["resolved", "ignored"];

struct Cache {
    at: i64,
    value: Value,
}

static CACHE: LazyLock<Mutex<Option<Cache>>> = LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
pub(crate) static API_OVERRIDE: Mutex<Option<String>> = Mutex::new(None);

fn api() -> String {
    #[cfg(test)]
    if let Some(base) = API_OVERRIDE.lock().unwrap().clone() {
        return base;
    }
    API.to_string()
}

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(300))).build())
}

fn mcp_token(root: &std::path::Path) -> Option<String> {
    let mcp = parse(&std::fs::read_to_string(root.join(".mcp.json")).ok()?)?;
    let servers = mcp.get("mcpServers").and_then(Value::as_object).cloned().unwrap_or_default();
    let arg_text = |a: &Value| a.as_str().map(str::to_string).unwrap_or_else(|| stringify(a));
    let server = servers.values().find(|s| s.get("args").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| arg_text(x).contains("sentry"))));
    let args: Vec<String> = server.and_then(|s| s.get("args")).and_then(Value::as_array).map(|a| a.iter().map(arg_text).collect()).unwrap_or_default();
    match args.iter().position(|a| a.starts_with("--access-token")) {
        None => server.and_then(|s| s.pointer("/env/SENTRY_ACCESS_TOKEN")).and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string),
        Some(i) => match args[i].find('=') {
            Some(eq) => Some(args[i][eq + 1..].to_string()),
            None => args.get(i + 1).filter(|t| !t.is_empty()).cloned(),
        },
    }
}

fn token_of(p: &Project) -> Option<String> {
    crate::features::projects_admin::secret(p, "SENTRY_TOKEN").filter(|t| !t.is_empty()).or_else(|| if p.id == main_project().id { p.root.as_deref().and_then(mcp_token) } else { None })
}

fn sentry_projects(p: &Project) -> Vec<String> {
    p.sentry.get("projects").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn org_of(p: &Project) -> Option<String> {
    p.sentry.get("org").and_then(Value::as_str).filter(|o| !o.is_empty()).map(str::to_string)
}

pub fn sources() -> Vec<Project> {
    projects().into_iter().filter(|p| org_of(p).is_some() && !sentry_projects(p).is_empty() && token_of(p).is_some()).collect()
}

pub fn sentry_available() -> bool {
    !sources().is_empty()
}

fn owner_of(id: Option<&str>) -> Project {
    id.and_then(crate::core::config::project).unwrap_or_else(|| main_project().clone())
}

pub fn errors_areas() -> Value {
    let mut m = Map::new();
    for p in projects() {
        if let Some(a) = &p.errors_area {
            m.insert(p.id.clone(), Value::from(a.clone()));
        }
    }
    Value::Object(m)
}

fn form_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn js_number(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Some(Value::Bool(b)) => *b as i32 as f64,
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

fn project_issues(p: &Project, slug: &str, auth: &str, many: bool) -> Result<Vec<Value>, String> {
    let setting = |k: &str, d: &str| p.sentry.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).unwrap_or(d).to_string();
    let q = [("query", setting("query", "is:unresolved level:error")), ("statsPeriod", setting("period", "14d")), ("sort", "date".into()), ("limit", "25".into())].iter().map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v))).collect::<Vec<_>>().join("&");
    let url = format!("{}/projects/{}/{}/issues/?{}", api(), org_of(p).unwrap_or_default(), slug, q);
    let mut r = agent().get(&url).header("authorization", format!("Bearer {auth}")).call().map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("Sentry respondió {status} para {slug}{}", if many { format!(" ({})", p.name) } else { String::new() }));
    }
    let list: Value = r.body_mut().read_json().map_err(|e| e.to_string())?;
    Ok(list
        .as_array()
        .into_iter()
        .flatten()
        .map(|x| {
            let mut m = Map::new();
            let mut put = |k: &str, v: Option<Value>| {
                if let Some(v) = v {
                    m.insert(k.into(), v);
                }
            };
            put("id", x.get("shortId").cloned());
            put("issueId", x.get("id").cloned());
            put("title", x.get("title").cloned());
            put("culprit", Some(x.get("culprit").filter(|c| truthy(Some(c))).cloned().unwrap_or(Value::from(""))));
            put("project", Some(Value::from(slug)));
            put("owner", Some(Value::from(p.id.clone())));
            put("level", x.get("level").cloned());
            let count = js_number(x.get("count"));
            put("count", Some(if count.is_nan() || count == 0.0 { json!(0) } else { crate::core::json::num(count) }));
            put("users", Some(x.get("userCount").filter(|c| truthy(Some(c))).cloned().unwrap_or(json!(0))));
            put("firstSeen", x.get("firstSeen").cloned());
            put("lastSeen", x.get("lastSeen").cloned());
            put("url", x.get("permalink").cloned());
            Value::Object(m)
        })
        .collect())
}

pub fn list_issues(force: bool) -> Value {
    let from = sources();
    if from.is_empty() {
        return json!({ "available": false, "issues": [] });
    }
    if !force {
        if let Some(c) = CACHE.lock().unwrap().as_ref() {
            if now_ms() - c.at < CACHE_MS {
                return c.value.clone();
            }
        }
    }
    let many = projects().len() > 1;
    let jobs: Vec<(Project, String, String)> = from.iter().flat_map(|p| sentry_projects(p).into_iter().map(move |slug| (p.clone(), slug, token_of(p).unwrap_or_default()))).collect();
    let results: Vec<Result<Vec<Value>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = jobs.iter().map(|(p, slug, auth)| scope.spawn(move || project_issues(p, slug, auth, many))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("fallo inesperado".into()))).collect()
    });
    let mut issues: Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();
    for r in results {
        match r {
            Ok(list) => issues.extend(list),
            Err(e) => errors.push(Value::from(e)),
        }
    }
    let seen_at = |x: &Value| x.get("lastSeen").and_then(Value::as_str).and_then(crate::core::time::parse).unwrap_or(i64::MIN);
    issues.sort_by(|a, b| seen_at(b).cmp(&seen_at(a)));
    let mut labels = Map::new();
    for p in &from {
        if let Some(l) = p.sentry.get("labels").and_then(Value::as_object) {
            labels.extend(l.clone());
        }
    }
    let mut slugs: Vec<String> = Vec::new();
    for (_, slug, _) in &jobs {
        if !slugs.contains(slug) {
            slugs.push(slug.clone());
        }
    }
    let mut owners = Map::new();
    for p in &from {
        owners.insert(p.id.clone(), Value::from(p.name.clone()));
    }
    let value = json!({ "available": true, "projects": slugs, "labels": labels, "owners": owners, "issues": issues, "errors": errors, "at": now() });
    *CACHE.lock().unwrap() = Some(Cache { at: now_ms(), value: value.clone() });
    value
}

pub fn set_status(issue_id: &Value, id: &str, status: &str, owner: Option<&str>) -> Result<(), String> {
    let issue = match issue_id {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => stringify(other),
    };
    let digits = !issue.is_empty() && issue.bytes().all(|b| b.is_ascii_digit());
    if !STATUSES.contains(&status) || !digits {
        return Err("estado o error no válido".into());
    }
    let p = owner_of(owner);
    let Some(org) = org_of(&p) else { return Err(format!("{} no tiene Sentry", p.name)) };
    let url = format!("{}/organizations/{}/issues/{}/", api(), org, issue);
    let r = agent().put(&url).header("authorization", format!("Bearer {}", token_of(&p).unwrap_or_else(|| "null".into()))).header("content-type", "application/json").send(stringify(&json!({ "status": status }))).map_err(|e| e.to_string())?;
    let code = r.status().as_u16();
    if !(200..300).contains(&code) {
        return Err(format!("Sentry respondió {code}"));
    }
    if let Some(c) = CACHE.lock().unwrap().as_mut() {
        if let Some(list) = c.value.get_mut("issues").and_then(Value::as_array_mut) {
            list.retain(|x| x.get("issueId").map(|v| match v {
                Value::String(s) => s.clone(),
                other => stringify(other),
            }).as_deref() != Some(issue.as_str()));
        }
    }
    mutate(|d| {
        if let Some(x) = d.get_mut("sentry").and_then(|s| s.get_mut(id)).and_then(Value::as_object_mut) {
            x.insert("closedAs".into(), Value::from(status));
            x.insert("closedAt".into(), Value::from(now()));
        }
    });
    Ok(())
}

pub fn sentry_issues(d: &Doc) -> Value {
    Value::from(d.get("sentry").and_then(Value::as_object).map(|m| m.values().cloned().collect::<Vec<_>>()).unwrap_or_default())
}

fn cut(v: Option<&Value>) -> String {
    let text = match v.filter(|x| truthy(Some(x))) {
        Some(Value::String(s)) => s.clone(),
        Some(other) => stringify(other),
        None => String::new(),
    };
    text.chars().take(300).collect()
}

pub fn send_issues(list: &Value, area: &str) -> usize {
    mutate(|d| {
        if !d.get("sentry").is_some_and(|s| truthy(Some(s))) {
            d.insert("sentry".into(), json!({}));
        }
        let sentry = d.get_mut("sentry").and_then(Value::as_object_mut).unwrap();
        let mut n = 0;
        for x in list.as_array().into_iter().flatten() {
            let key = match x.get("id") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => stringify(other),
                None => "undefined".into(),
            };
            let prev = sentry.get(&key).cloned();
            if prev.as_ref().and_then(|p| p.get("state")).and_then(Value::as_str) == Some("approved") {
                continue;
            }
            let mut m = Map::new();
            let mut put = |k: &str, v: Option<Value>| {
                if let Some(v) = v {
                    m.insert(k.into(), v);
                }
            };
            put("id", x.get("id").cloned());
            put("title", Some(Value::from(cut(x.get("title")))));
            put("culprit", Some(Value::from(cut(x.get("culprit")))));
            put("project", x.get("project").cloned());
            if let Some(owner) = x.get("owner").filter(|o| truthy(Some(o))) {
                put("owner", Some(Value::from(match owner {
                    Value::String(s) => s.clone(),
                    other => stringify(other),
                })));
            }
            put("url", x.get("url").cloned());
            put("count", x.get("count").cloned());
            put("users", x.get("users").cloned());
            put("lastSeen", x.get("lastSeen").cloned());
            put("area", Some(Value::from(area)));
            put("state", Some(Value::from("approved")));
            put("approvedVia", Some(Value::from("board")));
            put("at", Some(Value::from(now())));
            let rounds = prev.as_ref().and_then(|p| p.get("rounds")).and_then(Value::as_f64).filter(|r| *r != 0.0).unwrap_or(0.0) + 1.0;
            put("rounds", Some(crate::core::json::num(rounds)));
            sentry.insert(key, Value::Object(m));
            n += 1;
        }
        let limit = now_ms() - 30 * 24 * 3600 * 1000;
        sentry.retain(|_, v| v.get("state").and_then(Value::as_str) == Some("approved") || !v.get("at").and_then(Value::as_str).and_then(crate::core::time::parse).is_some_and(|t| t < limit));
        n
    })
}

pub fn mark_sent(ids: &[String]) -> usize {
    mutate(|d| {
        let mut k = 0;
        for id in ids {
            let Some(x) = d.get("sentry").and_then(|s| s.get(id)).cloned() else { continue };
            if x.get("state").and_then(Value::as_str) != Some("approved") || x.get("approvedVia").and_then(Value::as_str) != Some("board") {
                continue;
            }
            let area = x.get("area").and_then(Value::as_str).unwrap_or("").to_string();
            let held = crate::features::holds::check_area(d, &format!("El error {id}"), &area, None);
            if !held.is_empty() {
                eprintln!("{held}");
                continue;
            }
            if let Some(x) = d.get_mut("sentry").and_then(|s| s.get_mut(id)).and_then(Value::as_object_mut) {
                x.insert("state".into(), Value::from("sent"));
                x.insert("sentAt".into(), Value::from(now()));
            }
            k += 1;
        }
        k
    })
}

pub fn save_result(ids: &[String], text: &str) -> usize {
    mutate(|d| {
        let mut k = 0;
        for id in ids {
            let Some(x) = d.get_mut("sentry").and_then(|s| s.get_mut(id)).and_then(Value::as_object_mut) else { continue };
            let state = x.get("state").and_then(Value::as_str).unwrap_or("").to_string();
            if state != "approved" && state != "sent" {
                continue;
            }
            x.insert("result".into(), json!({ "text": text, "at": now() }));
            if state == "approved" {
                x.insert("state".into(), Value::from("sent"));
                x.insert("sentAt".into(), Value::from(now()));
            }
            k += 1;
        }
        k
    })
}

pub fn discard(id: &str) -> bool {
    mutate(|d| {
        let Some(sentry) = d.get_mut("sentry").and_then(Value::as_object_mut) else { return false };
        match sentry.get(id) {
            None => false,
            Some(x) if x.get("state").and_then(Value::as_str) == Some("approved") => false,
            Some(_) => {
                sentry.shift_remove(id);
                true
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::fresh;

    #[test]
    fn issues_sent_to_a_session_are_approved_once_and_can_be_marked_sent_or_discarded() {
        let _g = fresh();
        let list = json!([{ "id": "WEB-1", "title": "Boom", "project": "web", "owner": "test", "url": "u", "count": 2, "users": 1, "lastSeen": "2026-11-20T10:00:00Z" }]);
        assert_eq!(send_issues(&list, "pay"), 1);
        assert_eq!(send_issues(&list, "pay"), 0);
        let d = crate::core::data::load();
        let x = &d["sentry"]["WEB-1"];
        assert_eq!(x["state"], "approved");
        assert_eq!(x["rounds"], 1);
        assert!(!discard("WEB-1"));
        assert_eq!(save_result(&["WEB-1".into()], "hecho"), 1);
        assert_eq!(crate::core::data::load()["sentry"]["WEB-1"]["state"], "sent");
        assert!(discard("WEB-1"));
        assert_eq!(sentry_issues(&crate::core::data::load()), json!([]));
    }

    #[test]
    fn a_bad_status_or_issue_is_refused_before_calling_sentry() {
        let _g = fresh();
        assert_eq!(set_status(&json!("abc"), "WEB-1", "resolved", None), Err("estado o error no válido".into()));
        assert_eq!(set_status(&json!("12"), "WEB-1", "deleted", None), Err("estado o error no válido".into()));
    }
}

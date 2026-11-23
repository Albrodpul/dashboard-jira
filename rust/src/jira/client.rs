use crate::core::config::Project;
use crate::core::data::{Doc, load, mutate};
use crate::core::json::{stringify, truthy};
use crate::jira::sites::{self, Auth};
use regex::Regex;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

pub static ME: LazyLock<String> = LazyLock::new(|| crate::core::config::main_project().jira.as_ref().and_then(|j| j.me.get("id")).and_then(Value::as_str).unwrap_or_default().to_string());
pub static ATTACHMENTS_DIR: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::main_project().root.clone().unwrap_or_default().join(".attachments"));

#[derive(Clone, Debug, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Result<Value, String> {
        serde_json::from_slice(&self.body).map_err(|e| e.to_string())
    }
}

pub type HttpHook = Box<dyn Fn(&str, &str, &[(String, String)], Option<&[u8]>) -> Result<HttpResponse, String> + Send + Sync>;

static HTTP_HOOK: LazyLock<Mutex<Option<HttpHook>>> = LazyLock::new(|| Mutex::new(None));

pub fn set_http_hook(hook: Option<HttpHook>) {
    *HTTP_HOOK.lock().unwrap() = hook;
}

pub fn http(method: &str, url: &str, headers: &[(&str, &str)], body: Option<Vec<u8>>, timeout_ms: Option<u64>) -> Result<HttpResponse, String> {
    let owned: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    if let Some(hook) = HTTP_HOOK.lock().unwrap().as_ref() {
        return hook(method, url, &owned, body.as_deref());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(timeout_ms.map(Duration::from_millis)).build().into();
    let mut builder = ureq::http::Request::builder().method(method).uri(url);
    for (k, v) in &owned {
        builder = builder.header(k.as_str(), v.as_str());
    }
    let result = match body {
        Some(b) => agent.run(builder.body(b).map_err(|e| e.to_string())?),
        None => agent.run(builder.body(()).map_err(|e| e.to_string())?),
    };
    let mut r = result.map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let headers = r.headers().iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect();
    let body = r.body_mut().with_config().limit(u64::MAX).read_to_vec().map_err(|e| e.to_string())?;
    Ok(HttpResponse { status, headers, body })
}

pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn jira_auth(p: Option<&Project>) -> Result<Auth, String> {
    sites::auth(p)
}

pub fn jira_get(route: &str, p: Option<&Project>) -> Result<Value, String> {
    let Auth { base, auth, .. } = jira_auth(p)?;
    let r = http("GET", &format!("{base}{route}"), &[("Authorization", &auth), ("Accept", "application/json")], None, None)?;
    if !r.ok() {
        return Err(format!("Jira {}", r.status));
    }
    r.json()
}

pub fn jira_request(method: &str, route: &str, body: Option<&Value>, p: Option<&Project>) -> Result<Value, String> {
    let Auth { base, auth, .. } = jira_auth(p)?;
    let r = http(method, &format!("{base}{route}"), &[("Authorization", &auth), ("Accept", "application/json"), ("Content-Type", "application/json")], body.map(|b| stringify(b).into_bytes()), None)?;
    if !r.ok() {
        return Err(format!("Jira respondió {}", r.status));
    }
    if r.status == 204 { Ok(Value::Null) } else { r.json() }
}

fn epics_of(p: &Project) -> Result<Vec<Value>, String> {
    let projects_jql = p.jira.as_ref().map(|j| j.projects_jql.clone()).unwrap_or_default();
    let jql = encode_uri_component(&format!("{projects_jql} AND issuetype = Epic ORDER BY key"));
    let mut all: Vec<Value> = Vec::new();
    let mut token = String::new();
    loop {
        let next = if token.is_empty() { String::new() } else { format!("&nextPageToken={}", encode_uri_component(&token)) };
        let body = jira_get(&format!("/search/jql?jql={jql}&fields=summary,status&maxResults=100{next}"), Some(p))?;
        all.extend(body.get("issues").and_then(Value::as_array).cloned().unwrap_or_default());
        token = if truthy(body.get("isLast")) { String::new() } else { body.get("nextPageToken").and_then(Value::as_str).unwrap_or("").to_string() };
        if token.is_empty() {
            break;
        }
    }
    Ok(all.iter().map(|e| json!({ "key": e["key"], "name": e["fields"]["summary"], "status": e["fields"]["status"]["name"], "project": p.id })).collect())
}

fn settle<T: Send, F: Fn(&Project) -> Result<T, String> + Sync>(list: &[Project], f: F) -> Vec<Result<T, String>> {
    std::thread::scope(|s| {
        let handles: Vec<_> = list.iter().map(|p| s.spawn(|| f(p))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("fallo inesperado".to_string()))).collect()
    })
}

fn first_error<T>(results: &[Result<T, String>]) -> String {
    results.iter().find_map(|r| r.as_ref().err().cloned()).unwrap_or_default()
}

pub fn sync_jira_epics() -> Result<usize, String> {
    let list = sites::jira_projects();
    let results = settle(&list, epics_of);
    if results.iter().all(|r| r.is_err()) {
        return Err(first_error(&results));
    }
    let failed: Vec<String> = list.iter().zip(&results).filter(|(_, r)| r.is_err()).map(|(p, _)| p.id.clone()).collect();
    let fresh: Vec<Value> = results.into_iter().filter_map(Result::ok).flatten().collect();
    Ok(mutate(|d| {
        let kept: Vec<Value> = d
            .get("jiraEpics")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|e| {
                let project = e.get("project").filter(|v| truthy(Some(v))).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| sites::for_key(e.get("key").and_then(Value::as_str).unwrap_or("")).id);
                failed.contains(&project)
            })
            .collect();
        let mut all = fresh;
        all.extend(kept);
        let n = all.len();
        d.insert("jiraEpics".into(), Value::Array(all));
        d.insert("jiraEpicsAt".into(), Value::from(crate::core::time::now()));
        n
    }))
}

pub fn jira_search(jql: &str, max: usize, p: Option<&Project>) -> Result<Vec<Value>, String> {
    let body = jira_get(&format!("/search/jql?jql={}&fields=summary,status,assignee,parent,created,labels&maxResults={max}", encode_uri_component(jql)), p)?;
    Ok(body.get("issues").and_then(Value::as_array).cloned().unwrap_or_default())
}

pub fn jira_search_all(jql_of: &(dyn Fn(&Project) -> String + Sync), max: usize) -> Result<Vec<Value>, String> {
    let results = settle(&sites::jira_projects(), |p| jira_search(&jql_of(p), max, Some(p)));
    if results.iter().all(|r| r.is_err()) {
        return Err(first_error(&results));
    }
    Ok(results.into_iter().filter_map(Result::ok).flatten().collect())
}

pub fn jira_issues(keys: &[String], max: usize) -> Result<Vec<Value>, String> {
    let groups = sites::by_project(keys);
    let results: Vec<Result<Vec<Value>, String>> = std::thread::scope(|s| {
        let handles: Vec<_> = groups.iter().map(|(p, list)| s.spawn(move || jira_search(&format!("key in ({})", list.join(",")), max, Some(p)))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("fallo inesperado".to_string()))).collect()
    });
    if !results.is_empty() && results.iter().all(|r| r.is_err()) {
        return Err(first_error(&results));
    }
    Ok(results.into_iter().filter_map(Result::ok).flatten().collect())
}

fn jira_attachments(keys: &[String]) -> Result<serde_json::Map<String, Value>, String> {
    let mut out = serde_json::Map::new();
    let groups = sites::by_project(keys);
    let single = groups.len() == 1;
    for (p, list) in &groups {
        let body = match jira_get(&format!("/search/jql?jql={}&fields=attachment&maxResults=100", encode_uri_component(&format!("key in ({})", list.join(",")))), Some(p)) {
            Ok(b) => b,
            Err(e) if single => return Err(e),
            Err(_) => continue,
        };
        for i in body.get("issues").and_then(Value::as_array).cloned().unwrap_or_default() {
            let items: Vec<Value> = i["fields"].get("attachment").and_then(Value::as_array).cloned().unwrap_or_default().iter().map(|a| json!({ "id": a["id"], "name": a["filename"], "size": a["size"], "url": a["content"] })).collect();
            if let Some(k) = i.get("key").and_then(Value::as_str) {
                out.insert(k.to_string(), Value::Array(items));
            }
        }
    }
    Ok(out)
}

static ISSUE_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]+-\d+$").unwrap());

pub fn refresh_attachments() -> Result<(), String> {
    let d = load();
    let mut tasks: Vec<Value> = d
        .get("tasks")
        .and_then(Value::as_object)
        .map(|m| m.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|t| ["pending", "approved", "ignored"].contains(&t.get("status").and_then(Value::as_str).unwrap_or("")) && t.get("source").and_then(Value::as_str) != Some("manual"))
        .collect();
    let at = |t: &Value| t.get("at").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| if v.is_null() { String::new() } else { stringify(v) })).unwrap_or_default();
    tasks.sort_by(|x, y| at(y).cmp(&at(x)));
    let keys: Vec<String> = tasks.iter().filter_map(|t| t.get("key").and_then(Value::as_str)).filter(|k| ISSUE_KEY.is_match(k)).take(100).map(str::to_string).collect();
    if keys.is_empty() {
        return Ok(());
    }
    let found = jira_attachments(&keys)?;
    let summary = |list: &Value| -> Value { Value::Array(list.as_array().cloned().unwrap_or_default().iter().map(|a| json!({ "name": a["name"], "size": a["size"] })).collect()) };
    let differs = |t: &Value, list: &Value| stringify(t.get("attachments").unwrap_or(&Value::Null)) != stringify(list);
    let d0 = load();
    let task_of = |d: &Doc, k: &str| d.get("tasks").and_then(|t| t.get(k)).cloned();
    if !keys.iter().any(|k| found.get(k).map_or(false, |f| task_of(&d0, k).map_or(false, |t| differs(&t, &summary(f))))) {
        return Ok(());
    }
    mutate(|d| {
        for k in &keys {
            if let Some(f) = found.get(k) {
                if let Some(t) = d.get_mut("tasks").and_then(|t| t.get_mut(k.as_str())).filter(|t| t.is_object()) {
                    t["attachments"] = summary(f);
                }
            }
        }
    });
    Ok(())
}

static BAD_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1f]"#).unwrap());
static ZIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.zip$").unwrap());

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        other => stringify(other),
    }
}

pub fn download_attachments(key: &str) -> Result<Value, String> {
    if !ISSUE_KEY.is_match(key) {
        return Err("clave no válida".to_string());
    }
    let list = jira_attachments(&[key.to_string()])?.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    if list.is_empty() {
        return Ok(json!({ "folder": null, "files": [] }));
    }
    let project = sites::for_key(key);
    let Auth { auth, .. } = jira_auth(Some(&project))?;
    let folder = ATTACHMENTS_DIR.join(key);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let mut files: Vec<Value> = Vec::new();
    let mut used: Vec<String> = Vec::new();
    for a in &list {
        let raw = value_text(&a["name"]);
        let base = raw.rsplit('/').next().unwrap_or("").to_string();
        let mut name = BAD_NAME.replace_all(&base, "_").to_string();
        if name.is_empty() {
            name = format!("attachment-{}", value_text(&a["id"]));
        }
        if used.contains(&name.to_lowercase()) {
            name = format!("{}-{name}", value_text(&a["id"]));
        }
        used.push(name.to_lowercase());
        let target = folder.join(&name);
        let same_size = std::fs::metadata(&target).ok().map(|m| m.len() as f64) == a["size"].as_f64();
        if !(target.exists() && same_size) {
            let url = a["url"].as_str().unwrap_or("");
            let r = http("GET", url, &[("Authorization", &auth)], None, None)?;
            if !r.ok() {
                return Err(format!("no se pudo bajar {raw} ({})", r.status));
            }
            std::fs::write(&target, &r.body).map_err(|e| e.to_string())?;
        }
        let mut item = serde_json::Map::new();
        item.insert("file".into(), Value::from(target.to_string_lossy().replace('\\', "/")));
        if ZIP.is_match(&name) {
            let extracted = folder.join(format!("{}-extracted", ZIP.replace(&name, "")));
            if !extracted.exists() {
                let _ = std::fs::create_dir_all(&extracted);
                let tar = if cfg!(windows) { PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32").join("tar.exe").to_string_lossy().to_string() } else { "tar".to_string() };
                let ok = crate::core::platform::run_output(&tar, &["-xf".into(), target.to_string_lossy().to_string(), "-C".into(), extracted.to_string_lossy().to_string()], 60000, None, &[]).ok;
                if !ok {
                    let _ = std::fs::remove_dir_all(&extracted);
                }
            }
            if extracted.exists() {
                item.insert("extracted".into(), Value::from(extracted.to_string_lossy().replace('\\', "/")));
            }
        }
        files.push(Value::Object(item));
    }
    Ok(json!({ "folder": folder.to_string_lossy().replace('\\', "/"), "files": files }))
}

pub fn summarize_issue(i: &Value, d: &Doc, routes: &Value) -> Value {
    let f = &i["fields"];
    let key = i.get("key").and_then(Value::as_str).unwrap_or("");
    let p = sites::for_key(key);
    let parent = f.get("parent").filter(|v| truthy(Some(v)));
    let epic_key = parent.map(|x| x["key"].clone()).unwrap_or(Value::Null);
    let epic_name = parent.and_then(|x| x.get("fields")).filter(|v| truthy(Some(v))).map(|x| x["summary"].clone()).unwrap_or(Value::Null);
    let area = match epic_key.as_str() {
        Some(ek) => routes.get("areas").and_then(Value::as_object).and_then(|areas| areas.iter().find(|(_, a)| a.get("epics").map_or(false, |e| truthy(e.get(ek)))).map(|(k, _)| Value::from(k.clone()))).unwrap_or(Value::Null),
        None => Value::Null,
    };
    let assignee = f.get("assignee").filter(|v| truthy(Some(v)));
    let me = sites::me(Some(&p));
    let reject = sites::statuses(Some(&p)).reject_label;
    json!({
        "key": i["key"],
        "title": f["summary"],
        "status": f["status"]["name"],
        "assignee": assignee.map(|a| a["displayName"].clone()).unwrap_or(Value::Null),
        "available": assignee.map_or(true, |a| a.get("accountId") == me.get("id")),
        "epicKey": epic_key,
        "epicName": epic_name,
        "area": area,
        "created": f["created"],
        "rejected": f.get("labels").and_then(Value::as_array).map_or(false, |l| l.contains(&reject)),
        "onBoard": d.get("tasks").and_then(|t| t.get(key)).map_or(false, |t| truthy(Some(t))),
    })
}

static PARAGRAPHS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n").unwrap());

pub fn adf_from_text(text: &str, p: Option<&Project>) -> Value {
    let reviewer = sites::reviewer(p);
    let mentions: Vec<String> = reviewer.get("mentions").and_then(Value::as_array).map(|a| a.iter().filter_map(|m| m.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let mention = if mentions.is_empty() {
        None
    } else {
        let mut sorted = mentions.clone();
        sorted.sort_by(|a, b| b.len().cmp(&a.len()));
        Regex::new(&format!("({})", sorted.iter().map(|m| regex::escape(m)).collect::<Vec<_>>().join("|"))).ok()
    };
    let first = mentions.first().cloned().map(Value::from).unwrap_or(Value::Null);
    let paragraph = |block: &str| -> Value {
        let mut content: Vec<Value> = Vec::new();
        for (i, line) in block.split('\n').enumerate() {
            if i > 0 {
                content.push(json!({ "type": "hardBreak" }));
            }
            let mut pieces: Vec<&str> = Vec::new();
            match &mention {
                Some(re) => {
                    let mut last = 0;
                    for m in re.find_iter(line) {
                        pieces.push(&line[last..m.start()]);
                        pieces.push(m.as_str());
                        last = m.end();
                    }
                    pieces.push(&line[last..]);
                }
                None => pieces.push(line),
            }
            for piece in pieces {
                if piece.is_empty() {
                    continue;
                }
                if mentions.iter().any(|m| m == piece) {
                    content.push(json!({ "type": "mention", "attrs": { "id": reviewer["id"], "text": first } }));
                } else {
                    content.push(json!({ "type": "text", "text": piece }));
                }
            }
        }
        json!({ "type": "paragraph", "content": content })
    };
    let blocks: Vec<Value> = PARAGRAPHS.split(text.trim()).map(paragraph).collect();
    json!({ "type": "doc", "version": 1, "content": blocks })
}

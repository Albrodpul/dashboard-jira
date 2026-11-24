//! Port of src/server/routes/tasks.js.

use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::core::config::{Project, main_project};
use crate::core::data::{DATA_DIR, Doc, IN_SESSION, load, mutate, now};
use crate::core::json::{num, stringify, truthy};
use crate::core::time::{now_ms, parse};
use crate::features::holds;
use crate::jira::client::{adf_from_text, jira_get, jira_issues, jira_request, jira_search, jira_search_all, summarize_issue};
use crate::jira::sites;
use crate::server::http::{Res, send};
use crate::server::state::{open_if_closed, state};
use crate::sessions::registry::{load_routes, real_area, sessions_cli};

const DAY: i64 = 24 * 3600 * 1000;

static REVIEW_JOB: LazyLock<Mutex<Value>> = LazyLock::new(|| Mutex::new(Value::Null));
static KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]+-\d+$").unwrap());
static UPPER_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]+-\d+$").unwrap());
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

pub(crate) fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(n @ Value::Number(_)) => stringify(n),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

pub(crate) fn text_or_empty(v: Option<&Value>) -> String {
    if truthy(v) { js_string(v) } else { String::new() }
}

pub(crate) fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

pub(crate) fn is_true(v: &Value, k: &str) -> bool {
    truthy(v.get(k))
}

pub(crate) fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn encode_uri_component(s: &str) -> String {
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

pub(crate) fn error_res(code: u16, error: &str) -> Res {
    send(code, &json!({ "error": error }))
}

pub(crate) fn ok() -> Res {
    send(200, &json!({}))
}

pub(crate) fn obj(v: &mut Value) -> &mut Map<String, Value> {
    if !v.is_object() {
        *v = json!({});
    }
    v.as_object_mut().unwrap()
}

pub(crate) fn list_mut<'a>(d: &'a mut Doc, key: &str) -> &'a mut Vec<Value> {
    if !d.get(key).is_some_and(Value::is_array) {
        d.insert(key.into(), json!([]));
    }
    d.get_mut(key).and_then(Value::as_array_mut).unwrap()
}

fn tasks_mut(d: &mut Doc) -> &mut Map<String, Value> {
    if !d.get("tasks").is_some_and(Value::is_object) {
        d.insert("tasks".into(), json!({}));
    }
    d.get_mut("tasks").and_then(Value::as_object_mut).unwrap()
}

fn task_of(d: &Doc, key: &str) -> Option<Value> {
    d.get("tasks").and_then(|t| t.get(key)).cloned()
}

fn rounds_plus_one(t: &Map<String, Value>) -> Value {
    num(t.get("rounds").filter(|r| truthy(Some(r))).and_then(Value::as_f64).unwrap_or(0.0) + 1.0)
}

fn route_epic(t: &Value) -> Result<(), String> {
    if !is_true(t, "epicKey") || !is_true(t, "area") {
        return Ok(());
    }
    let epic = js_string(t.get("epicKey"));
    let area = js_string(t.get("area"));
    let r = load_routes();
    let areas = r.get("areas").and_then(Value::as_object).cloned().unwrap_or_default();
    let routed = areas.values().any(|a| a.get("epics").is_some_and(|e| truthy(e.get(&epic))));
    if !routed && truthy(areas.get(&area)) {
        let name = if is_true(t, "epicName") { js_string(t.get("epicName")) } else { epic.clone() };
        sessions_cli(&["route", &epic, &area, &name])?;
    }
    Ok(())
}

fn skip_list(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array).map(|a| a.iter().map(|x| js_string(Some(x))).filter(|s| !s.is_empty()).take(100).map(Value::String).collect()).unwrap_or_default()
}

pub fn handle_task(input: &Value) -> Res {
    let key = js_string(input.get("key"));
    let empty = json!({});
    let patch = input.get("patch").filter(|p| p.is_object()).unwrap_or(&empty);
    let status = patch.get("status");
    let status_str = status.and_then(Value::as_str);
    let by_hand = status_str == Some("sent") && patch.get("manual") == Some(&Value::Bool(true));
    if truthy(status) && !by_hand && !matches!(status_str, Some("pending" | "approved" | "ignored")) {
        return error_res(400, "estado no permitido");
    }
    let area: Option<Value> = if truthy(patch.get("area")) {
        let raw = js_string(patch.get("area"));
        Some(Value::String(real_area(&raw).filter(|a| !a.is_empty()).unwrap_or(raw)))
    } else {
        patch.get("area").cloned()
    };
    let result: Result<Value, (u16, String)> = mutate(|d| {
        let Some(snapshot) = task_of(d, &key) else { return Err((404, "tarea desconocida".to_string())) };
        if status_str == Some("approved") || by_hand {
            let target = if truthy(area.as_ref()) { area.as_ref().and_then(Value::as_str) } else { snapshot.get("area").and_then(Value::as_str) };
            let held = holds::check_task(d, &snapshot, target, None);
            if !held.is_empty() {
                return Err((409, held));
            }
        }
        let task_status = str_of(&snapshot, "status").to_string();
        let in_session = IN_SESSION.contains(&task_status.as_str());
        let t = obj(tasks_mut(d).get_mut(&key).unwrap());
        if in_session && status_str == Some("pending") && patch.get("resend") == Some(&Value::Bool(true)) {
            let changes = snapshot.get("changes").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
            let proposed = if is_true(&snapshot, "area") {
                snapshot["area"].clone()
            } else if is_true(&snapshot, "proposedArea") {
                snapshot["proposedArea"].clone()
            } else {
                json!("")
            };
            let previous = if is_true(&snapshot, "reply") {
                snapshot["reply"].clone()
            } else if is_true(&snapshot, "previousReply") {
                snapshot["previousReply"].clone()
            } else {
                Value::Null
            };
            let rounds = rounds_plus_one(t);
            t.insert("status".into(), json!("pending"));
            t.insert("kind".into(), json!("resend"));
            t.insert("proposedArea".into(), proposed);
            t.insert("note".into(), json!("Ya se envió una vez. Vuelve a enviarse para que la sesión relea el ticket y sus adjuntos."));
            t.insert("noteBy".into(), json!("Tablero"));
            t.insert("previousReply".into(), previous);
            t.insert("rounds".into(), rounds);
            t.insert("decidedAt".into(), Value::Null);
            let at = t.get("at").cloned();
            let sent_at = t.get("sentAt").cloned();
            let later = match (sent_at.as_ref().and_then(Value::as_str), at.as_ref().and_then(Value::as_str)) {
                (Some(s), Some(a)) => !s.is_empty() && s > a,
                _ => false,
            };
            if !truthy(at.as_ref()) || (later && changes == 0) {
                match if truthy(sent_at.as_ref()) { sent_at } else { at } {
                    Some(v) => {
                        t.insert("at".into(), v);
                    }
                    None => {
                        t.shift_remove("at");
                    }
                }
            }
            for k in ["sentAt", "reply", "manual", "approvedVia", "area", "notice", "answer", "extraContext", "skipAttachments"] {
                t.shift_remove(k);
            }
            return Ok(Value::Object(t.clone()));
        }
        let manual = is_true(&snapshot, "manual");
        if in_session && !(manual && status_str == Some("pending")) {
            return Err((409, "ya enviada".to_string()));
        }
        if by_hand && task_status == "approved" {
            return Err((409, "ya está aprobada: la envía la sesión que orquesta".to_string()));
        }
        if manual && status_str == Some("pending") {
            t.shift_remove("manual");
            t.shift_remove("sentAt");
        }
        if truthy(status) {
            t.insert("status".into(), status.cloned().unwrap());
        }
        if by_hand {
            t.insert("manual".into(), json!(true));
            t.insert("sentAt".into(), json!(now()));
            t.insert("decidedAt".into(), json!(now()));
            t.insert("approvedVia".into(), json!("manual"));
            return Ok(Value::Object(t.clone()));
        }
        if patch.get("area").is_some() {
            t.insert("area".into(), area.clone().unwrap_or(Value::Null));
        }
        if status_str == Some("approved") {
            let extra = clip(text_or_empty(patch.get("extraContext")).trim(), 4000);
            let skip = skip_list(patch.get("skipAttachments"));
            if !extra.is_empty() {
                t.insert("extraContext".into(), json!(extra));
            } else {
                t.shift_remove("extraContext");
            }
            if !skip.is_empty() {
                t.insert("skipAttachments".into(), Value::Array(skip));
            } else {
                t.shift_remove("skipAttachments");
            }
            t.insert("decidedAt".into(), json!(now()));
            t.insert("approvedVia".into(), json!("board"));
            t.shift_remove("delivery");
            t.shift_remove("heldBack");
        } else if truthy(status) {
            t.insert("decidedAt".into(), if status_str == Some("ignored") { json!(now()) } else { Value::Null });
            t.shift_remove("approvedVia");
        }
        Ok(Value::Object(t.clone()))
    });
    let t = match result {
        Ok(t) => t,
        Err((code, error)) => return error_res(code, &error),
    };
    if status_str == Some("approved") && is_true(&t, "area") {
        open_if_closed(&js_string(t.get("area")), None);
        crate::features::mailman::kick();
        if let Err(e) = route_epic(&t) {
            return error_res(500, &e);
        }
    }
    ok()
}

pub fn approve_many(pairs: &Value, via: &str) -> Value {
    let list = pairs.as_array().cloned().unwrap_or_default();
    let mut held: Vec<Value> = Vec::new();
    let approved: Vec<Value> = mutate(|d| {
        let at = now();
        let mut out = Vec::new();
        for p in &list {
            let key = js_string(p.get("key"));
            let Some(snapshot) = task_of(d, &key) else { continue };
            if str_of(&snapshot, "status") != "pending" {
                continue;
            }
            let error = holds::check_task(d, &snapshot, p.get("area").and_then(Value::as_str), None);
            if !error.is_empty() {
                held.push(json!({ "key": key, "error": error }));
                continue;
            }
            let t = obj(tasks_mut(d).get_mut(&key).unwrap());
            t.insert("status".into(), json!("approved"));
            t.insert("area".into(), p.get("area").cloned().unwrap_or(Value::Null));
            t.insert("decidedAt".into(), json!(at));
            t.insert("approvedVia".into(), json!(via));
            if is_true(p, "extra") {
                t.insert("extraContext".into(), p["extra"].clone());
            } else {
                t.shift_remove("extraContext");
            }
            if p.get("skip").and_then(Value::as_array).is_some_and(|s| !s.is_empty()) {
                t.insert("skipAttachments".into(), p["skip"].clone());
            } else {
                t.shift_remove("skipAttachments");
            }
            t.shift_remove("delivery");
            t.shift_remove("heldBack");
            out.push(Value::Object(t.clone()));
        }
        out
    });
    if !approved.is_empty() {
        let areas = state().get("areas").cloned().unwrap_or(Value::Null);
        let mut opened: Vec<String> = Vec::new();
        for t in &approved {
            let id = js_string(t.get("area"));
            if !opened.contains(&id) {
                opened.push(id);
            }
        }
        for id in &opened {
            open_if_closed(id, Some(&areas));
        }
    }
    let mut epics: Vec<String> = Vec::new();
    for t in &approved {
        if !is_true(t, "epicKey") {
            continue;
        }
        let epic = js_string(t.get("epicKey"));
        if epics.contains(&epic) {
            continue;
        }
        epics.push(epic);
        let _ = route_epic(t);
    }
    if !approved.is_empty() {
        crate::features::mailman::kick();
    }
    json!({ "approved": approved, "held": held })
}

pub fn handle_batch(input: &Value) -> Res {
    let Some(items) = input.get("items").and_then(Value::as_array).filter(|i| !i.is_empty()) else { return error_res(400, "faltan las tareas") };
    let routes = load_routes();
    let pairs: Vec<Value> = items
        .iter()
        .map(|i| {
            let area = if truthy(i.get("area")) { real_area(&js_string(i.get("area"))).map(Value::String).unwrap_or(Value::Null) } else { Value::Null };
            json!({ "key": js_string(i.get("key")), "area": area, "extra": clip(text_or_empty(i.get("extraContext")).trim(), 4000), "skip": skip_list(i.get("skipAttachments")) })
        })
        .collect();
    let unrouted = pairs.iter().any(|p| !is_true(p, "area") || !truthy(routes.get("areas").and_then(|a| a.get(str_of(p, "area")))));
    if unrouted {
        return error_res(400, "todas las tareas necesitan una sesión");
    }
    let r = approve_many(&Value::Array(pairs), "board");
    let approved = r["approved"].as_array().map(|a| a.len()).unwrap_or(0);
    let held = r["held"].as_array().cloned().unwrap_or_default();
    if !held.is_empty() && approved == 0 {
        let error = held.iter().map(|x| js_string(x.get("error"))).collect::<Vec<_>>().join(" ");
        return send(409, &json!({ "error": error, "held": held }));
    }
    send(200, &json!({ "approved": approved, "held": held }))
}

fn mark_deleted(d: &mut Doc, k: &str) {
    if let Some(t) = task_of(d, k).filter(|t| is_true(t, "sentAt")) {
        let or_null = |name: &str| if is_true(&t, name) { Some(t[name].clone()) } else { Some(Value::Null) };
        let mut line = Map::new();
        for (name, value) in [
            ("key", t.get("key").cloned()),
            ("title", t.get("title").cloned()),
            ("epicName", or_null("epicName")),
            ("kind", or_null("kind")),
            ("status", t.get("status").cloned()),
            ("sentAt", t.get("sentAt").cloned()),
            ("area", or_null("area")),
            ("removedAt", Some(json!(now()))),
        ] {
            if let Some(v) = value {
                line.insert(name.into(), v);
            }
        }
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(DATA_DIR.join("task-history.jsonl")) {
            let _ = f.write_all(format!("{}\n", stringify(&Value::Object(line))).as_bytes());
        }
    }
    tasks_mut(d).shift_remove(k);
    if !truthy(d.get("deleted")) {
        d.insert("deleted".into(), json!({}));
    }
    if let Some(deleted) = d.get_mut("deleted").and_then(Value::as_object_mut) {
        deleted.insert(k.to_string(), json!(now()));
    }
}

pub fn handle_delete(input: &Value) -> Res {
    let list: Vec<String> = input.get("keys").and_then(Value::as_array).map(|a| a.iter().map(|x| js_string(Some(x))).take(500).collect()).unwrap_or_default();
    if list.is_empty() {
        return error_res(400, "faltan las tareas");
    }
    let deleted = mutate(|d| {
        let mut n = 0;
        for k in &list {
            let Some(t) = task_of(d, k) else { continue };
            if !matches!(str_of(&t, "status"), "sent" | "ignored" | "done" | "partial") {
                continue;
            }
            mark_deleted(d, k);
            n += 1;
        }
        let limit = now_ms() - 30 * DAY;
        if let Some(deleted) = d.get_mut("deleted").and_then(Value::as_object_mut) {
            deleted.retain(|_, at| !at.as_str().and_then(parse).is_some_and(|ms| ms < limit));
        }
        n
    });
    send(200, &json!({ "deleted": deleted }))
}

pub fn archive_done() {
    let limit = now_ms() - DAY;
    mutate(|d| {
        let keys: Vec<String> = d
            .get("tasks")
            .and_then(Value::as_object)
            .map(|tasks| {
                tasks
                    .iter()
                    .filter(|(_, t)| str_of(t, "status") == "done" && is_true(t, "jiraClosedAt") && t["jiraClosedAt"].as_str().and_then(parse).is_some_and(|ms| ms <= limit))
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default();
        for k in keys {
            mark_deleted(d, &k);
        }
    });
}

pub fn handle_answer(input: &Value) -> Res {
    let clean = clip(text_or_empty(input.get("text")).trim(), 2000);
    if clean.is_empty() {
        return error_res(400, "escribe la respuesta");
    }
    let key = js_string(input.get("key"));
    let error = mutate(|d| {
        let Some(t) = tasks_mut(d).get_mut(&key) else { return "tarea desconocida".to_string() };
        let t = obj(t);
        let answer = t.get("answer").cloned();
        if truthy(answer.as_ref()) && !answer.as_ref().is_some_and(|a| is_true(a, "delivered")) {
            return "ya hay un mensaje tuyo de camino a la sesión: espera a que le llegue".to_string();
        }
        let status = t.get("status").and_then(Value::as_str).unwrap_or("").to_string();
        if status == "done" && truthy(t.get("area")) && t.get("approvedVia").and_then(Value::as_str) != Some("manual") {
            t.insert("answer".into(), json!({ "text": clean, "at": now(), "delivered": false, "kind": "changes" }));
            t.insert("status".into(), json!("sent"));
            t.insert("sentAt".into(), json!(now()));
            let rounds = rounds_plus_one(t);
            t.insert("rounds".into(), rounds);
            t.shift_remove("reviewedAt");
            t.shift_remove("notice");
            return String::new();
        }
        if !matches!(status.as_str(), "waiting" | "partial") {
            return "esta tarea no espera respuesta".to_string();
        }
        t.insert("answer".into(), json!({ "text": clean, "at": now(), "delivered": false }));
        String::new()
    });
    if !error.is_empty() {
        return error_res(409, &error);
    }
    crate::features::mailman::kick();
    ok()
}

fn review_one(key: &str) -> Result<(), String> {
    let p = sites::for_key(key);
    let st = sites::statuses(Some(&p));
    let route = format!("/issue/{}/transitions", encode_uri_component(key));
    let r = jira_request("GET", &route, None, Some(&p))?;
    let transitions = r.get("transitions").and_then(Value::as_array).cloned().unwrap_or_default();
    let tr = transitions.iter().find(|x| {
        let to = x.get("to").and_then(|t| t.get("name")).filter(|n| truthy(Some(n)));
        let name = to.or_else(|| x.get("name").filter(|n| truthy(Some(n)))).map(|n| js_string(Some(n))).unwrap_or_default();
        st.review_regex.is_match(&name)
    });
    let Some(tr) = tr else { return Err(format!("en Jira no hay paso a {} desde el estado actual", st.review)) };
    jira_request("POST", &route, Some(&json!({ "transition": { "id": tr.get("id").cloned().unwrap_or(Value::Null) } })), Some(&p))?;
    mutate(|d| {
        if let Some(t) = tasks_mut(d).get_mut(key) {
            obj(t).insert("reviewedAt".into(), json!(now()));
        }
    });
    Ok(())
}

pub fn handle_reviewed(input: &Value) -> Res {
    let key = js_string(input.get("key"));
    if !task_of(&load(), &key).is_some_and(|t| str_of(&t, "status") == "done") {
        return error_res(409, "solo se marcan revisadas las tareas hechas");
    }
    match review_one(&key) {
        Ok(()) => ok(),
        Err(e) => error_res(502, &e),
    }
}

pub fn handle_reviewed_all(input: &Value) -> Res {
    let tasks = load().get("tasks").cloned().unwrap_or(json!({}));
    let list: Vec<String> = input
        .get("keys")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|x| js_string(Some(x))).filter(|k| tasks.get(k).is_some_and(|t| str_of(t, "status") == "done" && !is_true(t, "reviewedAt"))).collect())
        .unwrap_or_default();
    if list.is_empty() {
        return error_res(400, "no hay tareas hechas sin pasar a revisión");
    }
    let mut job = REVIEW_JOB.lock().unwrap_or_else(|p| p.into_inner());
    if truthy(Some(&job)) && !is_true(&job, "finishedAt") {
        let done = job["done"].as_array().map(|a| a.len()).unwrap_or(0);
        let message = format!("ya se están pasando ({} de {})", done, js_string(job.get("total")));
        return error_res(409, &message);
    }
    let id = now_ms();
    let total = list.len();
    *job = json!({ "id": id, "total": total, "done": [], "failed": [], "startedAt": now(), "finishedAt": null });
    drop(job);
    std::thread::spawn(move || {
        for k in &list {
            let r = review_one(k);
            let mut job = REVIEW_JOB.lock().unwrap_or_else(|p| p.into_inner());
            match r {
                Ok(()) => job["done"].as_array_mut().unwrap().push(json!(k)),
                Err(e) => job["failed"].as_array_mut().unwrap().push(json!({ "key": k, "error": e })),
            }
        }
        let text = {
            let mut job = REVIEW_JOB.lock().unwrap_or_else(|p| p.into_inner());
            job["finishedAt"] = json!(now());
            let done = job["done"].as_array().map(|a| a.len()).unwrap_or(0);
            let failed = job["failed"].as_array().map(|a| a.len()).unwrap_or(0);
            let review = main_project().statuses.as_ref().map(|s| s.review.clone()).unwrap_or_default();
            format!("{} tareas pasadas a {}{}", done, review, if failed > 0 { format!("; {failed} no") } else { String::new() })
        };
        crate::server::push::send_push("tasks", false, Some(&text));
    });
    send(202, &json!({ "id": id, "total": total }))
}

pub fn review_job_state() -> Value {
    REVIEW_JOB.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

pub fn handle_comment(input: &Value) -> Res {
    let clean = clip(text_or_empty(input.get("text")).trim(), 5000);
    if clean.is_empty() {
        return error_res(400, "el comentario está vacío");
    }
    let key = js_string(input.get("key"));
    let t = task_of(&load(), &key);
    let notice = t.as_ref().and_then(|t| t.get("notice")).filter(|n| truthy(Some(n))).cloned();
    let proposed = t.as_ref().is_some_and(|t| str_of(t, "status") == "waiting") && notice.as_ref().is_some_and(|n| str_of(n, "type") == "comment");
    if !proposed {
        return error_res(409, "esta tarea no tiene un comentario propuesto");
    }
    let changed = clean != text_or_empty(notice.as_ref().and_then(|n| n.get("text"))).trim();
    let p = sites::for_key(&key);
    let route = format!("/issue/{}/comment", encode_uri_component(&key));
    match jira_request("POST", &route, Some(&json!({ "body": adf_from_text(&clean, Some(&p)) })), Some(&p)) {
        Ok(_) => {
            let me = js_string(sites::me(Some(&p)).get("name"));
            mutate(|d| {
                let Some(x) = tasks_mut(d).get_mut(&key) else { return };
                let x = obj(x);
                let at = now();
                x.insert("publishedComment".into(), json!({ "at": at, "text": clean }));
                let text = format!(
                    "{} ha publicado en Jira tu comentario{}. Texto publicado: «{}». Sigue con la tarea cuando haya respuesta en Jira, o con lo que no dependa de ella.",
                    me,
                    if changed { " con cambios" } else { " tal cual" },
                    clean
                );
                x.insert("answer".into(), json!({ "text": text, "at": at, "delivered": false }));
            });
            crate::features::mailman::kick();
            ok()
        }
        Err(e) => error_res(502, &e),
    }
}

pub fn handle_config(input: &Value) -> Res {
    let has = |k: &str| input.as_object().is_some_and(|o| o.contains_key(k));
    mutate(|d| {
        if !truthy(d.get("config")) {
            d.insert("config".into(), json!({}));
        }
        let c = obj(d.get_mut("config").unwrap());
        if has("yolo") {
            let on = is_true(input, "yolo");
            c.insert("yolo".into(), json!(on));
            c.insert("yoloAt".into(), if on { json!(now()) } else { Value::Null });
        }
        if has("paused") {
            let on = is_true(input, "paused");
            c.insert("paused".into(), json!(on));
            c.insert("pausedAt".into(), if on { json!(now()) } else { Value::Null });
        }
    });
    if is_true(input, "yolo") {
        crate::features::yolo::kick();
    }
    if input.get("paused") == Some(&Value::Bool(false)) {
        std::thread::spawn(crate::server::startup::wake_follow_up);
    }
    ok()
}

pub fn handle_refresh() -> Res {
    let request = mutate(|d| {
        let current = d.get("refreshRequest").cloned();
        if !truthy(current.as_ref()) || current.as_ref().is_some_and(|r| is_true(r, "handled")) {
            let at = now();
            d.insert("refreshRequest".into(), json!({ "id": at, "at": at, "handled": false }));
        }
        d["refreshRequest"].clone()
    });
    send(200, &request)
}

pub fn handle_search(input: &Value) -> Res {
    let text: String = clip(text_or_empty(input.get("q")).replace(['"', '\\'], " ").trim(), 80);
    let by_key = if KEY_RE.is_match(&text) { text.to_uppercase() } else { String::new() };
    let only_available = input.get("onlyAvailable") != Some(&Value::Bool(false));
    let skip_review = input.get("skipReview") != Some(&Value::Bool(false));
    let jql_of = |p: &Project| -> String {
        let projects_jql = p.jira.as_ref().map(|j| j.projects_jql.clone()).unwrap_or_default();
        let mut jql = format!("{projects_jql} AND issuetype != Epic AND statusCategory != Done");
        if !by_key.is_empty() {
            jql += &format!(" AND key = \"{by_key}\"");
        } else if !text.is_empty() {
            jql += &format!(" AND summary ~ \"{text}*\"");
        }
        if only_available {
            jql += &format!(" AND (assignee is EMPTY OR assignee = \"{}\")", js_string(sites::me(Some(p)).get("id")));
        }
        if skip_review {
            jql += &format!(" AND status != \"{}\"", sites::statuses(Some(p)).review);
        }
        jql + " ORDER BY created DESC"
    };
    let created = |i: &Value| js_string(i.get("fields").and_then(|f| f.get("created")));
    let found = if !by_key.is_empty() {
        let p = sites::for_key(&by_key);
        jira_search(&jql_of(&p), 60, Some(&p))
    } else {
        jira_search_all(&jql_of, 60).map(|mut all| {
            all.sort_by_key(|i| std::cmp::Reverse(created(i)));
            all.truncate(60);
            all
        })
    };
    match found {
        Ok(issues) => {
            let d = load();
            let routes = load_routes();
            let items: Vec<Value> = issues.iter().map(|i| summarize_issue(i, &d, &routes)).collect();
            send(200, &json!({ "items": items, "capped": issues.len() >= 60 }))
        }
        Err(_) => error_res(502, "No se pudo consultar Jira"),
    }
}

pub(crate) fn adf_text(node: Option<&Value>) -> String {
    let Some(node) = node.filter(|n| truthy(Some(n))) else { return String::new() };
    let kind = str_of(node, "type");
    match kind {
        "text" => return text_or_empty(node.get("text")),
        "hardBreak" => return "\n".to_string(),
        "mention" => return node.get("attrs").map(|a| text_or_empty(a.get("text"))).unwrap_or_default(),
        _ => {}
    }
    let inner: String = node.get("content").and_then(Value::as_array).map(|c| c.iter().map(|x| adf_text(Some(x))).collect()).unwrap_or_default();
    match kind {
        "listItem" => format!("- {}\n", inner.trim()),
        "bulletList" | "orderedList" => inner + "\n",
        "paragraph" | "heading" | "codeBlock" | "blockquote" => format!("{}\n\n", inner.trim()),
        _ => inner,
    }
}

pub fn handle_new_task(input: &Value) -> Res {
    let empty = json!({});
    let input = if truthy(Some(input)) { input } else { &empty };
    match mutate(|d| crate::features::manual_tasks::create_task(d, input)) {
        Ok(key) => send(200, &json!({ "key": key })),
        Err(error) => error_res(400, &error),
    }
}

pub fn handle_ticket(input: &Value) -> Res {
    let k = text_or_empty(input.get("key")).to_uppercase();
    if !UPPER_KEY_RE.is_match(&k) {
        return error_res(400, "clave no válida");
    }
    let own = task_of(&load(), &k).unwrap_or(Value::Null);
    if crate::features::manual_tasks::is_manual(&own) {
        let mut fields = Map::new();
        if let Some(title) = own.get("title") {
            fields.insert("summary".into(), title.clone());
        }
        fields.insert("status".into(), json!({ "name": "Sin Jira" }));
        fields.insert("labels".into(), json!([]));
        let mut x = summarize_issue(&json!({ "key": k, "fields": fields }), &load(), &load_routes());
        let o = obj(&mut x);
        o.insert("manual".into(), json!(true));
        o.insert("description".into(), if is_true(&own, "description") { own["description"].clone() } else { json!("") });
        return send(200, &x);
    }
    let route = format!("/issue/{k}?fields=summary,status,assignee,parent,created,updated,labels,issuetype,priority,reporter,description");
    match jira_get(&route, Some(&sites::for_key(&k))) {
        Ok(i) => {
            let f = i.get("fields").cloned().unwrap_or(json!({}));
            let mut x = summarize_issue(&i, &load(), &load_routes());
            let name_of = |k: &str, sub: &str| if is_true(&f, k) { f[k].get(sub).cloned().unwrap_or(Value::Null) } else { Value::Null };
            let description = clip(BLANK_LINES.replace_all(&adf_text(f.get("description")), "\n\n").trim(), 6000);
            let o = obj(&mut x);
            o.insert("type".into(), name_of("issuetype", "name"));
            o.insert("priority".into(), name_of("priority", "name"));
            o.insert("reporter".into(), name_of("reporter", "displayName"));
            match f.get("updated") {
                Some(u) => {
                    o.insert("updated".into(), u.clone());
                }
                None => {
                    o.shift_remove("updated");
                }
            }
            o.insert("description".into(), json!(description));
            send(200, &x)
        }
        Err(_) => error_res(502, "No se pudo consultar Jira"),
    }
}

pub fn handle_import(input: &Value) -> Res {
    let list: Vec<String> = input.get("keys").and_then(Value::as_array).map(|a| a.iter().map(|x| js_string(Some(x))).filter(|k| UPPER_KEY_RE.is_match(k)).take(60).collect()).unwrap_or_default();
    if list.is_empty() {
        return error_res(400, "faltan las tareas");
    }
    let issues = match jira_issues(&list, 60) {
        Ok(i) => i,
        Err(_) => return error_res(502, "No se pudo consultar Jira"),
    };
    let routes = load_routes();
    let mut skipped: Vec<Value> = Vec::new();
    let imported = mutate(|d| {
        let mut n = 0;
        let at = now();
        for i in &issues {
            let x = summarize_issue(i, d, &routes);
            let key_value = x.get("key").cloned().unwrap_or(Value::Null);
            if is_true(&x, "onBoard") {
                skipped.push(json!({ "key": key_value, "reason": "ya estaba en el tablero" }));
                continue;
            }
            if !is_true(&x, "available") {
                skipped.push(json!({ "key": key_value, "reason": format!("la lleva {}", js_string(x.get("assignee"))) }));
                continue;
            }
            let key = js_string(x.get("key"));
            let rejected = is_true(&x, "rejected");
            let note = format!(
                "Traída de Jira a mano. Estado en Jira: {}{}",
                js_string(x.get("status")),
                if rejected { format!(", con etiqueta {}.", js_string(Some(&sites::statuses(Some(&sites::for_key(&key))).reject_label))) } else { ".".to_string() }
            );
            let mut t = Map::new();
            t.insert("key".into(), key_value);
            if let Some(v) = x.get("title") {
                t.insert("title".into(), v.clone());
            }
            t.insert("kind".into(), json!(if rejected && is_true(&x, "assignee") { "returned" } else { "new" }));
            for name in ["epicKey", "epicName", "assignee"] {
                if let Some(v) = x.get(name) {
                    t.insert(name.into(), v.clone());
                }
            }
            t.insert("note".into(), json!(note));
            t.insert("noteBy".into(), json!("Tablero"));
            t.insert("at".into(), json!(at));
            if let Some(v) = x.get("area") {
                t.insert("proposedArea".into(), v.clone());
            }
            t.insert("status".into(), json!("pending"));
            tasks_mut(d).insert(key, Value::Object(t));
            n += 1;
        }
        n
    });
    send(200, &json!({ "imported": imported, "skipped": skipped }))
}

pub fn handle_restriction(input: &Value) -> Res {
    let areas: Vec<String> = load_routes().get("areas").and_then(Value::as_object).map(|a| a.keys().cloned().collect()).unwrap_or_default();
    let r = mutate(|d| {
        if str_of(input, "action") == "release" {
            holds::release_restriction(d, &text_or_empty(input.get("id")), Some("board"), None)
        } else {
            let mut with_by = input.as_object().cloned().unwrap_or_default();
            with_by.insert("createdBy".into(), json!("board"));
            holds::add_restriction(d, &Value::Object(with_by), holds::AddOptions { areas: Some(areas.clone()), now_ms: None })
        }
    });
    match r {
        Ok(v) => {
            crate::features::mailman::kick();
            send(200, &v)
        }
        Err(error) => error_res(400, &error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_string_prints_values_like_string_in_js() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&json!(null))), "null");
        assert_eq!(js_string(Some(&json!(3))), "3");
        assert_eq!(js_string(Some(&json!(["a", null, 2]))), "a,,2");
        assert_eq!(js_string(Some(&json!({}))), "[object Object]");
        assert_eq!(text_or_empty(Some(&json!(0))), "");
    }

    #[test]
    fn adf_text_flattens_paragraphs_lists_and_mentions() {
        let doc = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": " Hola " }, { "type": "mention", "attrs": { "text": "@Ana" } }] },
            { "type": "bulletList", "content": [{ "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "uno" }] }] }] }
        ] });
        assert_eq!(adf_text(Some(&doc)), "Hola @Ana\n\n- uno\n\n");
    }

    #[test]
    fn bad_input_is_refused_before_touching_the_board() {
        assert_eq!(handle_task(&json!({ "key": "WEB-1", "patch": { "status": "done" } })).body_text(), r#"{"error":"estado no permitido"}"#);
        assert_eq!(handle_batch(&json!({ "items": [] })).code, 400);
        assert_eq!(handle_delete(&json!({})).body_text(), r#"{"error":"faltan las tareas"}"#);
        assert_eq!(handle_answer(&json!({ "key": "WEB-1", "text": "  " })).body_text(), r#"{"error":"escribe la respuesta"}"#);
        assert_eq!(handle_comment(&json!({ "key": "WEB-1" })).body_text(), r#"{"error":"el comentario está vacío"}"#);
        assert_eq!(handle_ticket(&json!({ "key": "web 1" })).body_text(), r#"{"error":"clave no válida"}"#);
        assert_eq!(handle_import(&json!({ "keys": ["nope"] })).code, 400);
    }

    #[test]
    fn deleting_finished_tasks_keeps_pending_ones_and_logs_the_sent_ones() {
        let _guard = crate::testkit::fresh();
        mutate(|d| {
            d.insert("tasks".into(), json!({ "WEB-1": { "key": "WEB-1", "title": "a", "status": "sent", "sentAt": "2026-11-01T10:00:00.000Z" }, "WEB-2": { "key": "WEB-2", "title": "b", "status": "pending" } }));
            d.insert("deleted".into(), json!({ "OLD-1": "2000-01-01T00:00:00.000Z" }));
        });
        let r = handle_delete(&json!({ "keys": ["WEB-1", "WEB-2"] }));
        assert_eq!(r.body_text(), r#"{"deleted":1}"#);
        let d = load();
        assert!(d["tasks"].get("WEB-1").is_none());
        assert!(d["tasks"].get("WEB-2").is_some());
        assert!(d["deleted"].get("WEB-1").is_some());
        assert!(d["deleted"].get("OLD-1").is_none());
        let history = std::fs::read_to_string(DATA_DIR.join("task-history.jsonl")).unwrap();
        assert!(history.starts_with(r#"{"key":"WEB-1","title":"a","epicName":null,"kind":null,"status":"sent","sentAt":"2026-11-01T10:00:00.000Z","area":null,"removedAt":""#));
    }

    #[test]
    fn a_refresh_request_is_reused_until_it_is_handled() {
        let _guard = crate::testkit::fresh();
        let first = handle_refresh().json().unwrap();
        assert_eq!(handle_refresh().json().unwrap(), first);
        mutate(|d| d["refreshRequest"]["handled"] = json!(true));
        assert_eq!(handle_refresh().json().unwrap()["handled"], json!(false));
    }
}

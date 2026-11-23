//! Port of src/features/yolo.js.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::core::config;
use crate::core::data::{DATA_DIR, Doc, load, mutate, now};
use crate::core::json::truthy;
use crate::core::time::now_ms;
use crate::sessions::registry::{load_routes, title_key};

const RETRY_MS: i64 = 5 * 60000;

pub type CreateFn = Arc<dyn Fn(&str, &Value) -> Result<(u16, Value), String> + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Area(String),
    Create(String),
}

static FAILED: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CREATING: LazyLock<Mutex<Option<JoinHandle<()>>>> = LazyLock::new(|| Mutex::new(None));
static CREATE: LazyLock<Mutex<Option<CreateFn>>> = LazyLock::new(|| Mutex::new(None));
static KICK_GENERATION: AtomicU64 = AtomicU64::new(0);

fn log(line: &str) {
    crate::core::logfile::append_log(&DATA_DIR.join("yolo.log"), &format!("{} {line}\n", now()));
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(x) if truthy(Some(x)) => x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x)),
        _ => String::new(),
    }
}

fn slice_units(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n { s.to_string() } else { String::from_utf16_lossy(&units[..n]) }
}

fn on(d: &Doc) -> bool {
    truthy(d.get("config").and_then(|c| c.get("yolo")))
}

fn main_id() -> String {
    config::main_project().id.clone()
}

fn project_of(t: &Value) -> String {
    let p = str_of(t.get("project"));
    if p.is_empty() { main_id() } else { p }
}

fn area_project(a: &Value) -> String {
    project_of(a)
}

fn failed_recently(key: &str) -> bool {
    FAILED.lock().unwrap_or_else(|p| p.into_inner()).get(key).is_some_and(|at| now_ms() - at < RETRY_MS)
}

fn mark_failed(key: &str) {
    FAILED.lock().unwrap_or_else(|p| p.into_inner()).insert(key.to_string(), now_ms());
}

pub fn session_name(t: &Value, areas: &Value) -> String {
    let raw = [t.get("epicName"), t.get("title"), t.get("key")].into_iter().find(|v| truthy(*v)).map(|v| str_of(v)).unwrap_or_else(|| "undefined".into());
    let base = slice_units(raw.trim(), 60);
    let project = project_of(t);
    let clash = areas.as_object().is_some_and(|o| o.values().any(|a| title_key(&str_of(a.get("title"))) == title_key(&base) && area_project(a) != project));
    if !clash {
        return base;
    }
    let label = config::project(&project).map(|p| p.name).filter(|n| !n.is_empty()).unwrap_or_else(|| project.clone());
    slice_units(&format!("{base} ({label})"), 60)
}

pub fn target_of(t: &Value, routes: &Value) -> Target {
    let empty = json!({});
    let areas = routes.get("areas").filter(|v| truthy(Some(v))).unwrap_or(&empty);
    for id in [text(t, "area"), text(t, "proposedArea")] {
        if !id.is_empty() && truthy(areas.get(id)) {
            return Target::Area(id.to_string());
        }
    }
    let epic = text(t, "epicKey");
    if let Some(o) = areas.as_object() {
        if !epic.is_empty() {
            if let Some((id, _)) = o.iter().find(|(_, a)| truthy(a.get("epics").and_then(|e| e.get(epic)))) {
                return Target::Area(id.clone());
            }
        }
    }
    let name = session_name(t, areas);
    let project = project_of(t);
    if let Some(o) = areas.as_object() {
        if let Some((id, _)) = o.iter().find(|(_, a)| title_key(&str_of(a.get("title"))) == title_key(&name) && area_project(a) == project) {
            return Target::Area(id.clone());
        }
    }
    Target::Create(name)
}

fn create_session(name: &str, t: &Value) -> Result<(u16, Value), String> {
    let mut body = Map::new();
    body.insert("title".into(), Value::from(name));
    for k in ["epicKey", "epicName"] {
        if truthy(t.get(k)) {
            body.insert(k.into(), t[k].clone());
        }
    }
    let project = project_of(t);
    if !project.is_empty() {
        body.insert("project".into(), Value::from(project));
    }
    let res = crate::server::routes::sessions::handle_new_session(&Value::Object(body));
    Ok((res.code, res.json().unwrap_or(json!({}))))
}

fn send_errors() -> usize {
    let Some(area) = config::main_project().errors_area.clone().filter(|a| !a.is_empty()) else { return 0 };
    let ids: Vec<String> = mutate(|x| {
        if !crate::features::holds::check_area(x, "La sesión de errores", &area, None).is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        if let Some(reports) = x.get_mut("followUps").and_then(Value::as_array_mut) {
            for r in reports {
                if let Some(errors) = r.get_mut("errors").and_then(Value::as_array_mut) {
                    for e in errors {
                        if text(e, "state") != "proposed" {
                            continue;
                        }
                        let o = e.as_object_mut().unwrap();
                        o.insert("state".into(), Value::from("approved"));
                        o.insert("approvedVia".into(), Value::from("yolo"));
                        o.insert("decidedAt".into(), Value::from(now()));
                        out.push(str_of(o.get("id")));
                    }
                }
            }
        }
        out
    });
    if ids.is_empty() {
        return 0;
    }
    for id in &ids {
        log(&format!("{id} -> {area} (posible error del seguimiento)"));
    }
    crate::server::state::open_if_closed(&area, None);
    crate::features::mailman::kick();
    ids.len()
}

fn creating_now() -> bool {
    CREATING.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|h| !h.is_finished())
}

pub fn tick() {
    if !crate::cluster::cluster::primary_now() {
        return;
    }
    let d = load();
    if !on(&d) {
        return;
    }
    let proposed = d.get("followUps").and_then(Value::as_array).is_some_and(|a| a.iter().any(|r| r.get("errors").and_then(Value::as_array).is_some_and(|e| e.iter().any(|e| text(e, "state") == "proposed"))));
    if proposed {
        send_errors();
    }
    let pending: Vec<Value> = d
        .get("tasks")
        .and_then(Value::as_object)
        .map(|o| o.values().filter(|x| text(x, "status") == "pending" && !truthy(x.get("withdrawn")) && !failed_recently(text(x, "key"))).cloned().collect())
        .unwrap_or_default();
    if pending.is_empty() {
        return;
    }
    let routes = load_routes();
    let mut pairs = Vec::new();
    let mut to_create: Option<(String, Value)> = None;
    for t in &pending {
        match target_of(t, &routes) {
            Target::Area(area) => pairs.push(json!({ "key": t["key"], "area": area })),
            Target::Create(name) => {
                if to_create.is_none() {
                    to_create = Some((name, t.clone()));
                }
            }
        }
    }
    if !pairs.is_empty() {
        let r = crate::server::routes::tasks::approve_many(&Value::Array(pairs), "yolo");
        for x in r.get("approved").and_then(Value::as_array).cloned().unwrap_or_default() {
            log(&format!("{} -> {}", str_of(x.get("key")), str_of(x.get("area"))));
        }
        for x in r.get("held").and_then(Value::as_array).cloned().unwrap_or_default() {
            mark_failed(text(&x, "key"));
            log(&format!("{}: retenida ({})", str_of(x.get("key")), str_of(x.get("error"))));
        }
    }
    if let Some((name, task)) = to_create {
        let mut slot = CREATING.lock().unwrap_or_else(|p| p.into_inner());
        if slot.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let key = str_of(task.get("key"));
        log(&format!("{key}: sin sesión, se crea «{name}»"));
        let create = CREATE.lock().unwrap_or_else(|p| p.into_inner()).clone();
        *slot = Some(std::thread::spawn(move || {
            let outcome = match &create {
                Some(f) => f(&name, &task),
                None => create_session(&name, &task),
            };
            match outcome {
                Ok((200, body)) => {
                    let area = match body.get("area") {
                        None => "undefined".to_string(),
                        Some(Value::String(s)) => s.clone(),
                        Some(other) => crate::core::json::stringify(other),
                    };
                    log(&format!("«{name}» creada ({area})"));
                    kick();
                }
                Ok((409, _)) => {}
                Ok((code, body)) => {
                    mark_failed(&key);
                    let why = if truthy(body.get("error")) { str_of(body.get("error")) } else { code.to_string() };
                    log(&format!("{key}: no se pudo crear «{name}» ({why})"));
                }
                Err(e) => {
                    mark_failed(&key);
                    log(&format!("{key}: no se pudo crear «{name}» ({e})"));
                }
            }
        }));
    }
}

pub fn kick() {
    let generation = KICK_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        if KICK_GENERATION.load(Ordering::SeqCst) == generation {
            let _ = std::panic::catch_unwind(tick);
        }
    });
}

pub mod test_hooks {
    use super::*;

    pub fn reset() {
        FAILED.lock().unwrap_or_else(|p| p.into_inner()).clear();
        *CREATING.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *CREATE.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    pub fn set_create(create: Option<CreateFn>) {
        *CREATE.lock().unwrap_or_else(|p| p.into_inner()) = create;
    }

    pub fn idle() {
        let handle = CREATING.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(h) = handle {
            let _ = h.join();
        }
    }

    pub fn creating() -> bool {
        creating_now()
    }
}

//! Port of src/features/follow-up.js.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::core::data::{Doc, mutate, now};
use crate::core::json::truthy;
use crate::server::http::{Res, send};

pub const ENVIRONMENTS: [&str; 2] = ["beta", "production"];

static CONFIG_FILE: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::workspace().join("board.config.json"));
static SEPARATORS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s,;]+").unwrap());

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(x) if truthy(Some(x)) => x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x)),
        _ => String::new(),
    }
}

fn read_settings() -> Value {
    let read = || -> Option<Value> {
        let c: Value = serde_json::from_str(&std::fs::read_to_string(&*CONFIG_FILE).ok()?).ok()?;
        if let Some(projects) = c.get("projects").and_then(Value::as_array) {
            let main = crate::core::config::main_project().id.clone();
            return Some(projects.iter().find(|p| text(p, "id") == main).and_then(|p| p.get("followUp")).cloned().unwrap_or(Value::Null));
        }
        Some(c.get("followUp").cloned().unwrap_or(Value::Null))
    };
    read().unwrap_or_else(|| Value::Array(crate::core::config::main_project().follow_up.clone()))
}

struct Settings {
    people: Vec<Value>,
    beta: f64,
    production: f64,
}

fn settings() -> Settings {
    let raw = read_settings();
    let people = match &raw {
        Value::Array(a) => a.clone(),
        Value::Object(o) => o.get("people").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    let every = raw.get("everyHours").filter(|_| !raw.is_array()).cloned().unwrap_or(json!({}));
    let number = |k: &str, fallback: f64| {
        let n = match every.get(k) {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
            Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(if s.trim().is_empty() { 0.0 } else { f64::NAN }),
            Some(Value::Bool(b)) => *b as i64 as f64,
            _ => 0.0,
        };
        if n == 0.0 || n.is_nan() { fallback } else { n }
    };
    Settings { people, beta: number("beta", 1.0), production: number("production", 2.0) }
}

fn production_people(d: &Doc) -> HashSet<String> {
    people_list(d).iter().filter(|p| text(p, "environment") == "production").map(|p| text(p, "id").to_string()).collect()
}

fn environment_with(summary: &Value, production: &dyn Fn() -> HashSet<String>) -> String {
    let env = text(summary, "environment");
    if ENVIRONMENTS.contains(&env) {
        return env.to_string();
    }
    if !truthy(summary.get("person")) {
        return "beta".into();
    }
    if production().contains(text(summary, "person")) { "production".into() } else { "beta".into() }
}

pub fn environment_name(id: &str) -> String {
    match id {
        "beta" => "beta".into(),
        "production" => "producción".into(),
        other => other.to_string(),
    }
}

pub fn environment_of(summary: &Value, d: &Doc) -> String {
    environment_with(summary, &|| production_people(d))
}

fn last_of(d: &Doc, environment: &str, scheduled_only: bool, production: &dyn Fn() -> HashSet<String>) -> Value {
    d.get("followUps")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|r| environment_with(r, production) == environment && !(scheduled_only && truthy(r.get("manual")))))
        .and_then(|r| r.get("at"))
        .filter(|v| truthy(Some(v)))
        .cloned()
        .unwrap_or(Value::Null)
}

pub fn environments(d: &Doc) -> Value {
    let s = settings();
    let cache = std::cell::OnceCell::new();
    let production = || cache.get_or_init(|| production_people(d)).clone();
    Value::Array(
        ENVIRONMENTS
            .iter()
            .map(|id| {
                let every = if *id == "beta" { s.beta } else { s.production };
                json!({
                    "id": id,
                    "name": environment_name(id),
                    "everyHours": crate::core::json::num(every),
                    "cron": crate::features::followup_schedule::cron_of(id, every),
                    "last": last_of(d, id, false, &production),
                    "lastScheduled": last_of(d, id, true, &production),
                })
            })
            .collect(),
    )
}

fn with_config_people(stored: Option<&Value>, removed: Option<&Value>) -> Vec<Value> {
    let stored_array = stored.and_then(Value::as_array);
    let mut list: Vec<Value> = stored_array.cloned().unwrap_or_default();
    let removed: Vec<String> = removed.and_then(Value::as_array).map(|a| a.iter().map(|x| str_of(Some(x))).collect()).unwrap_or_default();
    for p in settings().people {
        let id = p.get("id").cloned().unwrap_or(Value::Null);
        if !truthy(Some(&id)) || list.iter().any(|x| x.get("id") == Some(&id)) || (stored_array.is_some() && removed.contains(&str_of(Some(&id)))) {
            continue;
        }
        let mut o = Map::new();
        o.insert("id".into(), id);
        for k in ["name", "environment"] {
            if let Some(v) = p.get(k) {
                o.insert(k.into(), v.clone());
            }
        }
        o.insert("accounts".into(), p.get("accounts").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!([])));
        list.push(Value::Object(o));
    }
    list
}

fn people_list(d: &Doc) -> Vec<Value> {
    let fu = d.get("followUp");
    with_config_people(fu.and_then(|f| f.get("people")), fu.and_then(|f| f.get("removed")))
        .into_iter()
        .map(|mut p| {
            if let Some(o) = p.as_object_mut() {
                o.shift_remove("hourly");
            }
            p
        })
        .collect()
}

pub fn people(d: &Doc) -> Value {
    Value::Array(people_list(d))
}

fn change_people<R>(f: impl FnOnce(&mut Map<String, Value>) -> R) -> R {
    mutate(|d| {
        if !d.get("followUp").is_some_and(|v| truthy(Some(v))) {
            d.insert("followUp".into(), json!({}));
        }
        let fu = d.get_mut("followUp").unwrap();
        if !fu.is_object() {
            *fu = json!({});
        }
        let fu = fu.as_object_mut().unwrap();
        let list = with_config_people(fu.get("people"), fu.get("removed"));
        fu.insert("people".into(), Value::Array(list));
        f(fu)
    })
}

fn clean_accounts(xs: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in xs.iter().map(|x| x.trim().to_string()).filter(|x| x.contains('@')) {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

fn add_person(fu: &mut Map<String, Value>, name: &str, accounts: &[String]) -> Result<Value, String> {
    let units: Vec<u16> = name.trim().encode_utf16().collect();
    let clean = String::from_utf16_lossy(&units[..units.len().min(80)]);
    if clean.is_empty() {
        return Err("escribe el nombre o el correo".into());
    }
    let slug = crate::core::config::slug(&clean);
    let id = if slug.is_empty() { format!("person-{}", crate::core::time::now_ms()) } else { slug };
    let list = fu.get_mut("people").and_then(Value::as_array_mut).unwrap();
    let idx = match list.iter().position(|x| text(x, "id") == id) {
        Some(i) => i,
        None => {
            list.push(json!({ "id": id, "name": clean, "accounts": [] }));
            list.len() - 1
        }
    };
    let mut wanted: Vec<String> = accounts.to_vec();
    if clean.contains('@') {
        wanted.push(clean.clone());
    }
    let more = clean_accounts(&wanted);
    let p = &mut list[idx];
    if !more.is_empty() {
        let mut all: Vec<String> = p.get("accounts").and_then(Value::as_array).map(|a| a.iter().map(|x| str_of(Some(x))).collect()).unwrap_or_default();
        all.extend(more);
        p["accounts"] = json!(clean_accounts(&all));
        p["accountsAt"] = Value::from(now());
    }
    let person = p.clone();
    let removed: Vec<Value> = fu.get("removed").and_then(Value::as_array).map(|a| a.iter().filter(|x| x.as_str() != Some(id.as_str())).cloned().collect()).unwrap_or_default();
    fu.insert("removed".into(), Value::Array(removed));
    Ok(json!({ "person": person }))
}

pub fn handle_people(input: &Value) -> Res {
    let action = text(input, "action").to_string();
    let error = change_people(|fu| {
        if action == "add" {
            let accounts: Vec<String> = SEPARATORS.split(&str_of(input.get("accounts"))).map(str::to_string).collect();
            return add_person(fu, &str_of(input.get("name")), &accounts).err().unwrap_or_default();
        }
        let id = input.get("id").cloned().unwrap_or(Value::Null);
        let list = fu.get_mut("people").and_then(Value::as_array_mut).unwrap();
        let Some(i) = list.iter().position(|x| x.get("id") == Some(&id) && !id.is_null()) else { return "persona desconocida".to_string() };
        if action != "remove" {
            return "acción desconocida".to_string();
        }
        let p = list.remove(i);
        let mut removed: Vec<Value> = fu.get("removed").and_then(Value::as_array).cloned().unwrap_or_default();
        let pid = p.get("id").cloned().unwrap_or(Value::Null);
        if !removed.contains(&pid) {
            removed.push(pid);
        }
        fu.insert("removed".into(), Value::Array(removed));
        String::new()
    });
    if error.is_empty() { send(200, &Value::Null) } else { send(400, &json!({ "error": error })) }
}

pub fn register_person(name: &str, accounts: &[String]) -> Result<Value, String> {
    change_people(|fu| add_person(fu, name, accounts))
}

pub fn save_accounts(id: &str, accounts: &[String]) -> bool {
    change_people(|fu| {
        let list = fu.get_mut("people").and_then(Value::as_array_mut).unwrap();
        let Some(p) = list.iter_mut().find(|x| text(x, "id") == id) else { return false };
        p["accounts"] = json!(clean_accounts(accounts));
        p["accountsAt"] = Value::from(now());
        true
    })
}

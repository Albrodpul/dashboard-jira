//! Port of src/features/manual-tasks.js.

use serde_json::{Value, json};

use crate::core::config::{self, Project};
use crate::core::data::{Doc, now};
use crate::core::json::truthy;

fn slice_units(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n { s.to_string() } else { String::from_utf16_lossy(&units[..n]) }
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(x) if truthy(Some(x)) => x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x)),
        _ => String::new(),
    }
}

pub fn is_manual(t: &Value) -> bool {
    t.get("source").and_then(Value::as_str) == Some("manual")
}

pub fn prefix_of(project: &Project) -> String {
    let raw = if truthy(Some(&project.task_prefix)) { str_of(Some(&project.task_prefix)) } else { project.id.clone() };
    let letters: String = raw.to_uppercase().chars().filter(|c| c.is_ascii_uppercase()).take(10).collect();
    let base = if letters.is_empty() { "TAREA".to_string() } else { letters };
    let jira_keys: Vec<String> = config::projects().iter().flat_map(|p| p.jira.as_ref().map(|j| j.projects.clone()).unwrap_or_default()).collect();
    if jira_keys.contains(&base) { format!("{base}L") } else { base }
}

pub fn next_key(d: &Doc, prefix: &str) -> String {
    let re = regex::Regex::new(&format!("^{}-([0-9]+)$", regex::escape(prefix))).unwrap();
    let mut n: u64 = 0;
    for key in ["tasks", "deleted"] {
        if let Some(o) = d.get(key).and_then(Value::as_object) {
            for k in o.keys() {
                if let Some(m) = re.captures(k) {
                    n = n.max(m[1].parse().unwrap_or(0));
                }
            }
        }
    }
    format!("{prefix}-{}", n + 1)
}

pub fn create_task(d: &mut Doc, input: &Value) -> Result<String, String> {
    let wanted = str_of(input.get("project"));
    let id = if wanted.is_empty() { config::main_project().id.clone() } else { wanted.clone() };
    let Some(p) = config::project(&id) else { return Err(format!("proyecto desconocido: {}", if input.get("project").is_none() { "undefined".to_string() } else { wanted })) };
    let clean = slice_units(str_of(input.get("title")).trim(), 200);
    if clean.is_empty() {
        return Err("falta el título".into());
    }
    let key = next_key(d, &prefix_of(&p));
    let description = slice_units(str_of(input.get("description")).trim(), 6000);
    let task = json!({ "key": key, "title": clean, "description": description, "project": p.id, "source": "manual", "kind": "new", "status": "pending", "at": now(), "events": [] });
    if !d.get("tasks").is_some_and(Value::is_object) {
        d.insert("tasks".into(), json!({}));
    }
    d.get_mut("tasks").unwrap().as_object_mut().unwrap().insert(key.clone(), task);
    Ok(key)
}

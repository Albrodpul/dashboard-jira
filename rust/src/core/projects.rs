use crate::core::config::{self, Project};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn real(p: &Path) -> PathBuf {
    let mut head = p.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    for _ in 0..64 {
        if let Ok(r) = std::fs::canonicalize(&head) {
            let mut out = r;
            for t in &tail {
                out.push(t);
            }
            return out;
        }
        let Some(up) = head.parent().map(Path::to_path_buf) else { return p.to_path_buf() };
        if up == head || head.file_name().is_none() {
            return p.to_path_buf();
        }
        tail.insert(0, head.file_name().unwrap().to_os_string());
        head = up;
    }
    p.to_path_buf()
}

fn norm(p: &str) -> String {
    let abs = config::normalize(&std::env::current_dir().unwrap_or_default().join(p));
    let s = real(&abs).to_string_lossy().replace('\\', "/");
    s.trim_end_matches('/').to_lowercase()
}

pub fn main_id() -> String {
    config::main_project().id.clone()
}

pub fn project_of_path(dir: Option<&str>) -> Option<Project> {
    let Some(dir) = dir.filter(|d| !d.is_empty()) else { return Some(config::main_project().clone()) };
    let d = norm(dir);
    let mut best: Option<(Project, usize)> = None;
    for p in config::projects() {
        let Some(root) = &p.root else { continue };
        let r = norm(&root.to_string_lossy());
        if (d == r || d.starts_with(&format!("{r}/"))) && best.as_ref().map_or(true, |(_, len)| r.len() > *len) {
            let len = r.len();
            best = Some((p, len));
        }
    }
    best.map(|(p, _)| p)
}

pub fn project_of_key(key: &str) -> Option<String> {
    let prefix = key.split('-').next().unwrap_or("");
    if prefix.is_empty() {
        return None;
    }
    let all = config::projects();
    if let Some(p) = all.iter().find(|x| x.jira.as_ref().map_or(false, |j| j.projects.iter().any(|k| k == prefix))) {
        return Some(p.id.clone());
    }
    all.iter().find(|x| crate::features::manual_tasks::prefix_of(x) == prefix).map(|p| p.id.clone())
}

pub fn project_of(record: &Value) -> String {
    if let Some(p) = record.get("project").filter(|v| crate::core::json::truthy(Some(v))).and_then(Value::as_str) {
        return p.to_string();
    }
    let key = match record.get("key") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => crate::core::json::stringify(other),
    };
    project_of_key(&key).unwrap_or_else(main_id)
}

pub fn area_project(area: Option<&str>, routes: Option<&Value>) -> Option<String> {
    let area = area.filter(|a| !a.is_empty())?;
    let loaded;
    let r = match routes {
        Some(r) => r,
        None => {
            loaded = crate::core::data::read_json(&crate::core::data::ROUTES_FILE, serde_json::json!({}));
            &loaded
        }
    };
    let a = r.get("areas").and_then(|a| a.get(area));
    Some(a.and_then(|a| a.get("project")).filter(|v| crate::core::json::truthy(Some(v))).and_then(Value::as_str).map(str::to_string).unwrap_or_else(main_id))
}

pub fn cross_project(record: &Value, area: Option<&str>, routes: Option<&Value>) -> String {
    let Some(area) = area.filter(|a| !a.is_empty()) else { return String::new() };
    let from = project_of(record);
    let to = area_project(Some(area), routes).unwrap_or_default();
    if from == to {
        return String::new();
    }
    let name = |id: &str| config::project(id).map(|p| p.name).unwrap_or_else(|| id.to_string());
    let label = [record.get("key"), record.get("id")].into_iter().flatten().find(|v| crate::core::json::truthy(Some(v))).map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(v))).unwrap_or_else(|| "esto".to_string());
    format!("{label} es de {} y la sesión {area} es de {}: entre proyectos no se envía nada.", name(&from), name(&to))
}

pub fn project_of_folder(folder: Option<&str>) -> Option<Project> {
    let folder = folder.filter(|f| !f.is_empty())?;
    config::projects().into_iter().find(|p| p.root.as_ref().map_or(false, |r| crate::agents::index::agent_for(Some(p)).transcript_folder(&r.to_string_lossy()) == folder))
}

pub fn project_of_conversation(id: &str) -> Option<Project> {
    project_of_folder(crate::agents::index::main().folder_of_conversation(id).as_deref())
}

pub fn role_route(routes: Option<&Value>, role: &str, project_id: Option<&str>) -> Option<Value> {
    let routes = routes?;
    let pick = |v: Option<&Value>| v.filter(|x| crate::core::json::truthy(Some(x))).cloned();
    match project_id.filter(|p| !p.is_empty()) {
        Some(pid) if pid != main_id() && role != "board" => pick(routes.get("projectRoles").and_then(|r| r.get(pid)).and_then(|r| r.get(role))),
        _ => pick(routes.get(role)),
    }
}

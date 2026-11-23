use crate::core::config::{self, Project, Statuses};
use base64::Engine;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub static NO_REVIEWER: LazyLock<Value> = LazyLock::new(|| json!({ "id": null, "name": "", "mentions": [] }));

#[derive(Clone, Copy)]
pub enum ProjectRef<'a> {
    Main,
    Id(&'a str),
    Of(&'a Project),
}

pub struct Auth {
    pub site: String,
    pub base: String,
    pub auth: String,
}

fn usable(p: &Project) -> bool {
    let Some(j) = &p.jira else { return false };
    if !crate::core::json::truthy(j.me.get("id")) {
        return false;
    }
    p.credentials().is_ok()
}

fn main_clone() -> Project {
    config::main_project().clone()
}

fn resolve(p: Option<&Project>) -> Project {
    p.cloned().unwrap_or_else(main_clone)
}

pub fn jira_projects() -> Vec<Project> {
    let main = config::main_project().id.clone();
    config::projects().into_iter().filter(|p| p.id == main || usable(p)).collect()
}

pub fn for_key(key: &str) -> Project {
    let prefix = key.split('-').next().unwrap_or("").to_uppercase();
    if prefix.is_empty() {
        return main_clone();
    }
    config::projects().into_iter().find(|p| p.jira.as_ref().map_or(false, |j| j.projects.iter().any(|k| *k == prefix))).unwrap_or_else(main_clone)
}

pub fn project_of(p: ProjectRef) -> Project {
    match p {
        ProjectRef::Main => main_clone(),
        ProjectRef::Id(id) => config::project(id).unwrap_or_else(main_clone),
        ProjectRef::Of(p) => p.clone(),
    }
}

pub fn auth(p: Option<&Project>) -> Result<Auth, String> {
    let k = resolve(p).credentials()?;
    let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", k.email, k.token));
    Ok(Auth { base: format!("https://{}/rest/api/3", k.site), site: k.site, auth: format!("Basic {token}") })
}

fn main_me() -> Value {
    config::main_project().jira.as_ref().map(|j| j.me.clone()).unwrap_or(Value::Null)
}

pub fn me(p: Option<&Project>) -> Value {
    match resolve(p).jira.as_ref().map(|j| j.me.clone()) {
        Some(m) if crate::core::json::truthy(Some(&m)) => m,
        _ => main_me(),
    }
}

pub fn reviewer(p: Option<&Project>) -> Value {
    match resolve(p).jira.as_ref().map(|j| j.reviewer.clone()) {
        Some(r) if crate::core::json::truthy(Some(&r)) => r,
        _ => NO_REVIEWER.clone(),
    }
}

pub fn statuses(p: Option<&Project>) -> Statuses {
    resolve(p).statuses.clone().or_else(|| config::main_project().statuses.clone()).expect("statuses")
}

pub fn site_of(p: Option<&Project>) -> String {
    resolve(p).secret("JIRA_SITE").unwrap_or_default()
}

pub fn by_project(keys: &[String]) -> Vec<(Project, Vec<String>)> {
    let mut groups: Vec<(Project, Vec<String>)> = Vec::new();
    for k in keys {
        let p = for_key(k);
        match groups.iter_mut().find(|(g, _)| g.id == p.id) {
            Some((_, list)) => list.push(k.clone()),
            None => groups.push((p, vec![k.clone()])),
        }
    }
    groups
}

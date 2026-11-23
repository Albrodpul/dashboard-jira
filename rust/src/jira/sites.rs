use crate::core::config::{Project, Statuses};
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

pub fn jira_projects() -> Vec<Project> {
    todo!()
}

pub fn for_key(key: &str) -> Project {
    todo!()
}

pub fn project_of(p: ProjectRef) -> Project {
    todo!()
}

pub fn auth(p: Option<&Project>) -> Result<Auth, String> {
    todo!()
}

pub fn me(p: Option<&Project>) -> Value {
    todo!()
}

pub fn reviewer(p: Option<&Project>) -> Value {
    todo!()
}

pub fn statuses(p: Option<&Project>) -> Statuses {
    todo!()
}

pub fn site_of(p: Option<&Project>) -> String {
    todo!()
}

pub fn by_project(keys: &[String]) -> Vec<(Project, Vec<String>)> {
    todo!()
}

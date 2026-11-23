use crate::core::config::Project;
use crate::core::data::Doc;
use crate::jira::sites::Auth;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

pub static ME: LazyLock<String> = LazyLock::new(|| crate::core::config::main_project().jira.as_ref().and_then(|j| j.me.get("id")).and_then(Value::as_str).unwrap_or_default().to_string());
pub static ATTACHMENTS_DIR: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::main_project().root.clone().unwrap_or_default().join(".attachments"));

pub fn jira_auth(p: Option<&Project>) -> Result<Auth, String> {
    todo!()
}

pub fn jira_get(route: &str, p: Option<&Project>) -> Result<Value, String> {
    todo!()
}

pub fn jira_request(method: &str, route: &str, body: Option<&Value>, p: Option<&Project>) -> Result<Value, String> {
    todo!()
}

pub fn sync_jira_epics() -> Result<usize, String> {
    todo!()
}

pub fn jira_search(jql: &str, max: usize, p: Option<&Project>) -> Result<Vec<Value>, String> {
    todo!()
}

pub fn jira_search_all(jql_of: &(dyn Fn(&Project) -> String + Sync), max: usize) -> Result<Vec<Value>, String> {
    todo!()
}

pub fn jira_issues(keys: &[String], max: usize) -> Result<Vec<Value>, String> {
    todo!()
}

pub fn refresh_attachments() -> Result<(), String> {
    todo!()
}

pub fn download_attachments(key: &str) -> Result<Value, String> {
    todo!()
}

pub fn summarize_issue(i: &Value, d: &Doc, routes: &Value) -> Value {
    todo!()
}

pub fn adf_from_text(text: &str, p: Option<&Project>) -> Value {
    todo!()
}

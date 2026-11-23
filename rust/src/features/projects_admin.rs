//! Port of src/features/projects-admin.js.
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub const SECRETS: [&str; 4] = ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"];
const OPEN: [&str; 5] = ["pending", "approved", "sent", "waiting", "partial"];
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,39}$").unwrap());
static PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]{2,10}$").unwrap());
static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_.-]{0,63}$").unwrap());

pub type JiraAsk<'a> = &'a dyn Fn(&str) -> Result<Value, String>;

pub fn list() -> Value {
    todo!()
}

pub fn save(input: &Value) -> Value {
    todo!()
}

pub fn remove(id: &str) -> Value {
    todo!()
}

pub fn set_credentials(id: &str, values: &Value) -> Value {
    todo!()
}

pub fn connect_jira(id: &str, options: &Value, ask: Option<JiraAsk>) -> Value {
    todo!()
}

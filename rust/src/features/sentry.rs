//! Port of src/features/sentry.js.
use crate::core::config::Project;
use crate::core::data::Doc;
use serde_json::Value;
use std::sync::{LazyLock, Mutex};

const API: &str = "https://sentry.io/api/0";
const CACHE_MS: i64 = 60 * 1000;
const STATUSES: [&str; 2] = ["resolved", "ignored"];

struct Cache {
    at: i64,
    value: Value,
}

static CACHE: LazyLock<Mutex<Option<Cache>>> = LazyLock::new(|| Mutex::new(None));

pub fn errors_areas() -> Value {
    todo!()
}

pub fn sources() -> Vec<Project> {
    todo!()
}

pub fn sentry_available() -> bool {
    todo!()
}

pub fn list_issues(force: bool) -> Value {
    todo!()
}

pub fn sentry_issues(d: &Doc) -> Value {
    todo!()
}

pub fn send_issues(list: &Value, area: &str) -> usize {
    todo!()
}

pub fn mark_sent(ids: &[String]) -> usize {
    todo!()
}

pub fn save_result(ids: &[String], text: &str) -> usize {
    todo!()
}

pub fn discard(id: &str) -> bool {
    todo!()
}

pub fn set_status(issue_id: &Value, id: &str, status: &str, owner: Option<&str>) -> Result<(), String> {
    todo!()
}

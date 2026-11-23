//! Port of src/features/holds.js.

use serde_json::Value;

use crate::core::data::Doc;

pub const MODES: [&str; 2] = ["hold", "note"];
const IN_SESSION_OPEN: [&str; 3] = ["sent", "waiting", "partial"];
const KEEP_MS: i64 = 30 * 24 * 3600 * 1000;

#[derive(Clone, Debug, Default)]
pub struct AddOptions {
    pub areas: Option<Vec<String>>,
    pub now_ms: Option<i64>,
}

pub fn parse_until(text: &str, now_ms: Option<i64>) -> Result<Option<String>, String> {
    todo!()
}

pub fn short_until(iso: Option<&str>) -> String {
    todo!()
}

pub fn long_until(iso: Option<&str>) -> String {
    todo!()
}

pub fn is_active(r: &Value, now_ms: Option<i64>) -> bool {
    todo!()
}

pub fn matches(r: &Value, target: &Value) -> bool {
    todo!()
}

pub fn task_target(t: &Value, area: Option<&str>) -> Value {
    todo!()
}

pub fn restrictions_for(d: &Doc, target: &Value, now_ms: Option<i64>) -> Vec<Value> {
    todo!()
}

pub fn holds_for(d: &Doc, target: &Value, now_ms: Option<i64>) -> Vec<Value> {
    todo!()
}

pub fn notes_for(d: &Doc, target: &Value, now_ms: Option<i64>) -> Vec<Value> {
    todo!()
}

pub fn scope_text(r: &Value, area_name: Option<&dyn Fn(&str) -> String>) -> String {
    todo!()
}

pub fn hold_error(what: &str, holds: &[Value]) -> String {
    todo!()
}

pub fn check_task(d: &Doc, t: &Value, area: Option<&str>, now_ms: Option<i64>) -> String {
    todo!()
}

pub fn check_area(d: &Doc, what: &str, area: &str, now_ms: Option<i64>) -> String {
    todo!()
}

pub fn add_restriction(d: &mut Doc, input: &Value, options: AddOptions) -> Result<Value, String> {
    todo!()
}

pub fn release_restriction(d: &mut Doc, id: &str, by: Option<&str>, now_ms: Option<i64>) -> Result<Value, String> {
    todo!()
}

pub fn pending_stop_notices(d: &Doc, now_ms: Option<i64>) -> Vec<Value> {
    todo!()
}

pub fn for_page(d: &Doc, now_ms: Option<i64>) -> Value {
    todo!()
}

pub fn madrid_to_ms(y: i64, m: i64, d: i64, h: i64, mi: i64) -> i64 {
    todo!()
}

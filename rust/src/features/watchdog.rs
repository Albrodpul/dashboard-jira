//! Port of src/features/watchdog.js.

use serde_json::Value;

use crate::core::data::Doc;

const WAITING_MIN: f64 = 4.0;
const REPEAT_MIN: i64 = 15;
const TYPING_MIN: f64 = 4.0;
const RENOTIFY_MS: i64 = 2 * 3600000;
const TAIL: u64 = 256 * 1024;
const DISMISS_KEEP_MS: i64 = 24 * 3600000;

pub fn tick() {
    todo!()
}

pub fn dismiss(key: &str) {
    todo!()
}

pub fn for_page(d: &Doc) -> Value {
    todo!()
}

pub fn findings(s: &Value, d: &Doc) -> Vec<Value> {
    todo!()
}

pub fn repeated_notices(lines: &[String], since_ms: i64) -> Vec<Value> {
    todo!()
}

pub fn apply(found: &[Value]) -> Vec<Value> {
    todo!()
}

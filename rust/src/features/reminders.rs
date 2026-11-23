//! Port of src/features/reminders.js.

use serde_json::Value;

use crate::core::data::Doc;
use crate::core::time::Clock;

pub fn madrid(ms: Option<i64>) -> Clock {
    todo!()
}

pub fn is_due(r: &Value, ms: Option<i64>) -> bool {
    todo!()
}

pub fn add(input: &Value) -> Result<Value, String> {
    todo!()
}

pub fn update(id: &str, input: &Value) -> Result<Value, String> {
    todo!()
}

pub fn remove(id: &str) -> String {
    todo!()
}

pub fn for_page(d: &Doc) -> Value {
    todo!()
}

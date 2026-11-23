//! Port of src/features/stuck.js.

use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value};

static STUCK: LazyLock<Mutex<Map<String, Value>>> = LazyLock::new(|| Mutex::new(Map::new()));

pub fn report(input: &Value) -> bool {
    todo!()
}

pub fn list() -> Vec<Value> {
    todo!()
}

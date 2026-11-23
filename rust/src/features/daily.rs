//! Port of src/features/daily.js.

use std::collections::{HashMap, HashSet};
use std::sync::{Condvar, LazyLock, Mutex};

use serde_json::Value;

use crate::core::config::Project;

const ZONE: &str = "Europe/Madrid";

static RUNNING: LazyLock<(Mutex<HashSet<String>>, Condvar)> = LazyLock::new(|| (Mutex::new(HashSet::new()), Condvar::new()));
static TRIED: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn daily_for(day: Option<&str>, auto: bool, project_id: Option<&str>) {
    todo!()
}

pub fn daily_if_missing() {
    todo!()
}

pub fn last_workday(from_ms: Option<i64>) -> String {
    todo!()
}

pub fn daily_state(project_id: Option<&str>) -> Value {
    todo!()
}

pub fn daily_states() -> Value {
    todo!()
}

pub fn tasks_of(day: &str, p: Option<&Project>) -> Vec<String> {
    todo!()
}

pub fn errors_of(day: &str, p: Option<&Project>) -> Vec<String> {
    todo!()
}

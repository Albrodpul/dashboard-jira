//! Port of src/features/devservers.js.
use crate::core::data::{DATA_DIR, Doc};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

static LOG_DIR: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("devservers"));
const STOP_WINDOW_MIN: u32 = 10;
static STARTING: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn spawn_hidden(command: &str, args: &[String], cwd: &str, log: &str) -> Result<u32, String> {
    todo!()
}

pub fn servers(project: Option<&str>, anywhere: bool) -> Vec<Value> {
    todo!()
}

pub fn auto_projects(d: Option<&Doc>) -> Value {
    todo!()
}

pub fn set_auto_project(project: &str, on: bool) -> Result<Value, String> {
    todo!()
}

pub fn status() -> Value {
    todo!()
}

pub fn start(id: &str) -> Result<bool, String> {
    todo!()
}

pub fn stop(id: &str) -> Result<bool, String> {
    todo!()
}

pub fn restart(id: &str) -> Result<bool, String> {
    todo!()
}

pub fn start_all(auto: bool, project: Option<&str>) -> Result<Vec<String>, String> {
    todo!()
}

pub fn stop_all(project: Option<&str>) -> Result<Vec<String>, String> {
    todo!()
}

pub fn standby() -> Result<Vec<String>, String> {
    todo!()
}

pub fn schedule() -> Result<(), String> {
    todo!()
}

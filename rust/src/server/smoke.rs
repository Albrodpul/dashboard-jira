//! Port of src/server/smoke.js.
use crate::core::data::DATA_DIR;
use regex::Regex;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

#[allow(dead_code)]
static FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("smoke.json"));
#[allow(dead_code)]
const VIEWS: [&str; 15] = ["home", "pending", "approved", "sent", "waiting", "done", "ignored", "find", "projects", "deploy", "sentry", "context", "follow-up", "sessions", "machines"];
#[allow(dead_code)]
const PHONE_VIEWS: [&str; 3] = ["today", "pending", "more"];
#[allow(dead_code)]
static CUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)has been closed|Target closed|browser has disconnected").unwrap());

pub fn run_smoke() -> Result<Value, String> {
    todo!()
}

pub fn smoke_after_update() {
    todo!()
}

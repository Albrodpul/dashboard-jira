//! Port of src/features/quota.js.
use crate::core::data::DATA_DIR;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

static FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("quota.json"));
static WAIT_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("quota-wait.json"));
static CREDENTIALS: LazyLock<PathBuf> = LazyLock::new(|| todo!());
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const WINDOWS: [&str; 2] = ["five_hour", "seven_day"];

pub fn read_quota() -> Option<Value> {
    todo!()
}

pub fn fetch_quota() -> Result<Option<Value>, String> {
    todo!()
}

pub fn ask_usage(token: &str) -> Result<Option<Value>, String> {
    todo!()
}

pub fn quota_from_headers(token: &str) -> Result<Value, String> {
    todo!()
}

pub fn login_token() -> Option<String> {
    todo!()
}

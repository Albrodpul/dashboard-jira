//! Port of src/features/claude-token.js.
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

const NAME: &str = "CLAUDE_CODE_OAUTH_TOKEN";
const WARN_DAYS: [i64; 6] = [30, 14, 7, 3, 1, 0];
static AGENT: LazyLock<PathBuf> = LazyLock::new(|| std::env::home_dir().unwrap_or_default().join("Library").join("LaunchAgents").join("com.nutria.claude-token.plist"));
static TOKEN: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"sk-ant-[A-Za-z0-9_-]{20,}").unwrap());

struct Cached {
    at: i64,
    value: Value,
}

struct Job {
    state: Value,
    cancelled: bool,
    writer: Option<Box<dyn std::io::Write + Send>>,
    killer: Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

static CACHED: LazyLock<Mutex<Option<Cached>>> = LazyLock::new(|| Mutex::new(None));
static JOB: LazyLock<Mutex<Option<Job>>> = LazyLock::new(|| Mutex::new(None));

pub fn apply_user_token(remove: bool) -> Result<bool, String> {
    todo!()
}

pub fn token_status() -> Value {
    todo!()
}

pub fn setup_token() -> Result<String, String> {
    todo!()
}

pub fn import_token(text: &str) -> Result<String, String> {
    todo!()
}

pub fn handle_setup(input: &Value) -> Result<Value, String> {
    todo!()
}

pub fn job_status() -> Value {
    todo!()
}

pub fn warn_expiry() -> Result<(), String> {
    todo!()
}

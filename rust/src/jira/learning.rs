use serde_json::Value;
use std::sync::atomic::AtomicBool;

const WEEKS: i64 = 16;
const DAY: i64 = 86_400_000;

static READING: AtomicBool = AtomicBool::new(false);

pub fn read_jira() -> Result<usize, String> {
    todo!()
}

pub fn start_reading() -> bool {
    todo!()
}

pub fn learning_summary() -> Value {
    todo!()
}

pub fn save_cause(key: &str, cause: &str, note: Option<&str>) -> bool {
    todo!()
}

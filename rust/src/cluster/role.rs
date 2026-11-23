use serde_json::Value;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

pub static CLUSTER: LazyLock<Option<Value>> = LazyLock::new(|| crate::core::config::cluster().cloned());
pub static STATE_FILE: LazyLock<PathBuf> = LazyLock::new(|| crate::core::data::DATA_DIR.join("cluster.json"));
const STALE_STATE_MS: i64 = 5 * 60_000;
pub static ST: LazyLock<Mutex<Value>> = LazyLock::new(|| Mutex::new(read_state()));

pub fn elapsed(iso: &str) -> i64 {
    todo!()
}

pub fn read_state() -> Value {
    todo!()
}

pub fn save() {
    todo!()
}

pub fn log(message: &str) {
    todo!()
}

pub fn is_primary() -> bool {
    todo!()
}

pub fn primary_now() -> bool {
    todo!()
}

pub fn info() -> Value {
    todo!()
}

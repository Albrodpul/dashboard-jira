//! Port of src/features/tunnel.js.
use crate::core::data::DATA_DIR;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

static STATE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("tunnel.json"));
static LOG: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("tunnel.log"));
static PEER_CACHE: LazyLock<Mutex<(i64, Option<Value>)>> = LazyLock::new(|| Mutex::new((0, None)));

pub fn status() -> Value {
    todo!()
}

pub fn open() -> Result<Value, String> {
    todo!()
}

pub fn close() -> Value {
    todo!()
}

pub fn guard() {
    todo!()
}

pub fn remote() -> Result<Option<Value>, String> {
    todo!()
}

pub fn pid() -> Option<u32> {
    todo!()
}

//! Port of src/features/memory-sync.js.
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

const INDEX: &str = "MEMORY.md";
const TOMB_MS: i64 = 30 * 24 * 3600 * 1000;
const MAIN_PEER: &str = "/api/cluster/memory";

#[derive(Clone)]
struct Context {
    dir: PathBuf,
    state: PathBuf,
    peer: String,
}

static CTX: LazyLock<Mutex<Option<Context>>> = LazyLock::new(|| Mutex::new(None));

pub fn memory_files() -> Value {
    todo!()
}

pub fn snapshot() -> Value {
    todo!()
}

pub fn project_snapshot(id: &str) -> Option<Value> {
    todo!()
}

pub fn sync_memory() -> Result<(), String> {
    todo!()
}

pub fn merge_index(local: &str, peer: &str, gone: &HashSet<String>) -> Option<String> {
    todo!()
}

pub fn drop_from_index(text: &str, gone: &HashSet<String>) -> Option<String> {
    todo!()
}

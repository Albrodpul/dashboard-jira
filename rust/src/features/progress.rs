//! Port of src/features/progress.js.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

const TAIL_BYTES: u64 = 768 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Phase {
    pub id: &'static str,
    pub label: &'static str,
}

pub const PHASES: [Phase; 5] = [
    Phase { id: "queued", label: "Por enviar" },
    Phase { id: "received", label: "Recibida" },
    Phase { id: "working", label: "Trabajando" },
    Phase { id: "review", label: "Revisando" },
    Phase { id: "done", label: "Hecha" },
];

static CACHE: LazyLock<Mutex<HashMap<PathBuf, (u64, Vec<Value>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn phases_json() -> Value {
    todo!()
}

pub fn describe(name: &str, input: &Value) -> Option<Value> {
    todo!()
}

pub fn read_tail(file: &Path) -> Option<Vec<Value>> {
    todo!()
}

pub fn typical(tasks: &[Value]) -> Option<Value> {
    todo!()
}

pub fn for_tasks(tasks: &[Value], conversation_of_area: &dyn Fn(&str) -> Option<String>, transcript_of: &dyn Fn(&str) -> Option<PathBuf>) -> Value {
    todo!()
}

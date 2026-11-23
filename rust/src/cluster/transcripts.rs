use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

const RECENT_MS: i64 = 14 * 24 * 3600 * 1000;
const TAIL: u64 = 4096;

pub static PROJECTS: LazyLock<PathBuf> = LazyLock::new(|| crate::agents::index::main().transcripts_dir());

struct TailEntry {
    size: u64,
    mtime: f64,
    hash: String,
}

static TAIL_CACHE: LazyLock<Mutex<HashMap<PathBuf, TailEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static KEPT: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub struct ServedTranscript {
    pub tail: String,
    pub body: Vec<u8>,
}

pub fn recent_since() -> i64 {
    todo!()
}

pub fn project_dir() -> PathBuf {
    todo!()
}

pub fn transcript_path(conversation: &str) -> Option<PathBuf> {
    todo!()
}

pub fn last_reply(conversation: &str) -> Option<String> {
    todo!()
}

pub fn transcripts() -> Vec<Value> {
    todo!()
}

pub fn serve_transcript(conversation: &str, from: u64) -> Option<ServedTranscript> {
    todo!()
}

pub fn refresh_from_peer(only_newer_than: Option<i64>, skip_running: bool) -> i64 {
    todo!()
}

pub fn running_conversations() -> HashSet<String> {
    todo!()
}

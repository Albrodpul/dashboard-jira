//! Port of src/server/server.js.
use regex::Regex;
use std::sync::LazyLock;

#[allow(dead_code)]
static LOCAL_API: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/(cluster|tunnel|claude-token/|push/|host/(respawned|prompt|sessions)|permission/(check|perm-)|quit)").unwrap());

#[allow(dead_code)]
static TERMINAL_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/term/([0-9a-f-]{36})$").unwrap());

#[allow(dead_code)]
const MAX_JSON_BODY: usize = 20000;

#[allow(dead_code)]
const PEER_TIMEOUT_MS: u64 = 15000;

pub fn serve() {
    todo!()
}

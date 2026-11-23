//! Port of src/features/voice.js.
use crate::core::data::DATA_DIR;
use crate::server::http::{PostHandler, Req, Res};
use regex::Regex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

static VOICE_DIR: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("voice"));
static LOCAL: LazyLock<PathBuf> = LazyLock::new(|| PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("whisper"));
static WHISPER_BIN: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::voice().get("whisperBin").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| LOCAL.join("bin").join("Release").join("whisper-cli.exe")));
static WHISPER_MODEL: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::voice().get("model").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| LOCAL.join("ggml-small-q5_1.bin")));
const MAX_BYTES: usize = 15 * 1024 * 1024;
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^voice-\d{17}$").unwrap());
static RECENT: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn voice_available() -> bool {
    todo!()
}

pub fn handle_voice(req: &Req, create_message: PostHandler) -> Result<Res, String> {
    todo!()
}

pub fn serve_voice(url: &str) -> Res {
    todo!()
}

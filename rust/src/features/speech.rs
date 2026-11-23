//! Port of src/features/speech.js.
use crate::core::data::DATA_DIR;
use crate::server::http::Res;
use regex::Regex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, LazyLock, Mutex};

static SPEECH_DIR: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("speech"));
static LOCAL: LazyLock<PathBuf> = LazyLock::new(|| PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("piper"));
static PIPER_BIN: LazyLock<PathBuf> = LazyLock::new(|| voice_setting("piperBin").map(PathBuf::from).unwrap_or_else(|| LOCAL.join("piper").join("piper.exe")));
static PIPER_VOICE: LazyLock<PathBuf> = LazyLock::new(|| voice_setting("piperVoice").map(PathBuf::from).unwrap_or_else(|| LOCAL.join("es_ES-davefx-medium.onnx")));
static FFMPEG: LazyLock<String> = LazyLock::new(|| voice_setting("ffmpeg").unwrap_or_else(|| "ffmpeg".to_string()));
static ROUTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/speech/(msg-\d{17})/(\d{1,2}|p\d{13})\.mp3$").unwrap());

type Synthesis = Arc<(Mutex<Option<bool>>, Condvar)>;
static RUNNING: LazyLock<Mutex<HashMap<PathBuf, Synthesis>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn voice_setting(key: &str) -> Option<String> {
    crate::core::config::voice().get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
}

pub fn speech_available() -> bool {
    todo!()
}

pub fn serve_speech(url: &str) -> Res {
    todo!()
}

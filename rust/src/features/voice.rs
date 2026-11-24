//! Port of src/features/voice.js.
use crate::core::data::DATA_DIR;
use crate::core::time::{now, now_ms};
use crate::server::http::{PostHandler, Req, Res, send};
use regex::Regex;
use serde_json::json;
use sha2::{Digest, Sha256};
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
    WHISPER_BIN.exists() && WHISPER_MODEL.exists()
}

fn transcribe(file: &std::path::Path) -> Result<String, String> {
    let language = crate::core::config::voice().get("language").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("es").to_string();
    let mut cmd = crate::core::platform::cmd(&*WHISPER_BIN);
    cmd.arg("-m").arg(&*WHISPER_MODEL).arg("-f").arg(file).args(["-l", &language, "-nt", "-np", "-t", "6"]);
    let out = crate::features::devservers::run_with_timeout(&mut cmd, None, 120000).map_err(|_| "no se pudo transcribir la nota".to_string())?;
    if !out.status.success() || out.stdout.len() > 1024 * 1024 {
        return Err("no se pudo transcribir la nota".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).split_whitespace().collect::<Vec<_>>().join(" "))
}

pub fn handle_voice(req: &Req, create_message: PostHandler) -> Result<Res, String> {
    if !voice_available() {
        return Ok(send(503, &json!({ "error": "Whisper no está instalado en este ordenador" })));
    }
    let to = req.query("to").unwrap_or("");
    if !["reporter", "orchestrator", "board"].contains(&to) {
        return Ok(send(400, &json!({ "error": "destino desconocido" })));
    }
    let body = &req.body;
    if body.len() > MAX_BYTES {
        return Err("la nota es demasiado larga".into());
    }
    if body.len() < 44 || &body[0..4] != b"RIFF" {
        return Ok(send(400, &json!({ "error": "audio no válido" })));
    }
    let hash: String = Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect();
    {
        let mut recent = RECENT.lock().unwrap();
        recent.retain(|_, at| now_ms() - *at <= 30 * 60000);
        if recent.contains_key(&hash) {
            return Ok(send(200, &json!({ "duplicate": true })));
        }
        recent.insert(hash, now_ms());
    }
    std::fs::create_dir_all(&*VOICE_DIR).map_err(|e| e.to_string())?;
    let digits: String = now().chars().filter(char::is_ascii_digit).take(17).collect();
    let id = format!("voice-{digits}");
    let file = VOICE_DIR.join(format!("{id}.wav"));
    std::fs::write(&file, body).map_err(|e| e.to_string())?;
    let text = transcribe(&file)?;
    if text.is_empty() {
        return Ok(send(422, &json!({ "error": "No se ha entendido nada en la nota" })));
    }
    Ok(create_message(&json!({ "to": to, "text": text, "voice": id })))
}

pub fn serve_voice(url: &str) -> Res {
    let base = url.rsplit(['/', '\\']).next().unwrap_or("");
    let id = if base != ".wav" { base.strip_suffix(".wav").unwrap_or(base) } else { base };
    if !ID.is_match(id) {
        return Res::empty(404);
    }
    let file = VOICE_DIR.join(format!("{id}.wav"));
    match std::fs::read(&file) {
        Ok(bytes) => Res { code: 200, headers: vec![("content-type".into(), "audio/wav".into()), ("cache-control".into(), "max-age=86400".into())], body: bytes },
        Err(_) => Res::empty(404),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_saved_notes_with_a_valid_id_are_served() {
        let _g = crate::testkit::fresh();
        assert_eq!(serve_voice("/api/voice/../board.db").code, 404);
        assert_eq!(serve_voice("/api/voice/voice-20261123101010123.wav").code, 404);
        std::fs::create_dir_all(&*VOICE_DIR).unwrap();
        std::fs::write(VOICE_DIR.join("voice-20261123101010123.wav"), b"RIFF").unwrap();
        let r = serve_voice("/api/voice/voice-20261123101010123.wav");
        assert_eq!(r.code, 200);
        assert_eq!(r.header("content-type"), Some("audio/wav"));
        assert_eq!(r.body, b"RIFF");
    }
}

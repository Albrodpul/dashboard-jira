//! Port of src/features/speech.js.
use crate::core::data::{DATA_DIR, load};
use crate::core::json::truthy;
use crate::server::http::Res;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
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
    PIPER_BIN.exists() && PIPER_VOICE.exists()
}

fn speakable(text: &str) -> String {
    static TICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`+").unwrap());
    static BOLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*?|__").unwrap());
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S+").unwrap());
    static EMOJI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]").unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    let t = TICKS.replace_all(text, "");
    let t = BOLD.replace_all(&t, "");
    let t = LINK.replace_all(&t, "el enlace");
    let t = EMOJI.replace_all(&t, "");
    let t = SPACE.replace_all(&t, " ");
    t.trim().chars().take(4000).collect()
}

fn run(bin: &Path, args: &[&str], input: Option<&str>) -> Result<(), String> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    let out = crate::features::devservers::run_with_timeout(&mut cmd, input.map(str::as_bytes), 120000).map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) }
}

fn synthesize(text: &str, file: &Path) -> Result<(), String> {
    let wav = format!("{}.{}.wav", file.display(), std::process::id());
    let result = (|| {
        run(&PIPER_BIN, &["-m", &PIPER_VOICE.to_string_lossy(), "-f", &wav, "-q"], Some(&speakable(text)))?;
        run(Path::new(&*FFMPEG), &["-y", "-loglevel", "error", "-i", &wav, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "48k", &file.to_string_lossy()], None)
    })();
    let _ = std::fs::remove_file(&wav);
    result
}

enum Index {
    Progress(String),
    Reply(usize),
}

fn reply_text(id: &str, index: &Index) -> Option<String> {
    let d = load();
    let m = d.get("messages").and_then(Value::as_array)?.iter().find(|x| x.get("id").and_then(Value::as_str) == Some(id))?.clone();
    let text = match index {
        Index::Progress(p) => {
            let progress = m.get("progress").filter(|x| truthy(Some(x)))?;
            let at = progress.get("at").and_then(Value::as_str).and_then(crate::core::time::parse)?;
            if &format!("p{at}") != p {
                return None;
            }
            progress.get("text").cloned()
        }
        Index::Reply(n) => {
            let replies = match m.get("replies").filter(|r| truthy(Some(r))) {
                Some(r) => r.clone(),
                None => match m.get("reply").filter(|r| truthy(Some(r))) {
                    Some(r) => serde_json::json!([{ "text": r }]),
                    None => serde_json::json!([]),
                },
            };
            replies.get(*n).filter(|r| truthy(Some(r))).and_then(|r| r.get("text")).cloned()
        }
    };
    text.filter(|t| truthy(Some(t))).map(|t| match t {
        Value::String(s) => s,
        other => crate::core::json::stringify(&other),
    })
}

pub fn serve_speech(url: &str) -> Res {
    let Some(m) = ROUTE.captures(url).filter(|_| speech_available()) else { return Res::empty(404) };
    let (id, n) = (m[1].to_string(), m[2].to_string());
    let index = if n.starts_with('p') { Index::Progress(n.clone()) } else { Index::Reply(n.parse().unwrap_or(usize::MAX)) };
    let Some(text) = reply_text(&id, &index) else { return Res::empty(404) };
    if std::fs::create_dir_all(&*SPEECH_DIR).is_err() {
        return Res::empty(500);
    }
    let file = SPEECH_DIR.join(format!("{id}-{n}.mp3"));
    let serve = |file: &Path| match std::fs::read(file) {
        Ok(bytes) => Res { code: 200, headers: vec![("content-type".into(), "audio/mpeg".into()), ("cache-control".into(), "max-age=86400".into())], body: bytes },
        Err(_) => Res::empty(500),
    };
    if file.exists() {
        return serve(&file);
    }
    let (job, mine) = {
        let mut running = RUNNING.lock().unwrap();
        match running.get(&file) {
            Some(j) => (j.clone(), false),
            None => {
                let j: Synthesis = Arc::new((Mutex::new(None), Condvar::new()));
                running.insert(file.clone(), j.clone());
                (j, true)
            }
        }
    };
    let ok = if mine {
        let ok = synthesize(&text, &file).is_ok();
        *job.0.lock().unwrap() = Some(ok);
        job.1.notify_all();
        RUNNING.lock().unwrap().remove(&file);
        ok
    } else {
        let mut slot = job.0.lock().unwrap();
        while slot.is_none() {
            slot = job.1.wait(slot).unwrap();
        }
        slot.unwrap()
    };
    if ok { serve(&file) } else { Res::empty(500) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_links_and_emoji_are_not_read_aloud() {
        assert_eq!(speakable("**Hecho**: mira `x` en https://example.com/a 🎉\n  y  ya"), "Hecho: mira x en el enlace y ya");
    }
}

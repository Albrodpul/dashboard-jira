//! Port of src/sessions/deliver.js.
use crate::core::json::truthy;
use regex::Regex;
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const PASTE_SETTLE_MS: u64 = 400;
const CONFIRM_MS: u64 = 15000;
const POLL_MS: u64 = 500;
const TAIL_BYTES: u64 = 4 * 1024 * 1024;

static NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r\n?").unwrap());
static CONTROL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f]").unwrap());

pub type TranscriptFn = Box<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;
pub type WriteFn = Box<dyn Fn(&str, &str) -> Result<Value, String> + Send + Sync>;
pub type WaitFn = Box<dyn Fn(u64) + Send + Sync>;
pub type WakeFn = Box<dyn Fn(&str, &str) -> bool + Send + Sync>;

pub struct Deps {
    pub transcript: TranscriptFn,
    pub write: WriteFn,
    pub wait: WaitFn,
    pub wake: WakeFn,
}

impl Default for Deps {
    fn default() -> Deps {
        Deps {
            transcript: Box::new(crate::sessions::registry::transcript_of),
            write: Box::new(|conversation, data| crate::sessions::host::host_request("POST", "/input", Some(&serde_json::json!({ "conversation": conversation, "data": data })))),
            wait: Box::new(|ms| std::thread::sleep(std::time::Duration::from_millis(ms))),
            wake: Box::new(|name, notice| crate::sessions::registry::wake_session(name, Some(notice))),
        }
    }
}

pub fn clean(text: &str) -> String {
    CONTROL.replace_all(&NEWLINES.replace_all(text, "\n"), "").trim().to_string()
}

fn size_of(file: &Path) -> u64 {
    std::fs::metadata(file).map(|m| m.len()).unwrap_or(0)
}

pub fn seen_since(file: Option<&Path>, token: &str, from: u64) -> bool {
    let Some(file) = file else { return false };
    let Ok(meta) = std::fs::metadata(file) else { return false };
    let size = meta.len();
    let start = from.min(size).max(size.saturating_sub(TAIL_BYTES));
    if size <= start {
        return false;
    }
    let Ok(mut f) = std::fs::File::open(file) else { return false };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity((size - start) as usize);
    if f.take(size - start).read_to_end(&mut buf).is_err() {
        return false;
    }
    String::from_utf8_lossy(&buf).contains(token)
}

pub fn seen_anywhere(conversation: &str, token: &str, deps: Option<&Deps>) -> bool {
    let fallback;
    let deps = match deps {
        Some(d) => d,
        None => {
            fallback = Deps::default();
            &fallback
        }
    };
    seen_since((deps.transcript)(conversation).as_deref(), token, 0)
}

fn confirm(transcript: &TranscriptFn, wait: &WaitFn, conversation: &str, token: &str, from: u64, ms: u64) -> bool {
    let mut waited = 0;
    while waited <= ms {
        if seen_since(transcript(conversation).as_deref(), token, from) {
            return true;
        }
        wait(POLL_MS);
        waited += POLL_MS;
    }
    false
}

fn error_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => crate::core::json::stringify(other),
    }
}

pub fn type_into(conversation: &str, text: &str, token: &str, deps: Option<&Deps>) -> Result<Value, String> {
    let fallback;
    let deps = match deps {
        Some(d) => d,
        None => {
            fallback = Deps::default();
            &fallback
        }
    };
    let body = clean(text);
    if !body.contains(token) {
        return Err("el mensaje no lleva su marca de envío".into());
    }
    let from = (deps.transcript)(conversation).map(|f| size_of(&f)).unwrap_or(0);
    let put = |data: &str| -> Result<(), String> {
        let r = (deps.write)(conversation, data)?;
        if let Some(e) = r.get("error").filter(|e| truthy(Some(e))) {
            return Err(format!("el gestor de sesiones no deja escribir: {}", error_text(e)));
        }
        Ok(())
    };
    put(&format!("\x1b[200~{body}\x1b[201~"))?;
    (deps.wait)(PASTE_SETTLE_MS);
    put("\r")?;
    if confirm(&deps.transcript, &deps.wait, conversation, token, from, CONFIRM_MS) {
        return Ok(json!({ "ok": true }));
    }
    put("\r")?;
    if confirm(&deps.transcript, &deps.wait, conversation, token, from, CONFIRM_MS) {
        return Ok(json!({ "ok": true, "retried": true }));
    }
    Ok(json!({ "ok": false, "error": "el mensaje no aparece en la conversación de la sesión: puede tener un diálogo abierto o estar arrancando. Mírala en Chats" }))
}

pub fn send_message_into(conversation: Option<&str>, send_to: &str, text: &str, token: &str, deps: Option<&Deps>) -> Value {
    let fallback;
    let deps = match deps {
        Some(d) => d,
        None => {
            fallback = Deps::default();
            &fallback
        }
    };
    let conversation = conversation.filter(|c| !c.is_empty());
    let from = conversation.and_then(|c| (deps.transcript)(c)).map(|f| size_of(&f)).unwrap_or(0);
    let ok = (deps.wake)(send_to, &clean(text));
    let Some(conversation) = conversation else {
        return if ok { json!({ "ok": true, "unconfirmed": true }) } else { json!({ "ok": false, "error": "no se pudo mandar el mensaje entre sesiones" }) };
    };
    if confirm(&deps.transcript, &deps.wait, conversation, token, from, CONFIRM_MS) {
        return json!({ "ok": true });
    }
    json!({ "ok": false, "error": if ok { "el mensaje entre sesiones no aparece en la conversación de destino" } else { "no se pudo mandar el mensaje entre sesiones" } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn deps(file: PathBuf, writes: Arc<Mutex<Vec<String>>>, appear_on: usize) -> Deps {
        let target = file.clone();
        Deps {
            transcript: Box::new(move |_| Some(file.clone())),
            wait: Box::new(|_| {}),
            write: Box::new(move |_, data| {
                let mut w = writes.lock().unwrap();
                w.push(data.to_string());
                if w.iter().filter(|x| *x == "\r").count() == appear_on {
                    use std::io::Write;
                    let mut f = std::fs::OpenOptions::new().append(true).open(&target).unwrap();
                    writeln!(f, "{}", crate::core::json::stringify(&json!({ "type": "queue-operation", "operation": "enqueue", "content": "Tablero: hola\nmundo [envío E9]" }))).unwrap();
                }
                Ok(json!({ "ok": true }))
            }),
            wake: Box::new(|_, _| true),
        }
    }

    #[test]
    fn type_into_pastes_submits_and_confirms_by_finding_the_mark_in_the_transcript() {
        let dir = crate::testkit::sandbox().dir.join(format!("deliver-{}", crate::core::time::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.jsonl");
        std::fs::write(&file, "{\"type\":\"user\",\"message\":{\"content\":\"antes [envío E9]\"}}\n").unwrap();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let conv = "11111111-2222-4333-8444-000000000001";
        let r = type_into(conv, "Tablero: hola\r\nmundo\x1b[201~ [envío E9]", "[envío E9]", Some(&deps(file.clone(), writes.clone(), 1))).unwrap();
        assert_eq!(r, json!({ "ok": true }));
        assert_eq!(writes.lock().unwrap()[0], "\x1b[200~Tablero: hola\nmundo[201~ [envío E9]\x1b[201~");
        assert_eq!(writes.lock().unwrap()[1], "\r");
        writes.lock().unwrap().clear();
        std::fs::write(&file, "").unwrap();
        let r = type_into(conv, "Tablero: x [envío E9]", "[envío E9]", Some(&deps(file.clone(), writes.clone(), 2))).unwrap();
        assert_eq!(r, json!({ "ok": true, "retried": true }));
        writes.lock().unwrap().clear();
        std::fs::write(&file, "").unwrap();
        let r = type_into(conv, "Tablero: x [envío E9]", "[envío E9]", Some(&deps(file.clone(), writes.clone(), 99))).unwrap();
        assert_eq!(r["ok"], false);
        assert_eq!(writes.lock().unwrap().len(), 3);
        assert_eq!(type_into(conv, "sin marca", "[envío E9]", Some(&deps(file.clone(), writes.clone(), 99))).unwrap_err(), "el mensaje no lleva su marca de envío");
    }

    #[test]
    fn a_message_between_sessions_without_a_target_conversation_is_sent_unconfirmed() {
        let mut d = deps(PathBuf::from("/nonexistent"), Arc::new(Mutex::new(Vec::new())), 99);
        assert_eq!(send_message_into(None, "Pagos", "hola [envío E1]", "[envío E1]", Some(&d)), json!({ "ok": true, "unconfirmed": true }));
        d.wake = Box::new(|_, _| false);
        assert_eq!(send_message_into(None, "Pagos", "hola", "[envío E1]", Some(&d)), json!({ "ok": false, "error": "no se pudo mandar el mensaje entre sesiones" }));
        assert_eq!(send_message_into(Some("c1"), "Pagos", "hola", "[envío E1]", Some(&d)), json!({ "ok": false, "error": "no se pudo mandar el mensaje entre sesiones" }));
    }
}

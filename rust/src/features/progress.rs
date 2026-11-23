//! Port of src/features/progress.js.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::core::json::truthy;
use crate::core::time::parse;

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
static BOARD_DONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"board\.js["']?\s+(done|partial|question)\b"#).unwrap());
static BOARD_SENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"board\.js["']?\s+sent\b|board\.js["']?\s+reply\b"#).unwrap());
static REVIEW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)revis|review").unwrap());
static BROWSER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^mcp__.*browser|Browser").unwrap());
static QUIET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"update_plan|wrap_up|TodoWrite|ToolSearch|TaskStop|ListAgents|ScheduleWakeup").unwrap());
static MCP_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^mcp__[^_]+__").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn rank(id: &str) -> usize {
    PHASES.iter().position(|p| p.id == id).unwrap_or(0)
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(x) if truthy(Some(x)) => x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x)),
        _ => String::new(),
    }
}

fn base(p: Option<&Value>) -> String {
    let s = str_of(p).replace('\\', "/");
    s.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

fn slice_units(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n { s.to_string() } else { String::from_utf16_lossy(&units[..n]) }
}

fn short(s: Option<&Value>, n: usize) -> String {
    let x = SPACES.replace_all(&str_of(s), " ").trim().to_string();
    if x.encode_utf16().count() > n { format!("{}…", slice_units(&x, n - 1)) } else { x }
}

fn said(text: String, phase: &str) -> Option<Value> {
    Some(json!({ "text": text, "phase": phase }))
}

pub fn phases_json() -> Value {
    Value::Array(PHASES.iter().map(|p| json!({ "id": p.id, "label": p.label })).collect())
}

pub fn describe(name: &str, input: &Value) -> Option<Value> {
    let cmd = str_of(input.get("command"));
    if BOARD_DONE.is_match(&cmd) {
        return said("Avisando al tablero de cómo ha quedado".into(), "working");
    }
    if BOARD_SENT.is_match(&cmd) {
        return said("Confirmando que la ha recibido".into(), "received");
    }
    match name {
        "Read" => said(format!("Leyendo {}", base(input.get("file_path"))), "working"),
        "Edit" | "MultiEdit" => said(format!("Editando {}", base(input.get("file_path"))), "working"),
        "Write" => said(format!("Escribiendo {}", base(input.get("file_path"))), "working"),
        "NotebookEdit" => said(format!("Editando {}", base(input.get("notebook_path"))), "working"),
        "Grep" | "Glob" => said("Buscando en el código".into(), "working"),
        "Agent" | "Task" => {
            let what = format!("{} {} {}", str_of(input.get("description")), str_of(input.get("subagent_type")), slice_units(&str_of(input.get("prompt")), 200));
            if REVIEW.is_match(&what) {
                said(format!("Revisando con un agente: {}", short(input.get("description"), 50)), "review")
            } else {
                said(format!("Con un agente: {}", short(input.get("description"), 50)), "working")
            }
        }
        "SendMessage" => said("Hablando con un agente".into(), "working"),
        "Skill" => said(if truthy(input.get("skill")) { format!("Usando /{}", str_of(input.get("skill"))) } else { "Usando un comando".into() }, "working"),
        "Monitor" | "TaskOutput" => said("Esperando a un proceso".into(), "working"),
        "AskUserQuestion" => said("Preguntándote algo".into(), "working"),
        "WebFetch" | "WebSearch" => said("Consultando la web".into(), "working"),
        "Bash" | "PowerShell" => said(if truthy(input.get("description")) { short(input.get("description"), 70) } else { "Ejecutando un comando".into() }, "working"),
        _ => {
            if BROWSER.is_match(name) {
                return said("Probando en el navegador".into(), "working");
            }
            if QUIET.is_match(name) {
                return None;
            }
            said(format!("Usando {}", MCP_PREFIX.replace(name, "")), "working")
        }
    }
}

pub fn read_tail(file: &Path) -> Option<Vec<Value>> {
    let size = std::fs::metadata(file).ok()?.len();
    if let Some((s, actions)) = CACHE.lock().unwrap_or_else(|p| p.into_inner()).get(file) {
        if *s == size {
            return Some(actions.clone());
        }
    }
    let start = size.saturating_sub(TAIL_BYTES);
    let mut buf = Vec::new();
    if let Ok(mut f) = std::fs::File::open(file) {
        let _ = f.seek(SeekFrom::Start(start));
        let _ = f.take(size - start).read_to_end(&mut buf);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let mut actions = Vec::new();
    for line in lines {
        if !line.contains("\"tool_use\"") {
            continue;
        }
        let Ok(j) = serde_json::from_str::<Value>(line) else { continue };
        if j.get("type").and_then(Value::as_str) != Some("assistant") || truthy(j.get("isSidechain")) {
            continue;
        }
        let Some(content) = j.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) else { continue };
        for c in content {
            if c.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let empty = json!({});
            let input = c.get("input").filter(|x| truthy(Some(x))).unwrap_or(&empty);
            if let Some(d) = describe(c.get("name").and_then(Value::as_str).unwrap_or("undefined"), input) {
                let mut o = Map::new();
                if let Some(at) = j.get("timestamp") {
                    o.insert("at".into(), at.clone());
                }
                for (k, v) in d.as_object().unwrap() {
                    o.insert(k.clone(), v.clone());
                }
                actions.push(Value::Object(o));
            }
        }
    }
    CACHE.lock().unwrap_or_else(|p| p.into_inner()).insert(file.to_path_buf(), (size, actions.clone()));
    Some(actions)
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

pub fn typical(tasks: &[Value]) -> Option<Value> {
    let mut mins: Vec<f64> = tasks
        .iter()
        .map(|t| {
            let sent_at = str_of(t.get("sentAt"));
            let mut ats: Vec<String> = t
                .get("history")
                .and_then(Value::as_array)
                .map(|h| {
                    h.iter()
                        .filter(|h| matches!(h.get("type").and_then(Value::as_str), Some("done" | "partial")) && !sent_at.is_empty() && str_of(h.get("at")) >= sent_at)
                        .map(|h| str_of(h.get("at")))
                        .collect()
                })
                .unwrap_or_default();
            ats.sort();
            let first = ats.into_iter().next().filter(|x| !x.is_empty());
            let end = first.or_else(|| if t.get("status").and_then(Value::as_str) == Some("done") { Some(str_of(t.get("notice").and_then(|n| n.get("at")))).filter(|x| !x.is_empty()) } else { None });
            match (sent_at.is_empty(), end) {
                (false, Some(e)) => match (parse(&e), parse(&sent_at)) {
                    (Some(a), Some(b)) => (a - b) as f64 / 60000.0,
                    _ => f64::NAN,
                },
                _ => f64::NAN,
            }
        })
        .filter(|m| *m >= 0.5 && *m <= 240.0)
        .collect();
    mins.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if mins.len() < 3 {
        return None;
    }
    let at = |q: f64| mins[(mins.len() - 1).min((q * mins.len() as f64).floor() as usize)];
    Some(json!({ "low": js_round(at(0.25)).max(1.0) as i64, "high": js_round(at(0.75)).max(2.0) as i64, "samples": mins.len() }))
}

pub fn for_tasks(tasks: &[Value], conversation_of_area: &dyn Fn(&str) -> Option<String>, transcript_of: &dyn Fn(&str) -> Option<PathBuf>) -> Value {
    let band = typical(tasks).unwrap_or(Value::Null);
    let mut out = Map::new();
    for t in tasks {
        let status = t.get("status").and_then(Value::as_str).unwrap_or("");
        let mut phase = match status {
            "approved" => "queued",
            "sent" => "received",
            "waiting" | "partial" => "working",
            "done" => "done",
            _ => continue,
        };
        let area = str_of(t.get("area"));
        let conversation = if area.is_empty() { None } else { conversation_of_area(&area) };
        let sent_at = str_of(t.get("sentAt"));
        let file = match &conversation {
            Some(c) if !c.is_empty() && !sent_at.is_empty() && !matches!(status, "approved" | "done") => transcript_of(c),
            _ => None,
        };
        let actions = file.and_then(|f| read_tail(&f)).unwrap_or_default();
        let since = if sent_at.is_empty() { Some(0) } else { parse(&sent_at) };
        let end = if status == "done" { parse(&str_of(t.get("notice").and_then(|n| n.get("at")))).unwrap_or(i64::MAX) } else { i64::MAX };
        let mine: Vec<&Value> = actions
            .iter()
            .filter(|a| match (parse(&str_of(a.get("at"))), since) {
                (Some(ms), Some(s)) => ms >= s && ms <= end.saturating_add(5000),
                _ => false,
            })
            .collect();
        if status == "sent" {
            for a in &mine {
                let p = a.get("phase").and_then(Value::as_str).unwrap_or("");
                if p != "received" && rank(p) > rank(phase) {
                    phase = PHASES[rank(p)].id;
                }
            }
            if phase == "received" && mine.iter().any(|a| a.get("phase").and_then(Value::as_str) == Some("working")) {
                phase = "working";
            }
        }
        let action = match mine.last() {
            Some(last) if status != "done" => json!({ "text": last.get("text").cloned().unwrap_or(Value::Null), "at": last.get("at").cloned().unwrap_or(Value::Null) }),
            _ => Value::Null,
        };
        let since_value = [t.get("sentAt"), t.get("decidedAt")].into_iter().flatten().find(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
        let key = str_of(t.get("key"));
        out.insert(key, json!({ "phase": phase, "step": rank(phase), "of": PHASES.len() - 1, "action": action, "since": since_value, "typical": band, "paused": matches!(status, "waiting" | "partial") }));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(at: &str, name: &str, input: Value) -> String {
        crate::core::json::stringify(&json!({ "type": "assistant", "timestamp": at, "message": { "content": [{ "type": "tool_use", "name": name, "input": input }] } }))
    }

    #[test]
    fn each_tool_call_is_said_in_a_few_words_with_the_phase_it_means() {
        assert_eq!(describe("Edit", &json!({ "file_path": "c:\\x\\backend\\web\\js\\booking-list.js" })), Some(json!({ "text": "Editando booking-list.js", "phase": "working" })));
        assert_eq!(describe("Agent", &json!({ "description": "Review TV-111 diff" })).unwrap()["phase"], "review");
        assert_eq!(describe("Agent", &json!({ "description": "Find the controller" })).unwrap()["phase"], "working");
        assert_eq!(describe("Bash", &json!({ "command": "grep -rn x .", "description": "Busca los botones" })).unwrap()["text"], "Busca los botones");
        assert_eq!(describe("mcp__ccd_turn__update_plan", &json!({})), None);
    }

    #[test]
    fn a_task_in_a_session_gets_the_furthest_phase_reached_and_its_last_action_since_it_was_sent() {
        let dir = std::env::temp_dir().join(format!("progress-test-{}-{}", std::process::id(), crate::core::time::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("conv.jsonl");
        let lines = [
            line("2026-11-16T09:00:00.000Z", "Edit", json!({ "file_path": "old.js" })),
            line("2026-11-16T10:00:10.000Z", "Read", json!({ "file_path": "a.js" })),
            line("2026-11-16T10:02:00.000Z", "Agent", json!({ "description": "Review the diff" })),
            line("2026-11-16T10:03:00.000Z", "Edit", json!({ "file_path": "a.js" })),
        ];
        std::fs::write(&file, lines.join("\n") + "\n").unwrap();
        let tasks = vec![json!({ "key": "T-1", "status": "sent", "area": "web", "sentAt": "2026-11-16T10:00:00.000Z" }), json!({ "key": "T-2", "status": "approved", "area": "web", "decidedAt": "2026-11-16T10:05:00.000Z" })];
        let f = file.clone();
        let out = for_tasks(&tasks, &|_| Some("conv".into()), &move |_| Some(f.clone()));
        assert_eq!(out["T-1"]["phase"], "review");
        assert_eq!(out["T-1"]["action"], json!({ "text": "Editando a.js", "at": "2026-11-16T10:03:00.000Z" }));
        assert_eq!(out["T-2"]["phase"], "queued");
        assert_eq!(out["T-2"]["action"], Value::Null);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_usual_time_counts_only_the_sessions_own_work_and_needs_a_few_tasks() {
        let start = parse("2026-11-16T10:00:00.000Z").unwrap();
        let done = |min: i64, waited: i64| {
            json!({
                "status": "done",
                "sentAt": "2026-11-16T10:00:00.000Z",
                "history": [{ "type": if waited > 0 { "partial" } else { "done" }, "at": crate::core::time::iso(start + min * 60000) }],
                "notice": { "at": crate::core::time::iso(start + (min + waited) * 60000) },
            })
        };
        assert_eq!(typical(&[done(3, 0), done(5, 0)]), None);
        let band = typical(&[done(2, 0), done(4, 120), done(6, 0), done(10, 0)]).unwrap();
        assert!(band["high"].as_i64().unwrap() <= 10, "{band}");
        assert_eq!(band["samples"], 4);
    }
}

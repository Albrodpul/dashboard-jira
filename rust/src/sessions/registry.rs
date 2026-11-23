//! Port of src/sessions/registry.js.
use crate::core::data::{Doc, ROUTES_FILE};
use crate::core::json::{self, truthy};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

pub const STARTUP_NOTICE: &str = "Aviso del arranque: arranca el reporte. Eres la sesión de reporte registrada: ejecuta ahora .claude/commands/resumen-jira.md (regla de AGENTS.md).";
const STOP_WORDS: [&str; 12] = ["de", "del", "la", "el", "los", "las", "y", "a", "en", "the", "of", "and"];
const SUBAGENT_MAX_AGE: f64 = 30.0 * 60000.0;
const SUBAGENT_BACKGROUND_AGE: f64 = 3.0 * 3600000.0;
const SHELL_REFRESH_MS: u64 = 20000;

struct TitleMark {
    mark: String,
    size: u64,
    title: Option<String>,
}

#[derive(Clone)]
struct SubagentState {
    mark: String,
    ended: bool,
    background: Vec<String>,
}

static TRANSCRIPT_PATHS: LazyLock<Mutex<HashMap<String, PathBuf>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static TITLE_CACHE: LazyLock<Mutex<HashMap<String, TitleMark>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SUBAGENT_CACHE: LazyLock<Mutex<HashMap<PathBuf, SubagentState>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SHELL_COMMANDS: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static SHELL_WATCHING: AtomicBool = AtomicBool::new(false);
static CUSTOM_TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""customTitle":"((?:[^"\\]|\\.)*)""#).unwrap());
static MARK_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"['"`]|&&|\|\||[;|<>]"#).unwrap());
static FAKE_AREA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(conv|sesion|session):").unwrap());
static TOKEN_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?m)^[ \t]*CLAUDE_CODE_OAUTH_TOKEN[ \t]*=[ \t]*["']?([^"'\s]+)["']?[ \t]*\r?$"#).unwrap());
static OK_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)ok").unwrap());

#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    pub cwd: Option<PathBuf>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Bounded {
    pub ok: bool,
    pub out: String,
}

fn agent() -> &'static dyn crate::agents::index::Agent {
    crate::agents::index::main()
}

fn root() -> PathBuf {
    crate::core::config::main_project().root.clone().unwrap_or_default()
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => json::stringify(other),
    }
}

fn or_value(v: Option<&Value>, fallback: Value) -> Value {
    match v {
        Some(x) if truthy(Some(x)) => x.clone(),
        _ => fallback,
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn time_of(v: &Value) -> f64 {
    v.get("started").and_then(|s| s.as_str()).and_then(crate::core::time::parse).map(|x| x as f64).unwrap_or(f64::NAN)
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

pub fn title_key(s: &str) -> String {
    let folded: String = s.nfd().collect::<String>().to_lowercase();
    folded.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).filter(|w| !w.is_empty() && !STOP_WORDS.contains(w)).collect::<Vec<_>>().join("-")
}

fn process_alive(pid: Option<&Value>) -> bool {
    let n = match pid {
        Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if s.trim().is_empty() => 0.0,
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    };
    if !n.is_finite() || n.fract() != 0.0 {
        return false;
    }
    alive(n as i64)
}

#[cfg(unix)]
fn alive(pid: i64) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn alive(pid: i64) -> bool {
    std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string())).unwrap_or(false)
}

pub fn transcript_of(session_id: &str) -> Option<PathBuf> {
    let mut known = TRANSCRIPT_PATHS.lock().unwrap();
    if let Some(p) = known.get(session_id)
        && p.exists()
    {
        return Some(p.clone());
    }
    known.remove(session_id);
    let base = agent().transcripts_dir();
    let mut dirs: Vec<String> = std::fs::read_dir(&base).ok()?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    dirs.sort();
    for dir in dirs {
        let file = base.join(dir).join(format!("{session_id}.jsonl"));
        if file.exists() {
            known.insert(session_id.to_string(), file.clone());
            return Some(file);
        }
    }
    None
}

pub fn conversation_title(session_id: &str) -> Option<String> {
    let file = transcript_of(session_id)?;
    let meta = std::fs::metadata(&file).ok()?;
    let size = meta.len();
    let mark = format!("{}:{}", size, mtime_ms(&meta));
    let mut cache = TITLE_CACHE.lock().unwrap();
    let previous = cache.get(session_id);
    if let Some(p) = previous
        && p.mark == mark
    {
        return p.title.clone();
    }
    let from = match previous {
        Some(p) if p.size <= size => p.size.saturating_sub(1024),
        _ => 0,
    };
    let length = (size - from).min(512 * 1024);
    let mut buf = vec![0u8; length as usize];
    let mut f = std::fs::File::open(&file).ok()?;
    f.seek(SeekFrom::Start(size - length)).ok()?;
    let mut read = 0;
    while read < buf.len() {
        match f.read(&mut buf[read..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => read += n,
        }
    }
    buf.truncate(read);
    let body = String::from_utf8_lossy(&buf);
    let mut title = previous.and_then(|p| p.title.clone());
    if let Some(last) = CUSTOM_TITLE.find_iter(&body).last()
        && let Some(found) = json::parse(&format!("{{{}}}", last.as_str()))
        && let Some(t) = found.get("customTitle").and_then(|t| t.as_str())
    {
        title = Some(t.to_string());
    }
    cache.insert(session_id.to_string(), TitleMark { mark, size, title: title.clone() });
    title
}

fn keep_shells(list: Vec<String>) -> Vec<String> {
    list.into_iter().filter(|x| x.contains("shell-snapshots")).collect()
}

fn refresh_shell_commands() {
    std::thread::spawn(|| {
        if !cfg!(windows) {
            if let Some(out) = output_within(std::process::Command::new("ps").args(["-axww", "-o", "command="]), Duration::from_millis(20000)) {
                *SHELL_COMMANDS.lock().unwrap() = keep_shells(out.split('\n').map(String::from).collect());
            }
            return;
        }
        let script = "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | ForEach-Object { $_.CommandLine } | ConvertTo-Json -Compress";
        let Some(out) = output_within(std::process::Command::new("powershell").args(["-NoProfile", "-Command", script]), Duration::from_millis(20000)) else { return };
        let trimmed = out.trim();
        let Some(list) = json::parse(if trimmed.is_empty() { "[]" } else { trimmed }) else { return };
        let items = match list {
            Value::Array(a) => a,
            other => vec![other],
        };
        *SHELL_COMMANDS.lock().unwrap() = keep_shells(items.into_iter().filter_map(|x| x.as_str().map(String::from)).collect());
    });
}

fn output_within(cmd: &mut std::process::Command, limit: Duration) -> Option<String> {
    let mut child = cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stdout.read_to_end(&mut s);
        s
    });
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then(|| String::from_utf8_lossy(&out).to_string());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn watch_shells() {
    if SHELL_WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    refresh_shell_commands();
    std::thread::spawn(|| {
        loop {
            std::thread::sleep(Duration::from_millis(SHELL_REFRESH_MS));
            refresh_shell_commands();
        }
    });
}

fn command_mark(command: &str) -> String {
    let mut parts: Vec<String> = MARK_SPLIT.split(command).map(|x| x.trim().to_string()).collect();
    parts.sort_by(|a, b| b.encode_utf16().count().cmp(&a.encode_utf16().count()));
    parts.into_iter().next().unwrap_or_default()
}

fn subagent_state(file: &Path, size: u64, mtime: f64) -> Option<SubagentState> {
    let mark = format!("{size}:{mtime}");
    if let Some(previous) = SUBAGENT_CACHE.lock().unwrap().get(file)
        && previous.mark == mark
    {
        return Some(previous.clone());
    }
    let body = std::fs::read(file).ok()?;
    let body = String::from_utf8_lossy(&body);
    let mut ended = false;
    let mut background = Vec::new();
    for line in body.split('\n') {
        if !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Some(j) = json::parse(line) else { continue };
        let Some(message) = j.get("message").filter(|m| !m.is_null()) else { continue };
        ended = message.get("stop_reason").and_then(|x| x.as_str()) == Some("end_turn");
        for c in message.get("content").and_then(|x| x.as_array()).into_iter().flatten() {
            if c.get("type").and_then(|x| x.as_str()) != Some("tool_use") {
                continue;
            }
            let Some(input) = c.get("input").filter(|x| truthy(Some(x))) else { continue };
            let Some(command) = input.get("command").filter(|x| truthy(Some(x))) else { continue };
            if c.get("name").and_then(|x| x.as_str()) != Some("Monitor") && !truthy(input.get("run_in_background")) {
                continue;
            }
            let m = command_mark(&text(command));
            if m.encode_utf16().count() >= 12 {
                background.push(m);
            }
        }
    }
    let state = SubagentState { mark, ended, background };
    SUBAGENT_CACHE.lock().unwrap().insert(file.to_path_buf(), state.clone());
    Some(state)
}

fn running_subagents(session_id: &str) -> usize {
    let Some(transcript) = transcript_of(session_id) else { return 0 };
    let dir = transcript.parent().unwrap_or(Path::new("")).join(session_id).join("subagents");
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    let mut files: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| f.ends_with(".jsonl")).collect();
    files.sort();
    let now = crate::core::time::now_ms() as f64;
    let mut n = 0;
    for f in files {
        let file = dir.join(f);
        let Ok(meta) = std::fs::metadata(&file) else { continue };
        let mtime = mtime_ms(&meta);
        let age = now - mtime;
        if age > SUBAGENT_BACKGROUND_AGE {
            continue;
        }
        let Some(s) = subagent_state(&file, meta.len(), mtime) else { continue };
        if !s.ended {
            if age < SUBAGENT_MAX_AGE {
                n += 1;
            }
            continue;
        }
        if s.background.is_empty() {
            continue;
        }
        watch_shells();
        let shells = SHELL_COMMANDS.lock().unwrap();
        if s.background.iter().any(|m| shells.iter().any(|c| c.contains(m.as_str()))) {
            n += 1;
        }
    }
    n
}

static BACKGROUND_CACHE: LazyLock<Mutex<HashMap<PathBuf, (u64, f64, Option<Value>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static MOVED: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?:moved to the background as task|moved to the background \(ID:|running in background with ID:)\s*([A-Za-z0-9_-]+)").unwrap());
static FINISHED: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<task-id>([A-Za-z0-9_-]+)</task-id>\s*(?:<tool-use-id>[^<]*</tool-use-id>\s*)?(?:<output-file>[^<]*</output-file>\s*)?<status>(?:completed|failed|killed|stopped)</status>").unwrap());

fn content_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|p| p.get("text").and_then(|t| t.as_str()).map(String::from).unwrap_or_else(|| content_text(p.get("content").unwrap_or(&Value::Null)))).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

pub fn background_what(conversation: &str) -> Option<Value> {
    let file = transcript_of(conversation)?;
    let meta = std::fs::metadata(&file).ok()?;
    let (size, mtime) = (meta.len(), mtime_ms(&meta));
    if let Some((s0, m0, v)) = BACKGROUND_CACHE.lock().unwrap().get(&file) {
        if *s0 == size && *m0 == mtime {
            return v.clone();
        }
    }
    let mut f = std::fs::File::open(&file).ok()?;
    let start = size.saturating_sub(768 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let body = String::from_utf8_lossy(&buf);
    let mut uses: HashMap<String, Value> = HashMap::new();
    let mut pending: Vec<(String, Value)> = Vec::new();
    for line in body.split('\n') {
        let Some(j) = json::parse(line) else { continue };
        let Some(content) = j.get("message").and_then(|m| m.get("content")) else { continue };
        let whole = content_text(content);
        for m in FINISHED.captures_iter(&whole) {
            pending.retain(|(id, _)| id != &m[1]);
        }
        for c in content.as_array().into_iter().flatten() {
            match c.get("type").and_then(|x| x.as_str()) {
                Some("tool_use") => {
                    let input = c.get("input").cloned().unwrap_or(Value::Null);
                    let name = c.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let command: String = input.get("command").or_else(|| input.get("code")).or_else(|| input.get("prompt")).map(text).unwrap_or_default().chars().take(400).collect();
                    let description: String = input.get("description").map(text).unwrap_or_default().chars().take(120).collect();
                    let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    uses.insert(id, json!({ "tool": name, "command": command, "description": description }));
                }
                Some("tool_result") => {
                    let t = content_text(c.get("content").unwrap_or(&Value::Null));
                    if let Some(m) = MOVED.captures(&t) {
                        let origin = c.get("tool_use_id").and_then(|x| x.as_str()).and_then(|id| uses.get(id)).cloned().unwrap_or(json!({}));
                        pending.push((m[1].to_string(), origin));
                    }
                }
                _ => {}
            }
        }
    }
    let found = pending.pop().map(|(_, v)| v);
    BACKGROUND_CACHE.lock().unwrap().insert(file, (size, mtime, found.clone()));
    found
}

pub fn live_status(status: Option<&str>, subagents: usize) -> String {
    if subagents > 0 {
        return "busy".into();
    }
    match status {
        Some("shell") => "idle".into(),
        Some(s) => s.into(),
        None => String::new(),
    }
}

pub fn live_sessions() -> Option<Vec<Value>> {
    let entries = agent().live_entries()?;
    let mut out = Vec::new();
    for e in entries {
        let Some(project) = crate::core::projects::project_of_path(str_of(&e, "cwd").filter(|c| !c.is_empty())) else { continue };
        if !process_alive(e.get("pid")) {
            continue;
        }
        let Some(started) = e.get("startedMs").and_then(|x| x.as_f64()).filter(|x| x.is_finite()) else { continue };
        let conversation = e.get("conversation").map(text).unwrap_or_default();
        let subagents = running_subagents(&conversation);
        let status = live_status(e.get("status").and_then(|x| x.as_str()), subagents);
        let status_since = e.get("statusSinceMs").and_then(|x| x.as_f64()).filter(|x| *x != 0.0 && x.is_finite()).map(|x| Value::String(crate::core::time::iso(x as i64))).unwrap_or(Value::Null);
        let title = conversation_title(&conversation).map(Value::String).unwrap_or(Value::Null);
        out.push(json!({
            "name": e.get("name").cloned().unwrap_or(Value::Null),
            "conversation": e.get("conversation").cloned().unwrap_or(Value::Null),
            "started": crate::core::time::iso(started as i64),
            "status": status,
            "subagents": subagents,
            "background": e.get("background").cloned().unwrap_or(Value::Null),
            "backgroundWhat": if status != "busy" { background_what(&conversation).unwrap_or(Value::Null) } else { Value::Null },
            "project": project.id,
            "statusSince": status_since,
            "title": title,
        }));
    }
    Some(out)
}

pub fn assign_refs(list: &[Value]) -> usize {
    let Some(live) = live_sessions() else { return 0 };
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for v in live {
        let name = v.get("name").map(text).unwrap_or_default();
        match groups.iter_mut().find(|(n, _)| *n == name) {
            Some((_, g)) => g.push(v),
            None => groups.push((name, vec![v])),
        }
    }
    let mut refs = Map::new();
    let by_time = |x: &Value, y: &Value| time_of(x).partial_cmp(&time_of(y)).unwrap_or(std::cmp::Ordering::Equal);
    for (name, mut group) in groups {
        let mut rows: Vec<&Value> = list.iter().filter(|s| s.get("name").map(text).as_deref() == Some(name.as_str()) && truthy(s.get("ref")) && truthy(s.get("started"))).collect();
        if rows.len() != group.len() {
            continue;
        }
        group.sort_by(by_time);
        rows.sort_by(|x, y| by_time(x, y));
        if rows.windows(2).any(|w| time_of(w[0]) == time_of(w[1])) {
            continue;
        }
        for (i, v) in group.iter().enumerate() {
            refs.insert(v.get("conversation").map(text).unwrap_or_default(), json!({ "ref": rows[i].get("ref").cloned().unwrap_or(Value::Null), "started": v.get("started").cloned().unwrap_or(Value::Null) }));
        }
    }
    let count = refs.len();
    crate::core::data::mutate(|d| {
        let mut current = match d.get("refs") {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        for (k, v) in refs {
            current.insert(k, v);
        }
        d.insert("refs".into(), Value::Object(current));
    });
    count
}

fn write_routes(r: &Value) {
    let tmp = PathBuf::from(format!("{}.{}.tmp", ROUTES_FILE.display(), std::process::id()));
    if std::fs::write(&tmp, json::stringify_pretty(r, 2) + "\n").is_ok() {
        let _ = std::fs::rename(&tmp, &*ROUTES_FILE);
    }
}

pub fn load_routes() -> Value {
    let parsed = std::fs::read_to_string(&*ROUTES_FILE).ok().and_then(|t| json::parse(&t));
    match parsed {
        Some(Value::Object(mut r)) => {
            if !truthy(r.get("areas")) {
                r.insert("areas".into(), json!({}));
            }
            Value::Object(r)
        }
        _ => json!({ "areas": {} }),
    }
}

pub fn change_routes<R>(f: impl FnOnce(&mut Value) -> R) -> R {
    let mut r = load_routes();
    let out = f(&mut r);
    write_routes(&r);
    out
}

pub fn rename_area(id: &str, title: &str) -> bool {
    change_routes(|r| {
        let Some(a) = r["areas"].get_mut(id).filter(|a| truthy(Some(a))) else { return false };
        if let Some(o) = a.as_object_mut() {
            o.insert("title".into(), Value::String(title.to_string()));
        }
        true
    })
}

fn registered_in_this_process(x: &Value, v: &Value) -> bool {
    if x.get("session") != v.get("name") || !truthy(x.get("since")) {
        return false;
    }
    let since = x.get("since").and_then(|s| s.as_str()).and_then(crate::core::time::parse);
    let started = v.get("started").and_then(|s| s.as_str()).and_then(crate::core::time::parse);
    matches!((since, started), (Some(a), Some(b)) if a >= b - 2000)
}

fn link(x: &mut Value, v: &Value, taken: &mut HashSet<String>, changed: &mut bool) {
    let Some(o) = x.as_object_mut() else { return };
    if o.get("conversation") != v.get("conversation") {
        o.insert("conversation".into(), v.get("conversation").cloned().unwrap_or(Value::Null));
        taken.insert(v.get("conversation").map(text).unwrap_or_default());
        *changed = true;
    }
    if o.get("session") != v.get("name") {
        o.insert("session".into(), v.get("name").cloned().unwrap_or(Value::Null));
        o.insert("ref".into(), Value::Null);
        o.insert("since".into(), Value::String(crate::core::time::now()));
        *changed = true;
    }
}

fn single(list: Vec<&Value>) -> Option<&Value> {
    if list.len() == 1 { Some(list[0]) } else { None }
}

pub fn reconcile(live: &[Value]) {
    if !ROUTES_FILE.exists() {
        return;
    }
    let mut r = load_routes();
    let mut changed = false;
    let conv_of = |x: &Value| x.get("conversation").filter(|c| truthy(Some(c))).map(text);
    let mut taken: HashSet<String> = r["areas"].as_object().map(|a| a.values().filter_map(conv_of).collect()).unwrap_or_default();
    for role in ["reporter", "orchestrator", "followUp", "board"] {
        if let Some(c) = r.get(role).filter(|x| truthy(Some(x))).and_then(conv_of) {
            taken.insert(c);
        }
    }
    let is_free = |taken: &HashSet<String>, x: &Value| !taken.contains(&x.get("conversation").map(text).unwrap_or_default());
    for role in ["reporter", "orchestrator"] {
        let Some(current) = r.get(role).filter(|x| truthy(Some(x))).cloned() else { continue };
        let found = live.iter().find(|x| x.get("conversation") == current.get("conversation")).or_else(|| single(live.iter().filter(|x| is_free(&taken, x) && registered_in_this_process(&current, x)).collect()));
        if let Some(v) = found {
            link(r.get_mut(role).unwrap(), v, &mut taken, &mut changed);
        }
    }
    let ids: Vec<String> = r["areas"].as_object().map(|a| a.keys().cloned().collect()).unwrap_or_default();
    for id in ids {
        let a = r["areas"][&id].clone();
        let mut found = if truthy(a.get("conversation")) { live.iter().find(|x| x.get("conversation") == a.get("conversation")) } else { None };
        if found.is_none() && !truthy(a.get("conversation")) {
            let title = title_key(&a.get("title").filter(|t| truthy(Some(t))).map(text).unwrap_or_default());
            found = single(live.iter().filter(|x| is_free(&taken, x) && registered_in_this_process(&a, x)).collect())
                .or_else(|| single(live.iter().filter(|x| is_free(&taken, x) && truthy(x.get("title")) && title_key(&x.get("title").map(text).unwrap_or_default()) == title).collect()));
        }
        if let Some(v) = found {
            link(&mut r["areas"][&id], v, &mut taken, &mut changed);
        }
    }
    if changed {
        write_routes(&r);
    }
}

pub fn sessions_cli(args: &[&str]) -> Result<String, String> {
    let exe = crate::core::platform::self_exe().map_err(|e| e.to_string())?;
    let out = std::process::Command::new(&exe).arg("routes").args(args).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("Command failed: {} routes {}\n{}", exe.display(), args.join(" "), String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn current_ref(refs: &Value, live: Option<&Value>) -> Value {
    let Some(live) = live else { return Value::Null };
    let Some(conversation) = live.get("conversation").filter(|c| truthy(Some(c))) else { return Value::Null };
    match refs.get(text(conversation)) {
        Some(x) if x.is_object() && x.get("started") == live.get("started") => x.get("ref").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

pub fn targets(d: &Doc, r: &Value) -> Vec<Value> {
    let empty = Vec::new();
    let open = d.get("sessions").and_then(|s| s.get("list")).and_then(|l| l.as_array()).unwrap_or(&empty);
    let refs = d.get("refs").filter(|x| truthy(Some(x))).cloned().unwrap_or(json!({}));
    let mut count: HashMap<String, usize> = HashMap::new();
    for s in open {
        *count.entry(s.get("name").map(text).unwrap_or_default()).or_default() += 1;
    }
    let by_conversation: HashMap<String, &Value> = open.iter().filter(|s| truthy(s.get("conversation"))).map(|s| (text(&s["conversation"]), s)).collect();
    let open_names: HashSet<String> = open.iter().map(|s| s.get("name").map(text).unwrap_or_default()).collect();
    let mut roles: Vec<&Value> = ["reporter", "orchestrator", "followUp", "board"].iter().filter_map(|k| r.get(*k)).collect();
    if let Some(boxes) = r.get("projectRoles").and_then(|x| x.as_object()) {
        for b in boxes.values() {
            if let Some(o) = b.as_object() {
                roles.extend(o.values());
            }
        }
    }
    roles.retain(|x| truthy(Some(x)));
    let mut out = Vec::new();
    let mut used_conversations = HashSet::new();
    let mut used_names = HashSet::new();
    for (id, a) in r.get("areas").and_then(|x| x.as_object()).into_iter().flatten() {
        let conversation = a.get("conversation").filter(|c| truthy(Some(c))).map(text);
        let session = a.get("session").filter(|c| truthy(Some(c))).map(text);
        if let Some(c) = &conversation {
            used_conversations.insert(c.clone());
        } else if let Some(s) = &session {
            used_names.insert(s.clone());
        }
        let live = conversation.as_ref().and_then(|c| by_conversation.get(c).copied());
        let open_now = match &conversation {
            Some(c) => by_conversation.contains_key(c),
            None => session.as_ref().is_some_and(|s| open_names.contains(s)),
        };
        let project = match a.get("project") {
            Some(p) if truthy(Some(p)) => p.clone(),
            _ => Value::String(crate::core::projects::main_id()),
        };
        out.push(json!({
            "id": id,
            "name": or_value(a.get("title"), Value::String(id.clone())),
            "sessionName": or_value(a.get("session"), Value::Null),
            "conversation": or_value(a.get("conversation"), Value::Null),
            "ref": current_ref(&refs, live),
            "open": open_now,
            "repeatedName": session.as_ref().is_some_and(|s| count.get(s).copied().unwrap_or(0) > 1),
            "epics": or_value(a.get("epics"), json!({})),
            "project": project,
            "keepOpen": truthy(a.get("keepOpen")),
        }));
    }
    for s in open {
        let name = s.get("name").map(text).unwrap_or_default();
        let conversation = s.get("conversation").filter(|c| truthy(Some(c))).map(text);
        let is_role = roles.iter().any(|x| {
            if truthy(x.get("conversation")) {
                s.get("conversation") == x.get("conversation")
            } else {
                truthy(x.get("session")) && s.get("name") == x.get("session")
            }
        });
        let used = match &conversation {
            Some(c) => used_conversations.contains(c),
            None => used_names.contains(&name),
        };
        if is_role || used {
            continue;
        }
        let project = match s.get("project") {
            Some(p) if truthy(Some(p)) => p.clone(),
            _ => Value::String(crate::core::projects::main_id()),
        };
        out.push(json!({
            "id": format!("conv:{}", conversation.clone().unwrap_or_else(|| s.get("name").map(text).unwrap_or_else(|| "undefined".into()))),
            "name": "",
            "sessionName": s.get("name").cloned().unwrap_or(Value::Null),
            "conversation": or_value(s.get("conversation"), Value::Null),
            "ref": current_ref(&refs, Some(s)),
            "open": true,
            "repeatedName": count.get(&name).copied().unwrap_or(0) > 1,
            "epics": {},
            "unnamed": true,
            "project": project,
            "vsCodeTitle": or_value(s.get("title"), Value::Null),
        }));
    }
    out
}

pub fn real_area(id: &str) -> Option<String> {
    if FAKE_AREA.is_match(id) { None } else { Some(id.to_string()) }
}

fn env_without_vs_code() -> HashMap<String, String> {
    std::env::vars().filter(|(k, _)| k != "ELECTRON_RUN_AS_NODE").collect()
}

pub fn clean_env() -> HashMap<String, String> {
    let filter = agent().env_variables();
    let mut env: HashMap<String, String> = std::env::vars().filter(|(k, _)| !filter.is_match(k)).collect();
    if let Some(token) = session_token() {
        env.insert(agent().token_variable().to_string(), token);
    }
    env
}

pub fn session_token() -> Option<String> {
    let body = std::fs::read_to_string(crate::core::config::workspace().join(".env")).ok()?;
    TOKEN_LINE.captures(&body).map(|m| m[1].to_string())
}

pub fn open_in_vs_code(conversation: Option<&str>) {
    let conversation = conversation.filter(|c| !c.is_empty());
    if let Some(c) = conversation
        && crate::sessions::host::hosted_conversations().iter().any(|x| x == c)
    {
        let c = c.to_string();
        std::thread::spawn(move || {
            crate::sessions::host::ensure_host();
            let _ = crate::sessions::host::host_request("POST", "/start", Some(&json!({ "conversation": c })));
        });
        return;
    }
    let url = agent().editor_url(conversation);
    let env = env_without_vs_code();
    crate::core::platform::open_folder_in_editor(&root().to_string_lossy(), Some(&env));
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        crate::core::platform::open_url(&url, Some(&env));
    });
}

fn random_uuid() -> String {
    let mut n: u128 = rand::random();
    n = (n & !(0xF000u128 << 64)) | (0x4000u128 << 64);
    n = (n & !(0xC000u128 << 48)) | (0x8000u128 << 48);
    let h = format!("{n:032x}");
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn create_conversation(name: &str, cwd: Option<&Path>) -> Option<String> {
    let id = random_uuid();
    let mut env = clean_env();
    env.insert("CLAUDE_CODE_ENTRYPOINT".into(), "claude-vscode".into());
    let args = agent().create_args(&json!({ "id": id, "name": name, "model": crate::core::config::session_model(), "prompt": format!("Sesión «{name}» creada desde el tablero de Jira. Responde solo «ok».") }));
    let editor = agent().editor_binary();
    let (exe, args) = agent().command(&args, editor.as_deref());
    let cwd = cwd.map(Path::to_path_buf).unwrap_or_else(root);
    let r = run_bounded(&exe, &args, &RunOptions { cwd: Some(cwd), env: Some(env) }, 90000);
    (r.ok && transcript_of(&id).is_some()).then_some(id)
}

pub fn wake_session(name: &str, notice: Option<&str>) -> bool {
    let notice = notice.filter(|n| !n.is_empty()).unwrap_or(STARTUP_NOTICE);
    let prompt = format!("Usa la herramienta SendMessage (cárgala con ToolSearch si hace falta) con to «{name}» y message exactamente «{notice}». No hagas nada más y responde solo ok.");
    let editor = agent().editor_binary();
    let (exe, args) = agent().command(&agent().wake_args(&prompt), editor.as_deref());
    let r = run_bounded(&exe, &args, &RunOptions { cwd: Some(root()), env: Some(clean_env()) }, 120000);
    r.ok && OK_WORD.is_match(&r.out)
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/pid", &pid.to_string(), "/t", "/f"]).output();
}

pub fn run_bounded(exe: &str, args: &[String], opts: &RunOptions, ms: u64) -> Bounded {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    if let Some(cwd) = &opts.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &opts.env {
        cmd.env_clear().envs(env);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let Ok(mut child) = cmd.spawn() else { return Bounded { ok: false, out: String::new() } };
    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    if let Some(mut stdout) = child.stdout.take() {
        let out = out.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = stdout.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                out.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
        });
    }
    let collected = |out: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&out.lock().unwrap()).to_string();
    let deadline = Instant::now() + Duration::from_millis(ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                std::thread::sleep(Duration::from_millis(300));
                return Bounded { ok: status.success(), out: collected(&out) };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                kill_group(child.id());
                let _ = child.kill();
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Bounded { ok: false, out: collected(&out) };
            }
            Err(_) => return Bounded { ok: false, out: collected(&out) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> (String, Vec<String>) {
        ("/bin/sh".into(), vec!["-c".into(), script.into()])
    }

    #[test]
    fn a_session_whose_only_activity_is_its_own_background_shell_is_idle() {
        assert_eq!(live_status(Some("shell"), 0), "idle");
    }

    #[test]
    fn running_subagents_still_make_a_session_busy() {
        assert_eq!(live_status(Some("shell"), 1), "busy");
        assert_eq!(live_status(Some("idle"), 2), "busy");
    }

    #[test]
    fn other_states_pass_through() {
        assert_eq!(live_status(Some("busy"), 0), "busy");
        assert_eq!(live_status(Some("idle"), 0), "idle");
        assert_eq!(live_status(None, 0), "");
    }

    #[test]
    fn a_process_that_answers_in_time_is_read() {
        let (exe, args) = sh("echo ok");
        let r = run_bounded(&exe, &args, &RunOptions::default(), 5000);
        assert!(r.ok);
        assert!(r.out.contains("ok"));
    }

    #[test]
    fn a_hung_process_whose_child_keeps_the_output_open_is_cut_off_at_the_limit() {
        let (exe, args) = sh("(sleep 60) & sleep 60");
        let started = Instant::now();
        let r = run_bounded(&exe, &args, &RunOptions::default(), 800);
        assert!(!r.ok);
        assert!(started.elapsed() < Duration::from_millis(3000));
    }

    #[test]
    fn a_process_that_exits_with_the_output_still_held_by_its_child_does_not_wait_for_it() {
        let (exe, args) = sh("sleep 2 & echo ok");
        let started = Instant::now();
        let r = run_bounded(&exe, &args, &RunOptions::default(), 10000);
        assert!(r.ok);
        assert!(started.elapsed() < Duration::from_millis(3000));
    }

    #[test]
    fn title_keys_drop_accents_case_and_stop_words() {
        assert_eq!(title_key("Investigación de la Wallet"), "investigacio-n-wallet");
        assert_eq!(title_key(""), "");
    }

    #[test]
    fn fake_area_ids_are_not_real_areas() {
        assert_eq!(real_area("conv:abc"), None);
        assert_eq!(real_area("session:x"), None);
        assert_eq!(real_area("wallet").as_deref(), Some("wallet"));
    }

    #[test]
    fn an_area_pinned_open_shows_keep_open_in_its_target() {
        let _g = crate::testkit::fresh();
        change_routes(|r| r["areas"]["herrero"] = json!({ "title": "Investigación inicial", "epics": {}, "conversation": "11111111-2222-3333-4444-555555555555", "keepOpen": true, "project": "main" }));
        let mut d = crate::core::data::load();
        d.insert("sessions".into(), json!({ "list": [] }));
        let t = targets(&d, &load_routes());
        let a = t.iter().find(|a| a["id"] == "herrero").unwrap();
        assert_eq!(a["keepOpen"], true);
        assert_eq!(a["name"], "Investigación inicial");
        assert_eq!(a["open"], false);
    }

    #[test]
    fn current_ref_needs_the_same_start() {
        let refs = json!({ "c1": { "ref": "R1", "started": "2026-01-01T00:00:00.000Z" } });
        assert_eq!(current_ref(&refs, Some(&json!({ "conversation": "c1", "started": "2026-01-01T00:00:00.000Z" }))), json!("R1"));
        assert_eq!(current_ref(&refs, Some(&json!({ "conversation": "c1", "started": "2026-01-02T00:00:00.000Z" }))), Value::Null);
        assert_eq!(current_ref(&refs, None), Value::Null);
    }
}

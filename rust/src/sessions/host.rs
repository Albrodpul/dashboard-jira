//! Port of src/sessions/host.js.
use crate::core::json::{self, truthy};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

pub static HOST_PORT: LazyLock<u16> = LazyLock::new(|| std::env::var("TOWER_HOST_PORT").ok().and_then(|p| p.parse().ok()).filter(|p| *p != 0).unwrap_or(4749));
pub static HOST_URL: LazyLock<String> = LazyLock::new(|| format!("http://127.0.0.1:{}", *HOST_PORT));
static CONFIG_FILE: LazyLock<PathBuf> = LazyLock::new(|| crate::core::data::DATA_DIR.join("host-sessions.json"));
static LOG_FILE: LazyLock<PathBuf> = LazyLock::new(|| crate::core::data::DATA_DIR.join("host.log"));
static WORKDIR: LazyLock<String> = LazyLock::new(|| {
    let root = crate::core::config::main_project().root.clone().unwrap_or_default().to_string_lossy().replace('\\', "/");
    let mut chars = root.chars();
    match (chars.next(), chars.next()) {
        (Some(d), Some(':')) if d.is_ascii_uppercase() => format!("{}{}", d.to_ascii_lowercase(), &root[1..]),
        _ => root,
    }
});

const BUFFER_BYTES: usize = 400 * 1024;
const RESTART_MS: u64 = 5000;
const PERMISSION_MODE: &str = "acceptEdits";
const POINTER: &str = "[❯>›]";
const STUCK_MS: u64 = 15000;
const PROMPT_DEBOUNCE_MS: u64 = 900;
const DIALOG_WINDOW_MS: i64 = 60000;
const SCROLLBACK: usize = 200;
const PROMPT_SCAN: usize = 40000;
const WATCH_MS: u64 = 3000;
const TICK_MS: u64 = 100;
const DIALOG_NAMES: [&str; 6] = ["/Claude ?in ?Chrome/i", "/fullscreen ?renderer/i", "/[❯>›] ?No, ?exit/i", "/trust ?this ?folder|project ?you ?trust/i", "/Use ?this ?MCP ?server/i", "/MCP ?servers? ?found/i"];

pub enum DialogKeys {
    Fixed(&'static str),
    Choose(fn(&str) -> &'static str),
}

impl DialogKeys {
    pub fn keys(&self, text: &str) -> &'static str {
        match self {
            DialogKeys::Fixed(k) => k,
            DialogKeys::Choose(f) => f(text),
        }
    }
}

static MCP_CONTINUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?i){POINTER} ?Continue ?without")).unwrap());
static MCP_USE_ALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?i){POINTER} ?Use ?this ?and ?all")).unwrap());

fn mcp_choice(text: &str) -> &'static str {
    if MCP_CONTINUE.is_match(text) {
        return "\x1b[A\x1b[A\r";
    }
    if MCP_USE_ALL.is_match(text) {
        return "\x1b[A\r";
    }
    "\r"
}

pub static DIALOGS: LazyLock<Vec<(Regex, DialogKeys)>> = LazyLock::new(|| {
    vec![
        (Regex::new(r"(?i)Claude ?in ?Chrome").unwrap(), DialogKeys::Fixed("\x1b")),
        (Regex::new(r"(?i)fullscreen ?renderer").unwrap(), DialogKeys::Fixed("2\r")),
        (Regex::new(&format!("(?i){POINTER} ?No, ?exit")).unwrap(), DialogKeys::Fixed("\x1b[B\r")),
        (Regex::new(r"(?i)trust ?this ?folder|project ?you ?trust").unwrap(), DialogKeys::Fixed("\r")),
        (Regex::new(r"(?i)Use ?this ?MCP ?server").unwrap(), DialogKeys::Choose(mcp_choice)),
        (Regex::new(r"(?i)MCP ?servers? ?found").unwrap(), DialogKeys::Fixed("\r")),
    ]
});

static UNANSWERED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Enter ?to ?confirm|Esc ?to ?cancel").unwrap());
static CONFIRM_FOOTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Enter ?to ?confirm|Space ?to ?select").unwrap());
static PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Do you want to [^?\n]{1,160}\?").unwrap());
static LATE_DIALOGS: LazyLock<Vec<Regex>> = LazyLock::new(|| vec![Regex::new(r"(?is)autocompact ?at.{0,400}?esc ?(to )?not ?now").unwrap()]);
static AFTER_ANSWER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[⏺⎿✢✳✶✻✽]").unwrap());
static ANSWERED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)esc to interrupt|Interrupted|User rejected").unwrap());
static PROMPT_ON_SCREEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Do\s+you\s+want\s+to\s[^?]{1,160}\?").unwrap());
static FIRST_OPTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[❯>›]?\s*1\.\s*Yes\b").unwrap());
static FOOTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Esc ?to ?cancel").unwrap());
static RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[─━╌▔▁ ]*[─━╌▔▁][─━╌▔▁ ]*$").unwrap());
static ORPHAN_WATCHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bwatch\s+(reports|dispatches|board)\b").unwrap());
static CSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());
static OSC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\][^\x07]*\x07").unwrap());
static CURSOR_FORWARD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[(\d*)C").unwrap());
static CURSOR_MOVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[\d*;?\d*[HfABDEFG]").unwrap());
static BOX_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[─━╌│╭╮╰╯▔▁]+").unwrap());
static BOX_EDGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[─━╌│╭╮╰╯]+").unwrap());
static BOX_SIDES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[│╭╮╰╯]").unwrap());
static RULE_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[─━╌▔▁]+").unwrap());
static INLINE_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\S\n]+").unwrap());
static LINE_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\n\s*").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static NOT_LETTERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());
static ING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\p{L}+?)ing").unwrap());
static FIRST_YES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)1\.\s*Yes").unwrap());
static ATTACH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/attach/([0-9a-f-]{36})").unwrap());
static SESSION_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.json$").unwrap());

pub static HOST_HEAD: LazyLock<Option<String>> = LazyLock::new(|| {
    let out = crate::core::platform::cmd("git").arg("-C").arg(crate::core::config::repo()).args(["rev-parse", "HEAD"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
});
pub static HOST_STARTED: LazyLock<String> = LazyLock::new(crate::core::time::now);
pub static HOST_BUILD: LazyLock<Option<String>> = LazyLock::new(binary_build);

#[derive(Debug, Clone, PartialEq)]
pub struct NativePrompt {
    pub question: String,
    pub text: String,
}

pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct Pty {
    pub pid: Option<u32>,
    pub writer: SharedWriter,
    pub master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    pub killer: Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

impl Pty {
    pub fn write(&self, data: &str) {
        let mut w = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        let _ = w.write_all(data.as_bytes());
        let _ = w.flush();
    }

    pub fn write_later(&self, data: &str, ms: u64) {
        let writer = self.writer.clone();
        let data = data.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            let mut w = writer.lock().unwrap_or_else(|p| p.into_inner());
            let _ = w.write_all(data.as_bytes());
            let _ = w.flush();
        });
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(m) = &self.master {
            let _ = m.resize(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn kill(&mut self) {
        if let Some(k) = self.killer.as_mut() {
            let _ = k.kill();
        }
    }
}

pub struct Viewer {
    pub id: u64,
    pub tx: mpsc::Sender<String>,
}

pub struct Session {
    pub conversation: String,
    pub name: String,
    pub buffer: String,
    pub total: usize,
    pub late_mark: usize,
    pub dialog_mark: usize,
    pub clients: Vec<Viewer>,
    pub cols: u16,
    pub rows: u16,
    pub restarts: u32,
    pub stopping: bool,
    pub started_at: Option<String>,
    pub exited_at: Option<String>,
    pub pty: Option<Pty>,
    pub term: Option<vt100::Parser>,
    pub generation: u64,
    pub prompt_key: Option<String>,
    pub prompt_due: Option<Instant>,
    pub stuck: Option<Value>,
    pub stuck_since: i64,
    pub stuck_due: Option<Instant>,
    pub last_input: i64,
    pub restart_due: Option<Instant>,
    pub started_ms: i64,
}

impl Session {
    pub fn new(conversation: &str, name: &str) -> Session {
        Session {
            conversation: conversation.to_string(),
            name: name.to_string(),
            buffer: String::new(),
            total: 0,
            late_mark: 0,
            dialog_mark: 0,
            clients: Vec::new(),
            cols: 120,
            rows: 40,
            restarts: 0,
            stopping: false,
            started_at: None,
            exited_at: None,
            pty: None,
            term: None,
            generation: 0,
            prompt_key: None,
            prompt_due: None,
            stuck: None,
            stuck_since: 0,
            stuck_due: None,
            last_input: 0,
            restart_due: None,
            started_ms: 0,
        }
    }

    fn broadcast(&mut self, data: &str) {
        self.clients.retain(|c| c.tx.send(data.to_string()).is_ok());
    }
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_VIEWER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn sessions() -> std::sync::MutexGuard<'static, HashMap<String, Session>> {
    SESSIONS.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn ensure_permission_hook(root: &std::path::Path) {
    let hook = crate::core::config::workspace().join("permission-hook.js");
    if !hook.exists() || !root.is_dir() {
        return;
    }
    let dir = root.join(".claude");
    let has_hook = |file: &std::path::Path| std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map_or(false, |v| v.pointer("/hooks/PreToolUse").map_or(false, |h| h.to_string().contains("permission-hook")));
    if has_hook(&dir.join("settings.json")) || has_hook(&dir.join("settings.local.json")) {
        return;
    }
    let file = dir.join("settings.local.json");
    let mut settings = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
    let entry = json!({ "matcher": "*", "hooks": [{ "type": "command", "command": format!("node {}", hook.to_string_lossy()), "timeout": 3600 }] });
    let obj = settings.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let pre = hooks.as_object_mut().unwrap().entry("PreToolUse").or_insert_with(|| json!([]));
    if !pre.is_array() {
        *pre = json!([]);
    }
    pre.as_array_mut().unwrap().insert(0, entry);
    let _ = std::fs::create_dir_all(&dir);
    let text = serde_json::to_string_pretty(&settings).unwrap_or_default() + "\n";
    if std::fs::write(&file, text).is_ok() {
        log(&format!("hook de permisos añadido en {}", file.to_string_lossy()));
    }
}

fn agent() -> &'static dyn crate::agents::index::Agent {
    crate::agents::index::main()
}

fn text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => json::stringify(other),
    }
}

fn boundary_up(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

fn from_byte(s: &str, i: usize) -> &str {
    &s[boundary_up(s, i)..]
}

fn last_bytes(s: &str, n: usize) -> &str {
    from_byte(s, s.len().saturating_sub(n))
}

fn last_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

fn first_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn char_index(s: &str, byte: usize) -> usize {
    s[..byte].chars().count()
}

fn chars_between(s: &str, from: usize, to: usize) -> String {
    s.chars().skip(from).take(to.saturating_sub(from)).collect()
}

fn mtime_ms(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)
}

pub fn binary_build() -> Option<String> {
    let exe = crate::core::platform::self_exe().ok()?;
    let meta = std::fs::metadata(exe).ok()?;
    Some(format!("{}-{}", mtime_ms(&meta), meta.len()))
}

pub fn read_config() -> Vec<Value> {
    match std::fs::read_to_string(&*CONFIG_FILE).ok().and_then(|t| json::parse(&t)) {
        Some(Value::Array(list)) => list,
        _ => Vec::new(),
    }
}

fn write_config(list: &[Value]) {
    let _ = std::fs::write(&*CONFIG_FILE, json::stringify_pretty(&Value::Array(list.to_vec()), 1));
}

fn log(message: &str) {
    crate::core::logfile::append_log(&LOG_FILE, &format!("[{}] {message}\n", crate::core::time::now()));
}

fn size_frame(s: &Session) -> String {
    format!("\u{0000}{}", json::stringify(&json!({ "cols": s.cols, "rows": s.rows })))
}

fn plain(s: &str) -> String {
    OSC.replace_all(&CSI.replace_all(s, ""), "").to_string()
}

pub fn readable(s: &str) -> String {
    let forward = CURSOR_FORWARD.replace_all(s, |c: &regex::Captures| {
        let n = c[1].parse::<usize>().unwrap_or(0);
        " ".repeat(if n == 0 { 1 } else { n.min(40) })
    });
    let moved = CURSOR_MOVE.replace_all(&forward, " ");
    let p = plain(&moved);
    let p = BOX_RUNS.replace_all(&p, " ");
    let p = INLINE_SPACE.replace_all(&p, " ");
    LINE_SPACE.replace_all(&p, "\n").trim().to_string()
}

pub fn emulator(cols: u16, rows: u16) -> vt100::Parser {
    let size = |n: u16| std::num::NonZeroU16::new(n).unwrap_or(std::num::NonZeroU16::MIN);
    vt100::Parser::new(size(rows), size(cols), SCROLLBACK)
}

pub fn resize_emulator(term: &mut vt100::Parser, cols: u16, rows: u16) {
    let size = |n: u16| std::num::NonZeroU16::new(n).unwrap_or(std::num::NonZeroU16::MIN);
    term.set_size(size(rows), size(cols));
}

pub fn screen_lines(term: &vt100::Parser) -> Vec<String> {
    let (_, cols) = term.screen().size();
    term.screen().rows(0, cols.get()).map(|r| r.trim_end().to_string()).collect()
}

fn stuck_check(s: &mut Session) {
    if s.pty.is_none() || s.stuck.is_some() {
        return;
    }
    let screen = s.term.as_ref().map(screen_lines);
    let fresh = match &screen {
        Some(lines) => lines.join("\n"),
        None => plain(from_byte(&s.buffer, s.dialog_mark)),
    };
    if !UNANSWERED.is_match(&fresh) || PROMPT.is_match(&fresh) || (s.last_input != 0 && s.last_input > s.stuck_since) {
        return;
    }
    let body = match &screen {
        Some(lines) => lines.iter().map(|l| BOX_RUNS.replace_all(l, " ").trim().to_string()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"),
        None => readable(&last_chars(&s.buffer, 3000)),
    };
    let rows: Vec<&str> = body.split('\n').collect();
    let text = last_chars(&rows[rows.len().saturating_sub(14)..].join("\n"), 900);
    s.stuck = Some(json!({ "at": crate::core::time::now() }));
    log(&format!("stuck {}: {}", s.name, json::stringify(&Value::String(last_chars(&text, 200)))));
    post_board("/api/host/stuck", json!({ "conversation": s.conversation, "name": s.name, "text": text }));
}

fn unstuck(s: &mut Session) {
    s.stuck_due = None;
    if s.stuck.is_none() {
        return;
    }
    s.stuck = None;
    post_board("/api/host/stuck", json!({ "conversation": s.conversation, "cleared": true }));
}

fn type_into(s: &mut Session, data: &str) {
    s.last_input = crate::core::time::now_ms();
    let answers = data.contains('\r') || data == "\x1b" || (data.len() == 1 && data.as_bytes()[0].is_ascii_digit());
    if answers && s.prompt_key.is_some() {
        s.prompt_key = None;
        s.prompt_due = Some(Instant::now() + Duration::from_millis(1500));
    }
    unstuck(s);
    if let Some(p) = &s.pty {
        p.write(data);
    }
}

fn entry_text(entry: &Value, key: &str) -> Option<String> {
    entry.get(key).filter(|v| truthy(Some(v))).map(|v| text(Some(v)))
}

fn spawn(entry: &Value, notify: bool) -> bool {
    let conversation = text(entry.get("conversation"));
    let name = text(entry.get("name"));
    let mut all = sessions();
    if all.get(&conversation).is_some_and(|s| s.pty.is_some()) {
        return true;
    }
    if !crate::cluster::cluster::primary_now() {
        log(&format!("no arranco {name}: este ordenador no manda"));
        return false;
    }
    if notify {
        let c = conversation.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20000));
            tell_board(&c);
        });
    }
    let s = all.entry(conversation.clone()).or_insert_with(|| Session::new(&conversation, &name));
    s.name = name.clone();
    s.stopping = false;
    s.started_at = Some(crate::core::time::now());
    s.started_ms = crate::core::time::now_ms();
    s.dialog_mark = s.buffer.len();
    s.term = Some(emulator(s.cols, s.rows));
    let mut options = Map::new();
    options.insert("conversation".into(), Value::String(conversation.clone()));
    if let Some(f) = entry.get("fresh") {
        options.insert("fresh".into(), f.clone());
    }
    options.insert("name".into(), Value::String(name.clone()));
    options.insert("permissionMode".into(), Value::String(PERMISSION_MODE.into()));
    options.insert("profile".into(), json!(crate::sessions::profiles::profile_args(&conversation)));
    let args = agent().hosted_args(&Value::Object(options));
    if truthy(entry.get("fresh")) {
        let mut list = read_config();
        if let Some(e) = list.iter_mut().find(|x| x.get("conversation").map(|c| text(Some(c))).as_deref() == Some(conversation.as_str()))
            && let Some(o) = e.as_object_mut()
        {
            o.remove("fresh");
        }
        write_config(&list);
    }
    let cli = agent().cli();
    let (exe, full_args) = agent().command(&args, Some(&cli));
    let cwd = entry_text(entry, "cwd").or_else(|| conversation_root(&conversation).map(|p| p.to_string_lossy().to_string())).unwrap_or_else(|| WORKDIR.clone());
    if agent().id() == crate::agents::claude::ID {
        ensure_permission_hook(std::path::Path::new(&cwd));
    }
    let system = portable_pty::native_pty_system();
    let pair = match system.openpty(portable_pty::PtySize { rows: s.rows, cols: s.cols, pixel_width: 0, pixel_height: 0 }) {
        Ok(p) => p,
        Err(e) => {
            log(&format!("crash: {e}"));
            return false;
        }
    };
    let mut cmd = portable_pty::CommandBuilder::new(&exe);
    cmd.args(&full_args);
    cmd.cwd(&cwd);
    cmd.env_clear();
    cmd.env("MCP_TIMEOUT", "120000");
    for (k, v) in crate::sessions::registry::clean_env() {
        cmd.env(k, v);
    }
    cmd.env("TOWER_HOSTED", "1");
    cmd.env("TERM", "xterm-256color");
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            log(&format!("crash: {e}"));
            return false;
        }
    };
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();
    let (Ok(reader), Ok(writer)) = (pair.master.try_clone_reader(), pair.master.take_writer()) else {
        let _ = child.kill();
        return false;
    };
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    s.generation = generation;
    s.pty = Some(Pty { pid, writer: Arc::new(Mutex::new(writer)), master: Some(pair.master), killer: Some(killer) });
    log(&format!("start {name} {conversation} pid {}", pid.map(|p| p.to_string()).unwrap_or_else(|| "undefined".into())));
    drop(all);
    let c = conversation.clone();
    std::thread::spawn(move || read_output(reader, &c, generation));
    let c = conversation.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        on_exit(&c, generation, code);
    });
    true
}

fn read_output(mut reader: Box<dyn Read + Send>, conversation: &str, generation: u64) {
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&chunk[..n]);
        let decoded = match std::str::from_utf8(&pending) {
            Ok(s) => {
                let out = s.to_string();
                pending.clear();
                out
            }
            Err(e) if e.error_len().is_none() => {
                let valid = e.valid_up_to();
                let out = String::from_utf8_lossy(&pending[..valid]).to_string();
                pending.drain(..valid);
                out
            }
            Err(_) => {
                let out = String::from_utf8_lossy(&pending).to_string();
                pending.clear();
                out
            }
        };
        if cfg!(windows) && decoded.contains("\x1b[6n") {
            let all = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(pty) = all.get(conversation).filter(|x| x.generation == generation).and_then(|x| x.pty.as_ref()) {
                pty.write("\x1b[1;1R");
            }
        }
        if !decoded.is_empty() {
            on_output(conversation, generation, &decoded);
        }
    }
}

fn on_output(conversation: &str, generation: u64, data: &str) {
    let mut all = sessions();
    let Some(s) = all.get_mut(conversation) else { return };
    if s.generation != generation {
        return;
    }
    s.buffer.push_str(data);
    s.total += data.len();
    if s.buffer.len() > BUFFER_BYTES {
        let cut = boundary_up(&s.buffer, s.buffer.len() - BUFFER_BYTES);
        s.buffer.drain(..cut);
    }
    if let Some(t) = s.term.as_mut() {
        t.process(data.as_bytes());
    }
    s.broadcast(data);
    s.prompt_due = Some(Instant::now() + Duration::from_millis(PROMPT_DEBOUNCE_MS));
    if crate::core::time::now_ms() - s.started_ms < DIALOG_WINDOW_MS {
        let fresh = plain(from_byte(&s.buffer, s.dialog_mark));
        let mut answered = false;
        for (i, (re, keys)) in DIALOGS.iter().enumerate() {
            if re.is_match(&fresh) && CONFIRM_FOOTER.is_match(&fresh) {
                s.dialog_mark = s.buffer.len();
                if let Some(p) = &s.pty {
                    p.write_later(keys.keys(&fresh), 300);
                }
                log(&format!("dialog {} in {}", DIALOG_NAMES[i], s.name));
                answered = true;
                break;
            }
        }
        if !answered && s.stuck_due.is_none() && s.stuck.is_none() && UNANSWERED.is_match(&fresh) && !PROMPT.is_match(&fresh) {
            s.stuck_since = crate::core::time::now_ms();
            s.stuck_due = Some(Instant::now() + Duration::from_millis(STUCK_MS));
        }
    }
}

fn on_exit(conversation: &str, generation: u64, code: u32) {
    let mut all = sessions();
    let Some(s) = all.get_mut(conversation) else { return };
    if s.generation != generation {
        return;
    }
    log(&format!("exit {} code {code}: {}", s.name, json::stringify(&Value::String(plain(&last_chars(&s.buffer, 600))))));
    s.pty = None;
    s.term = None;
    unstuck(s);
    s.exited_at = Some(crate::core::time::now());
    let notice = format!("\r\n\x1b[33m[La sesión se ha cerrado (código {code}).{}]\x1b[0m\r\n", if s.stopping { "" } else { " Se reabre sola en unos segundos." });
    s.broadcast(&notice);
    let still = read_config().iter().any(|x| x.get("conversation").and_then(|c| c.as_str()) == Some(conversation));
    if !s.stopping && still {
        s.restarts += 1;
        s.restart_due = Some(Instant::now() + Duration::from_millis(RESTART_MS * u64::from(s.restarts.min(6))));
    }
}

fn stop(conversation: &str) -> bool {
    let mut all = sessions();
    let Some(s) = all.get_mut(conversation) else { return false };
    let Some(p) = s.pty.as_mut() else { return false };
    s.stopping = true;
    let pid = p.pid;
    p.kill();
    drop(all);
    if let Some(pid) = pid {
        crate::core::platform::kill_tree(pid);
    }
    true
}

fn summary() -> Value {
    let all = sessions();
    Value::Array(
        read_config()
            .iter()
            .map(|e| {
                let conversation = text(e.get("conversation"));
                let s = all.get(&conversation);
                let mut o = Map::new();
                o.insert("conversation".into(), e.get("conversation").cloned().unwrap_or(Value::Null));
                o.insert("name".into(), e.get("name").cloned().unwrap_or(Value::Null));
                o.insert("running".into(), Value::Bool(s.is_some_and(|s| s.pty.is_some())));
                if let Some(at) = s.and_then(|s| s.started_at.clone()) {
                    o.insert("startedAt".into(), Value::String(at));
                }
                if let Some(at) = s.and_then(|s| s.exited_at.clone()) {
                    o.insert("exitedAt".into(), Value::String(at));
                }
                o.insert("restarts".into(), json!(s.map(|s| s.restarts).unwrap_or(0)));
                o.insert("viewers".into(), json!(s.map(|s| s.clients.len()).unwrap_or(0)));
                o.insert("waitingForVsCode".into(), Value::Bool(truthy(e.get("waitingForVsCode"))));
                Value::Object(o)
            })
            .collect(),
    )
}

struct Request {
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 1024 * 1024 {
            return None;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let url = first.next()?.to_string();
    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let mut body = buf[end + 4..].to_vec();
    let length = headers.get("content-length").and_then(|l| l.parse::<usize>().ok()).unwrap_or(0);
    while body.len() < length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length.max(0));
    Some(Request { method, url, headers, body })
}

fn respond(stream: &mut TcpStream, code: u16, body: &Value) {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        _ => "OK",
    };
    let text = json::stringify(body);
    let _ = write!(stream, "HTTP/1.1 {code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
    let _ = stream.flush();
}

fn handle_connection(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Some(req) = read_request(&mut stream) else { return };
    if req.headers.get("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket")) {
        attach(stream, &req);
        return;
    }
    let input = if req.body.is_empty() { json!({}) } else { json::parse(&String::from_utf8_lossy(&req.body)).unwrap_or(json!({})) };
    if req.method == "POST" && req.url == "/quit" {
        respond(&mut stream, 200, &json!({ "ok": true }));
        let open: Vec<String> = sessions().keys().cloned().collect();
        for c in open {
            stop(&c);
        }
        std::thread::sleep(Duration::from_millis(300));
        std::process::exit(0);
    }
    let (code, body) = handle_request(&req.method, &req.url, &input);
    respond(&mut stream, code, &body);
}

fn same_conversation(x: &Value, input: &Value) -> bool {
    x.get("conversation") == input.get("conversation")
}

fn handle_request(method: &str, url: &str, input: &Value) -> (u16, Value) {
    match (method, url) {
        ("GET", "/sessions") => (200, summary()),
        ("GET", "/version") => (200, json!({ "head": *HOST_HEAD, "startedAt": *HOST_STARTED, "build": *HOST_BUILD })),
        ("POST", "/start") => {
            let mut list = read_config();
            let mut e = match list.iter().find(|x| same_conversation(x, input)) {
                Some(e) => e.clone(),
                None => {
                    if !truthy(input.get("conversation")) || !truthy(input.get("name")) {
                        return (400, json!({ "error": "faltan conversation y name" }));
                    }
                    let e = json!({ "conversation": input["conversation"], "name": input["name"], "cwd": if truthy(input.get("cwd")) { input["cwd"].clone() } else { Value::Null }, "fresh": truthy(input.get("fresh")), "at": crate::core::time::now() });
                    list.push(e.clone());
                    write_config(&list);
                    e
                }
            };
            if truthy(e.get("waitingForVsCode")) {
                return (200, json!({ "waiting": true }));
            }
            if truthy(e.get("onDemand")) {
                let mut again = read_config();
                if let Some(o) = again.iter_mut().find(|x| same_conversation(x, &e)).and_then(|x| x.as_object_mut()) {
                    o.remove("onDemand");
                }
                write_config(&again);
                if let Some(o) = e.as_object_mut() {
                    o.remove("onDemand");
                }
            }
            spawn(&e, true);
            (200, json!({ "ok": true }))
        }
        ("POST", "/stop") => (200, json!({ "stopped": stop(&text(input.get("conversation"))) })),
        ("POST", "/release") => {
            stop(&text(input.get("conversation")));
            let kept: Vec<Value> = read_config().into_iter().filter(|x| !same_conversation(x, input)).collect();
            write_config(&kept);
            (200, json!({ "ok": true }))
        }
        ("POST", "/input") => {
            let mut all = sessions();
            match all.get_mut(&text(input.get("conversation"))).filter(|s| s.pty.is_some()) {
                None => (409, json!({ "error": "la sesión no está en marcha" })),
                Some(s) => {
                    let data = if truthy(input.get("data")) { text(input.get("data")) } else { String::new() };
                    type_into(s, &data);
                    (200, json!({ "ok": true }))
                }
            }
        }
        _ => (404, json!({ "error": "no existe" })),
    }
}

fn attach(mut stream: TcpStream, req: &Request) {
    let Some(conversation) = ATTACH.captures(&req.url).map(|m| m[1].to_string()) else { return };
    let Some(key) = req.headers.get("sec-websocket-key").cloned() else { return };
    let (tx, rx) = mpsc::channel::<String>();
    let id = NEXT_VIEWER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let agent_name = req.headers.get("user-agent").cloned().unwrap_or_else(|| "?".into()).replace("Mozilla/5.0 ", "");
    let who = format!("{} {}", req.headers.get("origin").cloned().unwrap_or_else(|| "?".into()), first_chars(&agent_name, 70));
    {
        let mut all = sessions();
        let Some(s) = all.get_mut(&conversation) else { return };
        let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
        if write!(stream, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").is_err() {
            return;
        }
        let _ = tx.send(size_frame(s));
        let _ = tx.send(s.buffer.clone());
        if s.pty.is_none() {
            let _ = tx.send("\r\n\x1b[33m[La sesión no está en marcha.]\x1b[0m\r\n".into());
        }
        s.clients.push(Viewer { id, tx });
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
    let mut ws = tungstenite::WebSocket::from_raw_socket(stream, tungstenite::protocol::Role::Server, None);
    'outer: loop {
        while let Ok(out) = rx.try_recv() {
            if ws.send(tungstenite::Message::text(out)).is_err() {
                break 'outer;
            }
        }
        match ws.read() {
            Ok(tungstenite::Message::Text(t)) => on_viewer_message(&conversation, &who, t.as_str()),
            Ok(tungstenite::Message::Binary(b)) => on_viewer_message(&conversation, &who, &String::from_utf8_lossy(&b)),
            Ok(tungstenite::Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
    }
    if let Some(s) = sessions().get_mut(&conversation) {
        s.clients.retain(|c| c.id != id);
    }
}

fn on_viewer_message(conversation: &str, who: &str, raw: &str) {
    let Some(msg) = json::parse(raw) else { return };
    let mut all = sessions();
    let Some(s) = all.get_mut(conversation) else { return };
    let kind = msg.get("type").and_then(|t| t.as_str());
    if kind == Some("input") && s.pty.is_some() {
        type_into(s, &text(msg.get("data")));
    }
    let cols = msg.get("cols").and_then(|c| c.as_f64()).unwrap_or(f64::NAN);
    let rows = msg.get("rows").and_then(|c| c.as_f64()).unwrap_or(f64::NAN);
    if kind == Some("resize") && s.pty.is_some() && cols > 20.0 && rows > 5.0 {
        log(&format!("resize {} {}x{} -> {}x{} by {who}", s.name, s.cols, s.rows, text(msg.get("cols")), text(msg.get("rows"))));
        s.cols = (cols.trunc() as i64).min(300) as u16;
        s.rows = (rows.trunc() as i64).min(120) as u16;
        if let Some(p) = &s.pty {
            p.resize(s.cols, s.rows);
        }
        let (c, r) = (s.cols, s.rows);
        if let Some(t) = s.term.as_mut() {
            resize_emulator(t, c, r);
        }
        let frame = size_frame(s);
        s.broadcast(&frame);
    }
}

fn tick() {
    let now = Instant::now();
    let mut restart = Vec::new();
    {
        let mut all = sessions();
        for s in all.values_mut() {
            if s.prompt_due.is_some_and(|t| t <= now) {
                s.prompt_due = None;
                check_prompt(s);
            }
            if s.stuck_due.is_some_and(|t| t <= now) {
                s.stuck_due = None;
                stuck_check(s);
            }
            if s.restart_due.is_some_and(|t| t <= now) {
                s.restart_due = None;
                restart.push(s.conversation.clone());
            }
        }
    }
    for c in restart {
        if let Some(e) = read_config().into_iter().find(|x| x.get("conversation").and_then(|v| v.as_str()) == Some(c.as_str())) {
            spawn(&e, true);
        }
    }
}

fn watch_primary() {
    if !crate::cluster::cluster::primary_now() {
        let running: Vec<(String, String)> = sessions().values().filter(|s| s.pty.is_some()).map(|s| (s.conversation.clone(), s.name.clone())).collect();
        for (conversation, name) in running {
            if stop(&conversation) {
                log(&format!("paro {name}: este ordenador ya no manda"));
            }
        }
        return;
    }
    let mut list = read_config();
    let mut changed = false;
    for i in 0..list.len() {
        if !truthy(list[i].get("waitingForVsCode")) {
            continue;
        }
        if !vs_code_has(&text(list[i].get("conversation"))) {
            if let Some(o) = list[i].as_object_mut() {
                o.remove("waitingForVsCode");
            }
            changed = true;
            spawn(&list[i].clone(), true);
        }
    }
    if changed {
        write_config(&list);
    }
}

pub fn serve() {
    LazyLock::force(&HOST_BUILD);
    LazyLock::force(&HOST_HEAD);
    LazyLock::force(&HOST_STARTED);
    std::panic::set_hook(Box::new(|info| {
        log(&format!("crash: {info}"));
        std::process::exit(1);
    }));
    let listener = match TcpListener::bind(("127.0.0.1", *HOST_PORT)) {
        Ok(l) => l,
        Err(e) => {
            log(&format!("crash: {e}"));
            std::process::exit(1);
        }
    };
    log(&format!("host listening on {}", *HOST_PORT));
    for e in read_config() {
        if !truthy(e.get("waitingForVsCode")) && !truthy(e.get("onDemand")) {
            spawn(&e, true);
        }
    }
    crate::features::board_alive::start(crate::features::board_alive::StartOptions { minutes: None, log: Some(Arc::new(log)) });
    std::thread::spawn(|| {
        loop {
            std::thread::sleep(Duration::from_millis(TICK_MS));
            tick();
        }
    });
    std::thread::spawn(|| {
        loop {
            std::thread::sleep(Duration::from_millis(WATCH_MS));
            watch_primary();
        }
    });
    for stream in listener.incoming().flatten() {
        std::thread::spawn(move || handle_connection(stream));
    }
}

fn kill_orphan_watchers() -> usize {
    use crate::core::platform::{is_shell, kill_tree, processes};
    let rows = processes();
    if rows.is_empty() {
        return 0;
    }
    let by_pid: HashMap<u32, &crate::core::platform::Process> = rows.iter().map(|r| (r.pid, r)).collect();
    let mut killed = 0;
    for r in &rows {
        if !ORPHAN_WATCHER.is_match(&r.command) || (r.name != "node" && r.name != "tower") {
            continue;
        }
        let mut p = by_pid.get(&r.ppid).copied();
        while let Some(x) = p.filter(|x| is_shell(&x.name)) {
            p = by_pid.get(&x.ppid).copied();
        }
        if p.is_some() {
            continue;
        }
        kill_tree(r.pid);
        killed += 1;
    }
    if killed > 0 {
        log(&format!("killed {killed} orphan watcher(s)"));
    }
    killed
}

fn post_board(route: &str, body: Value) {
    let url = format!("{}{route}", *crate::core::data::BASE_URL);
    std::thread::spawn(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_millis(5000))).http_status_as_error(false).build().into();
        let _ = agent.post(&url).header("origin", crate::core::data::BASE_URL.as_str()).header("content-type", "application/json").send(json::stringify(&body));
    });
}

pub fn late_dialog(s: &mut Session) -> bool {
    let unseen = 4000i64.min(s.total as i64 - s.late_mark as i64).min(s.buffer.len() as i64);
    if unseen <= 0 {
        return false;
    }
    let tail = readable(last_bytes(&s.buffer, unseen as usize));
    if !LATE_DIALOGS.iter().any(|re| re.is_match(&tail)) {
        return false;
    }
    s.late_mark = s.total;
    log(&format!("late dialog in {}: Esc", s.name));
    if let Some(p) = &s.pty {
        p.write_later("\x1b", 300);
    }
    true
}

fn letters(s: &str) -> String {
    NOT_LETTERS.replace_all(s, "").to_string()
}

fn without_doubled_ing(tail: &str) -> String {
    let chars: Vec<char> = tail.chars().collect();
    let mut i = 1;
    while i < chars.len() && chars[i - 1].is_alphabetic() {
        if chars[i].is_alphabetic() && chars.get(i + 1) == Some(&chars[i]) && chars.get(i + 2..i + 5).is_some_and(|x| x == ['i', 'n', 'g']) {
            return chars[..=i].iter().chain(chars[i + 5..].iter()).collect();
        }
        i += 1;
    }
    tail.to_string()
}

fn answered_after(before: &str, after: &str) -> bool {
    if ANSWERED.is_match(after) {
        return true;
    }
    let seen = letters(before);
    for m in AFTER_ANSWER.find_iter(after) {
        let at = char_index(after, m.start());
        let tail = letters(&chars_between(after, at + 1, at + 60));
        let keys: Vec<String> = [tail.clone(), ING.replacen(&tail, 1, "$1").to_string(), without_doubled_ing(&tail)].iter().map(|k| first_chars(k, 10)).collect();
        if keys[0].chars().count() >= 4 && keys.iter().all(|k| !seen.contains(k.as_str())) {
            return true;
        }
    }
    false
}

pub fn prompt_in(raw: &str) -> Option<NativePrompt> {
    let text = readable(last_bytes(raw, PROMPT_SCAN));
    let last = PROMPT.find_iter(&text).last()?;
    let after = &text[last.end()..];
    if !FIRST_YES.is_match(&first_chars(after, 400)) || answered_after(&text[..last.start()], after) {
        return None;
    }
    let at = char_index(&text, last.start());
    let around = chars_between(&text, at.saturating_sub(700), at + 400);
    let around = SPACES.replace_all(&BOX_EDGES.replace_all(&around, " "), " ").trim().to_string();
    Some(NativePrompt { question: last.as_str().to_string(), text: around })
}

pub fn prompt_on_screen(lines: &[String]) -> Option<NativePrompt> {
    let rows: Vec<String> = lines.iter().map(|l| BOX_SIDES.replace_all(l, " ").trim().to_string()).collect();
    let footer = rows.iter().rposition(|r| FOOTER.is_match(r))?;
    let option = (footer.saturating_sub(20)..footer).rev().find(|&i| FIRST_OPTION.is_match(&rows[i]))?;
    let from = option.saturating_sub(6);
    let above = rows[from..option].join("\n");
    let last = PROMPT_ON_SCREEN.find_iter(&above).last()?;
    let q_row = from + above[..last.start()].matches('\n').count();
    let mut start = q_row.saturating_sub(25);
    for i in (start..q_row).rev() {
        if RULE.is_match(&rows[i]) {
            start = i + 1;
            break;
        }
    }
    let text = SPACES.replace_all(&RULE_RUNS.replace_all(&rows[start..=footer].join(" "), " "), " ").trim().to_string();
    Some(NativePrompt { question: SPACES.replace_all(last.as_str(), " ").to_string(), text })
}

fn check_prompt(s: &mut Session) {
    if late_dialog(s) {
        return;
    }
    let found = match &s.term {
        Some(t) => prompt_on_screen(&screen_lines(t)),
        None => prompt_in(&s.buffer),
    };
    match found {
        Some(f) => {
            let key = format!("{}{}", f.question, first_chars(&f.text, 200));
            if s.prompt_key.as_deref() == Some(key.as_str()) {
                return;
            }
            s.prompt_key = Some(key);
            log(&format!("native prompt in {}: {}", s.name, f.question));
            post_board("/api/host/prompt", json!({ "conversation": s.conversation, "name": s.name, "question": f.question, "text": last_chars(&f.text, 1500) }));
        }
        None if s.prompt_key.is_some() => {
            s.prompt_key = None;
            post_board("/api/host/prompt", json!({ "conversation": s.conversation, "cleared": true }));
        }
        None => {}
    }
}

fn tell_board(conversation: &str) {
    kill_orphan_watchers();
    post_board("/api/host/respawned", json!({ "conversation": conversation }));
}

#[cfg(unix)]
fn signal_zero(pid: i64) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn signal_zero(pid: i64) -> bool {
    !crate::core::platform::command_line(pid as u32).is_empty()
}

pub fn vs_code_has(conversation: &str) -> bool {
    let dir = agent().sessions_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return false };
    let mut files: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| SESSION_FILE.is_match(f)).collect();
    files.sort();
    for f in files {
        let Some(j) = std::fs::read_to_string(dir.join(&f)).ok().and_then(|t| json::parse(&t)) else { return false };
        if j.get("sessionId").and_then(|s| s.as_str()) != Some(conversation) {
            continue;
        }
        let Some(pid) = j.get("pid").and_then(|p| p.as_i64()) else { continue };
        if !signal_zero(pid) {
            continue;
        }
        if !hosted_pid(pid as u32) {
            return true;
        }
    }
    false
}

fn hosted_pid(pid: u32) -> bool {
    agent().is_hosted_command_line(&crate::core::platform::command_line(pid))
}

pub fn host_request(method: &str, route: &str, body: Option<&Value>) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_millis(5000))).http_status_as_error(false).build().into();
    let url = format!("{}{route}", *HOST_URL);
    let response = match (method, body) {
        ("GET", _) => agent.get(&url).call(),
        (_, Some(b)) => agent.post(&url).header("content-type", "application/json").send(json::stringify(b)),
        (_, None) => agent.post(&url).send_empty(),
    };
    let mut response = response.map_err(|e| e.to_string())?;
    let text = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    json::parse(if text.is_empty() { "{}" } else { &text }).ok_or_else(|| format!("Unexpected token in JSON: {}", first_chars(&text, 40)))
}

pub fn ensure_host() -> bool {
    let up = || host_request("GET", "/sessions", None).is_ok();
    if up() {
        return true;
    }
    let Ok(exe) = crate::core::platform::self_exe() else { return false };
    let mut cmd = crate::core::platform::cmd(exe);
    cmd.arg("host").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).env_clear().envs(crate::sessions::registry::clean_env());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    if cmd.spawn().is_err() {
        return false;
    }
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(500));
        if up() {
            return true;
        }
    }
    false
}

pub fn hosted_conversations() -> Vec<String> {
    read_config().into_iter().filter(|e| !truthy(e.get("waitingForVsCode"))).map(|e| text(e.get("conversation"))).collect()
}

pub fn mark_on_demand(conversation: &str) {
    let mut list = read_config();
    if let Some(o) = list.iter_mut().find(|x| x.get("conversation").and_then(|c| c.as_str()) == Some(conversation)).and_then(|x| x.as_object_mut()) {
        o.insert("onDemand".into(), Value::Bool(true));
    }
    write_config(&list);
}

fn conversation_root(conversation: &str) -> Option<PathBuf> {
    let p = crate::core::projects::project_of_conversation(conversation)?;
    p.root.filter(|r| r.exists())
}

pub fn adopt(conversation: &str, name: &str) {
    let mut list = read_config();
    let cwd = conversation_root(conversation).map(|p| p.to_string_lossy().to_string());
    match list.iter_mut().find(|x| x.get("conversation").and_then(|c| c.as_str()) == Some(conversation)) {
        None => {
            let mut e = Map::new();
            e.insert("conversation".into(), json!(conversation));
            e.insert("name".into(), json!(name));
            e.insert("at".into(), json!(crate::core::time::now()));
            e.insert("onDemand".into(), json!(true));
            if let Some(c) = cwd {
                e.insert("cwd".into(), json!(c));
            }
            list.push(Value::Object(e));
        }
        Some(e) => {
            if !truthy(e.get("cwd"))
                && let (Some(c), Some(o)) = (cwd, e.as_object_mut())
            {
                o.insert("cwd".into(), json!(c));
            }
        }
    }
    write_config(&list);
}

pub fn mark_waiting(conversation: &str, name: &str) {
    let mut list = read_config();
    if !list.iter().any(|x| x.get("conversation").and_then(|c| c.as_str()) == Some(conversation)) {
        list.push(json!({ "conversation": conversation, "name": name, "at": crate::core::time::now(), "waitingForVsCode": true }));
    }
    write_config(&list);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(text: &str) -> Option<&'static str> {
        DIALOGS.iter().find(|(re, _)| re.is_match(text)).map(|(_, keys)| keys.keys(text))
    }

    #[test]
    fn a_new_mcp_server_with_continue_without_selected_is_answered_with_use_this_mcp_server() {
        let text = "NewMCPserverfoundin.mcp.json:playwright-firefoxMCPserversmayexecutecodeoraccesssystemresources.UsethisMCPserverUsethisandallfutureMCPserversinthisproject❯ContinuewithoutusingthisMCPserverEntertoconfirm·Esctocancel";
        assert_eq!(answer(text), Some("\x1b[A\x1b[A\r"));
    }

    #[test]
    fn the_trust_dialog_on_windows_with_no_exit_selected_moves_down_to_yes_before_confirming() {
        let text = "and27moreThesewillapplywithoutasking.Onlyproceedifyoutrustthisconfiguration.Securityguide>No,exitYes,ItrustthisfolderEntertoconfirm·Esctocancel";
        assert_eq!(answer(text), Some("\x1b[B\r"));
    }

    #[test]
    fn the_trust_dialog_on_macos_keeps_working() {
        assert_eq!(answer("Doyoutrustthisfolder?❯No,exitYes,ItrustthisfolderEntertoconfirm"), Some("\x1b[B\r"));
        assert_eq!(answer("Doyoutrustthisfolder?❯Yes,ItrustthisfolderNo,exitEntertoconfirm"), Some("\r"));
    }

    #[test]
    fn the_new_project_trust_dialog_is_accepted() {
        assert_eq!(answer("Is this a project you trust? ❯ 1. Yes, proceed 2. No, exit"), Some("\r"));
    }

    #[test]
    fn the_screen_text_of_a_stuck_dialog_keeps_its_words_apart() {
        let raw = "\x1b[1mNew\x1b[1CMCP\x1b[1Cserver\x1b[1Cfound\x1b[0m\r\n\x1b[2C❯\x1b[1CContinue\x1b[1Cwithout\r\n───────\r\nEnter\x1b[1Cto\x1b[1Cconfirm";
        assert_eq!(readable(raw), "New MCP server found\n❯ Continue without\nEnter to confirm");
    }

    #[test]
    fn the_autocompact_tip_between_turns_gets_one_esc_and_the_same_tip_is_not_answered_twice() {
        crate::testkit::sandbox();
        let sent: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        struct Sink(Arc<Mutex<Vec<u8>>>);
        impl Write for Sink {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let tip = "\r\n  Tip: Enable autocompact at 80% to keep long sessions going\r\n  Enter to enable · Esc not now\r\n";
        let mut s = Session::new("c", "x");
        s.pty = Some(Pty { pid: None, writer: Arc::new(Mutex::new(Box::new(Sink(sent.clone())))), master: None, killer: None });
        let feed = |s: &mut Session, d: &str| {
            s.buffer.push_str(d);
            s.total += d.len();
        };
        feed(&mut s, &format!("some output{tip}"));
        assert!(late_dialog(&mut s));
        assert!(!late_dialog(&mut s));
        feed(&mut s, "\r\n> working on it");
        assert!(!late_dialog(&mut s));
        feed(&mut s, tip);
        assert!(late_dialog(&mut s));
    }

    #[test]
    fn a_native_prompt_is_found_even_when_a_long_diff_is_redrawn_after_it() {
        let dialog = "Edit file\r.claude/commands/x.md\r Do you want to make this edit to x.md?\r ❯ 1. Yes\r2. Yes, and allow\r   3. No\r\r Esc to cancel · Tab to amend\r";
        let redraw: String = (0..80).map(|i| format!(" {i} - una línea larga del diff que se redibuja debajo del cuadro\r")).collect();
        let found = prompt_in(&format!("{dialog}{redraw}"));
        assert_eq!(found.map(|f| f.question).as_deref(), Some("Do you want to make this edit to x.md?"));
        assert_eq!(prompt_in(&format!("{dialog}{redraw}⏺ Update(.claude/commands/x.md)\r")), None);
        assert_eq!(prompt_in(&redraw), None);
    }

    #[test]
    fn a_native_prompt_is_still_found_after_a_resize_repaints_the_screen_and_the_pending_dot_blinks() {
        let before = "⏺ Cambio cada fila del listado a tres líneas\r⏺ Bash(grep -n 'Factura' e2e/smoke.mjs)\r";
        let dialog = "Bash command\r grep -n 'Factura' e2e/smoke.mjs\r Do you want to proceed?\r ❯ 1. Yes\r 2. No\r Esc to cancel · Tab to amend\r";
        let repaint = format!("Investigación inicial ⏺ Cambio cada fila del listado\r⎿ $ grep n 'Factura' e2e/smoke.mjs\r{}", "⏺ ".repeat(40));
        let found = prompt_in(&format!("{before}{dialog}{repaint}"));
        assert_eq!(found.map(|f| f.question).as_deref(), Some("Do you want to proceed?"));
        assert_eq!(prompt_in(&format!("{before}{dialog}{repaint}⎿ Tests 115 passed\r")), None);
        assert_eq!(prompt_in(&format!("{before}{dialog}⎿ Interrupted · What should Claude do instead?\r")), None);
    }

    #[test]
    fn a_native_prompt_is_still_found_when_the_repaint_names_the_pending_tool_in_its_running_form() {
        let before = "⏺ Running the read-only daily review\r⎿ $ npx tsx scripts/daily-review.ts\r";
        let dialog = "Bash command\r set -a && q 'select status from public.remittances'\r List pending/credited remittances, new movements and errors\r Do you want to proceed?\r ❯ 1. Yes\r 2. Yes, and switch to auto mode\r 3. No\r Esc to cancel · Tab to amend\r";
        let repaint = format!("Investigación inicial ⏺ Listing pending/credited remittances, new movements and errors\r⎿ $ set -a && q 'select status from public.remittances'\r{}", "⏺ ".repeat(40));
        let found = prompt_in(&format!("{before}{dialog}{repaint}"));
        assert_eq!(found.map(|f| f.question).as_deref(), Some("Do you want to proceed?"));
        assert_eq!(prompt_in(&format!("{before}{dialog}{repaint}⏺ Si alguna parte la devuelve el banco, la factura sale como devuelta\r")), None);
    }

    struct Term(vt100::Parser);

    impl Term {
        fn new(cols: u16, rows: u16) -> Term {
            Term(emulator(cols, rows))
        }
        fn feed(&mut self, d: &str) {
            self.0.process(d.as_bytes());
        }
        fn prompt(&self) -> Option<NativePrompt> {
            prompt_on_screen(&screen_lines(&self.0))
        }
        fn question(&self) -> Option<String> {
            self.prompt().map(|p| p.question)
        }
    }

    fn at(row: usize, text: &str) -> String {
        format!("\x1b[{row};1H\x1b[2K{text}")
    }

    fn rows(from: usize, lines: &[String]) -> String {
        lines.iter().enumerate().map(|(i, l)| at(from + i, l)).collect()
    }

    fn strs(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|x| x.to_string()).collect()
    }

    const FULLSCREEN: &str = "\x1b[?1049h\x1b[2J\x1b[H";

    fn input_box(row: usize) -> String {
        rows(row, &["─".repeat(60), "❯ ".into(), "─".repeat(60), "  ⏵⏵ accept edits on (shift+tab to cycle)".into()])
    }

    fn bash_dialog(command: &str, extra: &[&str]) -> Vec<String> {
        let mut v = vec!["─".repeat(80), " Bash command".into(), String::new(), format!("   {command}")];
        v.extend(extra.iter().map(|x| format!("   {x}")));
        v.extend(strs(&["", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"]));
        v
    }

    const PROCEED: &str = "Do you want to proceed?";

    #[test]
    fn on_screen_a_pending_bash_prompt_is_found_with_its_command_as_context() {
        let mut s = Term::new(100, 40);
        s.feed(&format!("{FULLSCREEN}{}{}", rows(1, &strs(&["⏺ Bash(grep -n 'Factura' e2e/smoke.mjs)"])), rows(30, &bash_dialog("grep -n 'Factura' e2e/smoke.mjs", &[]))));
        let found = s.prompt().unwrap();
        assert_eq!(found.question, PROCEED);
        assert!(found.text.starts_with("Bash command grep -n 'Factura' e2e/smoke.mjs Do you want to proceed? ❯ 1. Yes 2. No Esc to cancel"), "{}", found.text);
    }

    #[test]
    fn on_screen_a_resize_repaint_with_the_pending_dot_blinking_keeps_the_prompt_pending_until_it_is_answered() {
        let mut s = Term::new(100, 40);
        let transcript = strs(&["⏺ Cambio cada fila del listado a tres líneas", "⏺ Bash(grep -n 'Factura' e2e/smoke.mjs)"]);
        s.feed(&format!("{FULLSCREEN}{}{}", rows(1, &transcript), rows(30, &bash_dialog("grep -n 'Factura' e2e/smoke.mjs", &[]))));
        resize_emulator(&mut s.0, 80, 40);
        let repaint = format!("{}{}", rows(1, &strs(&["Investigación inicial ⏺ Cambio cada fila del listado", "  Bash(grep -n 'Factura' e2e/smoke.mjs)", "  ⎿ $ grep n 'Factura' e2e/smoke.mjs"])), rows(30, &bash_dialog("grep -n 'Factura' e2e/smoke.mjs", &[])));
        let blinks: String = (0..40).map(|i| at(2, &format!("{} Bash(grep -n 'Factura' e2e/smoke.mjs)", if i % 2 == 1 { " " } else { "⏺" }))).collect();
        s.feed(&format!("\x1b[2J\x1b[H{repaint}{blinks}"));
        assert_eq!(s.question().as_deref(), Some(PROCEED));
        s.feed(&format!("\x1b[30;1H\x1b[J{}{}", rows(30, &strs(&["  ⎿ Tests 115 passed"])), input_box(36)));
        assert_eq!(s.prompt(), None);
    }

    #[test]
    fn on_screen_a_repaint_naming_the_pending_tool_in_its_ing_form_does_not_answer_the_prompt() {
        let mut s = Term::new(120, 40);
        let dialog = bash_dialog("set -a && q 'select status from public.remittances'", &["List pending/credited remittances, new movements and errors"]);
        s.feed(&format!("{FULLSCREEN}{}{}", rows(1, &strs(&["⏺ Running the read-only daily review", "  ⎿ $ npx tsx scripts/daily-review.ts"])), rows(28, &dialog)));
        s.feed(&format!("\x1b[2J\x1b[H{}{}{}", rows(1, &strs(&["Investigación inicial", "⏺ Listing pending/credited remittances, new movements and errors", "  ⎿ $ set -a && q 'select status from public.remittances'"])), rows(28, &dialog), "⏺ ".repeat(40)));
        assert_eq!(s.question().as_deref(), Some(PROCEED));
        s.feed(&format!("\x1b[1;1H\x1b[J{}{}", rows(1, &strs(&["⏺ Si alguna parte la devuelve el banco, la factura sale como devuelta"])), input_box(36)));
        assert_eq!(s.prompt(), None);
    }

    #[test]
    fn on_screen_an_edit_prompt_is_found_when_a_long_diff_is_redrawn_after_it_in_the_byte_stream() {
        let mut s = Term::new(100, 40);
        let head = rows(8, &["─".repeat(80), " Edit file".into(), " .claude/commands/x.md".into()]);
        let question = rows(33, &strs(&[" Do you want to make this edit to x.md?", " ❯ 1. Yes", "   2. Yes, allow all edits during this session (shift+tab)", "   3. No", "", " Esc to cancel · Tab to amend"]));
        let diff: String = (0..80).map(|i| at(11 + (i % 21), &format!(" {i} - una línea larga del diff que se redibuja debajo del cuadro"))).collect();
        s.feed(&format!("{FULLSCREEN}{head}{question}{diff}"));
        let found = s.prompt().unwrap();
        assert_eq!(found.question, "Do you want to make this edit to x.md?");
        assert!(found.text.starts_with("Edit file .claude/commands/x.md"), "{}", found.text);
        s.feed(&format!("\x1b[8;1H\x1b[J{}{}", rows(8, &strs(&["⏺ Update(.claude/commands/x.md)", "  ⎿ Updated .claude/commands/x.md with 3 additions"])), input_box(36)));
        assert_eq!(s.prompt(), None);
        let mut only = Term::new(100, 40);
        only.feed(&format!("{FULLSCREEN}{diff}"));
        assert_eq!(only.prompt(), None);
    }

    #[test]
    fn on_screen_an_answered_prompt_followed_by_tool_output_is_no_longer_pending_also_in_the_normal_buffer() {
        let mut s = Term::new(100, 30);
        let history = (0..60).map(|i| format!("línea {i} del historial")).collect::<Vec<_>>().join("\r\n");
        let dialog = bash_dialog("npm test", &[]);
        s.feed(&format!("{history}\r\n{}", dialog.join("\r\n")));
        assert_eq!(s.question().as_deref(), Some(PROCEED));
        s.feed(&format!("\x1b[{}A\r\x1b[J⏺ Bash(npm test)\r\n  ⎿ ℹ tests 266\r\n  ⎿ ℹ pass 266\r\n", dialog.len() - 1));
        assert_eq!(s.prompt(), None);
    }

    #[test]
    fn on_screen_an_interrupted_prompt_is_not_pending() {
        let mut s = Term::new(100, 40);
        s.feed(&format!("{FULLSCREEN}{}", rows(30, &bash_dialog("rm -rf pruebas/X-1", &[]))));
        assert!(s.prompt().is_some());
        s.feed(&format!("\x1b[30;1H\x1b[J{}{}", rows(30, &strs(&["⏺ Bash(rm -rf pruebas/X-1)", "  ⎿ Interrupted · What should Claude do instead?"])), input_box(36)));
        assert_eq!(s.prompt(), None);
    }

    #[test]
    fn on_screen_a_question_wrapped_over_two_rows_on_a_narrow_terminal_is_joined() {
        let mut s = Term::new(34, 30);
        s.feed(&format!("{FULLSCREEN}{}", rows(20, &strs(&[" Edit file", " Do you want to make this edit", " to a-long-file-name.md?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"]))));
        assert_eq!(s.question().as_deref(), Some("Do you want to make this edit to a-long-file-name.md?"));
    }

    #[test]
    fn on_screen_a_real_bash_prompt_with_a_long_dont_ask_again_option_wrapped_over_several_rows_is_found() {
        let mut s = Term::new(60, 40);
        let mut lines = vec!["─".repeat(60)];
        lines.extend(strs(&[" Bash command", "", "   curl -s -A \"Mozilla/5.0\" \"https://query1.finance.yahoo.", "   com/v8/finance/chart/DRAM.DE?range=10d&interval=1d\"", "   Fetch DRAM.DE daily price range for recent days", "", " This command requires approval", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don’t ask again for: curl -s -A", "   \"Mozilla/5.0\" \"https://query1.finance.yahoo.com/v8/fin", "   ance/chart/DRAM.DE?range=10d&interval=1d\" and every", "   other command that starts the same way in this folder", "   3. Yes, and switch to auto mode · auto mode handles", "   these prompts for you", "   4. No", "", " Esc to cancel · Tab to amend"]));
        s.feed(&format!("{FULLSCREEN}{}", rows(40 - lines.len() + 1, &lines)));
        let found = s.prompt().unwrap();
        assert_eq!(found.question, PROCEED);
        assert!(found.text.starts_with("Bash command curl -s"), "{}", found.text);
    }

    #[test]
    fn on_screen_the_question_quoted_in_the_transcript_without_the_dialog_footer_is_not_a_prompt() {
        let mut s = Term::new(100, 40);
        s.feed(&format!("{FULLSCREEN}{}{}", rows(1, &strs(&["⏺ El cuadro decía «Do you want to proceed?» con:", "  1. Yes", "  2. No"])), input_box(36)));
        assert_eq!(s.prompt(), None);
    }

    #[test]
    fn the_host_config_keeps_adopted_waiting_and_on_demand_sessions() {
        let _g = crate::testkit::fresh();
        mark_waiting("c1", "Pagos");
        mark_waiting("c1", "Pagos");
        adopt("c2", "Tablero");
        mark_on_demand("c1");
        let list = read_config();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["waitingForVsCode"], true);
        assert_eq!(list[0]["onDemand"], true);
        assert_eq!(list[1]["onDemand"], true);
        assert_eq!(hosted_conversations(), vec!["c2".to_string()]);
    }

    #[test]
    fn the_host_answers_unknown_routes_and_missing_sessions_like_the_node_one() {
        let _g = crate::testkit::fresh();
        assert_eq!(handle_request("GET", "/nope", &json!({})), (404, json!({ "error": "no existe" })));
        assert_eq!(handle_request("POST", "/start", &json!({})), (400, json!({ "error": "faltan conversation y name" })));
        assert_eq!(handle_request("POST", "/input", &json!({ "conversation": "zz" })), (409, json!({ "error": "la sesión no está en marcha" })));
        assert_eq!(handle_request("POST", "/stop", &json!({ "conversation": "zz" })), (200, json!({ "stopped": false })));
        mark_waiting("c9", "Espera");
        assert_eq!(handle_request("POST", "/start", &json!({ "conversation": "c9", "name": "Espera" })), (200, json!({ "waiting": true })));
        assert_eq!(handle_request("GET", "/sessions", &json!({})).1[0]["waitingForVsCode"], true);
        assert_eq!(handle_request("POST", "/release", &json!({ "conversation": "c9" })), (200, json!({ "ok": true })));
        assert!(read_config().is_empty());
    }
}

#[cfg(test)]
mod permission_hook_setup {
    #[test]
    fn adds_the_hook_once_and_keeps_other_settings() {
        let _env = crate::testkit::sandbox();
        std::fs::write(crate::core::config::workspace().join("permission-hook.js"), "").unwrap();
        let root = std::env::temp_dir().join(format!("hook-root-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::write(root.join(".claude/settings.local.json"), r#"{"permissions":{"allow":["Bash"]}}"#).unwrap();
        super::ensure_permission_hook(&root);
        super::ensure_permission_hook(&root);
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join(".claude/settings.local.json")).unwrap()).unwrap();
        assert_eq!(v["permissions"]["allow"][0], "Bash");
        assert_eq!(v["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        assert!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"].as_str().unwrap().contains("permission-hook.js"));
        let _ = std::fs::remove_dir_all(&root);
    }
}

//! Port of src/sessions/host.js.
#![allow(dead_code, unused_variables)]
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

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

pub static HOST_HEAD: LazyLock<Option<String>> = LazyLock::new(|| {
    let out = std::process::Command::new("git").arg("-C").arg(crate::core::config::repo()).args(["rev-parse", "HEAD"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
});
pub static HOST_STARTED: LazyLock<String> = LazyLock::new(crate::core::time::now);

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
        todo!()
    }

    pub fn write_later(&self, data: &str, ms: u64) {
        todo!()
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        todo!()
    }

    pub fn kill(&mut self) {
        todo!()
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
        }
    }
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_VIEWER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn read_config() -> Vec<Value> {
    todo!()
}

fn write_config(list: &[Value]) {
    todo!()
}

fn log(message: &str) {
    todo!()
}

fn size_frame(s: &Session) -> String {
    todo!()
}

fn plain(s: &str) -> String {
    todo!()
}

pub fn readable(s: &str) -> String {
    todo!()
}

pub fn emulator(cols: u16, rows: u16) -> vt100::Parser {
    let size = |n: u16| std::num::NonZeroU16::new(n).unwrap_or(std::num::NonZeroU16::MIN);
    vt100::Parser::new(size(rows), size(cols), SCROLLBACK)
}

pub fn screen_lines(term: &vt100::Parser) -> Vec<String> {
    todo!()
}

fn stuck_check(s: &mut Session) {
    todo!()
}

fn unstuck(s: &mut Session) {
    todo!()
}

fn type_into(s: &mut Session, data: &str) {
    todo!()
}

fn spawn(entry: &Value, notify: bool) -> bool {
    todo!()
}

fn on_output(conversation: &str, generation: u64, data: &str) {
    todo!()
}

fn on_exit(conversation: &str, generation: u64, code: u32) {
    todo!()
}

fn stop(conversation: &str) -> bool {
    todo!()
}

fn summary() -> Value {
    todo!()
}

fn handle_connection(stream: TcpStream) {
    todo!()
}

fn handle_request(method: &str, url: &str, input: &Value) -> (u16, Value) {
    todo!()
}

fn attach(stream: TcpStream) {
    todo!()
}

fn on_viewer_message(conversation: &str, who: &str, raw: &str) {
    todo!()
}

fn tick() {
    todo!()
}

fn watch_primary() {
    todo!()
}

pub fn serve() {
    todo!()
}

fn kill_orphan_watchers() -> usize {
    todo!()
}

fn post_board(route: &str, body: &Value) {
    todo!()
}

pub fn late_dialog(s: &mut Session) -> bool {
    todo!()
}

fn letters(s: &str) -> String {
    todo!()
}

fn answered_after(before: &str, after: &str) -> bool {
    todo!()
}

pub fn prompt_in(raw: &str) -> Option<NativePrompt> {
    todo!()
}

pub fn prompt_on_screen(lines: &[String]) -> Option<NativePrompt> {
    todo!()
}

fn check_prompt(s: &mut Session) {
    todo!()
}

fn tell_board(conversation: &str) {
    todo!()
}

pub fn vs_code_has(conversation: &str) -> bool {
    todo!()
}

fn hosted_pid(pid: u32) -> bool {
    todo!()
}

pub fn host_request(method: &str, route: &str, body: Option<&Value>) -> Result<Value, String> {
    todo!()
}

pub fn ensure_host() -> bool {
    todo!()
}

pub fn hosted_conversations() -> Vec<String> {
    todo!()
}

pub fn mark_on_demand(conversation: &str) {
    todo!()
}

fn conversation_root(conversation: &str) -> Option<PathBuf> {
    todo!()
}

pub fn adopt(conversation: &str, name: &str) {
    todo!()
}

pub fn mark_waiting(conversation: &str, name: &str) {
    todo!()
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
    fn every_screen_pattern_compiles() {
        for re in [&*UNANSWERED, &*CONFIRM_FOOTER, &*PROMPT, &*AFTER_ANSWER, &*ANSWERED, &*PROMPT_ON_SCREEN, &*FIRST_OPTION, &*FOOTER, &*RULE, &*ORPHAN_WATCHER, &LATE_DIALOGS[0]] {
            let _ = re.is_match("");
        }
    }
}

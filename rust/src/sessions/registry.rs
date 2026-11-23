//! Port of src/sessions/registry.js.
#![allow(dead_code, unused_variables)]
use crate::core::data::Doc;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

pub const STARTUP_NOTICE: &str = "Aviso del arranque: arranca el reporte. Eres la sesión de reporte registrada: ejecuta ahora .claude/commands/resumen-jira.md (regla de AGENTS.md).";
const STOP_WORDS: [&str; 12] = ["de", "del", "la", "el", "los", "las", "y", "a", "en", "the", "of", "and"];
const SUBAGENT_MAX_AGE: i64 = 30 * 60000;
const SUBAGENT_BACKGROUND_AGE: i64 = 3 * 3600000;
const SHELL_REFRESH_MS: u64 = 20000;

struct TitleMark {
    mark: String,
    size: u64,
    title: Option<String>,
}

struct SubagentState {
    mark: String,
    ended: bool,
    background: Vec<String>,
}

static TRANSCRIPT_PATHS: LazyLock<Mutex<HashMap<String, PathBuf>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static TITLE_CACHE: LazyLock<Mutex<HashMap<String, TitleMark>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SUBAGENT_CACHE: LazyLock<Mutex<HashMap<PathBuf, SubagentState>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SHELL_COMMANDS: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static SHELL_WATCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

pub fn title_key(s: &str) -> String {
    todo!()
}

fn process_alive(pid: i64) -> bool {
    todo!()
}

pub fn transcript_of(session_id: &str) -> Option<PathBuf> {
    todo!()
}

pub fn conversation_title(session_id: &str) -> Option<String> {
    todo!()
}

fn keep_shells(list: Vec<String>) -> Vec<String> {
    todo!()
}

fn refresh_shell_commands() {
    todo!()
}

fn watch_shells() {
    todo!()
}

fn command_mark(command: &str) -> String {
    todo!()
}

fn subagent_state(file: &Path, size: u64, mtime_ms: f64) -> (bool, Vec<String>) {
    todo!()
}

fn running_subagents(session_id: &str) -> usize {
    todo!()
}

pub fn live_status(status: Option<&str>, subagents: usize) -> String {
    todo!()
}

pub fn live_sessions() -> Option<Vec<Value>> {
    todo!()
}

pub fn assign_refs(list: &[Value]) -> usize {
    todo!()
}

fn write_routes(r: &Value) {
    todo!()
}

pub fn load_routes() -> Value {
    todo!()
}

pub fn change_routes<R>(f: impl FnOnce(&mut Value) -> R) -> R {
    todo!()
}

pub fn rename_area(id: &str, title: &str) -> bool {
    todo!()
}

pub fn reconcile(live: &[Value]) {
    todo!()
}

pub fn sessions_cli(args: &[&str]) -> Result<String, String> {
    todo!()
}

pub fn current_ref(refs: &Value, live: Option<&Value>) -> Value {
    todo!()
}

pub fn targets(d: &Doc, r: &Value) -> Vec<Value> {
    todo!()
}

pub fn real_area(id: &str) -> Option<String> {
    todo!()
}

fn env_without_vs_code() -> HashMap<String, String> {
    todo!()
}

pub fn clean_env() -> HashMap<String, String> {
    todo!()
}

pub fn session_token() -> Option<String> {
    todo!()
}

pub fn open_in_vs_code(conversation: Option<&str>) {
    todo!()
}

pub fn create_conversation(name: &str, cwd: Option<&Path>) -> Option<String> {
    todo!()
}

pub fn wake_session(name: &str, notice: Option<&str>) -> bool {
    todo!()
}

pub fn run_bounded(exe: &str, args: &[String], opts: &RunOptions, ms: u64) -> Bounded {
    todo!()
}

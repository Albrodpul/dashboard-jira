//! Port of src/features/jira-watch.js.
use crate::core::time::Clock;
use std::sync::{LazyLock, Mutex};

static ME: LazyLock<String> = LazyLock::new(|| crate::core::config::main_project().jira.as_ref().and_then(|j| j.me.get("name")).and_then(|v| v.as_str()).unwrap_or_default().to_string());
const DOC: &str = ".claude/commands/resumen-jira.md";
const WAIT_MS: i64 = 5 * 60000;
const CHECK_MS: i64 = 15000;

struct Waiting {
    last: Option<String>,
    at: i64,
}

struct Watch {
    last_quiet: String,
    last_check: i64,
    waiting: Option<Waiting>,
    running: bool,
}

struct Parts {
    weekday: String,
    hour: String,
    minute: String,
}

struct Deps {
    primary: Box<dyn Fn() -> bool + Send>,
    fresh: Box<dyn Fn() -> Option<i64> + Send>,
    quiet: Box<dyn Fn(&str, Option<&str>) -> bool + Send>,
    notify: Box<dyn Fn(&str) + Send>,
    clock: Box<dyn Fn() -> Clock + Send>,
    overtime: Box<dyn Fn() -> bool + Send>,
    parts: Box<dyn Fn() -> Parts + Send>,
    ms: Box<dyn Fn() -> i64 + Send>,
}

static WATCH: LazyLock<Mutex<Watch>> = LazyLock::new(|| Mutex::new(Watch { last_quiet: String::new(), last_check: 0, waiting: None, running: false }));
static DEPS: LazyLock<Mutex<Option<Deps>>> = LazyLock::new(|| Mutex::new(None));

pub fn tick() {
    todo!()
}

pub fn review_hours(t: Option<&Clock>) -> bool {
    todo!()
}

pub fn fresh_in_jira() -> Option<i64> {
    todo!()
}

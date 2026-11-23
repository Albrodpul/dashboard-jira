//! Port of src/features/board-alive.js.

use std::sync::{Arc, Mutex};

const PROBE_MS: i64 = 60 * 1000;
const TIMEOUT_MS: u64 = 20 * 1000;
const RENOTIFY_MS: i64 = 60 * 60 * 1000;
const SLEEP_GAP_MS: i64 = 3 * PROBE_MS;

pub type PushFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct CheckerState {
    pub last_ok: i64,
    pub last_probe: i64,
    pub alerted_at: Option<i64>,
}

pub struct Checker {
    pub state: CheckerState,
    limit_ms: i64,
    push: PushFn,
    now_ms: NowFn,
}

impl Checker {
    pub fn record(&mut self, ok: bool) -> &'static str {
        todo!()
    }
}

#[derive(Default)]
pub struct StartOptions {
    pub minutes: Option<f64>,
    pub log: Option<LogFn>,
}

pub fn probe(url: Option<&str>, timeout_ms: Option<u64>) -> bool {
    todo!()
}

pub fn create_checker(minutes: f64, push: PushFn, now_ms: Option<NowFn>) -> Checker {
    todo!()
}

pub fn start(options: StartOptions) -> Arc<Mutex<Checker>> {
    todo!()
}

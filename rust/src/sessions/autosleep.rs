//! Port of src/sessions/autosleep.js.
#![allow(dead_code, unused_variables)]

const IDLE_MS: i64 = 30 * 60000;
const PENDING: [&str; 4] = ["approved", "sent", "waiting", "partial"];

fn log(message: &str) {
    todo!()
}

pub fn sleep_idle_sessions(now: bool) {
    todo!()
}

//! Port of src/sessions/rotate.js.
#![allow(dead_code, unused_variables)]
use crate::core::time::Clock;
use std::sync::atomic::AtomicBool;

const ROLES: [(&str, &str); 2] = [("reporter", "Reporte JIRA"), ("orchestrator", "Orquestar agentes")];
const BUSY_MS: u64 = 10 * 60 * 1000;
static BUSY: AtomicBool = AtomicBool::new(false);

fn log(message: &str) {
    todo!()
}

fn today() -> String {
    todo!()
}

fn fresh_conversation(role: &str, fallback_name: &str) -> bool {
    todo!()
}

pub fn morning(t: Option<&Clock>) -> bool {
    todo!()
}

pub fn in_rotation_window(t: Option<&Clock>) -> bool {
    todo!()
}

pub fn rotate_daily() {
    todo!()
}

pub fn rotate_if_morning() {
    todo!()
}

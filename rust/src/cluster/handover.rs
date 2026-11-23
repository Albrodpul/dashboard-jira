use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicI64};

const TAKEOVER_MS: i64 = 3 * 60_000;
const SLEPT_MS: i64 = 2 * 60_000;
const RESUME_DELAY_MS: u64 = 25_000;
const ACTIVE_TASKS: [&str; 2] = ["sent", "approved"];
const BACK_PULL_MS: i64 = 3 * 60 * 1000;
const SNAPSHOT_MS: i64 = 60_000;
const ROLES: [(&str, &str); 4] = [("reporter", "Reporte JIRA"), ("orchestrator", "Orquestar agentes"), ("followUp", "Seguimiento"), ("board", "Tablero")];
const RESUME_NOTICE: &str = "Tablero: el tablero ha cambiado de ordenador y esta sesión se cortó a medias. Sigue con tus tareas pendientes desde donde lo dejaste; revisa antes el estado del repo por si algo quedó a medio hacer.";

static LAST_TICK: AtomicI64 = AtomicI64::new(0);
static LAST_BACK_PULL: AtomicI64 = AtomicI64::new(0);
static LAST_PULL: AtomicI64 = AtomicI64::new(0);
static BUSY: AtomicBool = AtomicBool::new(false);

pub fn tick() {
    todo!()
}

pub fn keeps_command(peer: &Value) -> bool {
    todo!()
}

pub fn handle_yield(input: &Value) {
    todo!()
}

pub fn take_here() -> Value {
    todo!()
}

pub fn back_to_auto() -> Value {
    todo!()
}

pub fn command(target: Option<&str>, action: &str) -> Value {
    todo!()
}

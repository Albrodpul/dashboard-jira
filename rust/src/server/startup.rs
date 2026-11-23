//! Port of src/server/startup.js.
use crate::core::data::DATA_DIR;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

pub static STARTUP_LOG: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("startup.log"));
pub static STARTUP_LOCK: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("startup.lock"));
pub const FOLLOW_UP_NOTICE: &str = "Aviso del arranque: arranca el seguimiento. Eres la sesión de seguimiento registrada: ejecuta ahora .claude/commands/seguimiento.md (regla de AGENTS.md).";
pub const BOARD_NOTICE: &str = "Aviso del tablero: arranca la sesión del tablero. Eres la sesión del tablero registrada: ejecuta ahora .claude/commands/tablero.md (regla de AGENTS.md).";
pub const NOTICE_GAP_MS: i64 = 15 * 60000;

pub fn claim_orchestrator_notice() -> bool {
    todo!()
}

pub fn launch_startup(child: bool, force: bool) {
    let _ = (child, force);
    todo!()
}

pub fn wake_follow_up() {
    todo!()
}

pub fn set_overtime(on: bool) -> Value {
    let _ = on;
    todo!()
}

pub fn notice_follow_up(e: &Value) -> Option<bool> {
    let _ = e;
    todo!()
}

pub fn notice_board(session: Option<&str>, respawn: bool) -> Option<bool> {
    let _ = (session, respawn);
    todo!()
}

pub fn notice_board_with(session: Option<&str>, respawn: bool, wake: &dyn Fn(&str, &str) -> bool) -> Option<bool> {
    let _ = (session, respawn, wake);
    todo!()
}

pub fn notice_reporter(session: Option<&str>) -> Option<bool> {
    let _ = session;
    todo!()
}

pub fn notice_reporter_with(session: Option<&str>, wake: &dyn Fn(&str) -> bool) -> Option<bool> {
    let _ = (session, wake);
    todo!()
}

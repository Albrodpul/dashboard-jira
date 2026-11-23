//! Port of src/server/state.js.
use crate::core::config::main_project;
use crate::core::data::Doc;
use serde_json::Value;
use std::sync::LazyLock;

fn me_name() -> String {
    main_project().jira.as_ref().and_then(|j| j.me.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

pub static ERRORS_AREA: LazyLock<Option<String>> = LazyLock::new(|| main_project().errors_area.clone());

pub const MESSAGE_TARGETS: [(&str, &str); 3] = [("reporter", "la sesión de reporte"), ("orchestrator", "la orquestadora"), ("board", "la sesión del tablero")];

pub static ORCHESTRATOR_NOTICE: LazyLock<String> = LazyLock::new(|| {
    format!(
        "Aviso del tablero: arranca la orquestadora. Eres la sesión orquestadora registrada: lee ahora .claude/commands/orquesta.md (regla de AGENTS.md). No vigilas nada ni armas ningún Monitor: el tablero entrega solo. Quédate a la espera de lo que te pida {}.",
        me_name()
    )
});

pub fn message_target(to: &str) -> Option<&'static str> {
    MESSAGE_TARGETS.iter().find(|(k, _)| *k == to).map(|(_, v)| *v)
}

pub fn talk_target(s: &Value, to: &str) -> Value {
    let _ = (s, to);
    todo!()
}

pub fn state() -> Value {
    todo!()
}

pub fn tidy_blockers(d: &Doc, project_id: Option<&str>) -> Vec<String> {
    let _ = (d, project_id);
    todo!()
}

pub fn last_context_pass(project_id: Option<&str>) -> Option<String> {
    let _ = project_id;
    todo!()
}

pub fn tidy_of(d: &Doc, project_id: Option<&str>) -> Value {
    let _ = (d, project_id);
    todo!()
}

pub fn deployer_area(r: &Value) -> Option<String> {
    let _ = r;
    todo!()
}

pub fn follow_up_errors(d: &Doc) -> Vec<Value> {
    let _ = d;
    todo!()
}

pub fn open_if_closed(area_id: &str, areas: Option<&Value>) -> bool {
    let _ = (area_id, areas);
    todo!()
}

pub fn message_notice(id: &str) -> String {
    let _ = id;
    todo!()
}

pub fn is_paused(d: &Doc) -> bool {
    let _ = d;
    todo!()
}

pub fn wake_reporter(notice: &str) -> bool {
    let _ = notice;
    todo!()
}

pub fn ping() -> bool {
    todo!()
}

pub fn wait(ms: u64) {
    crate::core::data::pause(ms)
}

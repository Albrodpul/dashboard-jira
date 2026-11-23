//! Port of src/sessions/profiles.js.
#![allow(dead_code, unused_variables)]
use serde_json::{Value, json};
use std::sync::LazyLock;

pub const MODELS: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

static DEFAULTS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "reporter": { "model": "sonnet", "effort": "low", "why": "solo lee Jira y resume lo que cambió" },
        "orchestrator": { "model": "opus", "effort": "medium", "why": "ordena el contexto y habla de tareas y restricciones" },
        "followUp": { "model": "sonnet", "effort": "medium", "why": "resume lo que hace cada uno en beta y en producción" },
        "deploy": { "model": "sonnet", "effort": "medium", "why": "sigue los pasos de despliegue con cuidado" },
        "errors": { "model": "opus", "effort": "medium", "why": "investiga errores de producción" },
        "board": { "model": "opus", "effort": "medium", "why": "cambia el código del tablero" },
        "area": { "model": "opus", "effort": "medium", "why": "desarrolla tareas de Jira" }
    })
});

pub fn profiles() -> Value {
    todo!()
}

fn role_of(conversation: &str) -> &'static str {
    todo!()
}

fn override_of(conversation: &str) -> Option<Value> {
    todo!()
}

pub fn profile_for(conversation: &str, overrides: Option<&Value>) -> Value {
    todo!()
}

pub fn set_override(conversation: &str, model: Option<&str>, effort: Option<&str>) -> Result<Value, String> {
    todo!()
}

pub fn profile_args(conversation: &str) -> Vec<String> {
    todo!()
}

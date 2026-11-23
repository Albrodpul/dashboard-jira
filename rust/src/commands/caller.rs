//! Port of src/commands/caller.js.
use serde_json::Value;
use std::collections::HashMap;

pub const ROLE_NAMES: [(&str, &str); 4] = [
    ("orchestrator", "la orquestadora"),
    ("reporter", "la sesión de reporte"),
    ("followUp", "la sesión de seguimiento"),
    ("board", "la sesión del tablero"),
];

pub fn who_calls(env: Option<&HashMap<String, String>>) -> Option<Value> {
    todo!()
}

pub fn has_role(who: Option<&Value>, wanted: &[&str]) -> bool {
    todo!()
}

pub fn refuse(command: &str, wanted: &[&str], who: Option<&Value>, extra: Option<&str>) -> String {
    todo!()
}

pub fn only_from(command: &str, wanted: &[&str], env: Option<&HashMap<String, String>>) -> Result<Option<Value>, String> {
    todo!()
}

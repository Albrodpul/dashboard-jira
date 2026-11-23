//! Port of src/commands/caller.js.
use crate::core::json::truthy;
use crate::core::projects::main_id;
use crate::sessions::registry::load_routes;
use serde_json::{Value, json};
use std::collections::HashMap;

pub const ROLE_NAMES: [(&str, &str); 4] = [
    ("orchestrator", "la orquestadora"),
    ("reporter", "la sesión de reporte"),
    ("followUp", "la sesión de seguimiento"),
    ("board", "la sesión del tablero"),
];

fn role_name(role: &str) -> String {
    ROLE_NAMES.iter().find(|(k, _)| *k == role).map(|(_, v)| v.to_string()).unwrap_or_else(|| role.to_string())
}

fn same_conversation(v: Option<&Value>, conversation: &str) -> bool {
    v.and_then(|x| x.get("conversation")).and_then(Value::as_str) == Some(conversation)
}

pub fn who_calls(env: Option<&HashMap<String, String>>) -> Option<Value> {
    let raw = match env {
        Some(map) => map.get("CLAUDE_CODE_SESSION_ID").cloned().unwrap_or_default(),
        None => std::env::var("CLAUDE_CODE_SESSION_ID").unwrap_or_default(),
    };
    let conversation = raw.trim().to_string();
    if conversation.is_empty() {
        return None;
    }
    let r = load_routes();
    let mut roles: Vec<Value> = Vec::new();
    for (role, _) in ROLE_NAMES {
        if same_conversation(r.get(role), &conversation) {
            roles.push(json!({ "role": role, "project": main_id() }));
        }
    }
    if let Some(projects) = r.get("projectRoles").and_then(Value::as_object) {
        for (project, roles_box) in projects {
            if let Some(entries) = roles_box.as_object() {
                for (role, v) in entries {
                    if same_conversation(Some(v), &conversation) {
                        roles.push(json!({ "role": role, "project": project }));
                    }
                }
            }
        }
    }
    let area = r.get("areas").and_then(Value::as_object).and_then(|areas| areas.iter().find(|(_, a)| same_conversation(Some(a), &conversation))).map(|(id, a)| {
        let name = if truthy(a.get("title")) { a["title"].clone() } else { Value::from(id.as_str()) };
        let project = if truthy(a.get("project")) { a["project"].clone() } else { Value::from(main_id()) };
        json!({ "id": id, "name": name, "project": project })
    });
    let name = match &area {
        Some(a) => format!("«{}»", crate::commands::args::text(a.get("name"))),
        None => match roles.first() {
            Some(first) => role_name(first["role"].as_str().unwrap_or("")),
            None => "una sesión que el tablero no tiene registrada".to_string(),
        },
    };
    Some(json!({ "conversation": conversation, "roles": roles, "area": area.unwrap_or(Value::Null), "name": name }))
}

pub fn has_role(who: Option<&Value>, wanted: &[&str]) -> bool {
    who.and_then(|w| w.get("roles")).and_then(Value::as_array).is_some_and(|roles| roles.iter().any(|x| x.get("role").and_then(Value::as_str).is_some_and(|r| wanted.contains(&r))))
}

pub fn refuse(command: &str, wanted: &[&str], who: Option<&Value>, extra: Option<&str>) -> String {
    let mut from = wanted.iter().map(|r| role_name(r)).collect::<Vec<_>>().join(" o ");
    if let Some(e) = extra.filter(|e| !e.is_empty()) {
        from.push_str(&format!(" ({e})"));
    }
    let why = match who {
        Some(w) => format!("y lo pide {}", crate::commands::args::text(w.get("name"))),
        None => "y no se sabe qué sesión lo pide (falta CLAUDE_CODE_SESSION_ID: no viene de una sesión de Claude Code)".to_string(),
    };
    format!("Rechazado: «board.js {command}» solo se acepta desde {from}, {why}. Aprobar, retener y ordenar es cosa de Alberto: que lo haga en el tablero o se lo pida a la orquestadora. No lo intentes por otro camino.")
}

pub fn only_from(command: &str, wanted: &[&str], env: Option<&HashMap<String, String>>) -> Result<Option<Value>, String> {
    let who = who_calls(env);
    if !has_role(who.as_ref(), wanted) {
        return Err(refuse(command, wanted, who.as_ref(), None));
    }
    Ok(who)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_names_the_roles_and_who_asked() {
        let who = json!({ "name": "«Pagos»", "roles": [] });
        let text = refuse("approve-chat", &["orchestrator", "reporter"], Some(&who), None);
        assert!(text.starts_with("Rechazado: «board.js approve-chat» solo se acepta desde la orquestadora o la sesión de reporte, y lo pide «Pagos»."));
        assert!(refuse("hold add", &["orchestrator"], None, None).contains("falta CLAUDE_CODE_SESSION_ID"));
        assert!(refuse("tidy-start", &["orchestrator"], None, Some("o otra")).contains("la orquestadora (o otra), y no"));
    }

    #[test]
    fn has_role_looks_only_at_the_wanted_roles() {
        let who = json!({ "roles": [{ "role": "reporter", "project": "main" }] });
        assert!(has_role(Some(&who), &["orchestrator", "reporter"]));
        assert!(!has_role(Some(&who), &["orchestrator"]));
        assert!(!has_role(None, &["orchestrator"]));
    }
}

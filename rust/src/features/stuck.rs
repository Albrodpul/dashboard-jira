//! Port of src/features/stuck.js.

use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value, json};

use crate::core::json::truthy;

static STUCK: LazyLock<Mutex<Map<String, Value>>> = LazyLock::new(|| Mutex::new(Map::new()));

fn slice_units(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n { s.to_string() } else { String::from_utf16_lossy(&units[..n]) }
}

fn str_or(v: Option<&Value>, fallback: &str) -> String {
    match v {
        Some(x) if truthy(Some(x)) => x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x)),
        _ => fallback.to_string(),
    }
}

pub fn report(input: &Value) -> bool {
    let conversation = str_or(input.get("conversation"), "");
    if conversation.is_empty() {
        return false;
    }
    let mut stuck = STUCK.lock().unwrap_or_else(|p| p.into_inner());
    if truthy(input.get("cleared")) {
        stuck.shift_remove(&conversation);
        return false;
    }
    let fresh = !stuck.contains_key(&conversation);
    let entry = json!({
        "conversation": conversation,
        "name": slice_units(&str_or(input.get("name"), "Una sesión"), 80),
        "text": slice_units(&str_or(input.get("text"), ""), 1200),
        "at": crate::core::time::now(),
    });
    stuck.insert(conversation, entry);
    fresh
}

pub fn list() -> Vec<Value> {
    STUCK.lock().unwrap_or_else(|p| p.into_inner()).values().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_board_keeps_one_notice_per_stuck_session_tells_only_the_first_time_and_clears_it() {
        assert!(report(&json!({ "conversation": "c1", "name": "Tablero", "text": "pregunta" })));
        assert!(!report(&json!({ "conversation": "c1", "name": "Tablero", "text": "pregunta" })));
        assert_eq!(list().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect::<Vec<_>>(), vec!["Tablero"]);
        report(&json!({ "conversation": "c1", "cleared": true }));
        assert!(list().is_empty());
    }
}

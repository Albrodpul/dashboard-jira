//! Port of src/features/reminders.js.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::core::data::{Doc, load, mutate, now};
use crate::core::json::truthy;
use crate::core::time::Clock;

static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([01][0-9]|2[0-3]):[0-5][0-9]$").unwrap());
static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap());

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(x) if truthy(Some(x)) => x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x)),
        _ => String::new(),
    }
}

fn to_min(t: &str) -> u32 {
    let h: u32 = t.get(0..2).and_then(|x| x.parse().ok()).unwrap_or(0);
    let m: u32 = t.get(3..).and_then(|x| x.parse().ok()).unwrap_or(0);
    h * 60 + m
}

pub fn madrid(ms: Option<i64>) -> Clock {
    crate::core::time::madrid(ms.unwrap_or_else(crate::core::time::now_ms))
}

pub fn is_due(r: &Value, ms: Option<i64>) -> bool {
    if !truthy(Some(r)) || truthy(r.get("removed")) {
        return false;
    }
    let t = madrid(ms);
    let day = t.day.as_str();
    if r.get("from").and_then(Value::as_str).is_some_and(|f| day < f) || r.get("until").and_then(Value::as_str).is_some_and(|u| day > u) || r.get("lastDay").and_then(Value::as_str) == Some(day) {
        return false;
    }
    if truthy(r.get("weekdays")) && t.weekend {
        return false;
    }
    t.min >= to_min(text(r, "time"))
}

fn checked(input: &Value, keep_from: Option<&str>) -> Result<Map<String, Value>, String> {
    let units: Vec<u16> = str_of(input.get("text")).trim().encode_utf16().collect();
    let clean = String::from_utf16_lossy(&units[..units.len().min(4000)]);
    if clean.is_empty() {
        return Err("escribe el aviso".into());
    }
    let time = str_of(input.get("time"));
    if !TIME.is_match(&time) {
        return Err("la hora va como HH:MM".into());
    }
    let today = madrid(None).day;
    let from = [str_of(input.get("from")), keep_from.unwrap_or("").to_string(), today].into_iter().find(|x| !x.is_empty()).unwrap();
    let until = str_of(input.get("until"));
    if !DATE.is_match(&from) || !DATE.is_match(&until) {
        return Err("las fechas van como AAAA-MM-DD".into());
    }
    if until < from {
        return Err("el último día va antes del primero".into());
    }
    let area = input.get("area").cloned().unwrap_or(Value::Null);
    let state = crate::server::state::state();
    let known = state.get("areas").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.get("id") == Some(&area)));
    if !known {
        return Err("sesión desconocida".into());
    }
    let mut fields = Map::new();
    fields.insert("area".into(), area);
    fields.insert("text".into(), Value::from(clean));
    fields.insert("time".into(), Value::from(time));
    fields.insert("from".into(), Value::from(from));
    fields.insert("until".into(), Value::from(until));
    fields.insert("weekdays".into(), Value::from(truthy(input.get("weekdays"))));
    Ok(fields)
}

fn past_today(r: &Value) -> bool {
    let t = madrid(None);
    text(r, "from") <= t.day.as_str() && t.min >= to_min(text(r, "time"))
}

pub fn add(input: &Value) -> Result<Value, String> {
    let fields = checked(input, None)?;
    let at = now();
    let digits: String = at.chars().filter(|c| c.is_ascii_digit()).take(17).collect();
    let mut o = Map::new();
    o.insert("id".into(), Value::from(format!("rem-{digits}")));
    o.extend(fields);
    o.insert("createdAt".into(), Value::from(at));
    let mut r = Value::Object(o);
    if text(&r, "from") == madrid(None).day && past_today(&r) {
        let from = r["from"].clone();
        r["lastDay"] = from;
    }
    let saved = r.clone();
    mutate(move |d| {
        let list = d.entry("reminders").or_insert_with(|| json!([]));
        if let Some(a) = list.as_array_mut() {
            a.push(saved);
        }
    });
    crate::features::mailman::kick();
    Ok(json!({ "reminder": r }))
}

pub fn update(id: &str, input: &Value) -> Result<Value, String> {
    let old = load().get("reminders").and_then(Value::as_array).and_then(|a| a.iter().find(|x| text(x, "id") == id).cloned()).ok_or_else(|| "aviso desconocido".to_string())?;
    let fields = checked(input, old.get("from").and_then(Value::as_str))?;
    let r = mutate(|d| {
        let x = d.get_mut("reminders").and_then(Value::as_array_mut).and_then(|a| a.iter_mut().find(|y| text(y, "id") == id))?;
        let o = x.as_object_mut()?;
        for (k, v) in fields {
            o.insert(k, v);
        }
        o.insert("updatedAt".into(), Value::from(now()));
        let today = madrid(None).day;
        let snapshot = Value::Object(o.clone());
        if text(&snapshot, "lastDay") != today && past_today(&snapshot) && (text(&snapshot, "time") != text(&old, "time") || snapshot.get("from") != old.get("from")) {
            o.insert("lastDay".into(), Value::from(today));
        }
        o.shift_remove("delivery");
        Some(Value::Object(o.clone()))
    });
    crate::features::mailman::kick();
    Ok(json!({ "reminder": r.unwrap_or(Value::Null) }))
}

pub fn remove(id: &str) -> String {
    mutate(|d| {
        let Some(list) = d.get_mut("reminders").and_then(Value::as_array_mut) else { return "aviso desconocido".to_string() };
        if !list.iter().any(|x| text(x, "id") == id) {
            return "aviso desconocido".to_string();
        }
        list.retain(|x| text(x, "id") != id);
        String::new()
    })
}

pub fn for_page(d: &Doc) -> Value {
    let today = madrid(None).day;
    Value::Array(
        d.get("reminders")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|r| r.get("until").and_then(Value::as_str).is_some_and(|u| u >= today.as_str()))
                    .map(|r| {
                        let mut o = r.as_object().cloned().unwrap_or_default();
                        let delivery = o.get("delivery").filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
                        o.insert("delivery".into(), delivery);
                        Value::Object(o)
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

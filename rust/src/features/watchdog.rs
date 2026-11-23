//! Port of src/features/watchdog.js.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::core::data::{Doc, load, mutate, now};
use crate::core::json::truthy;
use crate::core::time::{minutes_since, now_ms, parse};

const WAITING_MIN: f64 = 4.0;
const REPEAT_MIN: i64 = 15;
const TYPING_MIN: f64 = 4.0;
const RENOTIFY_MS: i64 = 2 * 3600000;
const TAIL: u64 = 256 * 1024;
const DISMISS_KEEP_MS: i64 = 24 * 3600000;

static NOTICE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(Aviso del (?:tablero|arranque):[^\n<]*)").unwrap());
static MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\[envío E[0-9]+\]\s*").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn js_text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => crate::core::json::stringify(other),
    }
}

fn since(iso: Option<&Value>) -> f64 {
    match iso.and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(s) => minutes_since(s),
        None => 0.0,
    }
}

fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

fn slice_units(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n { s.to_string() } else { String::from_utf16_lossy(&units[..n]) }
}

fn tail_lines(file: &Path) -> Vec<String> {
    let Ok(meta) = std::fs::metadata(file) else { return Vec::new() };
    let size = meta.len();
    let length = size.min(TAIL);
    let mut buf = Vec::new();
    let Ok(mut f) = std::fs::File::open(file) else { return Vec::new() };
    if f.seek(SeekFrom::Start(size - length)).is_err() || f.take(length).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    text.split('\n').skip(if length < size { 1 } else { 0 }).map(str::to_string).collect()
}

fn notice_of(content: &str) -> Option<String> {
    let m = NOTICE.captures(content)?;
    let cleaned = MARK.replace_all(&m[1], " ");
    Some(SPACES.replace_all(&cleaned, " ").trim().to_string())
}

pub fn repeated_notices(lines: &[String], since_ms: i64) -> Vec<Value> {
    let mut seen: HashMap<String, i64> = HashMap::new();
    let mut out = Vec::new();
    for line in lines {
        if !line.contains("Aviso del") {
            continue;
        }
        let Ok(j) = serde_json::from_str::<Value>(line) else { continue };
        if text(&j, "type") != "user" || !truthy(j.get("message")) || !truthy(j.get("timestamp")) {
            continue;
        }
        let Some(at) = parse(text(&j, "timestamp")) else { continue };
        if at < since_ms {
            continue;
        }
        let content = match j["message"].get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a.iter().map(|c| c.get("text").and_then(Value::as_str).unwrap_or("").to_string()).collect::<Vec<_>>().join("\n"),
            _ => String::new(),
        };
        let Some(notice) = notice_of(&content) else { continue };
        if let Some(prev) = seen.get(&notice) {
            if at - prev < REPEAT_MIN * 60000 {
                out.push(json!({ "notice": notice, "at": j["timestamp"] }));
            }
        }
        seen.insert(notice, at);
    }
    out
}

fn finding(key: String, kind: &str, conversation: Option<&Value>, name: Option<&Value>, title: String, detail: String) -> Value {
    let mut o = Map::new();
    o.insert("key".into(), Value::from(key));
    o.insert("kind".into(), Value::from(kind));
    if let Some(c) = conversation {
        o.insert("conversation".into(), c.clone());
    }
    if let Some(n) = name {
        o.insert("name".into(), n.clone());
    }
    o.insert("title".into(), Value::from(title));
    o.insert("detail".into(), Value::from(detail));
    Value::Object(o)
}

fn first_truthy<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

pub fn findings(s: &Value, d: &Doc) -> Vec<Value> {
    let mut out = Vec::new();
    let pending: HashSet<String> = d.get("permissions").and_then(Value::as_array).map(|a| a.iter().filter(|p| text(p, "status") == "pending").map(|p| js_text(p.get("conversation"))).collect()).unwrap_or_default();
    let stuck: HashSet<String> = s.get("stuckDialogs").and_then(Value::as_array).map(|a| a.iter().map(|x| js_text(x.get("conversation"))).collect()).unwrap_or_default();
    let empty = Vec::new();
    let list = s.get("sessions").and_then(|x| x.get("list")).and_then(Value::as_array).unwrap_or(&empty);
    for x in list {
        if !truthy(x.get("conversation")) {
            continue;
        }
        let conversation = js_text(x.get("conversation"));
        let name = first_truthy(x.get("title"), x.get("name"));
        let name_text = js_text(name);
        if text(x, "status") == "waiting" && since(x.get("statusSince")) >= WAITING_MIN && !pending.contains(&conversation) && !stuck.contains(&conversation) {
            out.push(finding(
                format!("waiting|{conversation}|{}", js_text(x.get("statusSince"))),
                "waiting",
                x.get("conversation"),
                name,
                format!("«{name_text}» lleva {} min esperando y el tablero no muestra ninguna pregunta suya", js_round(since(x.get("statusSince")))),
                "Ábrela en directo y contesta. El tablero no la ha detectado: hay que ver por qué.".into(),
            ));
        }
        let Some(file) = crate::sessions::registry::transcript_of(&conversation) else { continue };
        for r in repeated_notices(&tail_lines(&file), now_ms() - 3 * 3600000) {
            out.push(finding(
                format!("repeat|{conversation}|{}", js_text(r.get("at"))),
                "repeat",
                x.get("conversation"),
                name,
                format!("«{name_text}» ha recibido dos veces el mismo aviso en menos de {REPEAT_MIN} min"),
                slice_units(text(&r, "notice"), 300),
            ));
        }
    }
    for r in d.get("deliveries").and_then(Value::as_array).unwrap_or(&empty) {
        if text(r, "status") == "typing" && since(r.get("at")) >= TYPING_MIN {
            let who = first_truthy(r.get("area"), r.get("role"));
            let ids: Vec<String> = r.get("ids").and_then(Value::as_array).map(|a| a.iter().map(|x| js_text(Some(x))).collect()).unwrap_or_default();
            out.push(finding(
                format!("typing|{}", js_text(r.get("id"))),
                "typing",
                r.get("conversation"),
                who,
                format!("El envío {} a «{}» lleva {} min a medio escribir", js_text(r.get("id")), js_text(who), js_round(since(r.get("at")))),
                format!("{}: {}", js_text(r.get("kind")), ids.join(", ")),
            ));
        }
    }
    out
}

fn board_notice(f: &Value) -> String {
    format!(
        "Aviso del tablero: el vigilante ha visto un fallo del tablero. {}. {} Revisa la causa en el código del tablero y arréglala; si no es un fallo del tablero, cuéntaselo a Alberto.",
        js_text(f.get("title")),
        js_text(f.get("detail"))
    )
}

fn stamps(w: Option<&Value>, k: &str) -> Map<String, Value> {
    w.and_then(|w| w.get(k)).and_then(Value::as_object).cloned().unwrap_or_default()
}

fn older_than(at: &Value, ms: i64) -> bool {
    at.as_str().and_then(parse).is_some_and(|t| now_ms() - t > ms)
}

pub fn apply(found: &[Value]) -> Vec<Value> {
    mutate(|d| {
        let w = d.get("watchdog");
        let prev: HashMap<String, Value> = w.and_then(|w| w.get("alerts")).and_then(Value::as_array).map(|a| a.iter().map(|x| (js_text(x.get("key")), x.clone())).collect()).unwrap_or_default();
        let mut notified = stamps(w, "notified");
        let mut dismissed = stamps(w, "dismissed");
        dismissed.retain(|_, at| !older_than(at, DISMISS_KEEP_MS));
        notified.retain(|_, at| !older_than(at, RENOTIFY_MS));
        let mut fresh = Vec::new();
        let alerts: Vec<Value> = found
            .iter()
            .filter(|f| !truthy(dismissed.get(&js_text(f.get("key")))))
            .map(|f| {
                let key = js_text(f.get("key"));
                let old = prev.get(&key);
                let kind_key = format!("{}|{}", js_text(f.get("kind")), f.get("conversation").filter(|c| truthy(Some(c))).map(|c| js_text(Some(c))).unwrap_or_default());
                if old.is_none() && !truthy(notified.get(&kind_key)) {
                    notified.insert(kind_key, Value::from(now()));
                    fresh.push(f.clone());
                }
                let mut o = f.as_object().cloned().unwrap_or_default();
                o.insert("at".into(), old.and_then(|x| x.get("at")).cloned().unwrap_or_else(|| Value::from(now())));
                o.insert("seenAt".into(), Value::from(now()));
                Value::Object(o)
            })
            .collect();
        d.insert("watchdog".into(), json!({ "alerts": alerts, "notified": notified, "dismissed": dismissed, "checkedAt": now() }));
        fresh
    })
}

pub fn dismiss(key: &str) {
    mutate(|d| {
        if !d.get("watchdog").is_some_and(|v| truthy(Some(v))) {
            d.insert("watchdog".into(), json!({}));
        }
        let w = d.get_mut("watchdog").unwrap();
        let mut dismissed = w.get("dismissed").and_then(Value::as_object).cloned().unwrap_or_default();
        dismissed.insert(key.to_string(), Value::from(now()));
        w["dismissed"] = Value::Object(dismissed);
        let alerts: Vec<Value> = w.get("alerts").and_then(Value::as_array).map(|a| a.iter().filter(|x| x.get("key").and_then(Value::as_str) != Some(key)).cloned().collect()).unwrap_or_default();
        w["alerts"] = Value::Array(alerts);
    });
}

pub fn tick() {
    if !crate::cluster::cluster::is_primary() || crate::core::hours::resting(None) {
        return;
    }
    let s = crate::server::state::state();
    let fresh = apply(&findings(&s, &load()));
    for f in fresh {
        let title = js_text(f.get("title"));
        crate::server::push::send_push("watchdog", true, Some(&title));
        crate::features::mailman::notify_role("board", &board_notice(&f));
    }
}

pub fn for_page(d: &Doc) -> Value {
    let alerts = d.get("watchdog").and_then(|w| w.get("alerts")).and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        alerts
            .iter()
            .map(|a| {
                let mut o = Map::new();
                for k in ["key", "kind", "conversation", "name", "title", "detail", "at"] {
                    if let Some(v) = a.get(k) {
                        o.insert(k.into(), v.clone());
                    }
                }
                Value::Object(o)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::time::iso;

    fn ago(min: i64) -> String {
        iso(now_ms() - min * 60000)
    }

    fn user_line(min: i64, content: &str) -> String {
        crate::core::json::stringify(&json!({ "type": "user", "timestamp": ago(min), "message": { "role": "user", "content": content } }))
    }

    #[test]
    fn the_same_startup_notice_twice_within_15_minutes_is_a_repeat_even_from_different_senders_or_with_different_marks() {
        let notice = "Aviso del arranque: arranca el seguimiento. Eres la sesión de seguimiento registrada.";
        let lines = vec![
            user_line(30, &format!("<cross-session-message from-name=\"palc-3c\">\n{notice}\n</cross-session-message>")),
            user_line(29, &format!("<cross-session-message from-name=\"palc-4c\">\n{notice}\n</cross-session-message>")),
            user_line(10, "Aviso del tablero: arranca la sesión del tablero [envío E1]"),
            user_line(1, "Aviso del tablero: algo distinto"),
        ];
        let r = repeated_notices(&lines, now_ms() - 3600000);
        assert_eq!(r.len(), 1);
        assert!(text(&r[0], "notice").contains("arranca el seguimiento"));
        assert_eq!(repeated_notices(&[user_line(40, notice), user_line(10, notice)], now_ms() - 3600000).len(), 0);
    }

    #[test]
    fn a_session_waiting_with_no_question_on_the_board_is_flagged_one_whose_question_the_board_shows_is_not() {
        let _g = crate::testkit::fresh();
        let s = json!({ "sessions": { "list": [
            { "conversation": "c1", "name": "Errores sentry", "status": "waiting", "statusSince": ago(6) },
            { "conversation": "c2", "name": "Otra", "status": "waiting", "statusSince": ago(6) },
            { "conversation": "c3", "name": "Reciente", "status": "waiting", "statusSince": ago(1) }
        ] }, "stuckDialogs": [] });
        let d = json!({ "permissions": [{ "conversation": "c2", "status": "pending" }], "deliveries": [{ "id": "E9", "status": "typing", "at": ago(10), "area": "pagos", "kind": "tasks", "ids": ["WEB-1"] }] });
        let f = findings(&s, d.as_object().unwrap());
        let mut got: Vec<String> = f.iter().map(|x| format!("{}:{}", text(x, "kind"), js_text(x.get("conversation")))).collect();
        got.sort();
        assert_eq!(got, vec!["typing:undefined".to_string(), "waiting:c1".to_string()]);
    }

    #[test]
    fn each_problem_is_announced_once_stays_listed_while_it_lasts_and_goes_away_when_fixed() {
        let _g = crate::testkit::fresh();
        let f = json!({ "key": "waiting|c1|x", "kind": "waiting", "conversation": "c1", "name": "A", "title": "t", "detail": "d" });
        assert_eq!(apply(&[f.clone()]).len(), 1);
        assert_eq!(apply(&[f.clone()]).len(), 0);
        assert_eq!(load()["watchdog"]["alerts"].as_array().unwrap().len(), 1);
        let mut other = f.clone();
        other["key"] = json!("waiting|c1|y");
        assert_eq!(apply(&[other]).len(), 0);
        apply(&[]);
        assert_eq!(load()["watchdog"]["alerts"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn a_dismissed_alert_leaves_the_page_and_does_not_come_back_while_the_same_finding_repeats() {
        let _g = crate::testkit::fresh();
        let f = json!({ "key": "repeat|c9|t", "kind": "repeat", "conversation": "c9", "name": "R", "title": "t", "detail": "d" });
        apply(&[f.clone()]);
        assert_eq!(for_page(&load()).as_array().unwrap().len(), 1);
        dismiss("repeat|c9|t");
        assert_eq!(for_page(&load()).as_array().unwrap().len(), 0);
        apply(&[f]);
        assert_eq!(for_page(&load()).as_array().unwrap().len(), 0);
    }
}

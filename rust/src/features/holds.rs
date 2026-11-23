//! Port of src/features/holds.js.

use std::sync::LazyLock;

use chrono::{Datelike, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Europe::Madrid;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::core::data::Doc;
use crate::core::json::truthy;
use crate::core::time::{iso, now_ms, parse};

pub const MODES: [&str; 2] = ["hold", "note"];
const IN_SESSION_OPEN: [&str; 3] = ["sent", "waiting", "partial"];
const KEEP_MS: i64 = 30 * 24 * 3600 * 1000;

static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9]+-[0-9]+$").unwrap());
static NO_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(null|none|never|nunca|ninguna|sin fecha|indefinida|-)$").unwrap());
static ISO_ZONED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2})(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})$").unwrap());
static YMD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[ T]([0-9]{1,2}):([0-9]{2}))?$").unwrap());
static DMY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{1,2})[-/]([0-9]{1,2})(?:[-/]([0-9]{2}|[0-9]{4}))?(?:[ T]([0-9]{1,2}):([0-9]{2}))?$").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

#[derive(Clone, Debug, Default)]
pub struct AddOptions {
    pub areas: Option<Vec<String>>,
    pub now_ms: Option<i64>,
}

struct Parts {
    y: i64,
    m: i64,
    d: i64,
    h: i64,
    mi: i64,
}

fn madrid_parts(ms: i64) -> Parts {
    let t = Utc.timestamp_millis_opt(ms).single().unwrap_or_default().with_timezone(&Madrid);
    Parts { y: t.year() as i64, m: t.month() as i64, d: t.day() as i64, h: t.hour() as i64, mi: t.minute() as i64 }
}

fn utc_ms(y: i64, m: i64, d: i64, h: i64, mi: i64) -> i64 {
    let first = NaiveDate::from_ymd_opt(y as i32, 1, 1).unwrap_or_default();
    let month_start = first.checked_add_months(chrono::Months::new((m - 1).max(0) as u32)).unwrap_or(first);
    let base = month_start.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis();
    base + (d - 1) * 86_400_000 + h * 3_600_000 + mi * 60_000
}

fn weekday_es(ms: i64) -> &'static str {
    let t = Utc.timestamp_millis_opt(ms).single().unwrap_or_default().with_timezone(&Madrid);
    ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"][t.weekday().num_days_from_monday() as usize]
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => crate::core::json::stringify(other),
    }
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

pub fn madrid_to_ms(y: i64, m: i64, d: i64, h: i64, mi: i64) -> i64 {
    let wanted = utc_ms(y, m, d, h, mi);
    let mut guess = wanted;
    for _ in 0..3 {
        let p = madrid_parts(guess);
        guess += wanted - utc_ms(p.y, p.m, p.d, p.h, p.mi);
    }
    guess
}

fn number(c: &regex::Captures, i: usize) -> Option<i64> {
    c.get(i).map(|x| x.as_str().parse::<i64>().unwrap_or(0))
}

pub fn parse_until(text: &str, now_ms_opt: Option<i64>) -> Result<Option<String>, String> {
    let now = now_ms_opt.unwrap_or_else(now_ms);
    let raw = text.trim();
    if raw.is_empty() || NO_DATE.is_match(raw) {
        return Ok(None);
    }
    let ms: Option<i64>;
    if let Some(c) = ISO_ZONED.captures(raw) {
        let secs = c.get(3).map(|x| x.as_str().to_string()).unwrap_or_else(|| ":00".into());
        let zone = c.get(5).unwrap().as_str();
        let zone = if zone == "Z" || zone.contains(':') { zone.to_string() } else { format!("{}:{}", &zone[..3], &zone[3..]) };
        ms = chrono::DateTime::parse_from_rfc3339(&format!("{}T{}{}{}", &c[1], &c[2], secs, zone)).ok().map(|x| x.timestamp_millis());
    } else {
        let (y, mo, d, h, mi, year_given);
        if let Some(c) = YMD.captures(raw) {
            y = number(&c, 1).unwrap();
            mo = number(&c, 2).unwrap();
            d = number(&c, 3).unwrap();
            h = number(&c, 4);
            mi = number(&c, 5);
            year_given = true;
        } else if let Some(c) = DMY.captures(raw) {
            d = number(&c, 1).unwrap();
            mo = number(&c, 2).unwrap();
            h = number(&c, 4);
            mi = number(&c, 5);
            year_given = c.get(3).is_some();
            y = match c.get(3) {
                Some(x) if x.as_str().len() == 2 => 2000 + x.as_str().parse::<i64>().unwrap_or(0),
                Some(x) => x.as_str().parse::<i64>().unwrap_or(0),
                None => madrid_parts(now).y,
            };
        } else {
            return Err(format!("no entiendo la fecha «{raw}»: usa 9-11, 9-11 18:00, 2026-11-09 o 2026-11-09 18:00 (hora de Madrid)"));
        }
        let h = h.unwrap_or(0);
        let mi = mi.unwrap_or(0);
        let valid = |yy: i64| (1..=12).contains(&mo) && d >= 1 && NaiveDate::from_ymd_opt(yy as i32, mo as u32, d as u32).is_some() && h < 24 && mi < 60;
        if !valid(y) {
            return Err(format!("la fecha «{raw}» no existe"));
        }
        let mut at = madrid_to_ms(y, mo, d, h, mi);
        if !year_given && at <= now && valid(y + 1) {
            at = madrid_to_ms(y + 1, mo, d, h, mi);
        }
        ms = Some(at);
    }
    let Some(ms) = ms else { return Err(format!("no entiendo la fecha «{raw}»")) };
    if ms <= now {
        return Err(format!("la fecha «{raw}» ya ha pasado"));
    }
    Ok(Some(iso(ms)))
}

pub fn short_until(iso_text: Option<&str>) -> String {
    let Some(s) = iso_text.filter(|s| !s.is_empty()) else { return String::new() };
    let p = madrid_parts(parse(s).unwrap_or(0));
    let clock = if p.h != 0 || p.mi != 0 { format!(" {:02}:{:02}", p.h, p.mi) } else { String::new() };
    format!("{}-{}{}", p.d, p.m, clock)
}

pub fn long_until(iso_text: Option<&str>) -> String {
    let Some(s) = iso_text.filter(|s| !s.is_empty()) else { return "hasta que se levante a mano".into() };
    let ms = parse(s).unwrap_or(0);
    let p = madrid_parts(ms);
    format!("hasta el {} {}-{}-{} a las {:02}:{:02} (hora de Madrid)", weekday_es(ms), p.d, p.m, p.y, p.h, p.mi)
}

fn list(d: &Doc) -> Vec<Value> {
    d.get("restrictions").and_then(Value::as_array).cloned().unwrap_or_default()
}

pub fn is_active(r: &Value, now_ms_opt: Option<i64>) -> bool {
    let now = now_ms_opt.unwrap_or_else(now_ms);
    if !truthy(Some(r)) || truthy(r.get("releasedAt")) {
        return false;
    }
    if !truthy(r.get("until")) {
        return true;
    }
    parse(text(r, "until")).is_some_and(|u| now < u)
}

fn scope_list(r: &Value, k: &str) -> Vec<String> {
    r.get("scope").and_then(|s| s.get(k)).and_then(Value::as_array).map(|a| a.iter().map(|x| str_of(Some(x))).collect()).unwrap_or_default()
}

pub fn matches(r: &Value, target: &Value) -> bool {
    let has = |list: &str, k: &str| {
        let v = text(target, k);
        !v.is_empty() && scope_list(r, list).iter().any(|x| x == v)
    };
    has("tasks", "key") || has("epics", "epicKey") || has("areas", "area")
}

pub fn task_target(t: &Value, area: Option<&str>) -> Value {
    let pick = [area.unwrap_or(""), text(t, "area"), text(t, "proposedArea")].into_iter().find(|x| !x.is_empty());
    let mut out = Map::new();
    if let Some(k) = t.get("key") {
        out.insert("key".into(), k.clone());
    }
    out.insert("epicKey".into(), if truthy(t.get("epicKey")) { t["epicKey"].clone() } else { Value::Null });
    out.insert("area".into(), pick.map(Value::from).unwrap_or(Value::Null));
    Value::Object(out)
}

pub fn restrictions_for(d: &Doc, target: &Value, now_ms_opt: Option<i64>) -> Vec<Value> {
    let now = now_ms_opt.unwrap_or_else(now_ms);
    list(d).into_iter().filter(|r| is_active(r, Some(now)) && matches(r, target)).collect()
}

pub fn holds_for(d: &Doc, target: &Value, now_ms_opt: Option<i64>) -> Vec<Value> {
    restrictions_for(d, target, now_ms_opt).into_iter().filter(|r| text(r, "mode") == "hold").collect()
}

pub fn notes_for(d: &Doc, target: &Value, now_ms_opt: Option<i64>) -> Vec<Value> {
    restrictions_for(d, target, now_ms_opt).into_iter().filter(|r| text(r, "mode") == "note").collect()
}

pub fn scope_text(r: &Value, area_name: Option<&dyn Fn(&str) -> String>) -> String {
    let mut out = Vec::new();
    let tasks = scope_list(r, "tasks");
    let epics = scope_list(r, "epics");
    let areas = scope_list(r, "areas");
    if !tasks.is_empty() {
        out.push(tasks.join(", "));
    }
    if !epics.is_empty() {
        out.push(format!("epic {}", epics.join(", ")));
    }
    if !areas.is_empty() {
        let names: Vec<String> = areas.iter().map(|a| area_name.map(|f| f(a)).unwrap_or_else(|| a.clone())).collect();
        out.push(format!("sesión {}", names.join(", ")));
    }
    out.join("; ")
}

pub fn hold_error(what: &str, holds: &[Value]) -> String {
    let r = &holds[0];
    format!(
        "{what} está retenida por la restricción {} («{}»), {}. No se puede aprobar ni enviar hasta que caduque o se levante (board.js hold release {}, o en Tareas → Restricciones).",
        text(r, "id"),
        str_of(r.get("reason")),
        long_until(r.get("until").and_then(Value::as_str)),
        text(r, "id")
    )
}

pub fn check_task(d: &Doc, t: &Value, area: Option<&str>, now_ms_opt: Option<i64>) -> String {
    let cross = crate::core::projects::cross_project(t, area, None);
    if !cross.is_empty() {
        return cross;
    }
    let holds = holds_for(d, &task_target(t, area), now_ms_opt);
    if holds.is_empty() { String::new() } else { hold_error(text(t, "key"), &holds) }
}

pub fn check_area(d: &Doc, what: &str, area: &str, now_ms_opt: Option<i64>) -> String {
    let holds = holds_for(d, &json!({ "area": area }), now_ms_opt);
    if holds.is_empty() { String::new() } else { hold_error(what, &holds) }
}

fn clean_list(values: Option<&Value>) -> Vec<String> {
    let items: Vec<String> = match values {
        Some(v) if !truthy(Some(v)) => Vec::new(),
        None => Vec::new(),
        Some(Value::Array(a)) => a.iter().map(|x| str_of(Some(x))).collect(),
        Some(other) => vec![str_of(Some(other))],
    };
    let mut out: Vec<String> = Vec::new();
    for x in items.iter().flat_map(|x| x.split(',').map(|p| p.trim().to_string()).collect::<Vec<_>>()) {
        if !x.is_empty() && !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

fn slice_units(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n { s.to_string() } else { String::from_utf16_lossy(&units[..n]) }
}

pub fn add_restriction(d: &mut Doc, input: &Value, options: AddOptions) -> Result<Value, String> {
    let now = options.now_ms.unwrap_or_else(now_ms);
    let mode = if truthy(input.get("mode")) { str_of(input.get("mode")) } else { "hold".to_string() };
    if !MODES.contains(&mode.as_str()) {
        return Err(format!("modo desconocido: {mode} (hold o note)"));
    }
    let tasks: Vec<String> = clean_list(input.get("tasks")).into_iter().map(|x| x.to_uppercase()).collect();
    let bad: Vec<String> = tasks.iter().filter(|k| !KEY.is_match(k)).cloned().collect();
    if !bad.is_empty() {
        return Err(format!("claves no válidas: {}", bad.join(", ")));
    }
    let epics: Vec<String> = clean_list(input.get("epics")).into_iter().map(|x| x.to_uppercase()).collect();
    let bad: Vec<String> = epics.iter().filter(|k| !KEY.is_match(k)).cloned().collect();
    if !bad.is_empty() {
        return Err(format!("epics no válidos: {}", bad.join(", ")));
    }
    let area_ids = clean_list(input.get("areas"));
    if let Some(areas) = &options.areas {
        let unknown: Vec<String> = area_ids.iter().filter(|a| !areas.contains(a)).cloned().collect();
        if !unknown.is_empty() {
            return Err(format!("sesiones desconocidas: {}. Las que hay: {}", unknown.join(", "), areas.join(", ")));
        }
    }
    if tasks.is_empty() && epics.is_empty() && area_ids.is_empty() {
        return Err("di a qué se aplica: tareas, epics o sesiones".into());
    }
    let reason_raw = if truthy(input.get("reason")) { str_of(input.get("reason")) } else { String::new() };
    let reason = slice_units(SPACES.replace_all(&reason_raw, " ").trim(), 600);
    if reason.is_empty() {
        return Err(if mode == "note" { "falta el texto de la indicación".into() } else { "falta el motivo".into() });
    }
    let mut until = Value::Null;
    match input.get("until") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s.is_empty() => {}
        Some(u) => {
            if let Some(x) = parse_until(&str_of(Some(u)), Some(now))? {
                until = Value::from(x);
            }
        }
    }
    let at = iso(now);
    let kept: Vec<Value> = list(d)
        .into_iter()
        .filter(|r| {
            if is_active(r, Some(now)) {
                return true;
            }
            let pick = ["releasedAt", "until", "createdAt"].iter().map(|k| text(r, k)).find(|x| !x.is_empty()).unwrap_or("");
            parse(pick).is_some_and(|t| now - t < KEEP_MS)
        })
        .collect();
    let digits: String = at.chars().filter(|c| c.is_ascii_digit()).take(17).collect();
    let base = format!("R{digits}");
    let mut id = base.clone();
    let mut n = 2;
    while kept.iter().any(|r| text(r, "id") == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    let created_by = if text(input, "createdBy") == "board" { "board" } else { "chat" };
    let r = json!({ "id": id, "scope": { "tasks": tasks, "epics": epics, "areas": area_ids }, "mode": mode, "reason": reason, "until": until, "createdAt": at, "createdBy": created_by, "releasedAt": null });
    let mut all = vec![r.clone()];
    all.extend(kept);
    d.insert("restrictions".into(), Value::Array(all));
    let mut reverted = Vec::new();
    let mut in_session = Vec::new();
    if let Some(tasks) = d.get_mut("tasks").and_then(Value::as_object_mut) {
        for t in tasks.values_mut() {
            if mode != "hold" || !matches(&r, &task_target(t, None)) {
                continue;
            }
            let status = text(t, "status").to_string();
            if status == "approved" {
                let proposed = [text(t, "area"), text(t, "proposedArea")].into_iter().find(|x| !x.is_empty()).unwrap_or("").to_string();
                let o = t.as_object_mut().unwrap();
                o.insert("status".into(), Value::from("pending"));
                o.insert("proposedArea".into(), Value::from(proposed));
                o.insert("decidedAt".into(), Value::Null);
                o.insert("heldBack".into(), json!({ "restriction": id, "at": at }));
                for k in ["approvedVia", "delivery"] {
                    o.shift_remove(k);
                }
                reverted.push(text(t, "key").to_string());
            } else if IN_SESSION_OPEN.contains(&status.as_str()) && !truthy(t.get("manual")) {
                in_session.push(text(t, "key").to_string());
            }
        }
    }
    Ok(json!({ "restriction": r, "reverted": reverted, "inSession": in_session }))
}

pub fn release_restriction(d: &mut Doc, id: &str, by: Option<&str>, now_ms_opt: Option<i64>) -> Result<Value, String> {
    let now = now_ms_opt.unwrap_or_else(now_ms);
    let missing = || format!("no existe la restricción {id}");
    let list = d.get_mut("restrictions").and_then(Value::as_array_mut).ok_or_else(missing)?;
    let r = list.iter_mut().find(|x| text(x, "id") == id).ok_or_else(missing)?;
    if truthy(r.get("releasedAt")) {
        return Err(format!("la restricción {id} ya se levantó"));
    }
    if !is_active(r, Some(now)) {
        return Err(format!("la restricción {id} ya caducó"));
    }
    let o = r.as_object_mut().unwrap();
    o.insert("releasedAt".into(), Value::from(iso(now)));
    o.insert("releasedBy".into(), Value::from(if by == Some("board") { "board" } else { "chat" }));
    Ok(json!({ "restriction": r.clone() }))
}

pub fn pending_stop_notices(d: &Doc, now_ms_opt: Option<i64>) -> Vec<Value> {
    let now = now_ms_opt.unwrap_or_else(now_ms);
    let mut out = Vec::new();
    let Some(tasks) = d.get("tasks").and_then(Value::as_object) else { return out };
    for t in tasks.values() {
        if !IN_SESSION_OPEN.contains(&text(t, "status")) || truthy(t.get("manual")) || !truthy(t.get("area")) {
            continue;
        }
        for r in holds_for(d, &task_target(t, None), Some(now)) {
            let sent = t.get("stopNotices").and_then(|s| s.get(text(&r, "id")));
            if !truthy(sent) {
                out.push(json!({ "task": t, "restriction": r }));
            }
        }
    }
    out
}

fn chip(r: &Value) -> Value {
    let reason = str_of(r.get("reason"));
    let id = text(r, "id");
    let until = r.get("until").and_then(Value::as_str);
    if text(r, "mode") == "note" {
        return json!({ "text": "Con indicación", "title": format!("Indicación obligatoria ({id}): {reason}") });
    }
    let short = if reason.encode_utf16().count() > 24 { format!("{}…", slice_units(&reason, 23)) } else { reason.clone() };
    let hasta = if until.is_some_and(|u| !u.is_empty()) { format!(" hasta {}", short_until(until)) } else { String::new() };
    json!({ "text": format!("Retenida{hasta} · {short}"), "title": format!("Retenida por {id}: {reason}, {}.", long_until(until)) })
}

pub fn for_page(d: &Doc, now_ms_opt: Option<i64>) -> Value {
    let now = now_ms_opt.unwrap_or_else(now_ms);
    Value::Array(
        list(d)
            .into_iter()
            .filter(|r| is_active(r, Some(now)))
            .map(|r| {
                let until = r.get("until").and_then(Value::as_str).map(str::to_string);
                let mut o = r.as_object().cloned().unwrap_or_default();
                o.insert("chip".into(), chip(&r));
                o.insert("untilText".into(), Value::from(long_until(until.as_deref())));
                o.insert("short".into(), Value::from(short_until(until.as_deref())));
                Value::Object(o)
            })
            .collect(),
    )
}

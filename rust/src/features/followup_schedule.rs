//! Port of src/features/followup-schedule.js.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use crate::core::data::{Doc, load, mutate, now};
use crate::core::hours;
use crate::core::json::truthy;
use crate::core::time::Clock;

const WINDOW: u32 = 10;

static BUSY: AtomicBool = AtomicBool::new(false);

fn minute_of(environment: &str) -> u32 {
    if environment == "production" { 33 } else { 3 }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Due {
    pub environments: Vec<String>,
    pub slot: u32,
}

fn first_hour() -> i64 {
    ((hours::start_min() as f64 + 57.0) / 60.0).ceil() as i64
}

fn last_hour(environment: &str) -> i64 {
    ((hours::end_min() as f64 - minute_of(environment) as f64 - 1.0) / 60.0).floor() as i64
}

fn closing() -> u32 {
    hours::end_min() + 1
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

pub fn slots(environment: &str, every_hours: f64) -> Vec<u32> {
    let every = if every_hours.is_finite() && every_hours != 0.0 { every_hours } else { 1.0 };
    let n = ((every + 0.5).floor() as i64).clamp(1, 9);
    let mut out = Vec::new();
    let last = last_hour(environment);
    let mut h = first_hour();
    while h <= last {
        out.push((h * 60) as u32 + minute_of(environment));
        h += n;
    }
    out
}

pub fn due_now(environments: &Value, t: Option<&Clock>) -> Option<Due> {
    let owned;
    let t = match t {
        Some(c) => c,
        None => {
            owned = hours::clock();
            &owned
        }
    };
    if t.weekend {
        return None;
    }
    let list = environments.as_array().cloned().unwrap_or_default();
    for e in &list {
        let id = text(e, "id");
        let every = e.get("everyHours").and_then(Value::as_f64).unwrap_or(0.0);
        if let Some(slot) = slots(id, every).into_iter().find(|s| t.min >= *s && t.min < s + WINDOW) {
            return Some(Due { environments: vec![id.to_string()], slot });
        }
    }
    let close = closing();
    if t.min >= close && t.min < close + WINDOW {
        return Some(Due { environments: list.iter().map(|e| text(e, "id").to_string()).collect(), slot: close });
    }
    None
}

fn day_key() -> String {
    crate::core::time::madrid_now().day
}

pub fn pending(d: &Doc, environments: &Value) -> Vec<String> {
    let empty = json!({});
    let due = d.get("followUpDue").filter(|v| truthy(Some(v))).unwrap_or(&empty);
    environments
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|e| {
                    let id = text(e, "id");
                    let Some(hit) = due.get(id).filter(|v| truthy(Some(v))) else { return false };
                    let last = text(e, "lastScheduled");
                    last.is_empty() || last < text(hit, "at")
                })
                .map(|e| text(e, "id").to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn notice(envs: &[String]) -> String {
    format!(
        "Aviso del tablero: toca el seguimiento de {}. Compruébalo con «{} followup-status» (campo due) y haz «Cada resumen» de .claude/commands/seguimiento.md para {}.",
        envs.join(" y "),
        crate::core::config::cli(),
        if envs.len() > 1 { "cada uno, en ese orden" } else { "ese entorno" }
    )
}

fn follow_up_status() -> Value {
    crate::server::state::state().get("followUpStatus").cloned().unwrap_or(Value::Null)
}

pub fn tick() {
    if BUSY.load(Ordering::SeqCst) || !crate::cluster::cluster::primary_now() {
        return;
    }
    let mut e = follow_up_status();
    if !truthy(Some(&e)) || truthy(e.get("paused")) {
        return;
    }
    let Some(hit) = due_now(e.get("environments").unwrap_or(&Value::Null), None) else { return };
    let key = format!("{}@{}", day_key(), hit.slot);
    let d = load();
    let due = d.get("followUpDue").cloned().unwrap_or(Value::Null);
    let fresh: Vec<String> = hit.environments.into_iter().filter(|env| due.get(env).filter(|v| truthy(Some(v))).is_none_or(|x| text(x, "key") != key)).collect();
    if fresh.is_empty() {
        return;
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let run = || {
        mutate(|x| {
            let mut all = x.get("followUpDue").and_then(Value::as_object).cloned().unwrap_or_default();
            for env in &fresh {
                all.insert(env.clone(), json!({ "key": key, "at": now() }));
            }
            x.insert("followUpDue".into(), Value::Object(all));
        });
        if !truthy(e.get("open")) {
            crate::sessions::registry::open_in_vs_code(e.get("conversation").and_then(Value::as_str));
            let mut i = 0;
            while i < 24 {
                e = follow_up_status();
                if truthy(e.get("open")) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5000));
                i += 1;
            }
            if !truthy(e.get("open")) {
                return;
            }
            std::thread::sleep(Duration::from_millis(8000));
        }
        crate::sessions::registry::wake_session(text(&e, "session"), Some(&notice(&fresh)));
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    BUSY.store(false, Ordering::SeqCst);
    if let Err(p) = outcome {
        std::panic::resume_unwind(p);
    }
}

pub fn cron_of(environment: &str, every_hours: f64) -> String {
    let list: Vec<String> = slots(environment, every_hours).into_iter().map(|m| (m / 60).to_string()).collect();
    let hours_text = if list.is_empty() { "-".to_string() } else { list.join(",") };
    format!("{} {} * * 1-5", minute_of(environment), hours_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(local: &str) -> Clock {
        hours::clock_at(crate::core::time::parse(&format!("{local}+01:00")).unwrap())
    }

    fn envs() -> Value {
        json!([{ "id": "beta", "everyHours": 1 }, { "id": "production", "everyHours": 2 }])
    }

    fn hm(list: Vec<u32>) -> Vec<String> {
        list.into_iter().map(|m| format!("{}:{}", m / 60, m % 60)).collect()
    }

    fn due(envs: &[&str], slot: u32) -> Option<Due> {
        Some(Due { environments: envs.iter().map(|x| x.to_string()).collect(), slot })
    }

    #[test]
    fn slots_follow_the_same_hours_as_the_old_crons() {
        let _g = crate::testkit::fresh();
        assert_eq!(hm(slots("beta", 1.0)), ["9:3", "10:3", "11:3", "12:3", "13:3", "14:3", "15:3", "16:3", "17:3", "18:3"]);
        assert_eq!(hm(slots("production", 2.0)), ["9:33", "11:33", "13:33", "15:33", "17:33"]);
    }

    #[test]
    fn due_now_fires_inside_the_ten_minute_window_of_a_slot_on_weekdays_only() {
        let _g = crate::testkit::fresh();
        assert_eq!(due_now(&envs(), Some(&at("2026-11-09T10:03:00"))), due(&["beta"], 10 * 60 + 3));
        assert_eq!(due_now(&envs(), Some(&at("2026-11-09T10:12:00"))), due(&["beta"], 10 * 60 + 3));
        assert_eq!(due_now(&envs(), Some(&at("2026-11-09T10:13:00"))), None);
        assert_eq!(due_now(&envs(), Some(&at("2026-11-09T10:33:00"))), None);
        assert_eq!(due_now(&envs(), Some(&at("2026-11-09T11:35:00"))), due(&["production"], 11 * 60 + 33));
        assert_eq!(due_now(&envs(), Some(&at("2026-11-14T10:05:00"))), None);
    }

    #[test]
    fn closing_run_covers_both_environments_at_18_31() {
        let _g = crate::testkit::fresh();
        assert_eq!(due_now(&envs(), Some(&at("2026-11-09T18:31:00"))), due(&["beta", "production"], 18 * 60 + 31));
    }

    #[test]
    fn pending_lists_environments_fired_after_their_last_scheduled_summary_and_survives_storage() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("followUpDue".into(), json!({ "beta": { "key": "k", "at": "2026-11-09T09:03:10.000Z" }, "production": { "key": "k", "at": "2026-11-09T08:33:10.000Z" } }));
        });
        let d = load();
        let list = json!([{ "id": "beta", "lastScheduled": "2026-11-09T08:05:00.000Z" }, { "id": "production", "lastScheduled": "2026-11-09T08:40:00.000Z" }]);
        assert_eq!(pending(&d, &list), vec!["beta".to_string()]);
    }
}

use crate::core::data::{load, mutate, read_key};
use crate::core::time::{Clock, madrid, now_ms};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

const DEFAULT_START: &str = "07:30";
const DEFAULT_END: &str = "18:30";
const DAILY_LEAD: u32 = 90;

static HHMM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap());

fn hhmm_ok(t: Option<&str>) -> bool {
    HHMM.is_match(t.unwrap_or(""))
}

fn to_hhmm(m: u32) -> String {
    format!("{:02}:{:02}", m / 60, m % 60)
}

fn daily_ok(daily: Option<&str>, start: &str, end: &str) -> bool {
    match daily {
        Some(d) if HHMM.is_match(d) => to_min(d) > to_min(start) && to_min(d) <= to_min(end),
        _ => false,
    }
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub fn clock() -> Clock {
    madrid(now_ms())
}

pub fn clock_at(ms: i64) -> Clock {
    madrid(ms)
}

pub fn to_min(t: &str) -> u32 {
    let h: u32 = t.get(0..2).and_then(|x| x.parse().ok()).unwrap_or(0);
    let m: u32 = t.get(3..).and_then(|x| x.parse().ok()).unwrap_or(0);
    h * 60 + m
}

fn schedule_parts() -> (String, String, String) {
    let s = read_key("config").and_then(|c| c.get("workSchedule").cloned()).unwrap_or(json!({}));
    let mut start = if hhmm_ok(str_field(&s, "start")) { str_field(&s, "start").unwrap().to_string() } else { DEFAULT_START.to_string() };
    let mut end = if hhmm_ok(str_field(&s, "end")) { str_field(&s, "end").unwrap().to_string() } else { DEFAULT_END.to_string() };
    if to_min(&end) <= to_min(&start) {
        start = DEFAULT_START.to_string();
        end = DEFAULT_END.to_string();
    }
    let daily = if daily_ok(str_field(&s, "daily"), &start, &end) { str_field(&s, "daily").unwrap().to_string() } else { to_hhmm((to_min(&start) + 1).max(to_min(&end).saturating_sub(DAILY_LEAD))) };
    (start, end, daily)
}

pub fn schedule() -> Value {
    let (start, end, daily) = schedule_parts();
    json!({ "start": start, "end": end, "daily": daily })
}

fn given<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    if crate::core::json::truthy(input.get(key)) { Some(input.get(key).and_then(Value::as_str).unwrap_or("")) } else { None }
}

pub fn set_schedule(input: &Value) -> Value {
    let saved = load().get("config").and_then(|c| c.get("workSchedule").cloned()).unwrap_or(json!({}));
    let (mut start, mut end, _) = schedule_parts();
    if let Some(s) = given(input, "start") {
        start = s.to_string();
    }
    if let Some(e) = given(input, "end") {
        end = e.to_string();
    }
    if !HHMM.is_match(&start) || !HHMM.is_match(&end) {
        return json!({ "error": "hora no válida (HH:MM)" });
    }
    if (to_min(&end) as i64) - (to_min(&start) as i64) < 60 {
        return json!({ "error": "la jornada tiene que durar al menos una hora" });
    }
    let daily = given(input, "daily");
    let saved_daily = if crate::core::json::truthy(saved.get("daily")) { saved.get("daily").and_then(Value::as_str) } else { None };
    let wanted = daily.or(saved_daily);
    if let Some(d) = daily {
        if !HHMM.is_match(d) {
            return json!({ "error": "hora de la daily no válida (HH:MM)" });
        }
        if !daily_ok(Some(d), &start, &end) {
            return json!({ "error": "la daily tiene que redactarse dentro de la jornada" });
        }
    }
    let mut stored = Map::new();
    stored.insert("start".into(), Value::from(start.clone()));
    stored.insert("end".into(), Value::from(end.clone()));
    if let Some(w) = wanted.filter(|w| daily_ok(Some(w), &start, &end)) {
        stored.insert("daily".into(), Value::from(w));
    }
    mutate(|d| {
        let config = d.entry("config").or_insert_with(|| json!({}));
        if !config.is_object() {
            *config = json!({});
        }
        config["workSchedule"] = Value::Object(stored);
    });
    json!({ "schedule": schedule() })
}

pub fn start_min() -> u32 {
    to_min(&schedule_parts().0)
}

pub fn end_min() -> u32 {
    to_min(&schedule_parts().1)
}

pub fn daily_min() -> u32 {
    to_min(&schedule_parts().2)
}

pub fn work_hours(t: Option<&Clock>) -> bool {
    let owned;
    let t = match t {
        Some(t) => t,
        None => {
            owned = clock();
            &owned
        }
    };
    !t.weekend && t.min >= start_min() && t.min < end_min()
}

pub fn expired(ot: Option<&Value>, now_ms: Option<i64>) -> bool {
    let Some(ot) = ot else { return false };
    if !crate::core::json::truthy(Some(ot)) || !crate::core::json::truthy(ot.get("since")) {
        return false;
    }
    let Some(since) = ot.get("since").and_then(Value::as_str).and_then(crate::core::time::parse) else { return false };
    let now = now_ms.unwrap_or_else(crate::core::time::now_ms);
    let s = madrid(since);
    let d = madrid(now);
    if s.day != d.day {
        return true;
    }
    !s.weekend && s.min < start_min() && work_hours(Some(&d))
}

fn stored_overtime(d: &crate::core::data::Doc) -> Option<Value> {
    d.get("config").and_then(|c| c.get("overtime")).filter(|v| crate::core::json::truthy(Some(v))).cloned()
}

pub fn overtime() -> Option<Value> {
    let ot = stored_overtime(&load());
    if !expired(ot.as_ref(), None) {
        return ot;
    }
    let dropped = mutate(|d| {
        let expired_now = d.get("config").map_or(false, |c| expired(c.get("overtime"), None));
        if expired_now {
            if let Some(c) = d.get_mut("config").and_then(Value::as_object_mut) {
                c.remove("overtime");
            }
        }
        expired_now
    });
    if dropped && !work_hours(None) && crate::cluster::cluster::primary_now() {
        std::thread::spawn(|| {
            let _ = crate::server::startup::set_overtime(false);
        });
    }
    None
}

pub fn set_overtime(on: bool) -> Option<Value> {
    mutate(|d| {
        let config = d.entry("config").or_insert_with(|| json!({}));
        if !config.is_object() {
            *config = json!({});
        }
        let c = config.as_object_mut().unwrap();
        if on {
            c.insert("overtime".into(), json!({ "since": crate::core::time::now() }));
        } else {
            c.remove("overtime");
        }
    });
    overtime()
}

pub fn resting(t: Option<&Clock>) -> bool {
    let weekend = match t {
        Some(t) => t.weekend,
        None => clock().weekend,
    };
    weekend && crate::core::json::truthy(crate::features::mac_power::schedule().get("weeklyOff")) && overtime().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(local: &str) -> i64 {
        crate::core::time::parse(&format!("{local}+01:00")).unwrap()
    }

    fn since(local: &str) -> Value {
        json!({ "since": crate::core::time::iso(at(local)) })
    }

    #[test]
    fn work_hours_covers_07_30_to_18_30_on_weekdays_only() {
        let _g = crate::testkit::fresh();
        let w = |s: &str| work_hours(Some(&clock_at(at(s))));
        assert!(!w("2026-11-09T07:29:00"));
        assert!(w("2026-11-09T07:30:00"));
        assert!(w("2026-11-09T18:29:00"));
        assert!(!w("2026-11-09T18:30:00"));
        assert!(!w("2026-11-14T10:00:00"));
        assert!(!w("2026-11-15T10:00:00"));
    }

    #[test]
    fn clock_reads_madrid_time_regardless_of_the_host_time_zone() {
        let c = clock_at(crate::core::time::parse("2026-07-01T05:30:00Z").unwrap());
        assert_eq!(c.hour, 7);
        assert_eq!(c.min, 7 * 60 + 30);
        assert_eq!(c.weekday, "Wed");
        assert!(!c.weekend);
    }

    #[test]
    fn overtime_turned_on_before_the_workday_expires_when_the_workday_starts() {
        let _g = crate::testkit::fresh();
        let ot = since("2026-11-09T06:09:00");
        assert!(!expired(Some(&ot), Some(at("2026-11-09T06:30:00"))));
        assert!(expired(Some(&ot), Some(at("2026-11-09T07:30:00"))));
        assert!(expired(Some(&ot), Some(at("2026-11-09T11:00:00"))));
    }

    #[test]
    fn overtime_turned_on_in_the_evening_or_during_the_workday_ends_at_midnight() {
        let _g = crate::testkit::fresh();
        let evening = since("2026-11-09T19:00:00");
        assert!(!expired(Some(&evening), Some(at("2026-11-09T23:59:00"))));
        assert!(expired(Some(&evening), Some(at("2026-11-10T00:00:00"))));
        let day = since("2026-11-09T18:00:00");
        assert!(!expired(Some(&day), Some(at("2026-11-09T21:00:00"))));
        assert!(expired(Some(&day), Some(at("2026-11-10T00:00:00"))));
    }

    #[test]
    fn overtime_on_weekends_ends_at_midnight_of_the_same_day() {
        let _g = crate::testkit::fresh();
        let saturday = since("2026-11-14T10:00:00");
        assert!(!expired(Some(&saturday), Some(at("2026-11-14T23:00:00"))));
        assert!(expired(Some(&saturday), Some(at("2026-11-15T00:00:00"))));
        let sunday_dawn = since("2026-11-15T06:00:00");
        assert!(!expired(Some(&sunday_dawn), Some(at("2026-11-15T09:00:00"))));
    }

    #[test]
    fn missing_overtime_never_counts_as_expired() {
        assert!(!expired(None, Some(at("2026-11-09T10:00:00"))));
        assert!(!expired(Some(&Value::Null), Some(at("2026-11-09T10:00:00"))));
        assert!(!expired(Some(&json!({})), Some(at("2026-11-09T10:00:00"))));
    }

    #[test]
    fn overtime_drops_an_expired_flag_from_the_stored_config_and_keeps_a_fresh_one() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("config".into(), json!({ "paused": true, "overtime": since("2026-11-09T06:00:00") }));
        });
        assert_eq!(overtime(), None);
        assert_eq!(load()["config"], json!({ "paused": true }));
        let on = set_overtime(true).unwrap();
        assert!((crate::core::time::now_ms() - crate::core::time::parse(on["since"].as_str().unwrap()).unwrap()).abs() < 5000);
        assert_eq!(overtime(), Some(on));
        assert_eq!(set_overtime(false), None);
        assert!(load()["config"].get("overtime").is_none());
    }

    #[test]
    fn with_the_weekend_off_the_board_rests_on_saturday_and_sunday_unless_there_is_overtime() {
        let _g = crate::testkit::fresh();
        let r = |s: &str| resting(Some(&clock_at(at(s))));
        assert!(r("2026-11-21T09:00:00"));
        assert!(r("2026-11-22T23:00:00"));
        assert!(!r("2026-11-23T03:00:00"));
        set_overtime(true);
        assert!(!r("2026-11-21T09:00:00"));
        set_overtime(false);
        crate::features::mac_power::set_schedule(&json!({ "weeklyOff": false }));
        assert!(!r("2026-11-21T09:00:00"));
        crate::features::mac_power::set_schedule(&json!({ "weeklyOff": true }));
    }

    #[test]
    fn a_custom_workday_moves_work_hours_and_overtime_expiry_and_invalid_schedules_are_refused() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("config".into(), json!({}));
        });
        assert_eq!(schedule(), json!({ "start": "07:30", "end": "18:30", "daily": "17:00" }));
        assert_eq!(set_schedule(&json!({ "start": "08:30", "end": "17:00" })), json!({ "schedule": { "start": "08:30", "end": "17:00", "daily": "15:30" } }));
        let w = |s: &str| work_hours(Some(&clock_at(at(s))));
        assert!(!w("2026-11-09T08:29:00"));
        assert!(w("2026-11-09T08:30:00"));
        assert!(w("2026-11-09T16:59:00"));
        assert!(!w("2026-11-09T17:00:00"));
        let dawn = since("2026-11-09T07:00:00");
        assert!(!expired(Some(&dawn), Some(at("2026-11-09T08:00:00"))));
        assert!(expired(Some(&dawn), Some(at("2026-11-09T08:30:00"))));
        assert!(set_schedule(&json!({ "start": "25:00" })).get("error").is_some());
        assert!(set_schedule(&json!({ "start": "17:30", "end": "18:00" })).get("error").is_some());
        assert_eq!(schedule(), json!({ "start": "08:30", "end": "17:00", "daily": "15:30" }));
    }

    #[test]
    fn the_daily_time_is_configurable_and_stays_inside_the_workday() {
        let _g = crate::testkit::fresh();
        set_schedule(&json!({ "start": "08:30", "end": "17:00" }));
        assert_eq!(set_schedule(&json!({ "daily": "16:15" }))["schedule"]["daily"], "16:15");
        assert_eq!(daily_min(), 16 * 60 + 15);
        assert!(set_schedule(&json!({ "daily": "18:00" })).get("error").is_some());
        assert!(set_schedule(&json!({ "daily": "8:00" })).get("error").is_some());
        assert_eq!(set_schedule(&json!({ "start": "09:00" }))["schedule"]["daily"], "16:15");
        assert_eq!(set_schedule(&json!({ "end": "16:00" }))["schedule"]["daily"], "14:30");
        assert_eq!(set_schedule(&json!({ "start": "08:30", "end": "17:00" }))["schedule"], json!({ "start": "08:30", "end": "17:00", "daily": "15:30" }));
    }
}

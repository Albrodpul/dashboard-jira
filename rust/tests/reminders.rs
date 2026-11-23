use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Value, json};
use tower::core::data::{load, mutate};
use tower::core::time::parse;
use tower::features::mailman::{self, Env, test_hooks};
use tower::features::reminders;

const CONV: &str = "55555555-5555-5555-5555-555555555555";

type Typed = Arc<Mutex<Vec<(String, String, String)>>>;

fn at(iso: &str) -> Option<i64> {
    parse(iso)
}

fn setup() -> (MutexGuard<'static, ()>, Typed) {
    tower::testkit::sandbox();
    let guard = tower::testkit::fresh();
    let typed: Typed = Arc::new(Mutex::new(Vec::new()));
    let t = typed.clone();
    test_hooks::set_env(Some(Env {
        state: Arc::new(|| json!({ "areas": [{ "id": "herrero", "name": "Herrero", "conversation": CONV, "sessionName": "Herrero", "open": true, "ref": null, "repeatedName": false }] })),
        live: Arc::new(|| vec![json!({ "conversation": CONV, "started": "2026-01-01T00:00:00.000Z" })]),
        open: Arc::new(|_| {}),
        hosted: Arc::new(|_| true),
        type_into: Arc::new(move |c, text, token| {
            t.lock().unwrap().push((c.to_string(), text.to_string(), token.to_string()));
            json!({ "ok": true })
        }),
        send_message: Arc::new(|_, _, _, _| json!({ "ok": false, "error": "no" })),
        push: Arc::new(|_| {}),
        primary: Arc::new(|| false),
        ..Env::stub()
    }));
    (guard, typed)
}

fn base() -> Value {
    json!({ "id": "rem-1", "area": "herrero", "text": "Ejecuta la revisión diaria.", "time": "08:23", "from": "2026-11-12", "until": "2026-11-19", "weekdays": false })
}

fn with(fields: Value) -> Value {
    let mut r = base();
    for (k, v) in fields.as_object().unwrap() {
        r[k] = v.clone();
    }
    r
}

#[test]
fn a_reminder_is_due_from_its_time_on_each_day_of_its_range_once_a_day_and_weekdays_only_skips_weekends() {
    assert!(!reminders::is_due(&base(), at("2026-11-13T07:20:00Z")));
    assert!(reminders::is_due(&base(), at("2026-11-13T07:24:00Z")));
    assert!(!reminders::is_due(&with(json!({ "lastDay": "2026-11-13" })), at("2026-11-13T10:00:00Z")));
    assert!(!reminders::is_due(&base(), at("2026-11-20T08:00:00Z")));
    assert!(!reminders::is_due(&base(), at("2026-11-11T08:00:00Z")));
    assert!(!reminders::is_due(&with(json!({ "weekdays": true })), at("2026-11-14T08:00:00Z")));
    assert!(reminders::is_due(&base(), at("2026-11-14T08:00:00Z")));
}

#[test]
fn the_mailman_types_a_due_reminder_into_its_session_with_the_board_mark_and_not_again_that_day() {
    let (_g, typed) = setup();
    mutate(|d| {
        d.insert("reminders".into(), json!([with(json!({ "from": "2000-01-01", "until": "2999-12-31", "time": "00:00" }))]));
        d.insert("deliveries".into(), json!([]));
        d.insert("restrictions".into(), json!([]));
    });
    for job in mailman::collect(&load(), None) {
        test_hooks::run_job(&job);
    }
    let typed = typed.lock().unwrap().clone();
    assert_eq!(typed.len(), 1);
    assert_eq!(typed[0].0, CONV);
    assert!(typed[0].1.starts_with("Aviso del tablero: aviso programado de las 00:00"));
    assert!(typed[0].1.contains("Ejecuta la revisión diaria."));
    assert!(typed[0].1.contains(&typed[0].2));
    assert_eq!(load()["reminders"][0]["lastDay"], reminders::madrid(None).day.as_str());
    assert_eq!(mailman::collect(&load(), None).iter().filter(|j| j["kind"] == "reminder").count(), 0);
}

#[test]
fn a_reminder_needs_text_a_valid_time_and_a_range_that_ends_after_it_starts() {
    let _s = setup();
    assert!(reminders::add(&json!({ "area": "x", "text": "", "time": "08:00", "until": "2999-01-01" })).unwrap_err().contains("escribe"));
    assert!(reminders::add(&json!({ "area": "x", "text": "a", "time": "8", "until": "2999-01-01" })).unwrap_err().contains("HH:MM"));
    assert!(reminders::add(&json!({ "area": "x", "text": "a", "time": "08:00", "from": "2026-11-20", "until": "2026-11-19" })).unwrap_err().contains("antes"));
}

#[test]
fn a_reminder_can_be_edited_in_place_same_id_new_text_time_and_range_and_a_bad_edit_is_refused() {
    let _s = setup();
    tower::sessions::registry::change_routes(|r| {
        if !r["areas"].is_object() {
            r["areas"] = json!({});
        }
        r["areas"]["herrero"] = json!({ "title": "Herrero", "epics": {}, "conversation": CONV });
    });
    let made = reminders::add(&json!({ "area": "herrero", "text": "Primero", "time": "23:59", "from": "2999-01-01", "until": "2999-01-07" })).unwrap();
    let id = made["reminder"]["id"].as_str().unwrap().to_string();
    assert!(reminders::update(&id, &json!({ "area": "herrero", "text": "Segundo", "time": "07:00", "until": "2999-01-10", "weekdays": true })).is_ok());
    let saved = load()["reminders"].as_array().unwrap().iter().find(|x| x["id"] == id.as_str()).unwrap().clone();
    assert_eq!([&saved["text"], &saved["time"], &saved["from"], &saved["until"], &saved["weekdays"]], [&json!("Segundo"), &json!("07:00"), &json!("2999-01-01"), &json!("2999-01-10"), &json!(true)]);
    assert!(reminders::update(&id, &json!({ "area": "herrero", "text": "", "time": "07:00", "until": "2999-01-10" })).unwrap_err().contains("escribe"));
    assert!(reminders::update("rem-nope", &json!({ "area": "herrero", "text": "x", "time": "07:00", "until": "2999-01-10" })).unwrap_err().contains("desconocido"));
}

#[test]
fn a_reminder_that_ran_out_of_attempts_one_day_is_tried_again_the_next_day() {
    let _s = setup();
    let failed = with(json!({ "lastDay": "2026-11-13", "delivery": { "error": "no", "at": "2026-11-14T10:06:10.905Z", "attempts": 3 } }));
    mutate(|d| {
        d.insert("reminders".into(), json!([failed]));
        d.insert("deliveries".into(), json!([]));
        d.insert("restrictions".into(), json!([]));
    });
    assert_eq!(mailman::collect(&load(), at("2026-11-14T12:00:00Z")).len(), 0);
    assert_eq!(mailman::collect(&load(), at("2026-11-16T07:30:00Z")).len(), 1);
}

use std::sync::{Arc, Mutex, MutexGuard};

use regex::Regex;
use serde_json::{Value, json};
use tower::core::data::{load, mutate};
use tower::core::time::{now, parse};
use tower::features::holds::{self, AddOptions};
use tower::features::{mailman, yolo};

const NOW: &str = "2026-11-08T10:00:00.000Z";
const ORCHESTRATOR: &str = "99999999-2222-4333-8444-555555555555";

fn now_fixed() -> i64 {
    parse(NOW).unwrap()
}

fn setup() -> MutexGuard<'static, ()> {
    let sb = tower::testkit::sandbox_with(json!({ "errorsArea": "errors", "deployProjects": ["web"] }));
    let guard = tower::testkit::fresh();
    mailman::test_hooks::set_env(Some(mailman::Env { primary: Arc::new(|| false), ..mailman::Env::stub() }));
    std::fs::write(sb.workspace.join("sessions.js"), "").unwrap();
    std::fs::write(
        sb.data.join("sessions.json"),
        json!({ "orchestrator": { "conversation": ORCHESTRATOR }, "areas": { "pay": { "title": "Pagos", "epics": { "WEB-1": "Checkout" } }, "cat": { "title": "Catálogo", "epics": {} }, "errors": { "title": "Errores", "epics": {} }, "deploy": { "title": "Subir", "epics": {} } } }).to_string(),
    )
    .unwrap();
    guard
}

fn reset(tasks: Value, extra: Value) {
    mutate(|d| {
        d.insert("tasks".into(), tasks);
        d.insert("restrictions".into(), json!([]));
        d.insert("deliveries".into(), json!([]));
        d.insert("deployments".into(), json!([]));
        d.insert("followUps".into(), json!([]));
        d.insert("sentry".into(), json!({}));
        d.insert("config".into(), json!({}));
        for (k, v) in extra.as_object().unwrap() {
            d.insert(k.clone(), v.clone());
        }
    });
}

fn task(key: &str, fields: Value) -> Value {
    let mut t = json!({ "key": key, "title": format!("Tarea {key}"), "kind": "new", "epicKey": "WEB-1", "epicName": "Checkout", "status": "pending", "proposedArea": "pay", "at": "2026-11-08T09:00:00.000Z" });
    for (k, v) in fields.as_object().unwrap() {
        t[k] = v.clone();
    }
    t
}

fn tasks(list: Vec<Value>) -> Value {
    let mut o = serde_json::Map::new();
    for t in list {
        o.insert(t["key"].as_str().unwrap().to_string(), t);
    }
    Value::Object(o)
}

fn add_hold(input: Value, now_ms: Option<i64>) -> Value {
    mutate(|d| holds::add_restriction(d, &input, AddOptions { areas: Some(vec!["pay".into(), "cat".into(), "errors".into(), "deploy".into()]), now_ms })).unwrap()
}

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

fn status_of(key: &str) -> Value {
    load()["tasks"][key]["status"].clone()
}

#[test]
fn parse_until_reads_madrid_dates_and_times_in_winter_and_in_summer() {
    let n = Some(now_fixed());
    assert_eq!(holds::parse_until("9-11", n).unwrap().as_deref(), Some("2026-11-08T23:00:00.000Z"));
    assert_eq!(holds::parse_until("2026-11-09 18:00", n).unwrap().as_deref(), Some("2026-11-09T17:00:00.000Z"));
    assert_eq!(holds::parse_until("2026-11-09T18:00", n).unwrap().as_deref(), Some("2026-11-09T17:00:00.000Z"));
    assert_eq!(holds::parse_until("1-7-2027 10:00", n).unwrap().as_deref(), Some("2027-07-01T08:00:00.000Z"));
    assert_eq!(holds::parse_until("", n).unwrap(), None);
    assert_eq!(holds::parse_until("nunca", n).unwrap(), None);
}

#[test]
fn parse_until_rejects_past_and_impossible_dates_and_rolls_a_bare_past_day_to_next_year() {
    let n = Some(now_fixed());
    assert!(holds::parse_until("2026-11-01", n).unwrap_err().contains("ya ha pasado"));
    assert!(holds::parse_until("31-2", n).unwrap_err().contains("no existe"));
    assert!(holds::parse_until("mañana", n).unwrap_err().contains("no entiendo"));
    assert_eq!(holds::parse_until("1-11", n).unwrap().as_deref(), Some("2027-10-31T23:00:00.000Z"));
}

#[test]
fn a_hold_stops_applying_at_its_until_and_when_released() {
    let _g = setup();
    reset(tasks(vec![task("WEB-10", json!({}))]), json!({}));
    let r = add_hold(json!({ "tasks": ["WEB-10"], "reason": "NFL", "until": "2026-11-09 00:00" }), Some(now_fixed()))["restriction"].clone();
    let d = load();
    let t = &d["tasks"]["WEB-10"];
    assert!(re(r"retenida por la restricción R\d+ \(«NFL»\)").is_match(&holds::check_task(&d, t, Some("pay"), Some(now_fixed()))));
    let until = parse(r["until"].as_str().unwrap()).unwrap();
    assert_ne!(holds::check_task(&d, t, Some("pay"), Some(until - 1)), "");
    assert_eq!(holds::check_task(&d, t, Some("pay"), Some(until)), "");
    reset(tasks(vec![task("WEB-10", json!({}))]), json!({}));
    let open = add_hold(json!({ "tasks": ["WEB-10"], "reason": "hasta que diga" }), None)["restriction"].clone();
    let d = load();
    assert_ne!(holds::check_task(&d, &d["tasks"]["WEB-10"], Some("pay"), None), "");
    let id = open["id"].as_str().unwrap().to_string();
    assert!(mutate(|x| holds::release_restriction(x, &id, None, None)).is_ok());
    let d = load();
    assert_eq!(holds::check_task(&d, &d["tasks"]["WEB-10"], Some("pay"), None), "");
    assert!(mutate(|x| holds::release_restriction(x, &id, None, None)).unwrap_err().contains("ya se levantó"));
}

#[test]
fn an_epic_hold_applies_to_tasks_that_arrive_after_it_and_an_area_hold_to_whatever_goes_to_that_session() {
    let _g = setup();
    reset(json!({}), json!({}));
    add_hold(json!({ "epics": ["WEB-1"], "reason": "evento" }), None);
    add_hold(json!({ "areas": ["cat"], "reason": "catálogo parado" }), None);
    mutate(|d| d["tasks"]["WEB-77"] = task("WEB-77", json!({})));
    mutate(|d| d["tasks"]["API-5"] = task("API-5", json!({ "epicKey": "API-2", "proposedArea": "pay" })));
    let d = load();
    assert_ne!(holds::check_task(&d, &d["tasks"]["WEB-77"], Some("pay"), None), "");
    assert_eq!(holds::check_task(&d, &d["tasks"]["API-5"], Some("pay"), None), "");
    assert_ne!(holds::check_task(&d, &d["tasks"]["API-5"], Some("cat"), None), "");
    assert_ne!(holds::check_area(&d, "El despliegue", "cat", None), "");
}

#[test]
fn adding_a_hold_sends_approved_tasks_back_to_pendientes_and_lists_the_ones_already_in_a_session() {
    let _g = setup();
    reset(
        tasks(vec![task("WEB-1", json!({ "status": "approved", "area": "pay", "approvedVia": "board", "decidedAt": "x" })), task("WEB-2", json!({ "status": "sent", "area": "pay", "approvedVia": "board" })), task("WEB-3", json!({ "status": "done", "area": "pay" }))]),
        json!({}),
    );
    let r = add_hold(json!({ "epics": ["WEB-1"], "reason": "NFL" }), None);
    assert_eq!(r["reverted"], json!(["WEB-1"]));
    assert_eq!(r["inSession"], json!(["WEB-2"]));
    let d = load();
    assert_eq!(d["tasks"]["WEB-1"]["status"], "pending");
    assert!(d["tasks"]["WEB-1"].get("approvedVia").is_none());
    assert_eq!(d["tasks"]["WEB-1"]["proposedArea"], "pay");
    let keys: Vec<Value> = holds::pending_stop_notices(&d, None).iter().map(|e| e["task"]["key"].clone()).collect();
    assert_eq!(keys, vec![json!("WEB-2")]);
}

#[test]
fn two_restrictions_created_in_the_same_millisecond_get_different_ids() {
    let _g = setup();
    reset(json!({}), json!({}));
    for k in ["WEB-1", "WEB-2", "WEB-3"] {
        add_hold(json!({ "tasks": [k], "reason": "x" }), Some(now_fixed()));
    }
    let mut ids: Vec<String> = load()["restrictions"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_string()).collect();
    ids.sort();
    assert_eq!(ids, vec!["R20261108100000000", "R20261108100000000-2", "R20261108100000000-3"]);
}

#[test]
fn a_note_restriction_does_not_block_and_validation_rejects_empty_or_unknown_scopes() {
    let _g = setup();
    reset(tasks(vec![task("WEB-1", json!({}))]), json!({}));
    add_hold(json!({ "tasks": ["WEB-1"], "mode": "note", "reason": "No toques la tabla de pagos" }), None);
    let d = load();
    assert_eq!(holds::check_task(&d, &d["tasks"]["WEB-1"], Some("pay"), None), "");
    assert_eq!(holds::notes_for(&d, &holds::task_target(&d["tasks"]["WEB-1"], Some("pay")), None).len(), 1);
    let bad = |input: Value| mutate(|x| holds::add_restriction(x, &input, AddOptions { areas: Some(vec!["pay".into()]), now_ms: None })).unwrap_err();
    assert!(bad(json!({ "reason": "x" })).contains("tareas, epics o sesiones"));
    assert!(bad(json!({ "tasks": ["WEB-1"] })).contains("falta el motivo"));
    assert!(bad(json!({ "areas": ["nope"], "reason": "x" })).contains("sesiones desconocidas"));
    assert!(bad(json!({ "tasks": ["web 1"], "reason": "x" })).contains("claves no válidas"));
    assert!(bad(json!({ "tasks": ["WEB-1"], "reason": "x", "mode": "pause" })).contains("modo desconocido"));
}

#[test]
fn restrictions_merge_record_by_record_between_machines_and_a_release_wins_when_newer() {
    use tower::core::records::merge_records;
    let t1 = "2026-11-09T10:00:00.000Z";
    let t2 = "2026-11-09T11:00:00.000Z";
    let a = json!({ "id": "R1", "scope": { "tasks": ["WEB-1"], "epics": [], "areas": [] }, "mode": "hold", "reason": "NFL", "until": null, "createdAt": t1, "releasedAt": null });
    let b = json!({ "id": "R2", "scope": { "tasks": [], "epics": ["WEB-1"], "areas": [] }, "mode": "note", "reason": "ojo", "until": null, "createdAt": t2, "releasedAt": null });
    let mut released = a.clone();
    released["releasedAt"] = json!(t2);
    let obj = |v: Value| v.as_object().unwrap().clone();
    let mut d = obj(json!({ "restrictions": [a], "syncStamps": { "restrictions": { "R1": t1 } } }));
    merge_records(&mut d, &obj(json!({ "restrictions": [b, released] })), Some(&obj(json!({ "restrictions": { "R1": t2, "R2": t2 } }))), true);
    assert_eq!(d["restrictions"].as_array().unwrap().iter().map(|r| r["id"].clone()).collect::<Vec<_>>(), vec![json!("R2"), json!("R1")]);
    assert_eq!(d["restrictions"].as_array().unwrap().iter().find(|r| r["id"] == "R1").unwrap()["releasedAt"], t2);
    let mut mine = obj(json!({ "restrictions": [released], "syncStamps": { "restrictions": { "R1": t2 } } }));
    merge_records(&mut mine, &obj(json!({ "restrictions": [a] })), Some(&obj(json!({ "restrictions": { "R1": t1 } }))), true);
    assert_eq!(mine["restrictions"][0]["releasedAt"], t2);
    let mut fresh = obj(json!({ "restrictions": [] }));
    merge_records(&mut fresh, &obj(json!({ "restrictions": [a] })), Some(&obj(json!({ "restrictions": { "R1": t1 } }))), false);
    assert_eq!(fresh["restrictions"].as_array().unwrap().len(), 1);
}

#[test]
fn a_restriction_written_with_mutate_gets_a_sync_stamp_and_travels_in_the_snapshot() {
    let _g = setup();
    reset(json!({}), json!({}));
    add_hold(json!({ "tasks": ["WEB-4"], "reason": "x" }), None);
    let d = load();
    let id = d["restrictions"][0]["id"].as_str().unwrap().to_string();
    assert!(d["syncStamps"]["restrictions"][&id].is_string());
    let snap = tower::cluster::snapshot::snapshot();
    assert_eq!(snap["docs"]["restrictions"][0]["id"], id.as_str());
    assert!(snap["stamps"]["restrictions"][&id].is_string());
}

#[test]
fn yolo_mode_off_pending_tasks_wait_for_hacer() {
    let _g = setup();
    yolo::test_hooks::reset();
    reset(tasks(vec![task("WEB-20", json!({}))]), json!({}));
    yolo::tick();
    assert_eq!(status_of("WEB-20"), "pending");
}

#[test]
fn yolo_mode_sends_pending_tasks_to_their_session_and_creates_one_per_epic_name_when_missing() {
    let _g = setup();
    yolo::test_hooks::reset();
    let created: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let c = created.clone();
    yolo::test_hooks::set_create(Some(Arc::new(move |name: &str, t: &Value| {
        c.lock().unwrap().push((name.to_string(), t["key"].as_str().unwrap().to_string()));
        let file = tower::testkit::sandbox().data.join("sessions.json");
        let mut r: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let epic = t["epicKey"].as_str().unwrap().to_string();
        r["areas"]["pepe"] = json!({ "title": name, "epics": { epic: t["epicName"].clone() } });
        std::fs::write(&file, r.to_string()).unwrap();
        Ok((200, json!({ "area": "pepe" })))
    })));
    reset(
        tasks(vec![
            task("WEB-21", json!({ "proposedArea": "" })),
            task("WEB-22", json!({ "epicKey": "WEB-50", "epicName": "Pepe", "proposedArea": "" })),
            task("API-23", json!({ "epicKey": "API-60", "epicName": "Pepe", "proposedArea": "" })),
            task("WEB-24", json!({ "proposedArea": "cat" })),
        ]),
        json!({ "config": { "yolo": true } }),
    );
    yolo::tick();
    yolo::test_hooks::idle();
    let d = load();
    assert_eq!(d["tasks"]["WEB-21"]["area"], "pay");
    assert_eq!(d["tasks"]["WEB-21"]["approvedVia"], "yolo");
    assert_eq!(d["tasks"]["WEB-24"]["area"], "cat");
    assert_eq!(*created.lock().unwrap(), vec![("Pepe".to_string(), "WEB-22".to_string())]);
    yolo::tick();
    let d = load();
    assert_eq!(d["tasks"]["WEB-22"]["area"], "pepe");
    assert_eq!(d["tasks"]["API-23"]["area"], "pepe");
    assert_eq!(created.lock().unwrap().len(), 1);
    std::thread::sleep(std::time::Duration::from_millis(400));
}

#[test]
fn yolo_mode_keeps_a_restricted_task_in_pendientes() {
    let _g = setup();
    yolo::test_hooks::reset();
    reset(tasks(vec![task("WEB-30", json!({}))]), json!({ "config": { "yolo": true }, "restrictions": [{ "id": "R9", "scope": { "tasks": ["WEB-30"], "epics": [], "areas": [] }, "mode": "hold", "reason": "espera", "until": null, "createdAt": now(), "releasedAt": null }] }));
    yolo::tick();
    assert_eq!(status_of("WEB-30"), "pending");
}

#[test]
fn yolo_mode_sends_possible_follow_up_errors_to_the_errors_session_unless_it_is_held() {
    let _g = setup();
    yolo::test_hooks::reset();
    let report = || json!([{ "at": "2026-11-08T09:00:00.000Z", "text": "x", "errors": [{ "id": "err-1", "text": "falla el login", "state": "proposed", "at": "2026-11-08T09:00:00.000Z" }, { "id": "err-2", "text": "y", "state": "discarded" }] }]);
    reset(json!({}), json!({ "config": { "yolo": true }, "followUps": report() }));
    yolo::tick();
    let e = load()["followUps"][0]["errors"].clone();
    assert_eq!(e[0]["state"], "approved");
    assert_eq!(e[0]["approvedVia"], "yolo");
    assert_eq!(e[1]["state"], "discarded");
    reset(json!({}), json!({ "config": { "yolo": true }, "followUps": report(), "restrictions": [{ "id": "R8", "scope": { "tasks": [], "epics": [], "areas": ["errors"] }, "mode": "hold", "reason": "no", "until": null, "createdAt": now(), "releasedAt": null }] }));
    yolo::tick();
    assert_eq!(load()["followUps"][0]["errors"][0]["state"], "proposed");
    reset(json!({}), json!({ "config": {}, "followUps": report() }));
    yolo::tick();
    assert_eq!(load()["followUps"][0]["errors"][0]["state"], "proposed");
}

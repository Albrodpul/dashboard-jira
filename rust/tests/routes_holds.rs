use serde_json::{Value, json};
use std::sync::Arc;
use tower::core::data::{load, mutate};
use tower::features::holds;
use tower::server::routes::{index, operations, tasks};

const ORCHESTRATOR: &str = "99999999-2222-4333-8444-555555555555";

fn setup() -> std::sync::MutexGuard<'static, ()> {
    let sb = tower::testkit::sandbox_with(json!({ "errorsArea": "errors", "deployProjects": ["web"] }));
    let guard = tower::testkit::fresh();
    unsafe { std::env::set_var("TOWER_EXE", "/usr/bin/true") };
    tower::features::mailman::test_hooks::set_env(Some(tower::features::mailman::Env { primary: Arc::new(|| false), ..tower::features::mailman::Env::stub() }));
    std::fs::write(sb.workspace.join("sessions.js"), "").unwrap();
    let routes = json!({ "orchestrator": { "conversation": ORCHESTRATOR }, "areas": { "pay": { "title": "Pagos", "epics": { "WEB-1": "Checkout" } }, "cat": { "title": "Catálogo", "epics": {} }, "errors": { "title": "Errores", "epics": {} }, "deploy": { "title": "Subir", "epics": {} } } });
    std::fs::write(sb.data.join("sessions.json"), tower::core::json::stringify(&routes)).unwrap();
    guard
}

fn reset(tasks: Value, extra: Value) {
    mutate(|d| {
        d.insert("tasks".into(), tasks);
        for (k, v) in [("restrictions", json!([])), ("deliveries", json!([])), ("deployments", json!([])), ("followUps", json!([])), ("sentry", json!({})), ("config", json!({}))] {
            d.insert(k.into(), v);
        }
        if let Some(e) = extra.as_object() {
            for (k, v) in e {
                d.insert(k.clone(), v.clone());
            }
        }
    });
}

fn task(key: &str, fields: Value) -> Value {
    let mut t = json!({ "key": key, "title": format!("Tarea {key}"), "kind": "new", "epicKey": "WEB-1", "epicName": "Checkout", "status": "pending", "proposedArea": "pay", "at": "2026-11-08T09:00:00.000Z" });
    if let Some(f) = fields.as_object() {
        for (k, v) in f {
            t[k] = v.clone();
        }
    }
    t
}

fn add_hold(input: Value) {
    let areas = ["pay", "cat", "errors", "deploy"].iter().map(|s| s.to_string()).collect();
    let r = mutate(|d| holds::add_restriction(d, &input, holds::AddOptions { areas: Some(areas), now_ms: Some(tower::core::time::now_ms()) }));
    assert!(r.is_ok(), "{:?}", r.err());
}

fn status_of(key: &str) -> String {
    load()["tasks"][key]["status"].as_str().unwrap_or("").to_string()
}

#[test]
fn board_routes_refuse_to_approve_batch_approve_or_resolve_by_hand_a_held_task() {
    let _guard = setup();
    reset(json!({ "WEB-1": task("WEB-1", json!({})), "WEB-2": task("WEB-2", json!({ "epicKey": "API-9" })) }), json!({}));
    add_hold(json!({ "tasks": ["WEB-1"], "reason": "NFL" }));
    let r = tasks::handle_task(&json!({ "key": "WEB-1", "patch": { "status": "approved", "area": "pay" } }));
    assert_eq!(r.code, 409);
    assert!(r.json().unwrap()["error"].as_str().unwrap().contains("NFL"));
    let r = tasks::handle_task(&json!({ "key": "WEB-1", "patch": { "status": "sent", "manual": true } }));
    assert_eq!(r.code, 409);
    let r = tasks::handle_batch(&json!({ "items": [{ "key": "WEB-1", "area": "pay" }] }));
    assert_eq!(r.code, 409);
    assert_eq!(status_of("WEB-1"), "pending");
    let r = tasks::handle_batch(&json!({ "items": [{ "key": "WEB-1", "area": "pay" }, { "key": "WEB-2", "area": "pay" }] }));
    assert_eq!(r.code, 200);
    let body = r.json().unwrap();
    assert_eq!(body["approved"], json!(1));
    assert_eq!(body["held"].as_array().unwrap().iter().map(|x| x["key"].clone()).collect::<Vec<_>>(), vec![json!("WEB-1")]);
    assert_eq!(status_of("WEB-1"), "pending");
    assert_eq!(status_of("WEB-2"), "approved");
}

#[test]
fn an_area_hold_blocks_desplegar_errores_sentry_and_sentry_sends_to_that_session() {
    let _guard = setup();
    reset(json!({}), json!({ "followUps": [{ "at": "2026-11-08T09:00:00.000Z", "text": "x", "errors": [{ "id": "err-1", "text": "fallo", "state": "proposed", "at": "2026-11-08T09:00:00.000Z" }] }] }));
    add_hold(json!({ "areas": ["deploy", "errors", "cat"], "reason": "congelado" }));
    let r = operations::handle_deploy(&json!({ "projects": ["web"], "environment": "develop", "area": "deploy" }));
    assert_eq!(r.code, 409);
    assert_eq!(load()["deployments"].as_array().unwrap().len(), 0);
    let r = operations::handle_follow_up_error(&json!({ "id": "err-1", "action": "send" }));
    assert_eq!(r.code, 409);
    assert_eq!(load()["followUps"][0]["errors"][0]["state"], json!("proposed"));
    let route = index::post_route("/api/sentry/send").unwrap();
    let r = route(&json!({ "issues": [{ "id": "WEB-K1", "title": "t" }], "area": "cat" }));
    assert_eq!(r.code, 409);
    assert_eq!(load()["sentry"], json!({}));
}

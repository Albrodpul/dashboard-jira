use serde_json::{Value, json};
use std::fs;
use std::process::Command;
use tower::core::data::{load, mutate};
use tower::features::holds;

const ORCHESTRATOR: &str = "99999999-2222-4333-8444-555555555555";

struct Out {
    code: i32,
    out: String,
    err: String,
}

fn setup() -> std::sync::MutexGuard<'static, ()> {
    tower::testkit::sandbox_with(json!({ "errorsArea": "errors", "deployProjects": ["web"] }));
    let guard = tower::testkit::fresh();
    let sb = tower::testkit::sandbox();
    mutate(|d| {
        d.insert("schema".into(), json!(tower::core::migrate::SCHEMA));
    });
    fs::write(sb.workspace.join("sessions.js"), "").unwrap();
    let routes = json!({ "orchestrator": { "conversation": ORCHESTRATOR }, "areas": { "pay": { "title": "Pagos", "epics": { "WEB-1": "Checkout" } }, "cat": { "title": "Catálogo", "epics": {} }, "errors": { "title": "Errores", "epics": {} }, "deploy": { "title": "Subir", "epics": {} } } });
    fs::write(sb.data.join("sessions.json"), routes.to_string()).unwrap();
    guard
}

fn cli(args: &[&str]) -> Out {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tower"));
    command.args(args).env("CLAUDE_CODE_SESSION_ID", ORCHESTRATOR);
    for k in ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"] {
        command.env_remove(k);
    }
    let r = command.output().unwrap();
    Out { code: r.status.code().unwrap_or(-1), out: String::from_utf8_lossy(&r.stdout).into(), err: String::from_utf8_lossy(&r.stderr).into() }
}

fn reset(tasks: Value, extra: Value) {
    mutate(|d| {
        d.insert("tasks".into(), tasks);
        for k in ["restrictions", "deliveries", "deployments", "followUps"] {
            d.insert(k.into(), json!([]));
        }
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

fn add_hold(input: Value) {
    let areas = ["pay", "cat", "errors", "deploy"].iter().map(|x| x.to_string()).collect();
    let r = mutate(|d| holds::add_restriction(d, &input, holds::AddOptions { areas: Some(areas), now_ms: None }));
    assert!(r.is_ok(), "{r:?}");
}

#[test]
fn cli_approve_chat_update_sent_and_the_returned_tasks_rule_cannot_get_past_a_hold() {
    let _g = setup();
    reset(json!({ "WEB-1": task("WEB-1", json!({})), "WEB-2": task("WEB-2", json!({ "status": "approved", "area": "pay", "approvedVia": "board" })) }), json!({}));
    add_hold(json!({ "tasks": ["WEB-1"], "reason": "NFL" }));
    let r = cli(&["approve-chat", "WEB-1", "pay"]);
    assert_eq!(r.code, 1);
    assert!(r.err.contains("retenida"), "{}", r.err);
    assert_eq!(load()["tasks"]["WEB-1"]["status"], "pending");
    mutate(|d| {
        let list = d.get_mut("restrictions").unwrap().as_array_mut().unwrap();
        list.push(json!({ "id": "R2", "scope": { "tasks": ["WEB-2"], "epics": [], "areas": [] }, "mode": "hold", "reason": "sin revertir", "until": null, "createdAt": tower::core::time::now(), "createdBy": "chat", "releasedAt": null }));
    });
    let r = cli(&["sent", "WEB-2"]);
    assert_eq!(r.code, 1);
    assert!(r.err.contains("retenida"));
    let r = cli(&["update", "WEB-2", &json!({ "status": "sent" }).to_string()]);
    assert_eq!(r.code, 1);
    assert_eq!(load()["tasks"]["WEB-2"]["status"], "approved");
    mutate(|d| {
        d["tasks"]["WEB-1"] = task("WEB-1", json!({ "status": "done", "area": "pay", "events": [] }));
        d.insert("config".into(), json!({ "autoReturned": true }));
    });
    let r = cli(&["add", &json!([{ "key": "WEB-1", "title": "Tarea WEB-1", "kind": "returned", "epicKey": "WEB-1", "event": "ev-1" }]).to_string()]);
    assert_eq!(r.code, 0, "{}", r.err);
    assert!(r.out.contains("Queda en Pendientes"), "{}", r.out);
    assert_eq!(load()["tasks"]["WEB-1"]["status"], "pending");
    assert!(load()["tasks"]["WEB-1"].get("approvedVia").is_none());
}

#[test]
fn cli_deployment_update_error_sent_and_sentry_sent_refuse_items_for_a_held_session() {
    let _g = setup();
    reset(
        json!({}),
        json!({
            "deployments": [{ "id": "D1", "projects": ["web"], "environment": "develop", "area": "deploy", "status": "approved", "approvedVia": "board", "at": tower::core::time::now() }],
            "followUps": [{ "at": "2026-11-08T09:00:00.000Z", "text": "x", "errors": [{ "id": "err-1", "text": "fallo", "state": "approved", "approvedVia": "board", "at": "2026-11-08T09:00:00.000Z" }] }],
            "sentry": { "WEB-K1": { "id": "WEB-K1", "area": "cat", "state": "approved", "approvedVia": "board", "at": tower::core::time::now() } },
        }),
    );
    add_hold(json!({ "areas": ["deploy", "errors", "cat"], "reason": "congelado" }));
    assert_eq!(cli(&["deployment-update", "D1", &json!({ "status": "sent" }).to_string()]).code, 1);
    assert_eq!(cli(&["sent", "D1"]).code, 1);
    assert_eq!(cli(&["error-sent", "err-1"]).code, 1);
    assert_eq!(cli(&["sentry-sent", "WEB-K1"]).code, 1);
    let d = load();
    assert_eq!(d["deployments"][0]["status"], "approved");
    assert_eq!(d["followUps"][0]["errors"][0]["state"], "approved");
    assert_eq!(d["sentry"]["WEB-K1"]["state"], "approved");
}

#[test]
fn cli_hold_add_list_check_and_release() {
    let _g = setup();
    reset(json!({ "WEB-1": task("WEB-1", json!({ "status": "approved", "area": "pay", "approvedVia": "board" })) }), json!({}));
    let r = cli(&["hold", "add", "--epics", "WEB-1", "--until", "2099-01-01 10:00", "--reason", "Evento NFL"]);
    assert_eq!(r.code, 0, "{}", r.err);
    assert!(regex::Regex::new(r"Restricción guardada: R\d+ · Retención · epic WEB-1 · «Evento NFL»").unwrap().is_match(&r.out), "{}", r.out);
    assert!(regex::Regex::new(r"Vuelven a Pendientes .*WEB-1").unwrap().is_match(&r.out));
    let id = load()["restrictions"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(load()["restrictions"][0]["createdBy"], "chat");
    assert!(cli(&["hold", "list"]).out.contains(&id));
    assert!(cli(&["hold", "check", "WEB-1"]).out.contains("Evento NFL"));
    assert_eq!(cli(&["hold", "add", "--areas", "nope", "--reason", "x"]).code, 1);
    let r = cli(&["hold", "release", &id]);
    assert_eq!(r.code, 0, "{}", r.err);
    assert!(cli(&["hold", "list"]).out.contains("No hay restricciones activas"));
    assert!(cli(&["hold", "check", "WEB-1"]).out.contains("sin restricciones"));
}

#[test]
fn dispatches_never_lists_a_held_task() {
    let _g = setup();
    reset(json!({ "WEB-1": task("WEB-1", json!({ "status": "approved", "area": "pay", "approvedVia": "board" })), "WEB-2": task("WEB-2", json!({ "epicKey": "API-3", "status": "approved", "area": "pay", "approvedVia": "board" })) }), json!({}));
    mutate(|d| {
        let list = d.get_mut("restrictions").unwrap().as_array_mut().unwrap();
        list.push(json!({ "id": "R9", "scope": { "tasks": ["WEB-1"], "epics": [], "areas": [] }, "mode": "hold", "reason": "NFL", "until": null, "createdAt": tower::core::time::now(), "createdBy": "chat", "releasedAt": null }));
    });
    let r = cli(&["dispatches"]);
    let out: Value = serde_json::from_str(&r.out).unwrap_or_else(|_| panic!("{} {}", r.out, r.err));
    let keys = |v: &Value| v.as_array().unwrap().iter().map(|t| t["key"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(keys(&out["tasks"]), vec!["WEB-2"]);
    assert_eq!(keys(&out["held"]), vec!["WEB-1"]);
}

#[test]
fn a_returned_task_whose_card_was_deleted_goes_back_to_the_session_that_did_it() {
    let _g = setup();
    reset(json!({}), json!({ "config": { "autoReturned": true }, "deleted": { "WEB-9": tower::core::time::now() } }));
    let sb = tower::testkit::sandbox();
    fs::write(sb.data.join("task-history.jsonl"), json!({ "key": "WEB-9", "status": "done", "area": "cat", "removedAt": tower::core::time::now() }).to_string() + "\n").unwrap();
    let r = cli(&["add", &json!([{ "key": "WEB-9", "title": "Tarea WEB-9", "kind": "returned", "epicKey": "WEB-1", "event": "ev-9" }]).to_string()]);
    assert_eq!(r.code, 0, "{}", r.err);
    let t = load()["tasks"]["WEB-9"].clone();
    assert_eq!(t["status"], "approved");
    assert_eq!(t["area"], "cat");
    assert_eq!(t["approvedVia"], "rule");
    assert!(load()["deleted"].get("WEB-9").is_none());
    let n = cli(&["add", &json!([{ "key": "WEB-10", "title": "Tarea WEB-10", "kind": "new", "epicKey": "WEB-1", "event": "ev-10" }]).to_string()]);
    assert_eq!(n.code, 0, "{}", n.err);
    assert_eq!(load()["tasks"]["WEB-10"]["status"], "pending");
}

#[test]
fn a_returned_task_the_board_never_sent_goes_to_the_proposed_session_when_the_rule_is_on() {
    let _g = setup();
    reset(json!({}), json!({ "config": { "autoReturned": true } }));
    let r = cli(&["add", &json!([{ "key": "WEB-11", "title": "Tarea WEB-11", "kind": "returned", "proposedArea": "cat", "event": "ev-11" }, { "key": "WEB-12", "title": "Tarea WEB-12", "kind": "returned", "proposedArea": "nope", "event": "ev-12" }]).to_string()]);
    assert_eq!(r.code, 0, "{}", r.err);
    let t = load()["tasks"]["WEB-11"].clone();
    assert_eq!(t["status"], "approved");
    assert_eq!(t["area"], "cat");
    assert_eq!(t["approvedVia"], "rule");
    assert_eq!(load()["tasks"]["WEB-12"]["status"], "pending");
    reset(json!({}), json!({ "config": {} }));
    cli(&["add", &json!([{ "key": "WEB-13", "title": "Tarea WEB-13", "kind": "returned", "proposedArea": "cat", "event": "ev-13" }]).to_string()]);
    assert_eq!(load()["tasks"]["WEB-13"]["status"], "approved");
}

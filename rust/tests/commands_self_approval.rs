use serde_json::{Value, json};
use std::fs;
use std::process::Command;
use tower::core::data::{load, mutate};

const ORCHESTRATOR: &str = "aaaaaaaa-2222-4333-8444-555555555555";
const REPORTER: &str = "bbbbbbbb-2222-4333-8444-555555555555";
const AREA: &str = "cccccccc-2222-4333-8444-555555555555";
const SIDE_AREA: &str = "dddddddd-2222-4333-8444-555555555555";
const STRANGER: &str = "eeeeeeee-2222-4333-8444-555555555555";

struct Out {
    code: i32,
    out: String,
    err: String,
}

fn setup() -> std::sync::MutexGuard<'static, ()> {
    let guard = tower::testkit::fresh();
    let sb = tower::testkit::sandbox();
    mutate(|d| {
        d.insert("schema".into(), json!(tower::core::migrate::SCHEMA));
    });
    fs::write(sb.workspace.join("sessions.js"), "").unwrap();
    let routes = json!({ "orchestrator": { "conversation": ORCHESTRATOR }, "reporter": { "conversation": REPORTER }, "areas": { "pay": { "title": "Pagos", "epics": {}, "conversation": AREA }, "side": { "title": "Side", "epics": {}, "conversation": SIDE_AREA, "project": "side" } } });
    fs::write(sb.data.join("sessions.json"), routes.to_string()).unwrap();
    guard
}

fn cli(conversation: Option<&str>, args: &[&str]) -> Out {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tower"));
    command.args(args);
    for k in ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN", "CLAUDE_CODE_SESSION_ID"] {
        command.env_remove(k);
    }
    if let Some(c) = conversation {
        command.env("CLAUDE_CODE_SESSION_ID", c);
    }
    let r = command.output().unwrap();
    Out { code: r.status.code().unwrap_or(-1), out: String::from_utf8_lossy(&r.stdout).into(), err: String::from_utf8_lossy(&r.stderr).into() }
}

fn pending() {
    mutate(|d| {
        d.insert("tasks".into(), json!({ "WEB-1": { "key": "WEB-1", "title": "Tarea", "kind": "new", "status": "pending", "at": tower::core::time::now() } }));
        d.insert("restrictions".into(), json!([]));
    });
}

fn task_field(key: &str, field: &str) -> Value {
    load()["tasks"][key][field].clone()
}

#[test]
fn approve_chat_is_accepted_only_from_the_orchestrator_and_the_reporter() {
    let _g = setup();
    for who in [Some(AREA), Some(STRANGER), None] {
        pending();
        let r = cli(who, &["approve-chat", "WEB-1", "pay"]);
        assert_eq!(r.code, 1, "{who:?}");
        assert!(r.err.contains("Rechazado: «board.js approve-chat» solo se acepta desde la orquestadora o la sesión de reporte"), "{}", r.err);
        assert_eq!(task_field("WEB-1", "status"), "pending");
    }
    assert!(cli(Some(AREA), &["approve-chat", "WEB-1", "pay"]).err.contains("lo pide «Pagos»"));
    assert!(cli(None, &["approve-chat", "WEB-1", "pay"]).err.contains("falta CLAUDE_CODE_SESSION_ID"));
    for who in [ORCHESTRATOR, REPORTER] {
        pending();
        let r = cli(Some(who), &["approve-chat", "WEB-1", "pay"]);
        assert_eq!(r.code, 0, "{}", r.err);
        assert_eq!(task_field("WEB-1", "status"), "approved");
        assert_eq!(task_field("WEB-1", "approvedVia"), "chat");
    }
}

#[test]
fn hold_add_and_release_are_accepted_only_from_the_orchestrator_list_and_check_stay_open() {
    let _g = setup();
    pending();
    for who in [Some(REPORTER), Some(AREA), None] {
        let r = cli(who, &["hold", "add", "--tasks", "WEB-1", "--reason", "x"]);
        assert_eq!(r.code, 1, "{who:?}");
        assert!(r.err.contains("solo se acepta desde la orquestadora"));
    }
    assert_eq!(load()["restrictions"], json!([]));
    let r = cli(Some(ORCHESTRATOR), &["hold", "add", "--tasks", "WEB-1", "--reason", "x"]);
    assert_eq!(r.code, 0, "{}", r.err);
    let id = load()["restrictions"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(cli(Some(AREA), &["hold", "list"]).code, 0);
    assert_eq!(cli(Some(AREA), &["hold", "check", "WEB-1"]).code, 0);
    let r = cli(Some(AREA), &["hold", "release", &id]);
    assert_eq!(r.code, 1);
    assert_eq!(load()["restrictions"][0]["releasedAt"], Value::Null);
    assert_eq!(cli(Some(ORCHESTRATOR), &["hold", "release", &id]).code, 0);
}

#[test]
fn tidy_start_and_tidy_end_come_from_the_orchestrator_or_from_a_session_of_the_project_being_tidied() {
    let _g = setup();
    mutate(|d| {
        d.insert("contextTidy".into(), json!({ "id": "tidy-1", "status": "approved", "approvedVia": "board", "at": tower::core::time::now() }));
        d.insert("contextTidies".into(), json!({ "side": { "id": "tidy-2", "project": "side", "status": "approved", "approvedVia": "board", "at": tower::core::time::now() } }));
    });
    for who in [Some(AREA), Some(REPORTER), Some(SIDE_AREA), None] {
        let r = cli(who, &["tidy-start", "tidy-1"]);
        assert_eq!(r.code, 1, "{who:?}");
        assert!(r.err.contains("solo se acepta desde la orquestadora"));
    }
    assert_eq!(load()["contextTidy"]["status"], "approved");
    assert_eq!(cli(Some(ORCHESTRATOR), &["tidy-start", "tidy-1"]).code, 0);
    assert_eq!(cli(Some(AREA), &["tidy-end", "tidy-1", "hecho"]).code, 1);
    assert_eq!(cli(Some(ORCHESTRATOR), &["tidy-end", "tidy-1", "hecho"]).code, 0);
    assert_eq!(load()["contextTidy"]["status"], "done");
    assert_eq!(cli(Some(AREA), &["tidy-start", "tidy-2"]).code, 1);
    let r = cli(Some(SIDE_AREA), &["tidy-start", "tidy-2"]);
    assert_eq!(r.code, 0, "{}", r.err);
    let r = cli(Some(SIDE_AREA), &["tidy-end", "tidy-2", "hecho"]);
    assert_eq!(r.code, 0, "{}", r.err);
    assert_eq!(load()["contextTidies"]["side"]["status"], "done");
    let _ = r.out;
}

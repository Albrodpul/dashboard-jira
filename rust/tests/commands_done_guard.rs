use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use tower::core::data::{load, mutate};

struct Out {
    code: i32,
    out: String,
    err: String,
}

struct Roots {
    main: PathBuf,
    side: PathBuf,
}

fn roots() -> &'static Roots {
    static ROOTS: OnceLock<Roots> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let sb = tower::testkit::sandbox();
        let base = sb.dir.join("done");
        let main = base.join("main");
        let side = base.join("side");
        for d in [&main, &side] {
            fs::create_dir_all(d).unwrap();
        }
        let statuses = json!({ "review": "IN REVIEW", "returned": ["To Do"], "inProgress": ["In Progress"], "closed": ["Done"], "rejectLabel": "rejected" });
        let jira = |key: &str| json!({ "projects": [key], "me": { "id": "me", "name": "Tester Person" }, "reviewer": { "id": "rev", "name": "Reviewer", "mentions": ["@Reviewer"] }, "transitions": {} });
        let config = json!({ "projects": [
            { "id": "acme", "name": "Acme", "root": main.to_string_lossy(), "jira": jira("WEB"), "statuses": statuses },
            { "id": "side", "name": "Side", "root": side.to_string_lossy(), "jira": jira("OPS"), "statuses": statuses }
        ] });
        fs::write(sb.workspace.join("board.config.json"), config.to_string()).unwrap();
        Roots { main, side }
    })
}

fn setup() -> std::sync::MutexGuard<'static, ()> {
    roots();
    let guard = tower::testkit::fresh();
    let sb = tower::testkit::sandbox();
    mutate(|d| {
        d.insert("schema".into(), json!(tower::core::migrate::SCHEMA));
    });
    fs::write(sb.workspace.join("sessions.js"), "").unwrap();
    fs::write(sb.data.join("sessions.json"), json!({ "areas": { "pay": { "title": "Pagos", "epics": {} } } }).to_string()).unwrap();
    guard
}

fn cli(args: &[&str]) -> Out {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tower"));
    command.args(args);
    for k in ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"] {
        command.env_remove(k);
    }
    let r = command.output().unwrap();
    Out { code: r.status.code().unwrap_or(-1), out: String::from_utf8_lossy(&r.stdout).into(), err: String::from_utf8_lossy(&r.stderr).into() }
}

fn sent(key: &str, fields: Value) -> Value {
    let mut t = json!({ "key": key, "title": format!("Tarea {key}"), "kind": "new", "status": "sent", "area": "pay", "approvedVia": "board", "sentAt": "2026-11-10T09:00:00.000Z", "at": "2026-11-10T08:00:00.000Z" });
    for (k, v) in fields.as_object().unwrap() {
        t[k] = v.clone();
    }
    t
}

fn reset(tasks: Value, extra: Value) {
    mutate(|d| {
        d.insert("tasks".into(), tasks);
        d.insert("causes".into(), json!([]));
        for (k, v) in extra.as_object().unwrap() {
            d.insert(k.clone(), v.clone());
        }
    });
}

fn status_of(key: &str) -> Value {
    load()["tasks"][key]["status"].clone()
}

#[test]
fn done_is_refused_while_pruebas_or_attachments_remain_in_the_tasks_own_project_folder() {
    let _g = setup();
    let r = roots();
    reset(json!({ "OPS-1": sent("OPS-1", json!({})), "WEB-1": sent("WEB-1", json!({})) }), json!({}));
    fs::create_dir_all(r.side.join("pruebas").join("OPS-1")).unwrap();
    fs::create_dir_all(r.main.join(".attachments").join("WEB-1")).unwrap();
    let out = cli(&["done", "OPS-1,WEB-1", "hecho"]);
    assert_ne!(out.code, 0);
    let ops = regex::Regex::new(r"OPS-1: no se da por hecha porque quedan restos de la prueba en .*side/pruebas/OPS-1\. Bórralos .* vuelve a lanzar «board\.js done OPS-1 …»").unwrap();
    assert!(ops.is_match(&out.err), "{}", out.err);
    assert!(regex::Regex::new(r"WEB-1: .*main/\.attachments/WEB-1").unwrap().is_match(&out.err));
    assert!(out.out.contains("0 de 2 anotada"));
    assert_eq!(status_of("OPS-1"), "sent");
    assert_eq!(status_of("WEB-1"), "sent");
    fs::remove_dir_all(r.side.join("pruebas")).unwrap();
    let out = cli(&["done", "OPS-1,WEB-1", "hecho"]);
    assert_ne!(out.code, 0);
    assert!(out.out.contains("1 de 2 anotada"));
    assert_eq!(status_of("OPS-1"), "done");
    fs::remove_dir_all(r.main.join(".attachments")).unwrap();
    let out = cli(&["done", "WEB-1", "hecho"]);
    assert_eq!(out.code, 0, "{}", out.err);
    assert_eq!(status_of("WEB-1"), "done");
}

#[test]
fn a_returned_task_is_not_done_until_its_cause_is_recorded_after_it_came_back() {
    let _g = setup();
    reset(json!({ "WEB-2": sent("WEB-2", json!({ "kind": "returned", "returnedAt": "2026-11-10T08:30:00.000Z" })) }), json!({ "causes": [{ "key": "WEB-2", "cause": "written", "note": "vuelta anterior", "at": "2026-11-01T10:00:00.000Z" }] }));
    let out = cli(&["done", "WEB-2", "hecho"]);
    assert_ne!(out.code, 0);
    assert!(out.err.contains("WEB-2: no se da por hecha porque volvió de la revisión (devuelta) y no tiene apuntada la causa. Apúntala primero con «board.js cause WEB-2 written|new"), "{}", out.err);
    assert_eq!(status_of("WEB-2"), "sent");
    let out = cli(&["cause", "WEB-2", "new", "apuntado en context/JIRA.md"]);
    assert_eq!(out.code, 0, "{}", out.err);
    let out = cli(&["done", "WEB-2", "hecho"]);
    assert_eq!(out.code, 0, "{}", out.err);
    assert_eq!(status_of("WEB-2"), "done");
}

#[test]
fn partial_and_question_are_not_blocked_by_leftovers_or_a_missing_cause() {
    let _g = setup();
    let r = roots();
    reset(json!({ "WEB-3": sent("WEB-3", json!({ "kind": "returned" })) }), json!({}));
    fs::create_dir_all(r.main.join("pruebas").join("WEB-3")).unwrap();
    let out = cli(&["partial", "WEB-3", "falta el back"]);
    assert_eq!(out.code, 0, "{}", out.err);
    assert_eq!(status_of("WEB-3"), "partial");
    fs::remove_dir_all(r.main.join("pruebas")).unwrap();
}

#[test]
fn a_returned_card_added_by_the_reporter_records_when_it_came_back() {
    let _g = setup();
    reset(json!({ "WEB-4": sent("WEB-4", json!({ "status": "done" })) }), json!({}));
    let out = cli(&["add", &json!([{ "key": "WEB-4", "title": "Tarea WEB-4", "kind": "returned", "event": "ev-4" }]).to_string()]);
    assert_eq!(out.code, 0, "{}", out.err);
    let at = tower::core::time::parse(load()["tasks"]["WEB-4"]["returnedAt"].as_str().unwrap()).unwrap();
    assert!(at > tower::core::time::now_ms() - 60000);
}

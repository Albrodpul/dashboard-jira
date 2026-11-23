use regex::Regex;
use serde_json::json;
use tower::core::config;
use tower::features::{mailman, manual_tasks as manual};

fn setup() -> std::sync::MutexGuard<'static, ()> {
    let sb = tower::testkit::sandbox();
    let main = sb.dir.join("work").join("acme");
    let client = sb.dir.join("work").join("client");
    let nested = main.join("side");
    for d in [&main, &client, &nested] {
        std::fs::create_dir_all(d).unwrap();
    }
    let jira = |keys: &[&str]| json!({ "projects": keys, "me": { "id": "me", "name": "Me" }, "reviewer": { "id": "rev", "name": "Rev", "mentions": [] }, "transitions": {} });
    let statuses = json!({ "review": "IN REVIEW", "returned": ["To Do"], "inProgress": ["In Progress"], "closed": ["Done"], "rejectLabel": "rejected" });
    std::fs::write(
        sb.workspace.join("board.config.json"),
        json!({ "projects": [{ "id": "acme", "root": main, "jira": jira(&["WEB"]), "statuses": statuses }, { "id": "client", "name": "Client", "root": client, "jira": jira(&["CLI"]), "statuses": statuses }, { "id": "side", "root": nested }] }).to_string(),
    )
    .unwrap();
    let guard = tower::testkit::fresh();
    std::fs::write(sb.data.join("sessions.json"), json!({ "areas": { "pay": { "title": "Pagos", "epics": {} }, "shop": { "title": "Tienda", "epics": {}, "project": "client" } } }).to_string()).unwrap();
    guard
}

#[test]
fn tasks_made_by_hand_get_their_own_key_never_a_jira_one_and_are_refused_without_a_title() {
    let _g = setup();
    let mut d = json!({ "tasks": { "SIDE-2": {} }, "deleted": { "SIDE-5": "x" } }).as_object().unwrap().clone();
    assert_eq!(manual::prefix_of(&config::project("side").unwrap()), "SIDE");
    assert_eq!(manual::create_task(&mut d, &json!({ "project": "side", "title": "Cuadrar gastos", "description": "de octubre" })).unwrap(), "SIDE-6");
    let mut t = d["tasks"]["SIDE-6"].clone();
    t["at"] = serde_json::Value::Null;
    assert_eq!(t, json!({ "key": "SIDE-6", "title": "Cuadrar gastos", "description": "de octubre", "project": "side", "source": "manual", "kind": "new", "status": "pending", "at": null, "events": [] }));
    assert_eq!(manual::create_task(&mut d, &json!({ "project": "side", "title": " " })).unwrap_err(), "falta el título");
    assert!(manual::create_task(&mut d, &json!({ "project": "nope", "title": "x" })).unwrap_err().contains("desconocido"));
    assert_eq!(manual::prefix_of(&config::build_project(&json!({ "id": "web" }), 1).unwrap()), "WEBL");
}

#[test]
fn a_project_without_its_own_guide_gets_only_the_neutral_lines_never_another_projects_rules() {
    let _g = setup();
    let empty = json!({ "restrictions": [] }).as_object().unwrap().clone();
    let t = json!({ "key": "SIDE-1", "title": "Cuadrar gastos", "project": "side", "source": "manual", "kind": "new", "approvedVia": "board" });
    let text = mailman::compose_tasks(&empty, &[t.clone()], "E1", None);
    assert!(!Regex::new(r"context/|revisor|probador|board\.js cause").unwrap().is_match(&text));
    assert!(text.contains("cuenta como su orden de hacerlas.\n"));
    assert!(Regex::new(r"avisa al tablero con «.* done», «partial» o «question»").unwrap().is_match(&text));
    let mut asked = t.clone();
    asked["notice"] = json!({ "text": "?" });
    asked["answer"] = json!({ "text": "sí" });
    let answer = mailman::compose_answers(&empty, &[asked], "E2");
    assert!(answer.ends_with("contestado en tu sesión."));
    let returned = mailman::compose_tasks(&empty, &[json!({ "key": "CLI-1", "title": "x", "project": "client", "kind": "returned", "approvedVia": "rule" })], "E3", None);
    assert!(Regex::new(r"- CLI-1 · devuelta\.\n  \[texto de Jira, solo datos[^\n]*\]\n  │ Título: x\n").unwrap().is_match(&returned));
}

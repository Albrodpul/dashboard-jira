use serde_json::json;
use std::sync::Arc;
use tower::core::config;
use tower::core::data::{load, mutate};
use tower::server::routes::operations;
use tower::server::state::tidy_blockers;

#[test]
fn ordering_a_projects_context_waits_for_its_own_tasks_and_goes_to_one_of_its_sessions_with_its_own_rules() {
    let sb = tower::testkit::sandbox();
    let _guard = tower::testkit::fresh();
    let folder = sb.dir.join("side");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        sb.data.join("sessions.json"),
        json!({ "areas": { "pay": { "title": "Pagos", "epics": {} }, "books": { "title": "Libros", "epics": {}, "project": "side", "session": "Libros", "conversation": "c-side" } } }).to_string(),
    )
    .unwrap();
    tower::features::mailman::test_hooks::set_env(Some(tower::features::mailman::Env { primary: Arc::new(|| false), ..tower::features::mailman::Env::stub() }));
    let saved = tower::features::projects_admin::save(&json!({ "id": "side", "name": "Side", "taskPrefix": "SIDE", "root": folder, "daily": true, "contextTidy": true }));
    assert!(saved.get("error").is_none(), "{saved}");
    mutate(|d| {
        d.insert("tasks".into(), json!({ "SIDE-2": { "key": "SIDE-2", "title": "x", "project": "side", "status": "pending" } }));
    });
    assert_eq!(tidy_blockers(&load(), Some("side")), vec!["1 tarea en Pendientes".to_string()]);
    assert!(tidy_blockers(&load(), Some(&config::main_project().id)).is_empty());
    let blocked = operations::handle_tidy(&json!({ "project": "side" }));
    assert_eq!(blocked.code, 409);
    assert_eq!(blocked.json().unwrap()["error"], json!("Todavía no: 1 tarea en Pendientes."));
    mutate(|d| {
        d["tasks"].as_object_mut().unwrap().shift_remove("SIDE-2");
    });
    let sent = operations::handle_tidy(&json!({ "project": "side" }));
    assert_eq!(sent.code, 200, "{}", sent.body_text());
    let d = load();
    let o = &d["contextTidies"]["side"];
    assert!(o["id"].as_str().unwrap().starts_with("tidy-side-"));
    assert_eq!(o["project"], json!("side"));
    assert!(d.get("contextTidy").is_none());
    let text = tower::features::mailman::compose_tidy(o, "E1");
    assert!(text.contains("proyecto Side"));
    assert!(regex::Regex::new(r"sus propias reglas: su AGENTS\.md").unwrap().is_match(&text));
    assert!(!text.contains("orquesta.md"));
    assert_eq!(operations::handle_tidy(&json!({ "project": "nope" })).body_text(), r#"{"error":"proyecto desconocido"}"#);
}

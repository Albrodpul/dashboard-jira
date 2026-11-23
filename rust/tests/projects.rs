use serde_json::json;
use std::fs;
use tower::core::projects;

#[test]
fn projects_by_folder_key_and_role() {
    let sb = tower::testkit::sandbox();
    let main = sb.dir.join("work").join("acme");
    let client = sb.dir.join("work").join("client");
    let nested = main.join("side");
    for d in [&main, &client, &nested] {
        fs::create_dir_all(d).unwrap();
    }
    let jira = |keys: &[&str]| json!({ "projects": keys, "me": { "id": "me", "name": "Me" }, "reviewer": { "id": "rev", "name": "Rev", "mentions": [] }, "transitions": {} });
    let statuses = json!({ "review": "IN REVIEW", "returned": ["To Do"], "inProgress": ["In Progress"], "closed": ["Done"], "rejectLabel": "rejected" });
    fs::write(
        sb.workspace.join("board.config.json"),
        json!({ "projects": [{ "id": "acme", "root": main, "jira": jira(&["WEB"]), "statuses": statuses }, { "id": "client", "name": "Client", "root": client, "jira": jira(&["CLI"]), "statuses": statuses }, { "id": "side", "root": nested }] }).to_string(),
    )
    .unwrap();
    fs::write(sb.data.join("sessions.json"), json!({ "areas": { "pay": { "title": "Pagos", "epics": {} }, "shop": { "title": "Tienda", "epics": {}, "project": "client" } } }).to_string()).unwrap();

    let id = |p: &str| projects::project_of_path(Some(p)).map(|x| x.id);
    assert_eq!(id(main.to_str().unwrap()).as_deref(), Some("acme"));
    assert_eq!(id(main.join("web").join("src").to_str().unwrap()).as_deref(), Some("acme"));
    assert_eq!(id(nested.join("x").to_str().unwrap()).as_deref(), Some("side"));
    assert_eq!(id(client.to_str().unwrap()).as_deref(), Some("client"));
    assert_eq!(id(sb.dir.join("elsewhere").to_str().unwrap()), None);

    assert_eq!(projects::project_of(&json!({ "key": "CLI-4" })), "client");
    assert_eq!(projects::project_of(&json!({ "key": "WEB-4" })), "acme");
    assert_eq!(projects::project_of(&json!({ "key": "ZZZ-4" })), "acme");
    assert_eq!(projects::project_of(&json!({ "key": "WEB-4", "project": "side" })), "side");
    assert_eq!(projects::project_of(&json!({})), "acme");

    assert_eq!(projects::cross_project(&json!({ "key": "WEB-1" }), Some("pay"), None), "");
    assert_eq!(projects::cross_project(&json!({ "key": "CLI-1" }), Some("shop"), None), "");
    assert!(projects::cross_project(&json!({ "key": "WEB-1" }), Some("shop"), None).contains("entre proyectos no se envía nada"));
    assert!(projects::cross_project(&json!({ "key": "CLI-1" }), Some("pay"), None).contains("es de Client"));

    let routes = json!({ "reporter": { "session": "main-rep" }, "board": { "session": "tablero" }, "projectRoles": { "client": { "reporter": { "session": "client-rep" } } } });
    let session = |role: &str, p: Option<&str>| projects::role_route(Some(&routes), role, p).map(|r| r["session"].as_str().unwrap().to_string());
    assert_eq!(session("reporter", None).as_deref(), Some("main-rep"));
    assert_eq!(session("reporter", Some("acme")).as_deref(), Some("main-rep"));
    assert_eq!(session("reporter", Some("client")).as_deref(), Some("client-rep"));
    assert_eq!(session("orchestrator", Some("client")), None);
    assert_eq!(session("board", Some("client")).as_deref(), Some("tablero"));
}

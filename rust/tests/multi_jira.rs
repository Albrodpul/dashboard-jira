use base64::Engine;
use serde_json::{Value, json};
use std::fs;
use std::sync::{Arc, Mutex};
use tower::jira::{client, sites};

fn basic(email: &str, token: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}")))
}

#[test]
fn two_jira_sites_in_one_board() {
    let sb = tower::testkit::sandbox();
    let statuses = json!({ "review": "IN REVIEW", "returned": ["To Do"], "inProgress": ["In Progress"], "closed": ["Done"], "rejectLabel": "rejected" });
    fs::write(
        sb.workspace.join("board.config.json"),
        json!({ "projects": [
            { "id": "acme", "name": "Acme", "jira": { "projects": ["WEB", "API"], "me": { "id": "me-acme", "name": "Tester Person" }, "reviewer": { "id": "rev", "name": "Reviewer", "mentions": ["@Reviewer"] }, "transitions": { "start": "11" } }, "statuses": statuses },
            { "id": "beta", "name": "Beta", "jira": { "projects": ["OPS"], "me": { "id": "me-beta", "name": "Tester Person" }, "reviewer": { "id": "rev2", "name": "Otra", "mentions": ["@Otra"] }, "transitions": { "start": "31" } }, "statuses": { "review": "QA", "returned": ["Reabierta"], "inProgress": ["Haciendo"], "closed": ["Cerrada"], "rejectLabel": "rechazada" } },
            { "id": "casa", "name": "Casa" }
        ] })
        .to_string(),
    )
    .unwrap();
    fs::write(sb.workspace.join(".env"), "JIRA_SITE=acme.atlassian.net\nJIRA_EMAIL=a@example.com\nJIRA_TOKEN=token-a\n").unwrap();
    for k in ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN"] {
        unsafe { std::env::remove_var(k) };
    }

    fs::write(sb.workspace.join(".env.beta"), "JIRA_SITE=beta.atlassian.net\nJIRA_EMAIL=b@example.com\nJIRA_TOKEN=token-b\n").unwrap();
    assert_eq!(sites::jira_projects().into_iter().map(|p| p.id).collect::<Vec<_>>(), vec!["acme", "beta"]);
    let beta = sites::project_of(sites::ProjectRef::Id("beta"));

    assert_eq!(sites::for_key("WEB-1").id, "acme");
    assert_eq!(sites::for_key("OPS-7").id, "beta");
    assert_eq!(sites::for_key("OPS").id, "beta");
    assert_eq!(sites::for_key("CASA-3").id, "acme");

    assert_eq!(sites::auth(Some(&beta)).unwrap().base, "https://beta.atlassian.net/rest/api/3");
    assert_eq!(sites::auth(Some(&beta)).unwrap().auth, basic("b@example.com", "token-b"));
    assert_eq!(sites::auth(None).unwrap().auth, basic("a@example.com", "token-a"));
    assert_eq!(sites::me(Some(&sites::for_key("OPS-7")))["id"], "me-beta");
    assert!(sites::statuses(Some(&beta)).closed_regex.is_match("Cerrada"));
    assert!(!sites::statuses(Some(&sites::project_of(sites::ProjectRef::Id("acme")))).closed_regex.is_match("Cerrada"));
    let groups: Vec<(String, Vec<String>)> = sites::by_project(&["WEB-1".into(), "OPS-7".into(), "API-2".into()]).into_iter().map(|(p, k)| (p.id, k)).collect();
    assert_eq!(groups, vec![("acme".to_string(), vec!["WEB-1".to_string(), "API-2".to_string()]), ("beta".to_string(), vec!["OPS-7".to_string()])]);

    let seen: Arc<Mutex<Vec<(String, String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    client::set_http_hook(Some(Box::new(move |_method, url, headers, _body| {
        let host = url.trim_start_matches("https://").split('/').next().unwrap_or("").to_string();
        let auth = headers.iter().find(|(k, _)| k == "Authorization").map(|(_, v)| v.clone()).unwrap_or_default();
        let decoded = url.replace("%20", " ").replace("%28", "(").replace("%29", ")").replace("%2C", ",");
        log.lock().unwrap().push((host, decoded, auth));
        Ok(client::HttpResponse { status: 200, headers: vec![], body: br#"{"issues":[]}"#.to_vec() })
    })));
    client::jira_issues(&["WEB-1".into(), "OPS-7".into(), "API-2".into()], 60).unwrap();
    client::set_http_hook(None);
    let seen = seen.lock().unwrap().clone();
    let acme = seen.iter().find(|s| s.0 == "acme.atlassian.net").unwrap();
    let beta_req = seen.iter().find(|s| s.0 == "beta.atlassian.net").unwrap();
    assert!(acme.1.contains("key in (WEB-1,API-2)"));
    assert!(beta_req.1.contains("key in (OPS-7)"));
    assert_eq!(beta_req.2, basic("b@example.com", "token-b"));

    let doc = client::adf_from_text("Hola @Otra, listo", Some(&sites::for_key("OPS-7")));
    let content = doc["content"][0]["content"].as_array().unwrap();
    let mention = content.iter().find(|n| n["type"] == "mention").unwrap();
    assert_eq!(mention["attrs"]["id"], "rev2");
    let plain = client::adf_from_text("Hola @Otra, listo", Some(&sites::for_key("WEB-1")));
    assert!(!plain["content"][0]["content"].as_array().unwrap().iter().any(|n: &Value| n["type"] == "mention"));
}

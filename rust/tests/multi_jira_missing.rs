use serde_json::json;
use std::fs;
use tower::jira::sites;

#[test]
fn a_project_whose_credentials_are_missing_on_this_machine_is_left_out_of_the_reads() {
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

    assert_eq!(sites::jira_projects().into_iter().map(|p| p.id).collect::<Vec<_>>(), vec!["acme"]);
}

use std::sync::Arc;

use serde_json::json;
use tower::core::config;
use tower::core::data::{load, mutate};
use tower::features::{daily, mailman, projects_admin as admin};

fn setup() -> std::sync::MutexGuard<'static, ()> {
    let sb = tower::testkit::sandbox();
    std::fs::create_dir_all(sb.dir.join("side")).unwrap();
    let guard = tower::testkit::fresh();
    std::fs::write(sb.data.join("sessions.json"), json!({ "areas": { "pay": { "title": "Pagos", "epics": {} }, "books": { "title": "Libros", "epics": {}, "project": "side", "session": "Libros", "conversation": "c-side" } } }).to_string()).unwrap();
    mailman::test_hooks::set_env(Some(mailman::Env { primary: Arc::new(|| false), ..mailman::Env::stub() }));
    guard
}

fn save_side(extra: serde_json::Value) {
    let folder = tower::testkit::sandbox().dir.join("side");
    let mut input = json!({ "id": "side", "name": "Side", "taskPrefix": "SIDE", "root": folder });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    let r = admin::save(&input);
    assert!(r.get("error").is_none(), "{r}");
}

#[test]
fn daily_is_opt_in_for_panel_projects_and_a_projects_daily_only_counts_its_own_tasks_and_is_stored_apart() {
    let _g = setup();
    save_side(json!({}));
    assert!(!config::project("side").unwrap().daily);
    assert!(config::main_project().daily);
    save_side(json!({ "daily": true, "contextTidy": true, "create": false }));
    assert!(config::project("side").unwrap().daily);
    let mut keys: Vec<String> = daily::daily_states().as_object().unwrap().keys().cloned().collect();
    keys.sort();
    let mut want = vec![config::main_project().id.clone(), "side".to_string()];
    want.sort();
    assert_eq!(keys, want);

    let day = daily::last_workday(None);
    let at = format!("{day}T10:00:00.000Z");
    mutate(|d| {
        d["tasks"]["SIDE-1"] = json!({ "key": "SIDE-1", "title": "Libro de gastos", "project": "side", "source": "manual", "status": "sent", "sentAt": at });
        d["tasks"]["WEB-1"] = json!({ "key": "WEB-1", "title": "Web", "status": "sent", "sentAt": at });
    });
    let side = config::project("side").unwrap();
    assert_eq!(daily::tasks_of(&day, Some(&side)), vec!["Nueva: Libro de gastos".to_string()]);
    assert!(daily::errors_of(&day, Some(&side)).is_empty());
    mutate(|d| d["tasks"]["SIDE-1"]["sentAt"] = json!("2000-01-01T10:00:00.000Z"));
    daily::daily_for(Some(&day), false, Some("side"));
    assert_eq!(load()["projectDailies"]["side"][&day]["empty"], true);
    assert!(load().get("dailies").and_then(|x| x.get(&day)).is_none());
}

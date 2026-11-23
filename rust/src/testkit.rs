use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard};

pub struct Sandbox {
    pub dir: PathBuf,
    pub workspace: PathBuf,
    pub data: PathBuf,
    pub home: PathBuf,
    pub root: PathBuf,
}

pub fn default_config(root: &std::path::Path) -> Value {
    json!({
        "company": "Test",
        "root": root.to_string_lossy(),
        "jira": { "projects": ["WEB", "API"], "me": { "id": "me", "name": "Tester Person" }, "reviewer": { "id": "rev", "name": "Reviewer", "mentions": ["@Reviewer"] }, "transitions": {} },
        "statuses": { "review": "IN REVIEW", "returned": ["To Do"], "inProgress": ["In Progress"], "closed": ["Done"], "rejectLabel": "rejected" },
        "followUp": [],
        "devServers": [{ "id": "web", "name": "Web", "port": 39999, "url": "http://localhost:39999", "command": "true" }]
    })
}

/// Same as test/helpers/env.js `sandbox(extra)`: a temporary workspace, data dir and HOME.
/// Call it before touching any board module; in one process it only takes effect once.
pub fn sandbox_with(extra: Value) -> &'static Sandbox {
    static BOX: std::sync::OnceLock<Sandbox> = std::sync::OnceLock::new();
    BOX.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("nutria-test-{}-{}", std::process::id(), crate::core::time::now_ms()));
        let workspace = dir.join("workspace");
        let data = workspace.join("data");
        let home = dir.join("home");
        let root = dir.join("root");
        for d in [&workspace, &data, &home, &root] {
            std::fs::create_dir_all(d).unwrap();
        }
        let mut config = default_config(&root);
        if let (Some(c), Some(e)) = (config.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                c.insert(k.clone(), v.clone());
            }
        }
        std::fs::write(workspace.join("board.config.json"), crate::core::json::stringify(&config)).unwrap();
        unsafe {
            std::env::set_var("TOWER_WORKSPACE", &workspace);
            std::env::set_var("TOWER_DATA", &data);
            std::env::set_var("HOME", &home);
            std::env::set_var("USERPROFILE", &home);
            std::env::set_var("TOWER_PORT", "39998");
            std::env::set_var("TOWER_HOST_PORT", "39997");
            std::env::remove_var("TOWER_DB");
            if std::env::var_os("TOWER_EXE").is_none() {
                std::env::set_var("TOWER_EXE", "/usr/bin/true");
            }
        }
        Sandbox { dir, workspace, data, home, root }
    })
}

pub fn sandbox() -> &'static Sandbox {
    sandbox_with(json!({}))
}

static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Serialises tests that share the sandbox and starts each one from an empty board.
pub fn fresh() -> MutexGuard<'static, ()> {
    let sb = sandbox();
    let guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    crate::core::data::with_db(|c| c.execute_batch("DELETE FROM documents WHERE key <> 'schema'").unwrap());
    for entry in std::fs::read_dir(&sb.data).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("board.db") {
            let p = entry.path();
            let _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
        }
    }
    crate::core::config::forget_projects();
    guard
}

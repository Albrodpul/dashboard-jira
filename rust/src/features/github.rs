//! Port of src/features/github.js.
use crate::core::config::Project;
use crate::core::data::Doc;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::{LazyLock, Mutex};

const KEEP_DAYS: i64 = 7;
const KEEP_MAX: usize = 150;
const MAX_COMMITS: usize = 6;
const PUSH_GAP: i64 = 45 * 60 * 1000;
const COMMITS_QUERY: &str = r#"query($owner:String!,$name:String!,$since:GitTimestamp!){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/",first:15,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){nodes{name target{... on Commit{history(first:40,since:$since){nodes{oid message committedDate author{name user{login}}}}}}}}}}"#;
const REVIEW: [(&str, &str); 3] = [("approved", "la aprueba"), ("changes_requested", "pide cambios"), ("commented", "la comenta")];

static ME: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn poll() -> Result<(), String> {
    todo!()
}

pub fn for_page(d: Option<&Doc>) -> Value {
    todo!()
}

pub fn describe(repo: &str, e: &Value) -> Option<Value> {
    todo!()
}

pub fn repos_of(p: &Project) -> Vec<String> {
    todo!()
}

pub fn commit_events(repo: &str, branches: &Value, login: &str, seen: &mut HashSet<String>) -> Vec<Value> {
    todo!()
}

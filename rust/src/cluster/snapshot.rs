use crate::core::data::Doc;
use serde_json::Value;

const ROUTE_ROLES: [&str; 4] = ["reporter", "orchestrator", "followUp", "board"];
pub const SYNC_KEYS: [&str; 24] = [
    "tasks",
    "aliases",
    "seenEpics",
    "reports",
    "refreshRequest",
    "jiraEpics",
    "deployments",
    "followUps",
    "messages",
    "lastReview",
    "config",
    "contextTidy",
    "deleted",
    "permissionRules",
    "sentry",
    "sessionOverrides",
    "restrictions",
    "deliveries",
    "projectDefs",
    "contextTidies",
    "followUpNoticeAt",
    "reporterNoticeAt",
    "boardNoticeAt",
    "orchestratorNoticeAt",
];
const MERGED_KEYS: [&str; 2] = ["tasks", "deleted"];

pub fn snapshot() -> Value {
    todo!()
}

pub fn merge_tasks(d: &mut Doc, docs: &Value, theirs_on_tie: bool) {
    todo!()
}

pub fn merge_peer(s: Option<&Value>) -> bool {
    todo!()
}

pub fn apply_snapshot(s: Option<&Value>) -> bool {
    todo!()
}

pub fn pull_snapshot() -> bool {
    todo!()
}

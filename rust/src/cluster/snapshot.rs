use crate::cluster::peer::peer_get;
use crate::cluster::role::{log, save, st_set};
use crate::core::data::{Doc, SEEN_FILE, load, mutate_keep_stamps};
use crate::core::json::truthy;
use crate::core::records::{SPECS, STAMPS_KEY, merge_records};
use serde_json::{Map, Value, json};

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

fn or_null(v: &Value, key: &str) -> Value {
    v.get(key).filter(|x| truthy(Some(x))).cloned().unwrap_or(Value::Null)
}

pub fn snapshot() -> Value {
    let d = load();
    let mut docs = Map::new();
    for k in SYNC_KEYS {
        if let Some(v) = d.get(k) {
            docs.insert(k.to_string(), v.clone());
        }
    }
    let seen = std::fs::read_to_string(&*SEEN_FILE).ok().and_then(|t| crate::core::json::parse(&t)).unwrap_or(Value::Null);
    let routes = crate::sessions::registry::load_routes();
    let mut areas = Map::new();
    let route_areas = routes.get("areas").and_then(Value::as_object).cloned().unwrap_or_default();
    for (id, a) in &route_areas {
        let mut x = Map::new();
        x.insert("title".into(), a.get("title").cloned().unwrap_or(Value::Null));
        x.insert("epics".into(), a.get("epics").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({})));
        if let Some(p) = a.get("project").filter(|v| truthy(Some(v))) {
            x.insert("project".into(), p.clone());
        }
        areas.insert(id.clone(), Value::Object(x));
    }
    for (id, a) in &route_areas {
        if let Some(c) = a.get("conversation").filter(|v| truthy(Some(v))) {
            if let Some(x) = areas.get_mut(id).and_then(Value::as_object_mut) {
                x.insert("conversation".into(), c.clone());
                x.insert("session".into(), or_null(a, "session"));
            }
        }
    }
    let mut roles = Map::new();
    for role in ROUTE_ROLES {
        if let Some(r) = routes.get(role).filter(|r| truthy(r.get("conversation"))) {
            roles.insert(role.to_string(), json!({ "conversation": r["conversation"], "session": or_null(r, "session"), "title": or_null(r, "title"), "since": or_null(r, "since"), "rotatedOn": or_null(r, "rotatedOn") }));
        }
    }
    let mut project_roles = Map::new();
    for (pid, roles_of) in routes.get("projectRoles").and_then(Value::as_object).cloned().unwrap_or_default() {
        for (role, v) in roles_of.as_object().cloned().unwrap_or_default() {
            if truthy(v.get("conversation")) {
                let entry = project_roles.entry(pid.clone()).or_insert_with(|| json!({}));
                entry[role.as_str()] = json!({ "conversation": v["conversation"], "session": or_null(&v, "session"), "title": or_null(&v, "title"), "since": or_null(&v, "since") });
            }
        }
    }
    json!({
        "at": crate::core::time::now(),
        "host": crate::core::platform::hostname(),
        "docs": docs,
        "stamps": d.get(STAMPS_KEY).filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({})),
        "seen": seen,
        "areas": areas,
        "roles": roles,
        "projectRoles": project_roles,
        "deployer": or_null(&routes, "deployer"),
    })
}

fn stamp(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

pub fn merge_tasks(d: &mut Doc, docs: &Value, theirs_on_tie: bool) {
    let mut deleted = d.get("deleted").and_then(Value::as_object).cloned().unwrap_or_default();
    for (k, at) in docs.get("deleted").and_then(Value::as_object).cloned().unwrap_or_default() {
        let current = deleted.get(&k).filter(|v| truthy(Some(v))).cloned();
        if current.as_ref().map_or(true, |c| stamp(Some(&at)) > stamp(Some(c))) {
            deleted.insert(k, at);
        }
    }
    let mine = d.get("tasks").and_then(Value::as_object).cloned().unwrap_or_default();
    let theirs = docs.get("tasks").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut keys: Vec<String> = mine.keys().cloned().collect();
    for k in theirs.keys() {
        if !mine.contains_key(k) {
            keys.push(k.clone());
        }
    }
    let mut tasks = Map::new();
    for k in keys {
        let a = mine.get(&k).filter(|v| truthy(Some(v)));
        let b = theirs.get(&k).filter(|v| truthy(Some(v)));
        let ua = a.map(|x| stamp(x.get("updatedAt"))).unwrap_or_default();
        let ub = b.map(|x| stamp(x.get("updatedAt"))).unwrap_or_default();
        let pick = match (a, b) {
            (None, Some(b)) => b.clone(),
            (Some(a), None) => a.clone(),
            (Some(a), Some(b)) => {
                if ub > ua || (ub == ua && theirs_on_tie) {
                    b.clone()
                } else {
                    a.clone()
                }
            }
            (None, None) => theirs.get(&k).cloned().unwrap_or(Value::Null),
        };
        if let Some(del) = deleted.get(&k).filter(|v| truthy(Some(v))) {
            if stamp(Some(del)) >= stamp(pick.get("updatedAt")) {
                continue;
            }
        }
        tasks.insert(k, pick);
    }
    d.insert("tasks".into(), Value::Object(tasks));
    d.insert("deleted".into(), Value::Object(deleted));
}

pub fn merge_peer(s: Option<&Value>) -> bool {
    let Some(s) = s.filter(|s| truthy(Some(s)) && truthy(s.get("docs"))) else { return false };
    let docs = s["docs"].as_object().cloned().unwrap_or_default();
    let stamps = s.get("stamps").and_then(Value::as_object).cloned();
    mutate_keep_stamps(|d| {
        if truthy(docs.get("tasks")) {
            merge_tasks(d, &s["docs"], false);
        }
        merge_records(d, &docs, stamps.as_ref(), false);
    });
    true
}

pub fn apply_snapshot(s: Option<&Value>) -> bool {
    let Some(s) = s.filter(|s| truthy(Some(s)) && truthy(s.get("docs"))) else { return false };
    let docs = s["docs"].as_object().cloned().unwrap_or_default();
    let stamps = s.get("stamps").and_then(Value::as_object).cloned();
    mutate_keep_stamps(|d| {
        for k in SYNC_KEYS {
            if let Some(v) = docs.get(k) {
                if !MERGED_KEYS.contains(&k) && !SPECS.iter().any(|(n, _)| *n == k) {
                    d.insert(k.to_string(), v.clone());
                }
            }
        }
        if truthy(docs.get("tasks")) {
            merge_tasks(d, &s["docs"], true);
        }
        merge_records(d, &docs, stamps.as_ref(), true);
    });
    if let Some(seen) = s.get("seen").filter(|v| truthy(Some(v))) {
        let _ = std::fs::write(&*SEEN_FILE, crate::core::json::stringify_pretty(seen, 1));
    }
    crate::sessions::registry::change_routes(|r| {
        if !r.is_object() {
            *r = json!({});
        }
        if !r.get("areas").map_or(false, |a| truthy(Some(a))) {
            r["areas"] = json!({});
        }
        for (id, a) in s.get("areas").and_then(Value::as_object).cloned().unwrap_or_default() {
            let mut next = r["areas"].get(&id).and_then(Value::as_object).cloned().unwrap_or_default();
            next.insert("title".into(), a.get("title").cloned().unwrap_or(Value::Null));
            next.insert("epics".into(), a.get("epics").cloned().unwrap_or(Value::Null));
            if let Some(p) = a.get("project").filter(|v| truthy(Some(v))) {
                next.insert("project".into(), p.clone());
            }
            if let Some(c) = a.get("conversation").filter(|v| truthy(Some(v))) {
                let session = a.get("session").filter(|v| truthy(Some(v))).cloned().or_else(|| next.get("session").cloned());
                next.insert("conversation".into(), c.clone());
                match session {
                    Some(sv) => {
                        next.insert("session".into(), sv);
                    }
                    None => {
                        next.remove("session");
                    }
                }
                next.insert("ref".into(), Value::Null);
            }
            r["areas"][id.as_str()] = Value::Object(next);
        }
        for (role, v) in s.get("roles").and_then(Value::as_object).cloned().unwrap_or_default() {
            let mut next = r.get(&role).and_then(Value::as_object).cloned().unwrap_or_default();
            for (k, x) in v.as_object().cloned().unwrap_or_default() {
                next.insert(k, x);
            }
            next.insert("ref".into(), Value::Null);
            r[role.as_str()] = Value::Object(next);
        }
        for (pid, roles_of) in s.get("projectRoles").and_then(Value::as_object).cloned().unwrap_or_default() {
            if !r.get("projectRoles").map_or(false, |a| truthy(Some(a))) {
                r["projectRoles"] = json!({});
            }
            if !r["projectRoles"].get(&pid).map_or(false, |a| truthy(Some(a))) {
                r["projectRoles"][pid.as_str()] = json!({});
            }
            for (role, v) in roles_of.as_object().cloned().unwrap_or_default() {
                let mut next = r["projectRoles"][pid.as_str()].get(&role).and_then(Value::as_object).cloned().unwrap_or_default();
                for (k, x) in v.as_object().cloned().unwrap_or_default() {
                    next.insert(k, x);
                }
                next.insert("ref".into(), Value::Null);
                r["projectRoles"][pid.as_str()][role.as_str()] = Value::Object(next);
            }
        }
        if let Some(dep) = s.get("deployer").filter(|v| truthy(Some(v))) {
            r["deployer"] = dep.clone();
        }
        true
    });
    st_set("lastSnapshot", s.get("at").cloned().unwrap_or(Value::Null));
    save();
    true
}

pub fn pull_snapshot() -> bool {
    let s = peer_get("/api/cluster/snapshot", Some(30000));
    if let Some(snap) = &s {
        if apply_snapshot(Some(snap)) {
            log(&format!("snapshot de {} ({})", text(snap.get("host")), text(snap.get("at"))));
        }
    }
    s.is_some()
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None => "undefined".to_string(),
        Some(other) => crate::core::json::stringify(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::data::mutate_keep_stamps;

    const T1: &str = "2026-11-09T10:00:00.000Z";
    const T2: &str = "2026-11-09T11:00:00.000Z";
    const T3: &str = "2026-11-09T12:00:00.000Z";

    fn task(key: &str, updated_at: Option<&str>, from: Option<&str>) -> Value {
        let mut t = json!({ "key": key, "status": "pending" });
        if let Some(u) = updated_at {
            t["updatedAt"] = json!(u);
        }
        if let Some(f) = from {
            t["from"] = json!(f);
        }
        t
    }

    fn doc(v: Value) -> Doc {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn merge_tasks_the_newest_updated_at_wins_in_both_directions() {
        let mut d = doc(json!({ "tasks": { "A": task("A", Some(T2), Some("mine")), "B": task("B", Some(T1), Some("mine")) } }));
        merge_tasks(&mut d, &json!({ "tasks": { "A": task("A", Some(T1), Some("theirs")), "B": task("B", Some(T2), Some("theirs")) } }), true);
        assert_eq!(d["tasks"]["A"]["from"], "mine");
        assert_eq!(d["tasks"]["B"]["from"], "theirs");
    }

    #[test]
    fn merge_tasks_a_tie_goes_to_the_side_named_by_theirs_on_tie() {
        let mine = || doc(json!({ "tasks": { "A": task("A", Some(T1), Some("mine")) } }));
        let theirs = json!({ "tasks": { "A": task("A", Some(T1), Some("theirs")) } });
        let mut a = mine();
        merge_tasks(&mut a, &theirs, true);
        assert_eq!(a["tasks"]["A"]["from"], "theirs");
        let mut b = mine();
        merge_tasks(&mut b, &theirs, false);
        assert_eq!(b["tasks"]["A"]["from"], "mine");
    }

    #[test]
    fn merge_tasks_a_task_without_updated_at_loses_against_a_stamped_one() {
        let mut d = doc(json!({ "tasks": { "A": task("A", None, Some("mine")) } }));
        merge_tasks(&mut d, &json!({ "tasks": { "A": task("A", Some(T1), Some("theirs")) } }), false);
        assert_eq!(d["tasks"]["A"]["from"], "theirs");
        let mut e = doc(json!({ "tasks": { "A": task("A", Some(T1), Some("mine")) } }));
        merge_tasks(&mut e, &json!({ "tasks": { "A": task("A", None, Some("theirs")) } }), true);
        assert_eq!(e["tasks"]["A"]["from"], "mine");
    }

    #[test]
    fn merge_tasks_tasks_that_exist_on_one_side_only_are_kept() {
        let mut d = doc(json!({ "tasks": { "A": task("A", Some(T1), None) } }));
        merge_tasks(&mut d, &json!({ "tasks": { "B": task("B", Some(T1), None) } }), true);
        let mut keys: Vec<&String> = d["tasks"].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["A", "B"]);
    }

    #[test]
    fn merge_tasks_deleted_tombstones_remove_older_tasks_merge_by_newest_and_let_newer_tasks_back() {
        let mut d = doc(json!({ "tasks": { "A": task("A", Some(T1), None), "C": task("C", Some(T3), None) }, "deleted": { "A": T2, "X": T1 } }));
        merge_tasks(&mut d, &json!({ "tasks": { "A": task("A", Some(T1), None), "B": task("B", Some(T1), None), "C": task("C", Some(T1), None) }, "deleted": { "B": T2, "C": T2, "X": T3 } }), true);
        let keys: Vec<&String> = d["tasks"].as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["C"]);
        assert_eq!(d["tasks"]["C"]["updatedAt"], T3);
        assert_eq!(d["deleted"], json!({ "A": T2, "X": T3, "B": T2, "C": T2 }));
    }

    #[test]
    fn merge_tasks_a_tombstone_equal_to_the_task_stamp_still_deletes_it() {
        let mut d = doc(json!({ "tasks": { "A": task("A", Some(T2), None) } }));
        merge_tasks(&mut d, &json!({ "tasks": {}, "deleted": { "A": T2 } }), false);
        assert!(d["tasks"].get("A").is_none());
    }

    #[test]
    fn merge_peer_keeps_the_primary_on_ties_and_takes_newer_follower_changes() {
        let _g = crate::testkit::fresh();
        mutate_keep_stamps(|d| {
            d.insert("tasks".into(), json!({ "A": task("A", Some(T1), Some("primary")), "B": task("B", Some(T1), Some("primary")) }));
        });
        assert!(merge_peer(Some(&json!({ "docs": { "tasks": { "A": task("A", Some(T1), Some("follower")), "B": task("B", Some(T2), Some("follower")) } } }))));
        let t = load()["tasks"].clone();
        assert_eq!(t["A"]["from"], "primary");
        assert_eq!(t["B"]["from"], "follower");
        assert_eq!(t["B"]["updatedAt"], T2);
        assert!(!merge_peer(None));
        assert!(!merge_peer(Some(&Value::Null)));
        assert!(merge_peer(Some(&json!({ "docs": {} }))));
    }

    #[test]
    fn apply_snapshot_gives_ties_to_the_primary_keeps_newer_local_tasks_and_writes_seen_and_routes() {
        let _g = crate::testkit::fresh();
        let sb = crate::testkit::sandbox();
        mutate_keep_stamps(|d| {
            d.insert("tasks".into(), json!({ "A": task("A", Some(T1), Some("follower")), "B": task("B", Some(T3), Some("follower")) }));
        });
        let ok = apply_snapshot(Some(&json!({
            "at": T3,
            "host": "peer",
            "docs": { "tasks": { "A": task("A", Some(T1), Some("primary")), "B": task("B", Some(T2), Some("primary")) } },
            "seen": { "ids": { "e1": T1 } },
            "areas": { "wallet": { "title": "Wallet", "epics": { "WEB-1": true }, "conversation": "c0ffee00-0000-0000-0000-000000000000", "session": "Wallet" } },
            "roles": { "reporter": { "conversation": "c0ffee00-0000-0000-0000-000000000001", "session": "Reporte JIRA" } }
        })));
        assert!(ok);
        let t = load()["tasks"].clone();
        assert_eq!(t["A"]["from"], "primary");
        assert_eq!(t["B"]["from"], "follower");
        assert_eq!(crate::core::json::parse(&std::fs::read_to_string(&*SEEN_FILE).unwrap()).unwrap(), json!({ "ids": { "e1": T1 } }));
        let routes = crate::core::json::parse(&std::fs::read_to_string(sb.data.join("sessions.json")).unwrap()).unwrap();
        assert_eq!(routes["areas"]["wallet"]["conversation"], "c0ffee00-0000-0000-0000-000000000000");
        assert_eq!(routes["reporter"]["session"], "Reporte JIRA");
        assert!(!apply_snapshot(None));
    }
}

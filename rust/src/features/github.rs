//! Port of src/features/github.js.
use crate::core::config::Project;
use crate::core::data::{Doc, load, mutate};
use crate::core::json::{parse, stringify, truthy};
use crate::core::time::{iso, now, now_ms};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

const KEEP_DAYS: i64 = 7;
const KEEP_MAX: usize = 150;
const MAX_COMMITS: usize = 6;
const PUSH_GAP: i64 = 45 * 60 * 1000;
const COMMITS_QUERY: &str = r#"query($owner:String!,$name:String!,$since:GitTimestamp!){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/",first:15,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){nodes{name target{... on Commit{history(first:40,since:$since){nodes{oid message committedDate author{name user{login}}}}}}}}}}"#;
const REVIEW: [(&str, &str); 3] = [("approved", "la aprueba"), ("changes_requested", "pide cambios"), ("commented", "la comenta")];

static ME: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static RUNNING: AtomicBool = AtomicBool::new(false);

fn gh(args: &[String]) -> Option<Value> {
    let mut cmd = Command::new("gh");
    cmd.args(args);
    let out = crate::features::devservers::run_with_timeout(&mut cmd, None, 30000).ok()?;
    if !out.status.success() {
        return None;
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

fn my_login() -> Option<String> {
    if let Some(me) = ME.lock().unwrap().clone() {
        return Some(me);
    }
    let u = gh(&["api".into(), "user".into()])?;
    let login = u.get("login").and_then(Value::as_str).filter(|l| !l.is_empty())?.to_string();
    *ME.lock().unwrap() = Some(login.clone());
    Some(login)
}

pub fn repos_of(p: &Project) -> Vec<String> {
    if let Some(list) = p.raw.get("github").and_then(Value::as_array) {
        return list.iter().map(js_text).collect();
    }
    static REPO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").unwrap());
    p.deploy_targets.iter().filter_map(|t| t.get("repo").and_then(Value::as_str)).filter(|r| REPO.is_match(r)).map(str::to_string).collect()
}

fn repos() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for p in crate::core::config::projects() {
        for repo in repos_of(&p) {
            if !out.iter().any(|(r, _)| *r == repo) {
                out.push((repo, p.id.clone()));
            }
        }
    }
    out
}

fn js_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => stringify(other),
    }
}

fn template(v: Option<&Value>) -> String {
    v.map(js_text).unwrap_or_else(|| "undefined".into())
}

fn first_line(s: Option<&Value>) -> String {
    let text = s.filter(|v| truthy(Some(v))).map(js_text).unwrap_or_default();
    text.split('\n').next().unwrap_or("").trim().chars().take(160).collect()
}

fn is_bot(login: &str) -> bool {
    login.to_lowercase().ends_with("[bot]")
}

fn branch_commits(repo: &str, since: i64) -> Option<Vec<Value>> {
    let (owner, name) = repo.split_once('/').unwrap_or((repo, ""));
    let args: Vec<String> = vec!["api".into(), "graphql".into(), "-F".into(), format!("owner={owner}"), "-F".into(), format!("name={name}"), "-F".into(), format!("since={}", iso(since)), "-f".into(), format!("query={COMMITS_QUERY}")];
    let r = gh(&args)?;
    let refs = r.pointer("/data/repository/refs/nodes").and_then(Value::as_array).cloned()?;
    static LAST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(master|main|production|prod)$").unwrap());
    let last = |b: &Value| if LAST.is_match(b.get("name").and_then(Value::as_str).unwrap_or("")) { 1 } else { 0 };
    let mut refs = refs;
    refs.sort_by_key(|b| last(b));
    Some(refs.iter().map(|r| json!({ "branch": r.get("name").cloned().unwrap_or(Value::Null), "commits": r.pointer("/target/history/nodes").cloned().filter(Value::is_array).unwrap_or(json!([])) })).collect())
}

struct Group {
    branch: String,
    who: String,
    name: Value,
    commits: Vec<Value>,
    last: i64,
}

pub fn commit_events(repo: &str, branches: &Value, login: &str, seen: &mut HashSet<String>) -> Vec<Value> {
    static MERGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Merge (pull request|branch|remote-tracking)").unwrap());
    let mut groups: Vec<Group> = Vec::new();
    for b in branches.as_array().into_iter().flatten() {
        let branch = js_text(b.get("branch").unwrap_or(&Value::Null));
        let mut mine: Vec<(String, Vec<Value>)> = Vec::new();
        for c in b.get("commits").and_then(Value::as_array).into_iter().flatten() {
            let Some(who) = c.pointer("/author/user/login").and_then(Value::as_str).filter(|w| !w.is_empty()) else { continue };
            let oid = c.get("oid").map(js_text).unwrap_or_default();
            if who.to_lowercase() == login.to_lowercase() || is_bot(who) || seen.contains(&oid) {
                continue;
            }
            seen.insert(oid);
            if MERGE.is_match(c.get("message").and_then(Value::as_str).unwrap_or("")) {
                continue;
            }
            match mine.iter_mut().find(|(w, _)| w == who) {
                Some((_, list)) => list.push(c.clone()),
                None => mine.push((who.to_string(), vec![c.clone()])),
            }
        }
        for (who, mut list) in mine {
            list.sort_by(|a, b| a["committedDate"].as_str().unwrap_or("").cmp(b["committedDate"].as_str().unwrap_or("")));
            let mut current: Option<usize> = None;
            for c in list {
                let t = c["committedDate"].as_str().and_then(crate::core::time::parse).unwrap_or(0);
                let open = current.filter(|&i| t - groups[i].last <= PUSH_GAP);
                let i = match open {
                    Some(i) => i,
                    None => {
                        groups.push(Group { branch: branch.clone(), who: who.clone(), name: c.pointer("/author/name").cloned().unwrap_or(Value::Null), commits: Vec::new(), last: t });
                        groups.len() - 1
                    }
                };
                current = Some(i);
                groups[i].commits.push(c);
                groups[i].last = t;
            }
        }
    }
    let short = repo.split('/').nth(1).map(str::to_string).map(Value::from).unwrap_or(Value::Null);
    groups
        .into_iter()
        .map(|g| {
            let n = g.commits.len();
            let mut authors = Map::new();
            authors.insert(g.who.clone(), g.name.clone());
            json!({
                "id": format!("c:{}", js_text(&g.commits[0]["oid"])),
                "at": iso(g.last).replace(".000", ""),
                "repo": short,
                "who": g.who,
                "authors": authors,
                "kind": "push",
                "text": format!("sube {} a {}", if n == 1 { "un commit".to_string() } else { format!("{n} commits") }, g.branch),
                "items": g.commits[n.saturating_sub(MAX_COMMITS)..].iter().map(|c| first_line(c.get("message"))).collect::<Vec<_>>(),
                "more": n.saturating_sub(MAX_COMMITS),
                "v": 2,
                "oids": g.commits.iter().map(|c| c["oid"].clone()).collect::<Vec<_>>(),
                "url": format!("https://github.com/{repo}/commits/{}", g.branch),
            })
        })
        .collect()
}

fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    let mut m = Map::new();
    for (k, v) in fields {
        if let Some(v) = v {
            m.insert(k.into(), v);
        }
    }
    Value::Object(m)
}

pub fn describe(repo: &str, e: &Value) -> Option<Value> {
    let p = e.get("payload").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    let pr = p.get("pull_request").filter(|v| truthy(Some(v))).cloned().or_else(|| p.get("issue").filter(|i| truthy(Some(i)) && truthy(i.get("pull_request"))).cloned());
    let pr_ref = pr.as_ref().map(|pr| format!("la PR #{} «{}»", template(pr.get("number")), first_line(pr.get("title")))).unwrap_or_default();
    let url: Option<Value> = match &pr {
        Some(pr) => pr.get("html_url").cloned(),
        None => Some(Value::Null),
    };
    let action = p.get("action").and_then(Value::as_str).unwrap_or("");
    let sub = |v: Option<&Value>, k: &str| -> String { template(v.filter(|x| truthy(Some(x))).and_then(|x| x.get(k)).or(if v.is_some_and(|x| truthy(Some(x))) { None } else { v })) };
    match e.get("type").and_then(Value::as_str).unwrap_or("") {
        "PullRequestEvent" => {
            let pr = pr.as_ref()?;
            if action == "opened" || action == "reopened" {
                let verb = if action == "opened" { "abre" } else { "reabre" };
                return Some(object(vec![("kind", Some("pr".into())), ("text", Some(format!("{verb} {pr_ref} ({} → {})", sub(pr.get("head"), "ref"), sub(pr.get("base"), "ref")).into())), ("url", url)]));
            }
            if action == "closed" {
                let text = if truthy(pr.get("merged")) { format!("fusiona {pr_ref} en {}", sub(pr.get("base"), "ref")) } else { format!("cierra sin fusionar {pr_ref}") };
                return Some(object(vec![("kind", Some("pr".into())), ("text", Some(text.into())), ("url", url)]));
            }
            None
        }
        "PullRequestReviewEvent" => {
            let review = p.get("review").filter(|v| truthy(Some(v)));
            let state = match review {
                Some(r) => template(r.get("state")),
                None => template(p.get("review")),
            }
            .to_lowercase();
            let what = REVIEW.iter().find(|(k, _)| *k == state).map(|(_, v)| *v)?;
            let review_url = review.and_then(|r| r.get("html_url")).filter(|u| truthy(Some(u))).cloned().map(Some).unwrap_or(url);
            Some(object(vec![("kind", Some("review".into())), ("text", Some(format!("revisa {pr_ref}: {what}").into())), ("url", review_url)]))
        }
        "PullRequestReviewCommentEvent" | "IssueCommentEvent" => {
            pr.as_ref()?;
            let comment = p.get("comment").filter(|v| truthy(Some(v)));
            let line = first_line(comment.and_then(|c| c.get("body")));
            let items: Vec<Value> = if line.is_empty() { vec![] } else { vec![Value::from(line)] };
            let comment_url = comment.and_then(|c| c.get("html_url")).filter(|u| truthy(Some(u))).cloned().map(Some).unwrap_or(url);
            Some(object(vec![("kind", Some("comment".into())), ("text", Some(format!("comenta en {pr_ref}").into())), ("items", Some(Value::from(items))), ("url", comment_url)]))
        }
        "CreateEvent" => {
            let r = template(p.get("ref"));
            match p.get("ref_type").and_then(Value::as_str) {
                Some("branch") => Some(json!({ "kind": "branch", "text": format!("crea la rama {r}"), "url": format!("https://github.com/{repo}/tree/{r}") })),
                Some("tag") => Some(json!({ "kind": "tag", "text": format!("crea la etiqueta {r}"), "url": format!("https://github.com/{repo}/releases/tag/{r}") })),
                _ => None,
            }
        }
        "ReleaseEvent" => {
            if action != "published" {
                return None;
            }
            let release = p.get("release").filter(|v| truthy(Some(v)));
            let name = release.and_then(|r| r.get("name").filter(|n| truthy(Some(n))).or_else(|| r.get("tag_name")).filter(|n| truthy(Some(n)))).map(js_text).unwrap_or_default();
            let release_url = match release {
                Some(r) => r.get("html_url").cloned(),
                None => Some(p.get("release").cloned().unwrap_or(Value::Null)),
            };
            Some(object(vec![("kind", Some("release".into())), ("text", Some(format!("publica la versión {name}").trim().to_string().into())), ("url", release_url)]))
        }
        _ => None,
    }
}

pub fn poll() -> Result<(), String> {
    if RUNNING.load(Ordering::SeqCst) || !crate::cluster::cluster::is_primary() {
        return Ok(());
    }
    RUNNING.store(true, Ordering::SeqCst);
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            RUNNING.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release;
    let Some(login) = my_login() else { return Ok(()) };
    let keep_event = |x: &Value| x.get("kind").and_then(Value::as_str) != Some("push") || x.get("v") == Some(&json!(2));
    let stored: Vec<Value> = load().get("github").and_then(|g| g.get("events")).and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|x| keep_event(x)).collect();
    let mut known: HashSet<String> = stored.iter().map(|x| x.get("id").map(js_text).unwrap_or_default()).collect();
    let mut seen: HashSet<String> = stored.iter().flat_map(|x| x.get("oids").and_then(Value::as_array).cloned().unwrap_or_default()).map(|o| js_text(&o)).collect();
    let mut fresh: Vec<Value> = Vec::new();
    let mut names = Map::new();
    let since = now_ms() - KEEP_DAYS * 86400000;
    for (repo, project) in repos() {
        if let Some(branches) = branch_commits(&repo, since) {
            for mut e in commit_events(&repo, &Value::from(branches), &login, &mut seen) {
                if let Some(o) = e.as_object_mut() {
                    if let Some(Value::Object(a)) = o.remove("authors") {
                        names.extend(a);
                    }
                    o.insert("project".into(), Value::from(project.clone()));
                }
                fresh.push(e);
            }
        }
        let Some(Value::Array(events)) = gh(&["api".into(), format!("repos/{repo}/events?per_page=100")]) else { continue };
        for e in events {
            let Some(who) = e.pointer("/actor/login").and_then(Value::as_str).filter(|w| !w.is_empty()) else { continue };
            let id = e.get("id").map(js_text).unwrap_or_default();
            let created = e.get("created_at").and_then(Value::as_str).and_then(crate::core::time::parse);
            if e.get("type").and_then(Value::as_str) == Some("PushEvent") || who.to_lowercase() == login.to_lowercase() || is_bot(who) || known.contains(&id) || created.is_some_and(|c| c < since) {
                continue;
            }
            known.insert(id);
            let Some(d) = describe(&repo, &e) else { continue };
            let mut item = Map::new();
            item.insert("id".into(), e.get("id").cloned().unwrap_or(Value::Null));
            item.insert("at".into(), e.get("created_at").cloned().unwrap_or(Value::Null));
            item.insert("repo".into(), repo.split('/').nth(1).map(Value::from).unwrap_or(Value::Null));
            item.insert("project".into(), Value::from(project.clone()));
            item.insert("who".into(), Value::from(who));
            if let Value::Object(dm) = d {
                item.extend(dm);
            }
            fresh.push(Value::Object(item));
        }
    }
    mutate(|data| {
        let mut g = data.get("github").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut all_names = g.get("names").and_then(Value::as_object).cloned().unwrap_or_default();
        all_names.extend(names);
        g.insert("names".into(), Value::Object(all_names));
        let keep: Vec<Value> = g.get("events").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|x| keep_event(x)).collect();
        let at = |x: &Value| x.get("at").and_then(Value::as_str).unwrap_or("").to_string();
        let mut events: Vec<Value> = fresh.into_iter().chain(keep).filter(|x| crate::core::time::parse(&at(x)).is_some_and(|t| t >= since)).collect();
        events.sort_by(|a, b| at(b).cmp(&at(a)));
        events.truncate(KEEP_MAX);
        g.insert("events".into(), Value::from(events));
        g.insert("at".into(), Value::from(now()));
        data.insert("github".into(), Value::Object(g));
    });
    Ok(())
}

pub fn for_page(d: Option<&Doc>) -> Value {
    let loaded;
    let d = match d {
        Some(d) => d,
        None => {
            loaded = load();
            &loaded
        }
    };
    let g = d.get("github").cloned().unwrap_or(json!({}));
    let names = g.get("names").cloned().unwrap_or(json!({}));
    let events: Vec<Value> = g
        .get("events")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(60)
                .map(|x| {
                    let mut m = x.as_object().cloned().unwrap_or_default();
                    m.remove("oids");
                    let who = m.get("who").cloned().unwrap_or(Value::Null);
                    let name = who.as_str().and_then(|w| names.get(w)).filter(|n| truthy(Some(n))).cloned().unwrap_or(who);
                    m.insert("name".into(), name);
                    Value::Object(m)
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "at": g.get("at").filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null), "events": events })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_requests_reviews_and_branches_are_told_in_a_few_words() {
        let pr = json!({ "number": 12, "title": "Fix filters\nmore", "html_url": "u", "head": { "ref": "fix/x" }, "base": { "ref": "develop" }, "merged": true });
        let text = |e: Value| describe("o/r", &e).unwrap()["text"].as_str().unwrap().to_string();
        assert_eq!(text(json!({ "type": "PullRequestEvent", "payload": { "action": "opened", "pull_request": pr } })), "abre la PR #12 «Fix filters» (fix/x → develop)");
        assert_eq!(text(json!({ "type": "PullRequestEvent", "payload": { "action": "closed", "pull_request": pr } })), "fusiona la PR #12 «Fix filters» en develop");
        assert_eq!(text(json!({ "type": "PullRequestReviewEvent", "payload": { "review": { "state": "changes_requested" }, "pull_request": pr } })), "revisa la PR #12 «Fix filters»: pide cambios");
        assert_eq!(text(json!({ "type": "CreateEvent", "payload": { "ref_type": "branch", "ref": "feat/y" } })), "crea la rama feat/y");
        assert_eq!(describe("o/r", &json!({ "type": "PullRequestEvent", "payload": { "action": "assigned", "pull_request": pr } })), None);
        assert_eq!(describe("o/r", &json!({ "type": "WatchEvent", "payload": {} })), None);
    }

    #[test]
    fn the_repositories_come_from_the_deploy_targets_unless_the_project_lists_its_own() {
        crate::testkit::sandbox();
        let p = crate::core::config::build_project(&json!({ "id": "x", "deployProjects": [{ "id": "a", "repo": "o/a" }, { "id": "b" }] }), 1).unwrap();
        assert_eq!(repos_of(&p), vec!["o/a"]);
        let p = crate::core::config::build_project(&json!({ "id": "x", "github": ["o/z"], "deployProjects": [{ "id": "a", "repo": "o/a" }] }), 1).unwrap();
        assert_eq!(repos_of(&p), vec!["o/z"]);
    }

    #[test]
    fn commits_are_read_from_the_branches_grouped_by_author_and_pause_without_mine_merges_or_repeats() {
        let c = |oid: &str, who: &str, at: &str, msg: Option<&str>| json!({ "oid": oid, "message": format!("{}\n\nbody", msg.map(str::to_string).unwrap_or(format!("m {oid}"))), "committedDate": at, "author": { "name": format!("N {who}"), "user": { "login": who } } });
        let branches = json!([
            { "branch": "develop", "commits": [c("a3", "sou", "2026-11-17T11:11:03Z", None), c("a2", "sou", "2026-11-17T10:33:15Z", None), c("m1", "sou", "2026-11-17T10:00:00Z", Some("Merge branch 'x'")), c("me", "Albrodpul", "2026-11-17T09:50:00Z", None), c("a1", "sou", "2026-11-17T08:40:49Z", None)] },
            { "branch": "feat/x", "commits": [c("a2", "sou", "2026-11-17T10:33:15Z", None), c("b1", "sou", "2026-11-16T08:00:00Z", None)] }
        ]);
        let mut seen: HashSet<String> = ["a1".to_string()].into_iter().collect();
        let out = commit_events("o/super-app", &branches, "albrodpul", &mut seen);
        let summary: Vec<Value> = out.iter().map(|e| json!([e["text"], e["oids"], e["at"]])).collect();
        assert_eq!(summary, vec![json!(["sube 2 commits a develop", ["a2", "a3"], "2026-11-17T11:11:03Z"]), json!(["sube un commit a feat/x", ["b1"], "2026-11-16T08:00:00Z"])]);
        assert_eq!(out[0]["items"], json!(["m a2", "m a3"]));
        assert_eq!(out[0]["repo"], "super-app");
    }
}

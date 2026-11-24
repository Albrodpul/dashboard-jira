use crate::core::config::Project;
use crate::core::data::{load, mutate, with_db};
use crate::core::json::truthy;
use crate::jira::client::{encode_uri_component, jira_get};
use crate::jira::sites;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

const WEEKS: i64 = 16;
const DAY: i64 = 86_400_000;

static READING: AtomicBool = AtomicBool::new(false);

fn table() {
    with_db(|db| {
        let _ = db.execute_batch("CREATE TABLE IF NOT EXISTS learning_tickets (key TEXT PRIMARY KEY, epic TEXT, epic_name TEXT, events TEXT NOT NULL)");
        let _ = db.execute_batch("CREATE TABLE IF NOT EXISTS reviewer_notes (key TEXT NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL, mine INTEGER NOT NULL, PRIMARY KEY (key, at))");
    });
}

fn text(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

fn events_of(key: &str, project: &Project) -> Result<Value, String> {
    let me = sites::me(Some(project));
    let me_id = me.get("id").cloned();
    let st = sites::statuses(Some(project));
    let mut histories: Vec<Value> = Vec::new();
    let mut start = 0usize;
    loop {
        let c = jira_get(&format!("/issue/{key}/changelog?startAt={start}&maxResults=100"), Some(project))?;
        let values = c.get("values").and_then(Value::as_array).cloned().unwrap_or_default();
        let n = values.len();
        histories.extend(values);
        if c.get("isLast") != Some(&Value::Bool(false)) || n == 0 {
            break;
        }
        start += n;
    }
    histories.sort_by(|a, b| text(a.get("created")).cmp(text(b.get("created"))));
    let mut deliveries: Vec<Value> = Vec::new();
    let mut returns: Vec<Value> = Vec::new();
    let mut reviewer_comments: Vec<Value> = Vec::new();
    let mut in_review = false;
    for h in &histories {
        for it in h.get("items").and_then(Value::as_array).cloned().unwrap_or_default() {
            if it.get("field").and_then(Value::as_str) != Some("status") {
                continue;
            }
            let to = text(it.get("toString"));
            let from = text(it.get("fromString"));
            if st.review_regex.is_match(to) {
                deliveries.push(h["created"].clone());
                in_review = true;
            } else {
                let author = h.get("author").filter(|a| truthy(Some(a)));
                let by_someone_else = !author.map_or(false, |a| a.get("accountId").cloned() == me_id);
                if in_review && st.review_regex.is_match(from) && st.back_from_review_regex.is_match(to) && by_someone_else {
                    returns.push(h["created"].clone());
                }
                in_review = false;
            }
        }
    }
    let comments = jira_get(&format!("/issue/{key}/comment?maxResults=100"), Some(project))?;
    let reviewer_id = sites::reviewer(Some(project)).get("id").cloned().filter(|v| truthy(Some(v)));
    for c in comments.get("comments").and_then(Value::as_array).cloned().unwrap_or_default() {
        if let Some(rid) = &reviewer_id {
            if c.get("author").filter(|a| truthy(Some(a))).and_then(|a| a.get("accountId")) == Some(rid) {
                reviewer_comments.push(c["created"].clone());
                save_note(key, text(c.get("created")), &crate::server::routes::tasks::adf_text(c.get("body")), true);
            }
        }
    }
    Ok(json!({ "deliveries": deliveries, "returns": returns, "reviewerComments": reviewer_comments }))
}

fn save_note(key: &str, at: &str, body: &str, mine: bool) {
    let body: String = body.trim().chars().take(4000).collect();
    if at.is_empty() || body.is_empty() {
        return;
    }
    with_db(|db| {
        let _ = db.execute("INSERT OR REPLACE INTO reviewer_notes VALUES (?, ?, ?, ?)", rusqlite::params![key, at, body, mine as i64]);
    });
}

fn read_others(project: &Project, days: i64) -> Result<usize, String> {
    let Some(reviewer) = sites::reviewer(Some(project)).get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from) else { return Ok(0) };
    let projects_jql = project.jira.as_ref().map(|j| j.projects_jql.clone()).unwrap_or_default();
    let me = sites::me(Some(project));
    let me_id = me.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let jql = encode_uri_component(&format!("{projects_jql} AND updated >= -{days}d AND (assignee != \"{me_id}\" OR assignee is EMPTY) ORDER BY updated DESC"));
    let mut token = String::new();
    let mut keys: Vec<String> = Vec::new();
    loop {
        let next = if token.is_empty() { String::new() } else { format!("&nextPageToken={}", encode_uri_component(&token)) };
        let b = jira_get(&format!("/search/jql?jql={jql}&fields=summary&maxResults=100{next}"), Some(project))?;
        keys.extend(b.get("issues").and_then(Value::as_array).into_iter().flatten().map(|i| text(i.get("key")).to_string()));
        token = if truthy(b.get("isLast")) { String::new() } else { b.get("nextPageToken").and_then(Value::as_str).unwrap_or("").to_string() };
        if token.is_empty() || keys.len() >= 400 {
            break;
        }
    }
    let mut saved = 0;
    for key in &keys {
        let Ok(comments) = jira_get(&format!("/issue/{key}/comment?maxResults=100"), Some(project)) else { continue };
        for c in comments.get("comments").and_then(Value::as_array).cloned().unwrap_or_default() {
            if c.get("author").and_then(|a| a.get("accountId")).and_then(Value::as_str) == Some(reviewer.as_str()) {
                save_note(key, text(c.get("created")), &crate::server::routes::tasks::adf_text(c.get("body")), false);
                saved += 1;
            }
        }
    }
    Ok(saved)
}

pub fn read_jira() -> Result<usize, String> {
    table();
    let previous = load().get("learningRead").filter(|v| truthy(Some(v))).cloned();
    let days = match previous.as_ref().and_then(|p| p.get("at")).and_then(Value::as_str).and_then(crate::core::time::parse) {
        Some(at) => (((crate::core::time::now_ms() - at) as f64 / DAY as f64).ceil() as i64 + 1).max(2),
        None if previous.is_some() => 2,
        None => 300,
    };
    let mut issues: Vec<(Value, Project)> = Vec::new();
    let mut failures = 0usize;
    for project in sites::jira_projects() {
        let projects_jql = project.jira.as_ref().map(|j| j.projects_jql.clone()).unwrap_or_default();
        let me = sites::me(Some(&project));
        let me_id = me.get("id").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(v))).unwrap_or_default();
        let jql = encode_uri_component(&format!("{projects_jql} AND assignee was \"{me_id}\" AND updated >= -{days}d ORDER BY updated DESC"));
        let mut token = String::new();
        let read: Result<(), String> = (|| {
            loop {
                let next = if token.is_empty() { String::new() } else { format!("&nextPageToken={}", encode_uri_component(&token)) };
                let b = jira_get(&format!("/search/jql?jql={jql}&fields=parent&maxResults=100{next}"), Some(&project))?;
                for i in b.get("issues").and_then(Value::as_array).cloned().unwrap_or_default() {
                    issues.push((i, project.clone()));
                }
                token = if truthy(b.get("isLast")) { String::new() } else { b.get("nextPageToken").and_then(Value::as_str).unwrap_or("").to_string() };
                if token.is_empty() {
                    return Ok(());
                }
            }
        })();
        if read.is_err() {
            failures += 1;
        }
    }
    for (i, project) in &issues {
        let key = text(i.get("key")).to_string();
        let p = i.get("fields").and_then(|f| f.get("parent")).filter(|v| truthy(Some(v)));
        let epic = p.and_then(|p| p.get("key")).and_then(Value::as_str).map(str::to_string);
        let epic_name = p.and_then(|p| p.get("fields")).filter(|v| truthy(Some(v))).and_then(|f| f.get("summary")).and_then(Value::as_str).map(str::to_string);
        match events_of(&key, project) {
            Ok(ev) => {
                let stored = with_db(|db| db.execute("INSERT OR REPLACE INTO learning_tickets VALUES (?, ?, ?, ?)", rusqlite::params![key, epic, epic_name, crate::core::json::stringify(&ev)]).is_ok());
                if !stored {
                    failures += 1;
                }
            }
            Err(_) => failures += 1,
        }
    }
    for project in sites::jira_projects() {
        if read_others(&project, days.min(30)).is_err() {
            failures += 1;
        }
    }
    let count = issues.len();
    mutate(|d| {
        d.insert("learningRead".into(), json!({ "at": crate::core::time::now(), "tickets": count, "failures": failures }));
    });
    Ok(count)
}

pub fn start_reading() -> bool {
    if READING.swap(true, Ordering::SeqCst) {
        return false;
    }
    let Ok(exe) = crate::core::platform::self_exe() else {
        READING.store(false, Ordering::SeqCst);
        return true;
    };
    let mut cmd = crate::core::platform::cmd(exe);
    cmd.arg("learning-read").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    match cmd.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
                READING.store(false, Ordering::SeqCst);
            });
        }
        Err(_) => READING.store(false, Ordering::SeqCst),
    }
    true
}

fn monday_of(iso: &str) -> String {
    let ms = crate::core::time::parse(iso).unwrap_or(0);
    let day = crate::core::time::madrid(ms).day;
    let Ok(date) = chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d") else { return day };
    use chrono::Datelike;
    let monday = date - chrono::Duration::days(date.weekday().num_days_from_monday() as i64);
    monday.format("%Y-%m-%d").to_string()
}

struct Domain {
    title: String,
    since: String,
    keys: Vec<String>,
}

static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^# (.+)$").unwrap());
static HISTORY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^## (?:Historial|History)\s*$").unwrap());
static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"20\d\d-\d\d-\d\d").unwrap());

fn domains() -> Vec<Domain> {
    let mut out = Vec::new();
    let Some(dir) = crate::core::config::main_project().context_domains.clone() else { return out };
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };
    let mut files: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| f.ends_with(".md") && !f.starts_with('_')).collect();
    files.sort();
    let projects = sites::jira_projects();
    for f in files {
        let Ok(text) = std::fs::read_to_string(dir.join(&f)) else { continue };
        let title = TITLE.captures(&text).map(|c| c[1].to_string()).unwrap_or_else(|| f.clone()).trim().to_string();
        let marks: Vec<regex::Match> = HISTORY.find_iter(&text).collect();
        let history = match marks.first() {
            Some(m) => &text[m.end()..marks.get(1).map_or(text.len(), |n| n.start())],
            None => "",
        };
        let mut dates: Vec<&str> = DATE.find_iter(history).map(|m| m.as_str()).collect();
        let mut keys: Vec<String> = Vec::new();
        for p in &projects {
            if let Some(re) = p.key_regex_global() {
                for m in re.find_iter(history) {
                    if !keys.iter().any(|k| k == m.as_str()) {
                        keys.push(m.as_str().to_string());
                    }
                }
            }
        }
        if !dates.is_empty() {
            dates.sort();
            out.push(Domain { title, since: dates[0].to_string(), keys });
        }
    }
    out
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default()
}

pub fn learning_summary() -> Value {
    table();
    let rows: Vec<(String, Option<String>, Value)> = with_db(|db| {
        let Ok(mut stmt) = db.prepare("SELECT key, epic, epic_name, events FROM learning_tickets") else { return Vec::new() };
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(3)?)))
            .map(|it| it.filter_map(Result::ok).map(|(k, e, ev)| (k, e, crate::core::json::parse(&ev).unwrap_or(Value::Null))).collect())
            .unwrap_or_default()
    });
    let now = crate::core::time::now_ms();
    let since = crate::core::time::iso(now - WEEKS * 7 * DAY);
    let mut weeks: Map<String, Value> = Map::new();
    let bump = |weeks: &mut Map<String, Value>, monday: String, field: &str| {
        let w = weeks.entry(monday).or_insert_with(|| json!({ "deliveries": 0, "returns": 0, "repeated": 0, "reviewerComments": 0, "written": 0, "new": 0 }));
        let n = w[field].as_i64().unwrap_or(0) + 1;
        w[field] = json!(n);
    };
    for (_, _, ev) in &rows {
        for at in strings(ev.get("deliveries")) {
            if at >= since {
                bump(&mut weeks, monday_of(&at), "deliveries");
            }
        }
        for (i, at) in strings(ev.get("returns")).into_iter().enumerate() {
            if at < since {
                continue;
            }
            bump(&mut weeks, monday_of(&at), "returns");
            if i >= 1 {
                bump(&mut weeks, monday_of(&at), "repeated");
            }
        }
        for at in strings(ev.get("reviewerComments")) {
            if at >= since {
                bump(&mut weeks, monday_of(&at), "reviewerComments");
            }
        }
    }
    let doc = load();
    let causes = doc.get("causes").and_then(Value::as_array).cloned().unwrap_or_default();
    for c in &causes {
        let at = text(c.get("at")).to_string();
        let cause = text(c.get("cause"));
        if at >= since && (cause == "written" || cause == "new") {
            bump(&mut weeks, monday_of(&at), cause);
        }
    }
    let all_domains = domains();
    let cut1 = crate::core::time::iso(now - 28 * DAY);
    let cut2 = crate::core::time::iso(now - 56 * DAY);
    let routes = crate::sessions::registry::load_routes();
    let mut areas: Vec<(i64, Value)> = Vec::new();
    for (id, a) in routes.get("areas").and_then(Value::as_object).cloned().unwrap_or_default() {
        let epics: Vec<String> = a.get("epics").and_then(Value::as_object).map(|e| e.keys().cloned().collect()).unwrap_or_default();
        if epics.is_empty() {
            continue;
        }
        let own: Vec<&(String, Option<String>, Value)> = rows.iter().filter(|(_, e, _)| e.as_ref().map_or(false, |e| epics.contains(e))).collect();
        let keys: Vec<&String> = own.iter().map(|(k, _, _)| k).collect();
        let own_domains: Vec<&Domain> = all_domains.iter().filter(|dm| dm.keys.iter().any(|k| keys.contains(&k))).collect();
        let context_since = own_domains.iter().map(|dm| dm.since.clone()).min();
        let mut recent = [0i64; 2];
        let mut previous = [0i64; 2];
        let mut before = [0i64; 2];
        for (_, _, ev) in &own {
            for (idx, field) in ["deliveries", "returns"].iter().enumerate() {
                for at in strings(ev.get(*field)) {
                    if at >= cut1 {
                        recent[idx] += 1;
                    } else if at >= cut2 {
                        previous[idx] += 1;
                    }
                    if let Some(cs) = &context_since {
                        if at.get(0..10).unwrap_or(&at) < cs.as_str() {
                            before[idx] += 1;
                        }
                    }
                }
            }
        }
        if recent[0] + previous[0] + before[0] <= 0 {
            continue;
        }
        let span = |x: [i64; 2]| json!({ "deliveries": x[0], "returns": x[1] });
        let name = a.get("title").filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| Value::from(id.clone()));
        areas.push((
            recent[0] + previous[0],
            json!({ "id": id, "name": name, "domains": own_domains.iter().map(|dm| dm.title.clone()).collect::<Vec<_>>(), "contextSince": context_since, "before": span(before), "previous": span(previous), "recent": span(recent) }),
        ));
    }
    areas.sort_by(|a, b| b.0.cmp(&a.0));
    let mut week_list: Vec<Value> = weeks
        .into_iter()
        .map(|(monday, x)| {
            let mut m = Map::new();
            m.insert("monday".into(), Value::from(monday));
            if let Value::Object(o) = x {
                m.extend(o);
            }
            Value::Object(m)
        })
        .collect();
    week_list.sort_by(|a, b| text(b.get("monday")).cmp(text(a.get("monday"))));
    json!({
        "read": load().get("learningRead").filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null),
        "reading": READING.load(Ordering::SeqCst),
        "weeks": week_list,
        "areas": areas.into_iter().map(|(_, a)| a).collect::<Vec<_>>(),
        "recentCauses": causes.iter().take(12).cloned().collect::<Vec<_>>(),
        "reviewerNotes": reviewer_notes(&rows),
    })
}

fn reviewer_notes(rows: &[(String, Option<String>, Value)]) -> Value {
    let notes: Vec<(String, String, String, bool)> = with_db(|db| {
        let Ok(mut stmt) = db.prepare("SELECT key, at, text, mine FROM reviewer_notes ORDER BY at DESC LIMIT 80") else { return Vec::new() };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0))).map(|it| it.filter_map(Result::ok).collect()).unwrap_or_default()
    });
    let returns_of = |key: &str| rows.iter().find(|(k, _, _)| k == key).map(|(_, _, ev)| strings(ev.get("returns"))).unwrap_or_default();
    let causes = load().get("causes").and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(notes.into_iter().map(|(key, at, body, mine)| {
        let t = crate::core::time::parse(&at).unwrap_or(0);
        let returned = returns_of(&key).iter().filter_map(|r| crate::core::time::parse(r)).any(|r| (r - t).abs() <= 3 * 3600 * 1000);
        let cause = causes.iter().find(|c| text(c.get("key")) == key && text(c.get("at")) >= at.as_str()).map(|c| json!({ "cause": c.get("cause"), "note": c.get("note") })).unwrap_or(Value::Null);
        json!({ "key": key, "at": at, "text": body, "mine": mine, "returned": returned, "cause": cause })
    }).collect())
}

pub fn save_cause(key: &str, cause: &str, note: Option<&str>) -> bool {
    mutate(|d| {
        let t = d.get("tasks").and_then(|t| t.get(key)).filter(|t| truthy(Some(t))).cloned();
        let area = t.as_ref().and_then(|t| t.get("area")).filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
        let mut entry = Map::new();
        entry.insert("key".into(), Value::from(key));
        entry.insert("cause".into(), Value::from(cause));
        if let Some(n) = note {
            entry.insert("note".into(), Value::from(n));
        }
        entry.insert("area".into(), area);
        entry.insert("at".into(), Value::from(crate::core::time::now()));
        let mut list = vec![Value::Object(entry)];
        list.extend(d.get("causes").and_then(Value::as_array).cloned().unwrap_or_default());
        list.truncate(500);
        d.insert("causes".into(), Value::Array(list));
        t.is_some()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cause_is_saved_first_with_the_area_of_its_task() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("tasks".into(), json!({ "WEB-1": { "key": "WEB-1", "area": "pagos" } }));
        });
        assert!(save_cause("WEB-1", "written", Some("nota")));
        assert!(!save_cause("WEB-9", "new", None));
        let causes = load()["causes"].clone();
        assert_eq!(causes[0]["key"], "WEB-9");
        assert_eq!(causes[0]["area"], Value::Null);
        assert!(causes[0].get("note").is_none());
        assert_eq!(causes[1]["area"], "pagos");
        assert_eq!(causes[1]["note"], "nota");
    }

    #[test]
    fn weeks_start_on_monday_in_madrid() {
        assert_eq!(monday_of("2026-11-15T23:30:00.000Z"), "2026-11-16");
        assert_eq!(monday_of("2026-11-12T10:00:00.000Z"), "2026-11-09");
    }
}

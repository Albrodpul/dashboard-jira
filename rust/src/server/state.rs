//! Port of src/server/state.js.
use crate::core::config::{self, main_project};
use crate::core::data::{BASE_URL, BOARD_HEARTBEAT, Doc, is_empty_report, is_uuid, load};
use crate::core::json::truthy;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

fn me_name() -> String {
    main_project().jira.as_ref().and_then(|j| j.me.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

pub static ERRORS_AREA: LazyLock<Option<String>> = LazyLock::new(|| main_project().errors_area.clone());

pub const MESSAGE_TARGETS: [(&str, &str); 3] = [("reporter", "la sesión de reporte"), ("orchestrator", "la orquestadora"), ("board", "la sesión del tablero")];

pub static ORCHESTRATOR_NOTICE: LazyLock<String> = LazyLock::new(|| {
    format!(
        "Aviso del tablero: arranca la orquestadora. Eres la sesión orquestadora registrada: lee ahora .claude/commands/orquesta.md (regla de AGENTS.md). No vigilas nada ni armas ningún Monitor: el tablero entrega solo. Quédate a la espera de lo que te pida {}.",
        me_name()
    )
});

pub fn message_target(to: &str) -> Option<&'static str> {
    MESSAGE_TARGETS.iter().find(|(k, _)| *k == to).map(|(_, v)| *v)
}

fn heartbeat_age(file: &std::path::Path) -> f64 {
    std::fs::metadata(file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| crate::core::time::now_ms() as f64 - d.as_millis() as f64)
        .unwrap_or(f64::INFINITY)
}

fn text_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str()).filter(|s| !s.is_empty())
}

fn or_null(v: Option<&Value>) -> Value {
    match v {
        Some(x) if truthy(Some(x)) => x.clone(),
        _ => Value::Null,
    }
}

fn session_list(d: &Doc) -> Vec<Value> {
    d.get("sessions").and_then(|s| s.get("list")).and_then(|l| l.as_array()).cloned().unwrap_or_default()
}

fn live_of(d: &Doc, role: &Value) -> Option<Value> {
    let list = session_list(d);
    match text_of(role, "conversation") {
        Some(c) => list.into_iter().find(|s| s.get("conversation").and_then(|x| x.as_str()) == Some(c)),
        None => {
            let name = role.get("session").cloned().unwrap_or(Value::Null);
            list.into_iter().find(|s| s.get("name").cloned().unwrap_or(Value::Null) == name && !name.is_null())
        }
    }
}

fn has_role(o: Option<&Value>) -> Option<&Value> {
    let o = o.filter(|o| truthy(Some(o)))?;
    if truthy(o.get("conversation")) || truthy(o.get("session")) { Some(o) } else { None }
}

pub fn is_paused(d: &Doc) -> bool {
    d.get("config").map_or(false, |c| truthy(c.get("paused")))
}

fn live_name(live: &Option<Value>, o: &Value) -> Value {
    match live {
        Some(l) => l.get("name").cloned().unwrap_or(Value::Null),
        None => or_null(o.get("session")),
    }
}

fn orchestrator(d: &Doc, r: &Value) -> Value {
    let Some(o) = has_role(r.get("orchestrator")) else { return Value::Null };
    let live = live_of(d, o);
    let refs = d.get("refs").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    json!({
        "title": text_of(o, "title").unwrap_or("Orquestar agentes"),
        "session": live_name(&live, o),
        "conversation": or_null(o.get("conversation")),
        "ref": if live.is_some() { crate::sessions::registry::current_ref(&refs, live.as_ref()) } else { Value::Null },
        "open": live.is_some(),
        "since": or_null(o.get("since")),
    })
}

fn reporter(d: &Doc, r: &Value) -> Value {
    let Some(o) = has_role(r.get("reporter")) else { return Value::Null };
    let live = live_of(d, o);
    json!({ "session": live_name(&live, o), "conversation": or_null(o.get("conversation")), "open": live.is_some(), "watching": live.is_some(), "paused": is_paused(d) })
}

fn board_status(d: &Doc, r: &Value) -> Value {
    let Some(o) = has_role(r.get("board")) else { return Value::Null };
    let live = live_of(d, o);
    json!({
        "title": text_of(o, "title").unwrap_or("Tablero"),
        "session": live_name(&live, o),
        "conversation": or_null(o.get("conversation")),
        "open": live.is_some(),
        "watching": live.is_some() && heartbeat_age(&BOARD_HEARTBEAT) < 60000.0,
    })
}

pub fn talk_target(s: &Value, to: &str) -> Value {
    let key = match to {
        "reporter" => "reporterStatus",
        "orchestrator" => "orchestrator",
        "board" => "boardStatus",
        _ => return Value::Null,
    };
    or_null(s.get(key))
}

fn follow_up_status(d: &Doc, r: &Value) -> Value {
    let Some(o) = r.get("followUp").filter(|o| truthy(Some(o))) else { return Value::Null };
    let Some(conversation) = text_of(o, "conversation") else { return Value::Null };
    let live = session_list(d).into_iter().find(|s| s.get("conversation").and_then(|x| x.as_str()) == Some(conversation));
    let request = match d.get("followUpRequest") {
        Some(req) if truthy(Some(req)) && !truthy(req.get("handled")) => req.clone(),
        _ => Value::Null,
    };
    let envs = crate::features::follow_up::environments(d);
    let last = d.get("followUps").and_then(|f| f.get(0)).map(|f| or_null(f.get("at"))).unwrap_or(Value::Null);
    json!({
        "title": text_of(o, "title").unwrap_or("Seguimiento"),
        "session": live.as_ref().and_then(|l| l.get("name").cloned()).unwrap_or(Value::Null),
        "conversation": conversation,
        "open": live.is_some(),
        "last": last,
        "environments": envs.clone(),
        "due": crate::features::followup_schedule::pending(d, &envs),
        "request": request,
        "paused": is_paused(d),
    })
}

pub fn deployer_area(r: &Value) -> Option<String> {
    static DEPLOY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)subir|desplieg|deploy").unwrap());
    let empty = Map::new();
    let areas = r.get("areas").and_then(|a| a.as_object()).unwrap_or(&empty);
    if let Some(dep) = text_of(r, "deployer") {
        if areas.get(dep).map_or(false, |a| truthy(Some(a))) {
            return Some(dep.to_string());
        }
    }
    areas.iter().find(|(_, a)| DEPLOY.is_match(text_of(a, "title").unwrap_or(""))).map(|(k, _)| k.clone())
}

pub fn tidy_of(d: &Doc, project_id: Option<&str>) -> Value {
    let main = project_id.map_or(true, |p| p.is_empty() || p == main_project().id);
    if main {
        or_null(d.get("contextTidy"))
    } else {
        or_null(d.get("contextTidies").and_then(|t| t.get(project_id.unwrap())))
    }
}

pub fn tidy_blockers(d: &Doc, project_id: Option<&str>) -> Vec<String> {
    let main_id = main_project().id.clone();
    let pid = project_id.filter(|p| !p.is_empty()).map(|p| p.to_string()).unwrap_or(main_id);
    let label = |s: &str| -> Option<&'static str> {
        match s {
            "pending" => Some("en Pendientes"),
            "approved" => Some("por enviar"),
            "sent" => Some("en Enviadas"),
            "waiting" => Some("esperándote"),
            "partial" => Some("a medias"),
            _ => None,
        }
    };
    let mut count: Vec<(String, usize)> = Vec::new();
    if let Some(tasks) = d.get("tasks").and_then(|t| t.as_object()) {
        for t in tasks.values() {
            let status = t.get("status").and_then(|s| s.as_str()).unwrap_or("");
            if label(status).is_none() || (status == "sent" && truthy(t.get("manual"))) || crate::core::projects::project_of(t) != pid {
                continue;
            }
            match count.iter_mut().find(|(s, _)| s == status) {
                Some(entry) => entry.1 += 1,
                None => count.push((status.to_string(), 1)),
            }
        }
    }
    let mut out: Vec<String> = count.iter().map(|(s, n)| format!("{n} tarea{} {}", if *n == 1 { "" } else { "s" }, label(s).unwrap())).collect();
    let o = tidy_of(d, Some(&pid));
    if matches!(o.get("status").and_then(|s| s.as_str()), Some("approved") | Some("in-progress")) {
        out.push("ya hay una ordenación en marcha".to_string());
    }
    out
}

pub fn last_context_pass(project_id: Option<&str>) -> Option<String> {
    static PASS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Última pasada de `/ordena-contexto`: (\d{4}-\d{2}-\d{2})").unwrap());
    let main = main_project();
    let id = project_id.filter(|p| !p.is_empty()).unwrap_or(&main.id);
    let p = config::project(id).unwrap_or_else(|| main.clone());
    if let Some(root) = &p.root {
        if let Ok(text) = std::fs::read_to_string(root.join("AGENTS.md")) {
            if let Some(m) = PASS.captures(&text) {
                return Some(m[1].to_string());
            }
        }
    }
    if p.id == main.id {
        return None;
    }
    let o = tidy_of(&load(), Some(&p.id));
    o.get("finishedAt").and_then(|f| f.as_str()).filter(|f| !f.is_empty()).map(|f| f.chars().take(10).collect())
}

fn tidy_states(d: &Doc) -> Value {
    let main_id = main_project().id.clone();
    let mut out = Map::new();
    for p in config::projects() {
        if p.id != main_id && p.context_tidy && p.root.is_some() {
            out.insert(p.id.clone(), json!({ "contextTidy": tidy_of(d, Some(&p.id)), "blockers": tidy_blockers(d, Some(&p.id)), "lastPass": last_context_pass(Some(&p.id)) }));
        }
    }
    Value::Object(out)
}

pub fn follow_up_errors(d: &Doc) -> Vec<Value> {
    let mut out = Vec::new();
    for r in d.get("followUps").and_then(|f| f.as_array()).into_iter().flatten() {
        for e in r.get("errors").and_then(|e| e.as_array()).into_iter().flatten() {
            let mut m = e.as_object().cloned().unwrap_or_default();
            match r.get("at") {
                Some(at) => {
                    m.insert("summaryAt".to_string(), at.clone());
                }
                None => {
                    m.remove("summaryAt");
                }
            }
            out.push(Value::Object(m));
        }
    }
    out
}

fn task_progress(d: &Doc, r: &Value) -> Value {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let areas = r.get("areas").cloned().unwrap_or(json!({}));
        let tasks: Vec<Value> = d.get("tasks").and_then(|t| t.as_object()).map(|t| t.values().cloned().collect()).unwrap_or_default();
        let conversation_of = |area: &str| areas.get(area).and_then(|a| text_of(a, "conversation")).map(|s| s.to_string());
        crate::features::progress::for_tasks(&tasks, &conversation_of, &|c: &str| crate::sessions::registry::transcript_of(c))
    }))
    .unwrap_or_else(|_| json!({}))
}

fn slice(v: Option<&Value>, n: usize) -> Vec<Value> {
    v.and_then(|x| x.as_array()).map(|a| a.iter().take(n).cloned().collect()).unwrap_or_default()
}

pub fn state() -> Value {
    let mut d = load();
    if let Some(mut live) = crate::sessions::registry::live_sessions() {
        crate::sessions::registry::reconcile(&live);
        let refs = d.get("refs").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
        for v in live.iter_mut() {
            let r = crate::sessions::registry::current_ref(&refs, Some(v));
            if let Some(m) = v.as_object_mut() {
                m.insert("ref".to_string(), r);
            }
        }
        d.insert("sessions".to_string(), json!({ "list": live, "syncedAt": crate::core::time::now() }));
    }
    let r = crate::sessions::registry::load_routes();
    let areas = crate::sessions::registry::targets(&d, &r);
    let mut epics = Map::new();
    if let Some(seen) = d.get("seenEpics").and_then(|s| s.as_object()) {
        for (key, e) in seen {
            epics.insert(key.clone(), json!({ "key": key, "name": e.get("name").cloned().unwrap_or(Value::Null), "seenAt": e.get("seenAt").cloned().unwrap_or(Value::Null), "area": null }));
        }
    }
    for a in &areas {
        if let Some(es) = a.get("epics").and_then(|e| e.as_object()) {
            for (key, name) in es {
                let seen_at = epics.get(key).map(|e| or_null(e.get("seenAt"))).unwrap_or(Value::Null);
                epics.insert(key.clone(), json!({ "key": key, "name": name, "seenAt": seen_at, "area": a.get("id").cloned().unwrap_or(Value::Null) }));
            }
        }
    }
    let mut area_of_epic = Map::new();
    for a in &areas {
        if let Some(es) = a.get("epics").and_then(|e| e.as_object()) {
            for k in es.keys() {
                area_of_epic.insert(k.clone(), a.get("id").cloned().unwrap_or(Value::Null));
            }
        }
    }
    let all_epics: Vec<Value> = d
        .get("jiraEpics")
        .and_then(|e| e.as_array())
        .into_iter()
        .flatten()
        .filter(|e| {
            let key = e.get("key").and_then(|k| k.as_str()).unwrap_or("");
            let project = match text_of(e, "project") {
                Some(pid) => crate::jira::sites::project_of(crate::jira::sites::ProjectRef::Id(pid)),
                None => crate::jira::sites::for_key(key),
            };
            let status = e.get("status").and_then(|s| s.as_str()).unwrap_or("undefined");
            !crate::jira::sites::statuses(Some(&project)).closed_regex.is_match(status)
        })
        .map(|e| {
            let key = e.get("key").cloned().unwrap_or(Value::Null);
            let area = key.as_str().and_then(|k| area_of_epic.get(k)).map(|a| or_null(Some(a))).unwrap_or(Value::Null);
            json!({ "key": key, "name": e.get("name").cloned().unwrap_or(Value::Null), "area": area })
        })
        .collect();
    let tasks: Vec<Value> = d
        .get("tasks")
        .and_then(|t| t.as_object())
        .map(|t| {
            t.values()
                .map(|t| {
                    if truthy(t.get("project")) {
                        t.clone()
                    } else {
                        let mut m = t.as_object().cloned().unwrap_or_default();
                        m.insert("project".to_string(), Value::String(crate::core::projects::project_of(t)));
                        Value::Object(m)
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let follow_ups: Vec<Value> = slice(d.get("followUps"), 80)
        .into_iter()
        .map(|x| {
            let env = crate::features::follow_up::environment_of(&x, &d);
            let mut m = x.as_object().cloned().unwrap_or_default();
            m.insert("environment".to_string(), Value::String(env));
            Value::Object(m)
        })
        .collect();
    let hosted = crate::sessions::host::read_config();
    let overrides = d.get("sessionOverrides").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    let mut conv_profiles = Map::new();
    for e in &hosted {
        let conv = match e.get("conversation") {
            Some(Value::String(s)) => s.clone(),
            Some(other) => crate::core::json::stringify(other),
            None => "undefined".to_string(),
        };
        conv_profiles.insert(conv.clone(), crate::sessions::profiles::profile_for(&conv, Some(&overrides)));
    }
    let reports: Vec<Value> = d
        .get("reports")
        .and_then(|r| r.as_array())
        .into_iter()
        .flatten()
        .filter(|x| !is_empty_report(x.get("text").and_then(|t| t.as_str()).unwrap_or("")))
        .take(10)
        .cloned()
        .collect();
    let mut out = Map::new();
    let mut put = |k: &str, v: Value| {
        out.insert(k.to_string(), v);
    };
    put("allEpics", Value::Array(all_epics));
    put("areas", Value::Array(areas.clone()));
    put("tasks", Value::Array(tasks));
    put("sessions", d.get("sessions").cloned().unwrap_or(Value::Null));
    put("aliases", d.get("aliases").cloned().unwrap_or(Value::Null));
    put("reporterRoute", or_null(r.get("reporter")));
    put("orchestrator", orchestrator(&d, &r));
    put("reporterStatus", reporter(&d, &r));
    put("boardStatus", board_status(&d, &r));
    put("followUps", Value::Array(follow_ups));
    put("permissions", crate::sessions::permissions::for_page(&d));
    put("contextSync", or_null(d.get("contextSync")));
    put("github", crate::features::github::for_page(Some(&d)));
    put("progress", task_progress(&d, &r));
    put("progressPhases", crate::features::progress::phases_json());
    put("daily", crate::features::daily::daily_state(None));
    put("dailies", crate::features::daily::daily_states());
    put("sessionProfiles", crate::sessions::profiles::profiles());
    put("cluster", crate::cluster::cluster::info());
    put("hosted", Value::Array(hosted));
    put("stuckDialogs", Value::Array(crate::features::stuck::list()));
    put("watchdog", crate::features::watchdog::for_page(&d));
    put("convProfiles", Value::Object(conv_profiles));
    put(
        "sentry",
        json!({ "enabled": crate::features::sentry::sentry_available(), "errorsArea": ERRORS_AREA.clone(), "errorsAreas": crate::features::sentry::errors_areas(), "sends": crate::features::sentry::sentry_issues(&d) }),
    );
    put("people", crate::features::follow_up::people(&d));
    put("followUpStatus", follow_up_status(&d, &r));
    put("epics", Value::Array(epics.into_iter().map(|(_, v)| v).collect()));
    put("reports", Value::Array(reports));
    put("lastReview", or_null(d.get("lastReview")));
    put("config", d.get("config").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({})));
    put("contextTidy", or_null(d.get("contextTidy")));
    put("messages", Value::Array(slice(d.get("messages"), 30)));
    put("tidyBlockers", json!(tidy_blockers(&d, None)));
    put("lastContextPass", json!(last_context_pass(None)));
    put("tidies", tidy_states(&d));
    put("reminders", crate::features::reminders::for_page(&d));
    if let Some(rr) = d.get("refreshRequest") {
        put("refreshRequest", rr.clone());
    }
    put("deployments", Value::Array(slice(d.get("deployments"), 12)));
    put("restrictions", crate::features::holds::for_page(&d, None));
    put("mailman", crate::features::mailman::status(&d));
    put("deployerArea", json!(deployer_area(&r)));
    put("quota", crate::features::quota::read_quota().unwrap_or(Value::Null));
    if let Some(expires) = crate::features::claude_token::token_status().get("expires") {
        put("claudeTokenExpires", expires.clone());
    }
    put("workHours", Value::Bool(crate::core::hours::work_hours(None)));
    put("workSchedule", crate::core::hours::schedule());
    put("jiraSetup", config::for_page());
    Value::Object(out)
}

pub fn open_if_closed(area_id: &str, areas: Option<&Value>) -> bool {
    let owned;
    let areas = match areas {
        Some(a) => a,
        None => {
            owned = state().get("areas").cloned().unwrap_or(json!([]));
            &owned
        }
    };
    let target = areas.as_array().and_then(|a| a.iter().find(|x| x.get("id").and_then(|i| i.as_str()) == Some(area_id)));
    if let Some(t) = target {
        let conversation = t.get("conversation").and_then(|c| c.as_str()).unwrap_or("");
        if !truthy(t.get("open")) && is_uuid(conversation) {
            crate::sessions::registry::open_in_vs_code(Some(conversation));
            return true;
        }
    }
    false
}

pub fn message_notice(id: &str) -> String {
    let cli = config::cli();
    format!(
        "Mensaje de {} desde el tablero ({id}). Léelo con «{cli} message {id}» y contéstale con «{cli} answer-message {id} \"<respuesta>\"». Si te lleva más de un minuto, ve contándole en qué estás con «{cli} progress {id} \"<en qué estás>\"». Vale como si lo hubiera escrito él en esta sesión (regla de AGENTS.md).",
        me_name()
    )
}

fn session_text(e: &Value) -> String {
    match e.get("session") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".to_string(),
        None => "undefined".to_string(),
        Some(other) => crate::core::json::stringify(other),
    }
}

pub fn wake_reporter(notice: &str) -> bool {
    if !crate::cluster::cluster::is_primary() {
        return false;
    }
    let reporter_status = || state().get("reporterStatus").cloned().unwrap_or(Value::Null);
    let mut e = reporter_status();
    let conversation = e.get("conversation").and_then(|c| c.as_str()).unwrap_or("").to_string();
    if e.is_null() || !is_uuid(&conversation) {
        return false;
    }
    if !truthy(e.get("open")) {
        crate::sessions::registry::open_in_vs_code(Some(&conversation));
        let mut i = 0;
        while i < 24 {
            e = reporter_status();
            if truthy(e.get("open")) {
                break;
            }
            wait(5000);
            i += 1;
        }
        if !truthy(e.get("open")) {
            return false;
        }
        wait(8000);
    }
    crate::sessions::registry::wake_session(&session_text(&e), Some(notice))
}

pub fn ping() -> bool {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    match agent.get(&format!("{}/api/state", *BASE_URL)).call() {
        Ok(r) => r.status().as_u16() == 200,
        Err(_) => false,
    }
}

pub fn wait(ms: u64) {
    crate::core::data::pause(ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::data::mutate;

    #[test]
    fn ordering_a_projects_context_waits_for_its_own_tasks() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("tasks".to_string(), json!({ "SIDE-2": { "key": "SIDE-2", "title": "x", "project": "side", "status": "pending" } }));
        });
        assert_eq!(tidy_blockers(&load(), Some("side")), vec!["1 tarea en Pendientes".to_string()]);
        assert_eq!(tidy_blockers(&load(), Some(&main_project().id)), Vec::<String>::new());
    }

    #[test]
    fn the_deployer_area_is_the_configured_one_or_the_one_named_after_deploying() {
        assert_eq!(deployer_area(&json!({ "deployer": "ops", "areas": { "ops": { "title": "Ops" } } })), Some("ops".to_string()));
        assert_eq!(deployer_area(&json!({ "deployer": "gone", "areas": { "pay": { "title": "Pagos" }, "up": { "title": "Subir a producción" } } })), Some("up".to_string()));
        assert_eq!(deployer_area(&json!({ "areas": { "pay": { "title": "Pagos" } } })), None);
    }

    #[test]
    fn talking_to_a_role_picks_its_status() {
        let s = json!({ "reporterStatus": { "session": "r" }, "orchestrator": null, "boardStatus": { "session": "b" } });
        assert_eq!(talk_target(&s, "board")["session"], "b");
        assert_eq!(talk_target(&s, "orchestrator"), Value::Null);
        assert_eq!(talk_target(&s, "nobody"), Value::Null);
    }

    #[test]
    fn follow_up_errors_carry_the_time_of_their_summary() {
        let mut d = Doc::new();
        d.insert("followUps".to_string(), json!([{ "at": "2026-11-20T10:00:00.000Z", "errors": [{ "id": "e1" }] }, { "errors": [{ "id": "e2" }] }]));
        let out = follow_up_errors(&d);
        assert_eq!(crate::core::json::stringify(&json!(out)), r#"[{"id":"e1","summaryAt":"2026-11-20T10:00:00.000Z"},{"id":"e2"}]"#);
    }
}

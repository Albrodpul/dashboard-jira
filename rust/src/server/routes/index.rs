//! Port of src/server/routes/index.js.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};

use super::tasks::{clip, error_res, is_true, js_string, obj, ok, str_of, text_or_empty};
use super::{operations, sessions, tasks};
use crate::cluster::cluster;
use crate::core::data::{DATA_DIR, load, now};
use crate::core::json::{stringify, stringify_pretty, truthy};
use crate::features::{devservers, mailman, sentry};
use crate::server::http::{PostHandler, Req, Res, decode_uri_component, send, serve_json};
use crate::sessions::{host, permissions};

static CONVERSATION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f-]{36}$").unwrap());
static HOUR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap());
static SYNCED_AT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""syncedAt":"[^"]*""#).unwrap());

pub fn post_route(url: &str) -> Option<PostHandler> {
    match url {
        "/api/claude-token/setup" => Some(claude_token_setup),
        "/api/cluster/claude-token" => Some(cluster_claude_token),
        "/api/task" => Some(tasks::handle_task),
        "/api/task/new" => Some(tasks::handle_new_task),
        "/api/projects-admin/save" => Some(projects_admin_save),
        "/api/projects-admin/remove" => Some(projects_admin_remove),
        "/api/projects-admin/credentials" => Some(projects_admin_credentials),
        "/api/projects-admin/connect-jira" => Some(projects_admin_connect_jira),
        "/api/batch" => Some(tasks::handle_batch),
        "/api/delete" => Some(tasks::handle_delete),
        "/api/answer" => Some(tasks::handle_answer),
        "/api/reviewed" => Some(tasks::handle_reviewed),
        "/api/reviewed-all" => Some(tasks::handle_reviewed_all),
        "/api/comment" => Some(tasks::handle_comment),
        "/api/config" => Some(tasks::handle_config),
        "/api/refresh" => Some(refresh),
        "/api/search" => Some(tasks::handle_search),
        "/api/import" => Some(tasks::handle_import),
        "/api/ticket" => Some(tasks::handle_ticket),
        "/api/session" => Some(sessions::handle_session),
        "/api/reminder" => Some(reminder),
        "/api/new-session" => Some(sessions::handle_new_session),
        "/api/epic" => Some(sessions::handle_epic),
        "/api/deploy" => Some(operations::handle_deploy),
        "/api/deploy-status/refresh" => Some(deploy_status_refresh),
        "/api/tidy" => Some(tidy),
        "/api/message" => Some(operations::handle_message),
        "/api/followup-error" => Some(operations::handle_follow_up_error),
        "/api/followup-request" => Some(operations::handle_follow_up_request),
        "/api/restriction" => Some(tasks::handle_restriction),
        "/api/delivery/retry" => Some(delivery_retry),
        "/api/people" => Some(people),
        "/api/layout-report" => Some(layout_report),
        "/api/term-claim" => Some(term_claim),
        "/api/page-errors" => Some(page_errors),
        "/api/audio-report" => Some(audio_report),
        "/api/sentry/send" => Some(sentry_send),
        "/api/daily" => Some(daily),
        "/api/cluster/yield" => Some(cluster_yield),
        "/api/cluster/take" => Some(cluster_take),
        "/api/watchdog/dismiss" => Some(watchdog_dismiss),
        "/api/cluster/auto" => Some(cluster_auto),
        "/api/cluster/command" => Some(cluster_command),
        "/api/host/respawned" => Some(host_respawned),
        "/api/session-profile" => Some(session_profile),
        "/api/host/action" => Some(host_action),
        "/api/permission/check" => Some(permission_check),
        "/api/permission/decide" => Some(permission_decide),
        "/api/host/prompt" => Some(host_prompt),
        "/api/host/stuck" => Some(host_stuck),
        "/api/permission/rule-remove" => Some(permission_rule_remove),
        "/api/mac-power" => Some(mac_power),
        "/api/work-hours" => Some(work_hours),
        "/api/overtime" => Some(overtime),
        "/api/devservers" => Some(devservers_action),
        "/api/tunnel" => Some(tunnel),
        "/api/sentry/status" => Some(sentry_status),
        "/api/sentry/discard" => Some(sentry_discard),
        "/api/learning-read" => Some(learning_read),
        "/api/push/subscribe" => Some(push_subscribe),
        "/api/push/unsubscribe" => Some(push_unsubscribe),
        "/api/push/test" => Some(push_test),
        "/api/push/prefs" => Some(push_prefs),
        _ => None,
    }
}

fn or_empty(input: &Value) -> Value {
    if truthy(Some(input)) { input.clone() } else { json!({}) }
}

fn opt_str<'a>(input: &'a Value, k: &str) -> Option<&'a str> {
    input.get(k).and_then(Value::as_str)
}

fn defined(input: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for k in keys {
        if let Some(v) = input.get(*k) {
            out.insert((*k).to_string(), v.clone());
        }
    }
    Value::Object(out)
}

fn status_by_error(r: Value) -> Res {
    send(if is_true(&r, "error") { 400 } else { 200 }, &r)
}

fn status_by_ok(r: Value) -> Res {
    send(if is_true(&r, "ok") { 200 } else { 409 }, &r)
}

fn claude_token_setup(input: &Value) -> Res {
    match crate::features::claude_token::handle_setup(input) {
        Ok(r) => send(200, &r),
        Err(e) => error_res(500, &e),
    }
}

fn cluster_claude_token(input: &Value) -> Res {
    match crate::features::claude_token::import_token(opt_str(input, "token").unwrap_or("")) {
        Ok(expires) => send(200, &json!({ "expires": expires })),
        Err(e) => error_res(400, &e),
    }
}

fn projects_admin_save(input: &Value) -> Res {
    status_by_error(crate::features::projects_admin::save(&or_empty(input)))
}

fn projects_admin_remove(input: &Value) -> Res {
    status_by_error(crate::features::projects_admin::remove(&text_or_empty(input.get("id"))))
}

fn projects_admin_credentials(input: &Value) -> Res {
    let values = input.get("values").map(or_empty).unwrap_or(json!({}));
    status_by_error(crate::features::projects_admin::set_credentials(&text_or_empty(input.get("id")), &values))
}

fn projects_admin_connect_jira(input: &Value) -> Res {
    let options = defined(input, &["sample", "reviewer"]);
    status_by_error(crate::features::projects_admin::connect_jira(&text_or_empty(input.get("id")), &options, None))
}

fn refresh(_input: &Value) -> Res {
    tasks::handle_refresh()
}

fn reminder(input: &Value) -> Res {
    if is_true(input, "remove") {
        let error = crate::features::reminders::remove(&js_string(input.get("remove")));
        return if error.is_empty() { ok() } else { error_res(400, &error) };
    }
    let r = if is_true(input, "id") { crate::features::reminders::update(&js_string(input.get("id")), input) } else { crate::features::reminders::add(&or_empty(input)) };
    match r {
        Ok(r) => send(200, &r),
        Err(error) => error_res(400, &error),
    }
}

fn deploy_status_refresh(_input: &Value) -> Res {
    crate::features::deploy_status::handle_deploy_status_refresh()
}

fn tidy(input: &Value) -> Res {
    operations::handle_tidy(&or_empty(input))
}

fn delivery_retry(input: &Value) -> Res {
    send(if mailman::retry(&or_empty(input)) { 200 } else { 409 }, &json!({}))
}

fn people(input: &Value) -> Res {
    crate::features::follow_up::handle_people(input)
}

fn write_report(file: &str, input: &Value, max: usize) -> Res {
    let mut out = Map::new();
    out.insert("at".into(), json!(now()));
    if let Some(o) = input.as_object() {
        for (k, v) in o {
            out.insert(k.clone(), v.clone());
        }
    }
    let text = clip(&stringify_pretty(&Value::Object(out), 1), max);
    let _ = std::fs::write(DATA_DIR.join(file), text);
    ok()
}

fn layout_report(input: &Value) -> Res {
    write_report("layout-report.json", input, 8000)
}

fn term_claim(input: &Value) -> Res {
    let line = format!(
        "{} {} {} {} -> {}x{} {}\n",
        now(),
        clip(&text_or_empty(input.get("conversation")), 8),
        js_string(input.get("why")),
        js_string(input.get("from")),
        js_string(input.get("cols")),
        js_string(input.get("rows")),
        clip(&text_or_empty(input.get("device")), 120)
    );
    crate::core::logfile::append_log(&DATA_DIR.join("term-claims.log"), &line);
    ok()
}

fn page_errors(input: &Value) -> Res {
    write_report("page-errors.json", input, 20000)
}

fn audio_report(input: &Value) -> Res {
    write_report("audio-report.json", input, 20000)
}

fn sentry_send(input: &Value) -> Res {
    let issues = input.get("issues").and_then(Value::as_array).filter(|i| !i.is_empty());
    let Some(issues) = issues.filter(|_| is_true(input, "area")) else { return error_res(400, "faltan los errores o la sesión") };
    let area = js_string(input.get("area"));
    let held = crate::features::holds::check_area(&load(), "Esa sesión", &area, None);
    if !held.is_empty() {
        return error_res(409, &held);
    }
    let n = sentry::send_issues(&Value::Array(issues.iter().take(50).cloned().collect()), &area);
    if n > 0 {
        crate::server::state::open_if_closed(&area, None);
        mailman::kick();
    }
    send(200, &json!({ "sent": n }))
}

fn daily(input: &Value) -> Res {
    if !cluster::is_primary() {
        return error_res(409, "la daily la redacta el ordenador que manda");
    }
    let day = if is_true(input, "today") { crate::core::time::madrid_now().day } else { crate::features::daily::last_workday(None) };
    let project = if is_true(input, "project") { Some(js_string(input.get("project"))) } else { None };
    std::thread::spawn(move || crate::features::daily::daily_for(Some(&day), false, project.as_deref()));
    send(200, &json!({ "ok": true }))
}

fn cluster_yield(input: &Value) -> Res {
    cluster::handle_yield(input);
    ok()
}

fn cluster_take(_input: &Value) -> Res {
    status_by_ok(cluster::take_here())
}

fn watchdog_dismiss(input: &Value) -> Res {
    if !is_true(input, "key") {
        return error_res(400, "falta el aviso");
    }
    crate::features::watchdog::dismiss(&js_string(input.get("key")));
    ok()
}

fn cluster_auto(_input: &Value) -> Res {
    send(200, &cluster::back_to_auto())
}

fn cluster_command(input: &Value) -> Res {
    status_by_ok(cluster::command(opt_str(input, "target"), opt_str(input, "action").unwrap_or("")))
}

fn host_respawned(input: &Value) -> Res {
    let conversation = input.get("conversation").cloned();
    std::thread::spawn(move || {
        if !cluster::is_primary() {
            return;
        }
        let r = crate::sessions::registry::load_routes();
        let s = crate::server::state::state();
        let is = |role: &str| r.get(role).is_some_and(|x| truthy(Some(x)) && x.get("conversation") == conversation.as_ref());
        if is("orchestrator") && is_true(&s, "orchestrator") {
            if crate::server::startup::claim_orchestrator_notice() {
                mailman::notify_role("orchestrator", &crate::server::state::ORCHESTRATOR_NOTICE);
            }
            return;
        }
        if is("reporter") && is_true(&s, "reporterStatus") {
            crate::server::startup::notice_reporter(s["reporterStatus"].get("session").and_then(Value::as_str));
            return;
        }
        if is("board") && is_true(&s, "boardStatus") {
            crate::server::startup::notice_board(s["boardStatus"].get("session").and_then(Value::as_str), true);
            return;
        }
        if is("followUp") {
            crate::server::startup::wake_follow_up();
        }
    });
    ok()
}

fn valid_conversation(input: &Value) -> Option<String> {
    let conversation = text_or_empty(input.get("conversation"));
    CONVERSATION_RE.is_match(&conversation).then_some(conversation)
}

fn start_body(conversation: &str, name: Option<&Value>) -> Value {
    let mut body = json!({ "conversation": conversation });
    if let Some(name) = name {
        obj(&mut body).insert("name".into(), name.clone());
    }
    body
}

fn session_profile(input: &Value) -> Res {
    let Some(conversation) = valid_conversation(input) else { return error_res(400, "conversación no válida") };
    let profile = match crate::sessions::profiles::set_override(&conversation, opt_str(input, "model"), opt_str(input, "effort")) {
        Ok(p) => p,
        Err(e) => return error_res(400, &e),
    };
    let run = || -> Result<Value, String> {
        let list = host::host_request("GET", "/sessions", None).unwrap_or(json!([]));
        let live = list.as_array().and_then(|l| l.iter().find(|x| str_of(x, "conversation") == conversation && is_true(x, "running")).cloned());
        let Some(live) = live else { return Ok(json!({ "profile": profile, "restarted": false })) };
        host::host_request("POST", "/stop", Some(&json!({ "conversation": conversation })))?;
        let name = if is_true(&live, "name") { live.get("name") } else { input.get("name") };
        host::host_request("POST", "/start", Some(&start_body(&conversation, name)))?;
        Ok(json!({ "profile": profile, "restarted": true }))
    };
    match run() {
        Ok(r) => send(200, &r),
        Err(e) => error_res(500, &e),
    }
}

fn host_action(input: &Value) -> Res {
    let Some(conversation) = valid_conversation(input) else { return error_res(400, "conversación no válida") };
    let action = opt_str(input, "action").unwrap_or("");
    let name_value = input.get("name");
    let name = name_value.and_then(Value::as_str).unwrap_or("");
    let start = || host::host_request("POST", "/start", Some(&start_body(&conversation, name_value)));
    let stop = || host::host_request("POST", "/stop", Some(&json!({ "conversation": conversation })));
    let go = || -> Result<Value, String> {
        host::ensure_host();
        match action {
            "move" => {
                if host::vs_code_has(&conversation) {
                    host::mark_waiting(&conversation, name);
                    return Ok(json!({ "waiting": true }));
                }
                let routes = crate::sessions::registry::load_routes();
                let is_role = ["reporter", "orchestrator", "followUp", "board"].iter().any(|k| routes.get(*k).is_some_and(|r| truthy(Some(r)) && str_of(r, "conversation") == conversation));
                if !is_role {
                    host::adopt(&conversation, name);
                    return Ok(json!({ "adopted": true }));
                }
                start()
            }
            "back" => {
                host::host_request("POST", "/release", Some(&json!({ "conversation": conversation })))?;
                crate::sessions::registry::open_in_vs_code(Some(&conversation));
                Ok(json!({ "ok": true }))
            }
            "open" => start(),
            "sleep" => {
                stop()?;
                host::adopt(&conversation, name);
                host::mark_on_demand(&conversation);
                Ok(json!({ "ok": true }))
            }
            "restart" => {
                stop()?;
                crate::core::data::pause(1500);
                start()
            }
            _ => Err("acción desconocida".to_string()),
        }
    };
    match go() {
        Ok(r) => send(200, &r),
        Err(e) => error_res(500, &e),
    }
}

fn permission_check(input: &Value) -> Res {
    send(200, &permissions::check(input))
}

fn permission_decide(input: &Value) -> Res {
    let id = js_string(input.get("id"));
    let decision = opt_str(input, "decision").unwrap_or("");
    if !permissions::decide(&id, decision, opt_str(input, "reason")) {
        return send(409, &json!({}));
    }
    let p = load().get("permissions").and_then(Value::as_array).and_then(|l| l.iter().find(|x| str_of(x, "id") == id).cloned());
    if let Some(p) = p.filter(|p| is_true(p, "native")) {
        let body = json!({ "conversation": p.get("conversation").cloned().unwrap_or(Value::Null), "data": if decision == "deny" { "\x1b" } else { "1" } });
        std::thread::spawn(move || {
            let _ = host::host_request("POST", "/input", Some(&body));
        });
    }
    ok()
}

fn session_name(input: &Value) -> String {
    if is_true(input, "name") { js_string(input.get("name")) } else { "Una sesión".to_string() }
}

fn push_later(kind: &'static str, text: String) {
    std::thread::spawn(move || {
        crate::server::push::send_push(kind, true, Some(&text));
    });
}

fn host_prompt(input: &Value) -> Res {
    let input = or_empty(input);
    if permissions::native_prompt(&input).is_some() {
        push_later("permission", format!("{} pide permiso: {}", session_name(&input), clip(&text_or_empty(input.get("question")), 80)));
    }
    ok()
}

fn host_stuck(input: &Value) -> Res {
    let input = or_empty(input);
    if crate::features::stuck::report(&input) {
        push_later("permission", format!("{} está parada en una pregunta al arrancar: ábrela para contestarla.", session_name(&input)));
    }
    ok()
}

fn permission_rule_remove(input: &Value) -> Res {
    send(if permissions::remove_rule(&js_string(input.get("key"))) { 200 } else { 404 }, &json!({}))
}

fn mac_power(input: &Value) -> Res {
    let hour_ok = |k: &str| !is_true(input, k) || HOUR_RE.is_match(&js_string(input.get(k)));
    if !hour_ok("wake") || !hour_ok("sleep") {
        return error_res(400, "hora no válida (HH:MM)");
    }
    let mut schedule = defined(input, &["wake", "sleep"]);
    if let Some(off) = input.get("weeklyOff").filter(|v| v.is_boolean()) {
        obj(&mut schedule).insert("weeklyOff".into(), off.clone());
    }
    send(200, &json!({ "schedule": crate::features::mac_power::set_schedule(&schedule) }))
}

fn work_hours(input: &Value) -> Res {
    let r = crate::core::hours::set_schedule(&defined(input, &["start", "end", "daily"]));
    if is_true(&r, "error") {
        return send(400, &json!({ "error": r["error"].clone() }));
    }
    send(200, &r)
}

fn overtime(input: &Value) -> Res {
    send(200, &json!({ "overtime": crate::server::startup::set_overtime(is_true(input, "on")) }))
}

fn devservers_action(input: &Value) -> Res {
    let id = opt_str(input, "id").unwrap_or("");
    let project = if is_true(input, "project") { opt_str(input, "project") } else { None };
    let r: Result<Value, String> = match opt_str(input, "action").unwrap_or("") {
        "autoProject" => devservers::set_auto_project(opt_str(input, "project").unwrap_or(""), is_true(input, "on")),
        "start" => devservers::start(id).map(Value::Bool),
        "stop" => devservers::stop(id).map(Value::Bool),
        "restart" => devservers::restart(id).map(Value::Bool),
        "startAll" => devservers::start_all(false, project).map(|v| json!(v)),
        "stopAll" => devservers::stop_all(project).map(|v| json!(v)),
        _ => return error_res(400, "acción desconocida"),
    };
    match r {
        Ok(r) => send(200, &json!({ "result": r })),
        Err(e) => error_res(500, &e),
    }
}

fn tunnel(input: &Value) -> Res {
    let r = match opt_str(input, "action").unwrap_or("") {
        "open" => crate::features::tunnel::open(),
        "close" => Ok(crate::features::tunnel::close()),
        _ => return error_res(400, "acción desconocida"),
    };
    match r {
        Ok(t) => send(200, &t),
        Err(e) => error_res(500, &e),
    }
}

fn sentry_status(input: &Value) -> Res {
    let owner = if is_true(input, "owner") { Some(js_string(input.get("owner"))) } else { None };
    let issue_id = input.get("issueId").cloned().unwrap_or(Value::Null);
    match sentry::set_status(&issue_id, &text_or_empty(input.get("id")), opt_str(input, "status").unwrap_or(""), owner.as_deref()) {
        Ok(()) => ok(),
        Err(e) => error_res(502, &e),
    }
}

fn sentry_discard(input: &Value) -> Res {
    send(if sentry::discard(&js_string(input.get("id"))) { 200 } else { 409 }, &json!({}))
}

fn learning_read(_input: &Value) -> Res {
    send(200, &json!({ "started": crate::jira::learning::start_reading() }))
}

fn push_subscribe(input: &Value) -> Res {
    crate::server::push::handle_push("/api/push/subscribe", input)
}

fn push_unsubscribe(input: &Value) -> Res {
    crate::server::push::handle_push("/api/push/unsubscribe", input)
}

fn push_test(input: &Value) -> Res {
    crate::server::push::handle_push("/api/push/test", input)
}

fn push_prefs(input: &Value) -> Res {
    crate::server::push::handle_push("/api/push/prefs", input)
}

fn state_body() -> String {
    let mut s = crate::server::state::state().as_object().cloned().unwrap_or_default();
    s.insert("voice".into(), json!(crate::features::voice::voice_available()));
    s.insert("speech".into(), json!(crate::features::speech::speech_available()));
    s.insert("deployStatus".into(), crate::features::deploy_status::read_status().unwrap_or(Value::Null));
    s.insert("reviewJob".into(), tasks::review_job_state());
    stringify(&Value::Object(s))
}

fn serve_state(req: &Req) -> Res {
    let body = state_body();
    let hash = Sha1::digest(SYNCED_AT_RE.replace_all(&body, "").as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
    if req.header("x-state-hash") == Some(hash.as_str()) {
        return Res::empty(204).with_header("x-state-hash", &hash).with_header("cache-control", "no-store");
    }
    Res { code: 200, headers: Vec::new(), body: body.into_bytes() }.with_header("content-type", "application/json").with_header("cache-control", "no-store").with_header("x-state-hash", &hash)
}

pub fn handle_get(req: &Req) -> Option<Res> {
    let url = req.url.as_str();
    let res = match url {
        "/api/claude-token/setup" => serve_json(&crate::features::claude_token::job_status()),
        "/api/push/reason" => serve_json(&crate::server::push::push_reason()),
        "/api/push/key" => {
            let keys = crate::server::push::push_keys();
            let mut out = Map::new();
            if let Some(k) = keys.get("publicKey") {
                out.insert("key".into(), k.clone());
            }
            serve_json(&Value::Object(out))
        }
        _ if url.starts_with("/api/permission/perm-") => serve_json(&permissions::poll(&url["/api/permission/".len()..])),
        "/api/cluster/quota" => serve_json(&crate::features::quota::read_quota().unwrap_or(Value::Null)),
        "/api/cluster/memory" => serve_json(&crate::features::memory_sync::snapshot()),
        _ if url.starts_with("/api/cluster/memory/") => {
            match decode_uri_component(&url["/api/cluster/memory/".len()..]).ok().and_then(|id| crate::features::memory_sync::project_snapshot(&id)) {
                Some(snap) => serve_json(&snap),
                None => Res::empty(404),
            }
        }
        "/api/projects-admin" => serve_json(&crate::features::projects_admin::list()),
        "/api/cluster" => serve_json(&cluster::info()),
        "/api/cluster/snapshot" => serve_json(&cluster::snapshot()),
        "/api/cluster/machines" => serve_json(&cluster::machines()),
        "/api/cluster/transcripts" => serve_json(&Value::Array(cluster::transcripts())),
        _ if url.starts_with("/api/cluster/transcript/") => {
            let from = req.query("from").and_then(|f| f.trim().parse::<f64>().ok()).filter(|f| f.is_finite() && *f > 0.0).unwrap_or(0.0) as u64;
            match cluster::serve_transcript(&url["/api/cluster/transcript/".len()..], from) {
                Some(part) => Res { code: 200, headers: Vec::new(), body: part.body }
                    .with_header("content-type", "application/x-ndjson")
                    .with_header("cache-control", "no-store")
                    .with_header("x-tail-hash", &part.tail),
                None => Res::empty(404),
            }
        }
        "/api/host/sessions" => {
            let hosted = Value::Array(host::read_config());
            match host::host_request("GET", "/sessions", None) {
                Ok(v) => serve_json(&json!({ "up": true, "sessions": v, "hosted": hosted })),
                Err(_) => serve_json(&json!({ "up": false, "sessions": [], "hosted": hosted })),
            }
        }
        "/api/tunnel" => {
            let mut out = crate::features::tunnel::status().as_object().cloned().unwrap_or_default();
            match crate::features::tunnel::remote() {
                Ok(remote) => {
                    out.insert("remote".into(), remote.unwrap_or(Value::Null));
                }
                Err(e) => {
                    out.insert("remote".into(), Value::Null);
                    out.insert("error".into(), json!(e));
                }
            }
            serve_json(&Value::Object(out))
        }
        "/api/devservers" => serve_json(&devservers::status()),
        "/api/sentry" | "/api/sentry?force=1" => serve_json(&sentry::list_issues(url.ends_with("force=1"))),
        "/api/files" => serve_json(&json!(crate::features::files::search_files(req.query("q").unwrap_or("")))),
        "/api/learning" => serve_json(&crate::jira::learning::learning_summary()),
        "/api/state" => serve_state(req),
        _ if url.starts_with("/api/voice/") => crate::features::voice::serve_voice(url),
        _ if url.starts_with("/api/speech/") => crate::features::speech::serve_speech(url),
        _ => return None,
    };
    Some(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_post_path_of_the_page_has_a_route_and_unknown_ones_do_not() {
        for path in ["/api/task", "/api/batch", "/api/session", "/api/deploy", "/api/tidy", "/api/message", "/api/push/prefs", "/api/host/action", "/api/sentry/send"] {
            assert!(post_route(path).is_some(), "{path}");
        }
        assert!(post_route("/api/nope").is_none());
        assert!(post_route("/api/state").is_none());
    }

    #[test]
    fn host_actions_refuse_a_conversation_that_is_not_a_uuid() {
        let r = host_action(&json!({ "action": "open", "conversation": "x" }));
        assert_eq!(r.code, 400);
        assert_eq!(r.body_text(), r#"{"error":"conversación no válida"}"#);
        assert_eq!(session_profile(&json!({ "conversation": 5 })).code, 400);
    }

    #[test]
    fn mac_power_refuses_hours_that_are_not_hh_mm() {
        assert_eq!(mac_power(&json!({ "wake": "25:00" })).body_text(), r#"{"error":"hora no válida (HH:MM)"}"#);
        assert_eq!(mac_power(&json!({ "sleep": "7:5" })).code, 400);
    }
}

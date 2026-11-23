//! Port of src/server/routes/operations.js.

use std::sync::LazyLock;

use serde_json::{Map, Value, json};

use super::tasks::{clip, error_res, is_true, js_string, list_mut, obj, ok, str_of, text_or_empty};
use crate::core::config::{self, main_project};
use crate::core::data::{Doc, is_uuid, load, mutate, now};
use crate::core::json::truthy;
use crate::features::{follow_up, holds};
use crate::server::http::{Res, send};
use crate::server::state::{ERRORS_AREA, message_notice, message_target, open_if_closed, state, talk_target, tidy_blockers, wait};
use crate::sessions::registry::{change_routes, load_routes, open_in_vs_code, real_area, wake_session};

pub const ENVIRONMENT_NAME: [(&str, &str); 3] = [("develop", "develop"), ("production", "producción"), ("both", "develop y producción")];

const ENVIRONMENTS: [&str; 3] = ["develop", "production", "both"];
const VERSIONS: [&str; 3] = ["z", "y", "x"];

static FOLLOW_UP_NOTICE: LazyLock<String> = LazyLock::new(|| {
    format!(
        "Aviso del tablero: {} pide ahora un resumen de seguimiento. Compruébalo con «{} followup-status» (campo request, con el entorno) y sigue «Pedido desde el tablero» de .claude/commands/seguimiento.md.",
        me_name(),
        config::cli()
    )
});

fn stamp(at: &str, n: usize) -> String {
    at.chars().filter(char::is_ascii_digit).take(n).collect()
}

fn me_name() -> String {
    main_project().jira.as_ref().map(|j| js_string(j.me.get("name"))).unwrap_or_else(|| "undefined".to_string())
}

pub fn handle_deploy(input: &Value) -> Res {
    let cancel = input.get("cancel");
    if truthy(cancel) {
        let cancel = cancel.cloned().unwrap();
        let done = mutate(|d| {
            let Some(x) = list_mut(d, "deployments").iter_mut().find(|y| y.get("id") == Some(&cancel)) else { return false };
            if str_of(x, "status") != "approved" {
                return false;
            }
            let x = obj(x);
            x.insert("status".into(), json!("cancelled"));
            x.insert("cancelledAt".into(), json!(now()));
            true
        });
        return if done { ok() } else { error_res(409, "ya se había enviado") };
    }
    let projects = input.get("projects").and_then(Value::as_array);
    let list: Vec<String> = main_project().deploy_projects.iter().filter(|p| projects.is_some_and(|ps| ps.iter().any(|x| x.as_str() == Some(p.as_str())))).cloned().collect();
    let asked = match input.get("projects") {
        Some(Value::Array(a)) => a.len(),
        Some(Value::String(s)) => s.encode_utf16().count(),
        _ => 0,
    };
    if list.is_empty() || list.len() != asked {
        return error_res(400, "elige qué proyectos subir");
    }
    let environment = str_of(input, "environment").to_string();
    if !input.get("environment").is_some_and(Value::is_string) || !ENVIRONMENTS.contains(&environment.as_str()) {
        return error_res(400, "elige a dónde subir");
    }
    let version = str_of(input, "version");
    let tag = if environment == "develop" {
        Value::Null
    } else if input.get("version").is_some_and(Value::is_string) && VERSIONS.contains(&version) {
        json!(version)
    } else {
        json!("z")
    };
    let routes = load_routes();
    let area = str_of(input, "area").to_string();
    let valid = !area.is_empty() && real_area(&area).is_some_and(|a| !a.is_empty()) && truthy(routes.get("areas").and_then(|a| a.get(&area)));
    if !valid {
        return error_res(400, "elige la sesión que despliega");
    }
    let target = area;
    if routes.get("deployer").and_then(Value::as_str) != Some(target.as_str()) {
        change_routes(|r| {
            obj(r).insert("deployer".into(), json!(target));
        });
    }
    let held = holds::check_area(&load(), "El despliegue", &target, None);
    if !held.is_empty() {
        return error_res(409, &held);
    }
    let created = mutate(|d| {
        let deployments = list_mut(d, "deployments");
        if deployments.iter().any(|x| str_of(x, "status") == "approved") {
            return None;
        }
        let at = now();
        let x = json!({ "id": format!("D{}", stamp(&at, 14)), "projects": list, "environment": environment, "version": tag, "area": target, "status": "approved", "approvedVia": "board", "at": at });
        deployments.insert(0, x.clone());
        deployments.truncate(40);
        Some(x)
    });
    let Some(created) = created else { return error_res(409, "ya hay un despliegue esperando envío") };
    open_if_closed(&target, None);
    crate::features::mailman::kick();
    send(200, &created)
}

pub fn handle_tidy(input: &Value) -> Res {
    let main = main_project();
    let p = if truthy(input.get("project")) { config::project(&js_string(input.get("project"))) } else { Some(main.clone()) };
    let Some(p) = p else { return error_res(400, "proyecto desconocido") };
    if !p.context_tidy {
        return error_res(400, &format!("{} no tiene Ordenar contexto", p.name));
    }
    let is_main = p.id == main.id;
    let r: Result<(), String> = mutate(|d| {
        let b = tidy_blockers(d, Some(&p.id));
        if !b.is_empty() {
            return Err(format!("Todavía no: {}.", b.join(", ")));
        }
        let at = now();
        if is_main {
            d.insert("contextTidy".into(), json!({ "id": format!("tidy-{}", stamp(&at, 14)), "at": at, "status": "approved", "approvedVia": "board" }));
        } else {
            let mut tidies: Map<String, Value> = d.get("contextTidies").and_then(Value::as_object).cloned().unwrap_or_default();
            tidies.insert(p.id.clone(), json!({ "id": format!("tidy-{}-{}", p.id, stamp(&at, 14)), "at": at, "status": "approved", "approvedVia": "board", "project": p.id }));
            d.insert("contextTidies".into(), Value::Object(tidies));
        }
        Ok(())
    });
    if let Err(error) = r {
        return error_res(409, &error);
    }
    crate::features::mailman::kick();
    ok()
}

fn find_message(d: &Doc, id: &str) -> Option<Value> {
    d.get("messages").and_then(Value::as_array).and_then(|m| m.iter().find(|x| str_of(x, "id") == id)).cloned()
}

fn open_and_wait(first: Value, current: &dyn Fn() -> Value) -> Option<Value> {
    let mut e = first;
    if is_true(&e, "open") {
        return Some(e);
    }
    open_in_vs_code(e.get("conversation").and_then(Value::as_str));
    for _ in 0..24 {
        e = current();
        if e.is_null() {
            return None;
        }
        if is_true(&e, "open") {
            break;
        }
        wait(5000);
    }
    if !is_true(&e, "open") {
        return None;
    }
    wait(8000);
    Some(e)
}

fn deliver_message(id: &str) {
    let Some(m) = find_message(&load(), id) else { return };
    if is_true(&m, "readAt") {
        return;
    }
    let to = js_string(m.get("to"));
    let session = || talk_target(&state(), &to);
    let e = session();
    if !truthy(Some(&e)) || !is_uuid(&text_or_empty(e.get("conversation"))) {
        return;
    }
    let Some(e) = open_and_wait(e, &session) else { return };
    match find_message(&load(), id) {
        Some(x) if !is_true(&x, "readAt") => {}
        _ => return,
    }
    let ok = wake_session(&js_string(e.get("session")), Some(&message_notice(id)));
    mutate(|d| {
        if let Some(x) = list_mut(d, "messages").iter_mut().find(|y| str_of(y, "id") == id) {
            obj(x).insert("wokenUp".into(), json!({ "at": now(), "ok": ok }));
        }
    });
}

pub fn handle_message(input: &Value) -> Res {
    let clean = clip(text_or_empty(input.get("text")).trim(), 4000);
    let to = input.get("to").and_then(Value::as_str).unwrap_or("");
    if message_target(to).is_none() {
        return error_res(400, "destino desconocido");
    }
    if clean.is_empty() {
        return error_res(400, "escribe el mensaje");
    }
    let at = now();
    let id = format!("msg-{}", stamp(&at, 17));
    mutate(|d| {
        let mut m = json!({ "id": id, "to": to, "text": clean, "at": at, "readAt": null, "reply": null });
        if is_true(input, "voice") {
            obj(&mut m).insert("voice".into(), input["voice"].clone());
        }
        let messages = list_mut(d, "messages");
        messages.insert(0, m);
        messages.truncate(60);
    });
    let target = talk_target(&state(), to);
    let delay = if is_true(&target, "watching") { 45000 } else { 1500 };
    let later = id.clone();
    std::thread::spawn(move || {
        wait(delay);
        deliver_message(&later);
    });
    send(200, &json!({ "id": id }))
}

fn summary_to_errors(d: &mut Doc, at: Option<&Value>) -> String {
    let follow_ups = d.get("followUps").and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(index) = follow_ups.iter().position(|x| x.get("at") == at) else { return "no existe ese resumen".to_string() };
    let r = &follow_ups[index];
    let errors = r.get("errors").and_then(Value::as_array).cloned().unwrap_or_default();
    if errors.iter().any(|e| is_true(e, "wholeSummary") && str_of(e, "state") != "discarded") {
        return "ese resumen ya se ha enviado".to_string();
    }
    let mark = now();
    let time = r.get("at").and_then(Value::as_str).and_then(crate::core::time::parse).map(crate::core::time::madrid_hhmm).unwrap_or_else(|| "Invalid Date".to_string());
    let text = format!(
        "Resumen de seguimiento de {} de las {}, enviado entero por {} porque ve un posible fallo:\n\n{}",
        follow_up::environment_name(&follow_up::environment_of(r, d)),
        time,
        me_name(),
        js_string(r.get("text"))
    );
    let mut all = errors;
    all.push(json!({ "id": format!("err-{}", stamp(&mark, 17)), "text": text, "wholeSummary": true, "state": "approved", "approvedVia": "board", "at": mark, "decidedAt": mark }));
    if let Some(target) = list_mut(d, "followUps").get_mut(index) {
        obj(target).insert("errors".into(), Value::Array(all));
    }
    String::new()
}

pub fn handle_follow_up_error(input: &Value) -> Res {
    let action = str_of(input, "action").to_string();
    if !matches!(action.as_str(), "send" | "discard" | "summary") {
        return error_res(400, "acción desconocida");
    }
    let errors_area = ERRORS_AREA.clone().unwrap_or_default();
    let id = input.get("id").cloned();
    let error = mutate(|d| {
        if action != "discard" {
            let held = holds::check_area(d, "La sesión de errores", &errors_area, None);
            if !held.is_empty() {
                return held;
            }
        }
        if action == "summary" {
            return summary_to_errors(d, input.get("at"));
        }
        for r in list_mut(d, "followUps").iter_mut() {
            let Some(e) = r.get_mut("errors").and_then(Value::as_array_mut).and_then(|errs| errs.iter_mut().find(|x| x.get("id") == id.as_ref())) else { continue };
            if str_of(e, "state") != "proposed" {
                return format!("ese posible error ya está {}", js_string(e.get("state")));
            }
            let e = obj(e);
            if action == "send" {
                e.insert("state".into(), json!("approved"));
                e.insert("approvedVia".into(), json!("board"));
                e.insert("decidedAt".into(), json!(now()));
            } else {
                e.insert("state".into(), json!("discarded"));
                e.insert("decidedAt".into(), json!(now()));
            }
            return String::new();
        }
        "no existe ese posible error".to_string()
    });
    if !error.is_empty() {
        return error_res(409, &error);
    }
    if action != "discard" {
        open_if_closed(&errors_area, None);
        crate::features::mailman::kick();
    }
    ok()
}

fn wake_follow_up_for(id: Value) {
    let current = || state().get("followUpStatus").cloned().unwrap_or(Value::Null);
    let e = current();
    if !truthy(Some(&e)) || !is_uuid(&text_or_empty(e.get("conversation"))) {
        return;
    }
    let Some(e) = open_and_wait(e, &current) else { return };
    let ok = wake_session(&js_string(e.get("session")), Some(&FOLLOW_UP_NOTICE));
    mutate(|d| {
        if let Some(r) = d.get_mut("followUpRequest").filter(|r| r.is_object() && r.get("id") == Some(&id)) {
            obj(r).insert("wokenUp".into(), json!({ "at": now(), "ok": ok }));
        }
    });
}

pub fn handle_follow_up_request(input: &Value) -> Res {
    let environment = str_of(input, "environment");
    let place = if follow_up::ENVIRONMENTS.contains(&environment) { environment.to_string() } else { "beta".to_string() };
    let p = mutate(|d| {
        let current = d.get("followUpRequest").cloned();
        if !truthy(current.as_ref()) || current.as_ref().is_some_and(|r| is_true(r, "handled")) {
            let at = now();
            d.insert("followUpRequest".into(), json!({ "id": at, "at": at, "handled": false, "environment": place }));
        }
        d["followUpRequest"].clone()
    });
    let id = p.get("id").cloned().unwrap_or(Value::Null);
    std::thread::spawn(move || wake_follow_up_for(id));
    send(200, &p)
}

//! Port of src/commands/orchestration.js.
use crate::commands::args::{Args, assign, encode_uri_component, is_one_of, json, json_of, list_mut, list_of, madrid_hour_minute, obj, or, parse_json, slice_chars, str_of, text, ME};
use crate::core::config::{self, main_project};
use crate::core::data::{Doc, HUMAN_APPROVALS, is_empty_report, load, mark_counted, mutate, now, read_stdin};
use crate::core::json::{stringify, truthy};
use crate::features::holds;
use crate::server::push::send_push;
use crate::server::state::{ERRORS_AREA, follow_up_errors, last_context_pass, message_target, state, tidy_blockers};
use regex::Regex;
use serde_json::{Value, json};

fn destination(s: &Value, id: Option<&Value>) -> Value {
    let id = id.and_then(Value::as_str);
    let found = s.get("areas").and_then(Value::as_array).and_then(|areas| areas.iter().find(|y| y.get("id").and_then(Value::as_str).is_some() && y.get("id").and_then(Value::as_str) == id));
    match found {
        Some(x) => {
            let send_to = if truthy(x.get("repeatedName")) && truthy(x.get("ref")) { Value::from(format!("{} [{}]", text(x.get("sessionName")), text(x.get("ref")))) } else { x.get("sessionName").cloned().unwrap_or(Value::Null) };
            obj(vec![("session", x.get("name").cloned()), ("sendTo", Some(send_to)), ("open", x.get("open").cloned()), ("repeatedName", x.get("repeatedName").cloned()), ("ref", x.get("ref").cloned())])
        }
        None => Value::Null,
    }
}

fn human_approved(t: &Value) -> bool {
    t.get("status").and_then(Value::as_str) == Some("approved") && is_one_of(t.get("approvedVia"), &HUMAN_APPROVALS)
}

fn area_of(t: &Value) -> Option<&str> {
    t.get("area").and_then(Value::as_str)
}

pub fn dispatches(_args: &Args) -> Result<i32, String> {
    let s = state();
    let d = load();
    let tasks_all = s.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
    let approved: Vec<&Value> = tasks_all.iter().filter(|t| human_approved(t)).collect();
    let held: Vec<Value> = approved.iter().filter_map(|t| {
        let error = holds::check_task(&d, t, area_of(t), None);
        (!error.is_empty()).then(|| obj(vec![("key", t.get("key").cloned()), ("area", t.get("area").cloned()), ("error", Some(Value::from(error)))]))
    }).collect();
    let mut tasks: Vec<Value> = approved
        .iter()
        .filter(|t| holds::check_task(&d, t, area_of(t), None).is_empty())
        .map(|t| {
            let epic = [t.get("epicKey"), t.get("epicName")].iter().filter(|x| truthy(**x)).map(|x| text(*x)).collect::<Vec<_>>().join(" ");
            let mandatory: Vec<Value> = holds::notes_for(&d, &holds::task_target(t, area_of(t)), None).iter().map(|r| Value::from(format!("{}: {}", text(r.get("id")), text(r.get("reason"))))).collect();
            obj(vec![
                ("key", t.get("key").cloned()),
                ("title", t.get("title").cloned()),
                ("kind", t.get("kind").cloned()),
                ("epic", Some(Value::from(epic))),
                ("approvedVia", t.get("approvedVia").cloned()),
                ("assignee", Some(or(t.get("assignee"), Some(&Value::from("sin asignar"))).unwrap())),
                ("note", Some(Value::from(crate::features::mailman::task_note(t)))),
                ("mandatory", Some(Value::Array(mandatory))),
                ("delivery", Some(or(t.get("delivery"), Some(&Value::Null)).unwrap())),
                ("area", t.get("area").cloned()),
                ("destination", Some(destination(&s, t.get("area")))),
            ])
        })
        .collect();
    let deployments: Vec<Value> = s
        .get("deployments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|x| x.get("status").and_then(Value::as_str) == Some("approved") && x.get("approvedVia").and_then(Value::as_str) == Some("board") && holds::check_area(&d, &text(x.get("id")), str_of(x, "area"), None).is_empty())
        .map(|x| obj(vec![("id", x.get("id").cloned()), ("projects", x.get("projects").cloned()), ("environment", x.get("environment").cloned()), ("version", x.get("version").cloned()), ("area", x.get("area").cloned()), ("delivery", Some(or(x.get("delivery"), Some(&Value::Null)).unwrap())), ("destination", Some(destination(&s, x.get("area"))))]))
        .collect();
    for t in tasks.iter_mut() {
        let key = text(t.get("key"));
        t["attachments"] = match crate::jira::client::download_attachments(&key) {
            Ok(v) => v,
            Err(e) => json!({ "error": e }),
        };
    }
    let answers: Vec<Value> = tasks_all
        .iter()
        .filter(|t| truthy(t.get("answer")) && !truthy(t.get("answer").and_then(|a| a.get("delivered"))))
        .map(|t| {
            let asked = t.get("notice").filter(|n| truthy(Some(n))).and_then(|n| n.get("text")).filter(|x| truthy(Some(x))).cloned().unwrap_or(Value::from(""));
            obj(vec![("key", t.get("key").cloned()), ("title", t.get("title").cloned()), ("asked", Some(asked)), ("answer", t["answer"].get("text").cloned()), ("area", t.get("area").cloned()), ("destination", Some(destination(&s, t.get("area"))))])
        })
        .collect();
    let errors_area = ERRORS_AREA.clone();
    let errors_area_value = errors_area.clone().map(Value::from);
    let errors: Vec<Value> = follow_up_errors(&load())
        .into_iter()
        .filter(|e| e.get("state").and_then(Value::as_str) == Some("approved") && is_one_of(e.get("approvedVia"), &["board", "yolo"]) && holds::check_area(&d, &text(e.get("id")), errors_area.as_deref().unwrap_or(""), None).is_empty())
        .map(|e| obj(vec![("id", e.get("id").cloned()), ("text", e.get("text").cloned()), ("seenAt", e.get("at").cloned()), ("destination", Some(destination(&s, errors_area_value.as_ref())))]))
        .collect();
    let sentry_all = crate::features::sentry::sentry_issues(&load());
    let sentry: Vec<Value> = sentry_all
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|x| x.get("state").and_then(Value::as_str) == Some("approved") && x.get("approvedVia").and_then(Value::as_str) == Some("board") && holds::check_area(&d, &text(x.get("id")), str_of(x, "area"), None).is_empty())
        .map(|x| {
            let again = x.get("rounds").and_then(Value::as_f64).is_some_and(|r| r > 1.0);
            obj(vec![
                ("id", x.get("id").cloned()),
                ("title", x.get("title").cloned()),
                ("culprit", x.get("culprit").cloned()),
                ("project", x.get("project").cloned()),
                ("url", x.get("url").cloned()),
                ("events", x.get("count").cloned()),
                ("users", x.get("users").cloned()),
                ("lastSeen", x.get("lastSeen").cloned()),
                ("again", Some(Value::Bool(again))),
                ("destination", Some(destination(&s, x.get("area")))),
            ])
        })
        .collect();
    json(&json!({
        "deliveredBy": "board",
        "note": format!("El tablero entrega todo esto solo, en cuanto {} lo aprueba: esta lista es para consultar. No lo envíes tú.", *ME),
        "tasks": tasks,
        "held": held,
        "deployments": deployments,
        "answers": answers,
        "errors": errors,
        "sentry": sentry,
    }));
    Ok(0)
}

pub fn orchestrator(_args: &Args) -> Result<i32, String> {
    let s = state();
    let mut waiting: Vec<Value> = s.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default().iter().filter(|t| human_approved(t)).map(|t| obj(vec![("key", t.get("key").cloned()), ("since", t.get("decidedAt").cloned())])).collect();
    for x in s.get("deployments").and_then(Value::as_array).cloned().unwrap_or_default() {
        if x.get("status").and_then(Value::as_str) == Some("approved") {
            waiting.push(obj(vec![("key", x.get("id").cloned()), ("since", x.get("at").cloned())]));
        }
    }
    let orchestrator = match s.get("orchestrator") {
        Some(o) if truthy(Some(o)) => {
            let mut o = o.clone();
            o["watching"] = Value::Bool(true);
            Some(o)
        }
        other => other.cloned(),
    };
    json(&obj(vec![("orchestrator", orchestrator), ("note", Some(Value::from("El tablero entrega solo lo que se aprueba: la orquestadora no vigila nada y no hay que despertarla."))), ("waiting", Some(Value::Array(waiting)))]));
    Ok(0)
}

pub fn deployments(args: &Args) -> Result<i32, String> {
    let wanted = args.a().filter(|a| !a.is_empty()).map(|a| match a {
        "aprobada" => "approved".to_string(),
        "enviada" => "sent".to_string(),
        "cancelada" => "cancelled".to_string(),
        other => other.to_string(),
    });
    let list: Vec<Value> = list_of(&load(), "deployments").into_iter().filter(|x| wanted.as_deref().is_none_or(|w| x.get("status").and_then(Value::as_str) == Some(w))).take(10).collect();
    json(&Value::Array(list));
    Ok(0)
}

pub fn deployment_update(args: &Args) -> Result<i32, String> {
    let raw = args.b().filter(|b| !b.is_empty()).map(String::from).unwrap_or_else(read_stdin);
    let mut patch = parse_json(&raw)?;
    if patch.get("status").and_then(Value::as_str) == Some("enviada") {
        patch["status"] = Value::from("sent");
    }
    let a = args.a_text();
    let error = mutate(|d| {
        let snapshot: Doc = d.clone();
        let Some(x) = list_mut(d, "deployments").iter_mut().find(|y| y.get("id").and_then(Value::as_str) == args.a()) else {
            return format!("no existe {a}");
        };
        let extra: Vec<String> = patch.as_object().map(|p| p.keys().filter(|k| !["status", "sentAt", "reply"].contains(&k.as_str())).cloned().collect()).unwrap_or_default();
        if !extra.is_empty() {
            return format!("solo se pueden cambiar status, sentAt y reply (sobra: {})", extra.join(", "));
        }
        let status = patch.get("status");
        if truthy(status) && status.and_then(Value::as_str) != Some("sent") {
            return format!("un despliegue solo lo ordena o lo cancela {}, en el tablero", *ME);
        }
        let to_sent = status.and_then(Value::as_str) == Some("sent");
        if to_sent && !(x.get("status").and_then(Value::as_str) == Some("approved") && x.get("approvedVia").and_then(Value::as_str) == Some("board")) {
            return format!("{a} no está esperando envío: no se puede marcar como enviado");
        }
        if to_sent {
            let held = holds::check_area(&snapshot, &format!("El despliegue {a}"), str_of(x, "area"), None);
            if !held.is_empty() {
                return held;
            }
        }
        if to_sent && !truthy(patch.get("sentAt")) {
            patch["sentAt"] = Value::from(now());
        }
        assign(x, &patch);
        String::new()
    });
    if !error.is_empty() {
        return Err(error);
    }
    println!("{a} actualizado");
    Ok(0)
}

pub fn report(args: &Args) -> Result<i32, String> {
    let raw = args.a().filter(|a| !a.is_empty()).map(String::from).unwrap_or_else(read_stdin);
    let text = raw.trim().to_string();
    if text.is_empty() {
        return Err("falta el texto del reporte".into());
    }
    let empty = is_empty_report(&text);
    mutate(|d| {
        let at = now();
        let pending = d.get("refreshRequest").filter(|r| truthy(Some(r))).filter(|r| !truthy(r.get("handled"))).cloned();
        let request = pending.as_ref().map(|r| r.get("id").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null);
        d.insert("lastReview".into(), json!({ "at": at, "text": text, "empty": empty, "request": request }));
        if !empty {
            let reports = list_mut(d, "reports");
            reports.insert(0, json!({ "at": at, "text": text, "request": request }));
            reports.retain(|x| !is_empty_report(x.get("text").and_then(Value::as_str).unwrap_or("")));
            reports.truncate(20);
        }
        if pending.is_some() {
            if let Some(r) = d.get_mut("refreshRequest") {
                r["handled"] = Value::Bool(true);
            }
        }
    });
    let counted = mark_counted();
    let empty_note = if empty { " (sin novedades: la página sigue enseñando el último reporte con contenido)" } else { "" };
    let counted_note = if counted > 0 { format!("; {counted} evento(s) de Jira quedan como contados") } else { String::new() };
    println!("reporte guardado{empty_note}{counted_note}");
    Ok(0)
}

pub fn reporter(_args: &Args) -> Result<i32, String> {
    json_of(state().get("reporterStatus"));
    Ok(0)
}

pub fn board_session(_args: &Args) -> Result<i32, String> {
    json_of(state().get("boardStatus"));
    Ok(0)
}

pub fn counted(_args: &Args) -> Result<i32, String> {
    println!("{} evento(s) de Jira marcados como contados sin publicar reporte", mark_counted());
    Ok(0)
}

pub fn refresh_request(_args: &Args) -> Result<i32, String> {
    let d = load();
    match d.get("refreshRequest") {
        Some(p) if truthy(Some(p)) && !truthy(p.get("handled")) => println!("{}", stringify(p)),
        _ => println!("ninguna"),
    }
    Ok(0)
}

pub fn tidy_status(_args: &Args) -> Result<i32, String> {
    let d = load();
    let context_tidy = or(d.get("contextTidy"), Some(&Value::Null)).unwrap();
    json(&json!({ "contextTidy": context_tidy, "blockers": tidy_blockers(&d, None), "lastPass": last_context_pass(None) }));
    Ok(0)
}

fn find_message<'a>(d: &'a mut Doc, id: Option<&str>) -> Option<&'a mut Value> {
    list_mut(d, "messages").iter_mut().find(|x| x.get("id").and_then(Value::as_str).is_some() && x.get("id").and_then(Value::as_str) == id)
}

pub fn message(args: &Args) -> Result<i32, String> {
    let m = mutate(|d| {
        let m = find_message(d, args.a())?;
        if !truthy(m.get("readAt")) {
            m["readAt"] = Value::from(now());
        }
        Some(m.clone())
    });
    let Some(m) = m else {
        return Err(format!("no existe el mensaje {}", args.a_text()));
    };
    let time = madrid_hour_minute(m.get("at"));
    let target = m.get("to").and_then(Value::as_str).and_then(message_target).unwrap_or("undefined");
    println!("Mensaje de {} ({}, {time}) para {target}:\n{}", *ME, text(m.get("id")), text(m.get("text")));
    Ok(0)
}

pub fn answer_message(args: &Args) -> Result<i32, String> {
    let text = slice_chars(&args.rest(4), 4000);
    if text.is_empty() {
        return Err("Uso: board.js answer-message <id> <respuesta>".into());
    }
    let ok = mutate(|d| {
        let Some(m) = find_message(d, args.a()) else { return false };
        if !truthy(m.get("readAt")) {
            m["readAt"] = Value::from(now());
        }
        let mut replies = m.get("replies").and_then(Value::as_array).cloned().unwrap_or_default();
        replies.push(json!({ "at": now(), "text": text }));
        let skip = replies.len().saturating_sub(10);
        m["replies"] = Value::Array(replies.split_off(skip));
        m["reply"] = Value::from(text.as_str());
        true
    });
    if !ok {
        return Err(format!("no existe el mensaje {}", args.a_text()));
    }
    println!("respuesta guardada en el tablero");
    let target = list_of(&load(), "messages").into_iter().find(|x| x.get("id").and_then(Value::as_str) == args.a()).and_then(|m| m.get("to").and_then(Value::as_str).map(String::from));
    let who = target.as_deref().and_then(message_target).unwrap_or("una sesión");
    send_push("reply", true, Some(&format!("Te ha contestado {who}")));
    Ok(0)
}

pub fn progress(args: &Args) -> Result<i32, String> {
    let text = slice_chars(&args.rest(4), 300);
    if text.is_empty() {
        return Err("Uso: board.js progress <id> <en qué estás, en una línea>".into());
    }
    let ok = mutate(|d| {
        let Some(m) = find_message(d, args.a()) else { return false };
        if !truthy(m.get("readAt")) {
            m["readAt"] = Value::from(now());
        }
        m["progress"] = json!({ "at": now(), "text": text });
        true
    });
    if !ok {
        return Err(format!("no existe el mensaje {}", args.a_text()));
    }
    println!("progreso guardado en el tablero");
    Ok(0)
}

pub fn jira_setup(args: &Args) -> Result<i32, String> {
    let mut rest: Vec<String> = args.from(3).to_vec();
    let project_id = rest.iter().position(|x| x == "--project").and_then(|at| {
        let end = (at + 2).min(rest.len());
        rest.drain(at..end).nth(1)
    });
    let project = match project_id.as_deref().filter(|p| !p.is_empty()) {
        Some(id) => config::project(id).ok_or_else(|| format!("no hay ningún proyecto con id {id}"))?,
        None => main_project().clone(),
    };
    let Some(jira) = project.jira.clone() else {
        return Err(format!("el proyecto {} no tiene jira en board.config.json: ponle al menos jira.projects", project.id));
    };
    let jira_get = |route: &str| crate::jira::client::jira_get(route, Some(&project));
    let key_shape = Regex::new(r"^[A-Z][A-Z0-9]+-\d+$").unwrap();
    let issue = rest.first().filter(|x| key_shape.is_match(x)).cloned();
    let reviewer = rest.iter().skip(if issue.is_some() { 1 } else { 0 }).cloned().collect::<Vec<_>>().join(" ").trim().to_string();
    let me = jira_get("/myself")?;
    let mut out = json!({ "project": project.id, "me": obj(vec![("id", me.get("accountId").cloned()), ("name", me.get("displayName").cloned())]) });
    if !reviewer.is_empty() {
        let found = jira_get(&format!("/user/search?query={}", encode_uri_component(&reviewer)))?;
        let candidates: Vec<Value> = found.as_array().cloned().unwrap_or_default().iter().filter(|u| u.get("accountType").and_then(Value::as_str) == Some("atlassian")).map(|u| obj(vec![("id", u.get("accountId").cloned()), ("name", u.get("displayName").cloned())])).collect();
        out["reviewerCandidates"] = Value::Array(candidates);
    }
    let mut statuses = serde_json::Map::new();
    for p in &jira.projects {
        let value = match jira_get(&format!("/project/{}/statuses", encode_uri_component(p))) {
            Ok(types) => {
                let mut names: Vec<Value> = Vec::new();
                for t in types.as_array().cloned().unwrap_or_default() {
                    for s in t.get("statuses").and_then(Value::as_array).cloned().unwrap_or_default() {
                        let name = s.get("name").cloned().unwrap_or(Value::Null);
                        if !names.contains(&name) {
                            names.push(name);
                        }
                    }
                }
                Value::Array(names)
            }
            Err(e) => Value::from(format!("no se pudo leer ({e})")),
        };
        statuses.insert(p.clone(), value);
    }
    out["statuses"] = Value::Object(statuses);
    if let Some(issue) = issue {
        let found = jira_get(&format!("/issue/{issue}/transitions"))?;
        let transitions: Vec<Value> = found.get("transitions").and_then(Value::as_array).cloned().unwrap_or_default().iter().map(|t| {
            let to = match t.get("to") {
                Some(to) if truthy(Some(to)) => to.get("name").cloned(),
                other => other.cloned(),
            };
            obj(vec![("id", t.get("id").cloned()), ("name", t.get("name").cloned()), ("to", to)])
        }).collect();
        out["transitionsFrom"] = json!({ "issue": issue, "transitions": transitions });
    }
    json(&out);
    Ok(0)
}

fn context_tidy(args: &Args) -> Result<i32, String> {
    let cmd = args.cmd();
    let text = slice_chars(&args.rest(4), 4000);
    let a = args.a();
    let who = crate::commands::caller::who_calls(None);
    if !crate::commands::caller::has_role(who.as_ref(), &["orchestrator"]) {
        let d = load();
        let o = d.get("contextTidies").and_then(Value::as_object).and_then(|m| m.values().find(|x| truthy(Some(x)) && x.get("id").and_then(Value::as_str).is_some() && x.get("id").and_then(Value::as_str) == a && truthy(x.get("project"))).cloned());
        let area_project = who.as_ref().and_then(|w| w.get("area")).filter(|x| truthy(Some(x))).map(|x| x.get("project").cloned().unwrap_or(Value::Null));
        let allowed = match (&o, &area_project) {
            (Some(o), Some(p)) => o.get("project") == Some(p),
            _ => false,
        };
        if !allowed {
            return Err(crate::commands::caller::refuse(&cmd, &["orchestrator"], who.as_ref(), Some("o, si es la ordenación de otro proyecto, una sesión de ese proyecto")));
        }
    }
    let start = cmd == "tidy-start";
    let error = mutate(|d| {
        let matches = |x: &Value| truthy(Some(x)) && x.get("id").and_then(Value::as_str).is_some() && x.get("id").and_then(Value::as_str) == a;
        let main_matches = d.get("contextTidy").is_some_and(|x| matches(x));
        let o: Option<&mut Value> = if main_matches { d.get_mut("contextTidy") } else { d.get_mut("contextTidies").and_then(Value::as_object_mut).and_then(|m| m.values_mut().find(|x| matches(x))) };
        let Some(o) = o else {
            return format!("no hay ninguna ordenación {}", a.unwrap_or(""));
        };
        if start {
            if o.get("status").and_then(Value::as_str) != Some("approved") || o.get("approvedVia").and_then(Value::as_str) != Some("board") {
                return format!("esa ordenación no está aprobada por {} en el tablero", *ME);
            }
            o["status"] = Value::from("in-progress");
            o["startedAt"] = Value::from(now());
        } else {
            if o.get("status").and_then(Value::as_str) != Some("in-progress") {
                return "esa ordenación no está en curso".to_string();
            }
            o["status"] = Value::from("done");
            o["finishedAt"] = Value::from(now());
            o["summary"] = Value::from(if text.is_empty() { "Hecha.".to_string() } else { text.clone() });
        }
        String::new()
    });
    if !error.is_empty() {
        return Err(error);
    }
    let a = args.a_text();
    println!("{}", if start { format!("{a} en curso") } else { format!("{a} terminada; resumen guardado en el tablero") });
    Ok(0)
}

pub fn tidy_start(args: &Args) -> Result<i32, String> {
    context_tidy(args)
}

pub fn tidy_end(args: &Args) -> Result<i32, String> {
    context_tidy(args)
}

//! Port of src/commands/tasks.js.
use crate::commands::args::{Args, MY_FIRST_NAME, ME, concat, is_one_of, json, key_list, list_mut, map_mut, or, parse_json, slice_chars, status, str_of, text};
use crate::core::config::{self, main_project, normalize};
use crate::core::data::{DATA_DIR, Doc, HUMAN_APPROVALS, IN_SESSION, STATUSES, is_uuid, load, mutate, now, read_stdin};
use crate::core::json::{num, truthy};
use crate::core::migrate::{CAUSE, TASK_KIND};
use crate::features::holds;
use crate::server::push::send_push;
use crate::sessions::registry::{assign_refs, load_routes, open_in_vs_code, title_key};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::sync::{LazyLock, OnceLock};

static ROUTES: OnceLock<Value> = OnceLock::new();
static TO_STATUS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"status: .* -> (.*)$").unwrap());
static UNASSIGNED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)sin asignar|unassigned").unwrap());

fn routes() -> &'static Value {
    ROUTES.get_or_init(load_routes)
}

fn task_of<'a>(d: &'a Doc, key: &str) -> Option<&'a Value> {
    d.get("tasks").and_then(|t| t.get(key)).filter(|t| truthy(Some(t)))
}

fn input_or_stdin(v: Option<&str>) -> String {
    v.filter(|x| !x.is_empty()).map(String::from).unwrap_or_else(read_stdin)
}

fn removed_card(d: &Doc, t: &Value) -> Option<Value> {
    let key = text(t.get("key"));
    if !is_one_of(t.get("kind"), &["returned", "comment"]) || !truthy(d.get("deleted").and_then(|x| x.get(key.as_str()))) {
        return None;
    }
    let mut found: Option<Value> = None;
    if let Ok(content) = std::fs::read_to_string(DATA_DIR.join("task-history.jsonl")) {
        let needle = format!("\"{key}\"");
        for line in content.split('\n') {
            if !line.contains(&needle) {
                continue;
            }
            let Ok(r) = serde_json::from_str::<Value>(line) else { break };
            if r.get("key").and_then(Value::as_str) == Some(key.as_str()) && truthy(r.get("area")) {
                found = Some(r);
            }
        }
    }
    let found = found?;
    let status = if found.get("status").and_then(Value::as_str) == Some("partial") { Value::from("done") } else { found.get("status").cloned().unwrap_or(Value::Null) };
    Some(json!({ "area": found["area"], "status": status, "removed": true }))
}

fn leftovers(t: &Value) -> Vec<String> {
    let p = config::project(&crate::core::projects::project_of(t));
    let mut roots: Vec<PathBuf> = Vec::new();
    for r in [p.and_then(|p| p.root), main_project().root.clone()].into_iter().flatten() {
        let resolved = normalize(&r);
        if !roots.contains(&resolved) {
            roots.push(resolved);
        }
    }
    let key = text(t.get("key"));
    roots.iter().flat_map(|r| ["pruebas", ".attachments"].map(|dir| r.join(dir).join(&key))).filter(|f| f.exists()).map(|f| f.to_string_lossy().to_string()).collect()
}

fn needs_cause(d: &Doc, t: &Value) -> bool {
    if t.get("kind").and_then(Value::as_str) != Some("returned") {
        return false;
    }
    let since_text = or(t.get("returnedAt"), t.get("at")).filter(|v| truthy(Some(v))).map(|v| text(Some(&v))).unwrap_or_default();
    let since = crate::core::time::parse(&since_text).unwrap_or(0);
    let key = t.get("key");
    !d.get("causes").and_then(Value::as_array).is_some_and(|causes| causes.iter().any(|c| c.get("key") == key && c.get("at").and_then(Value::as_str).and_then(crate::core::time::parse).unwrap_or(0) >= since))
}

fn done_refusal(d: &Doc, t: &Value, again: &str) -> Vec<String> {
    let mut out = Vec::new();
    let key = text(t.get("key"));
    let left = leftovers(t);
    if !left.is_empty() {
        let list = left.iter().map(|f| f.replace('\\', "/")).collect::<Vec<_>>().join(", ");
        out.push(format!("{key}: no se da por hecha porque quedan restos de la prueba en {list}. Bórralos (lo de pruebas/{key}/ y .attachments/{key}/ se borra al cerrar la tarea) y vuelve a lanzar {again}."));
    }
    if needs_cause(d, t) {
        out.push(format!("{key}: no se da por hecha porque volvió de la revisión (devuelta) y no tiene apuntada la causa. Apúntala primero con «board.js cause {key} written|new <dónde estaba escrito, o qué se ha apuntado ahora>» y vuelve a lanzar {again}."));
    }
    out
}

fn lookup(table: &[(&'static str, &'static str)], v: Option<&Value>) -> Option<&'static str> {
    let s = v?.as_str()?;
    table.iter().find(|(k, _)| *k == s).map(|(_, x)| *x)
}

fn tail(mut list: Vec<Value>, n: usize) -> Vec<Value> {
    let skip = list.len().saturating_sub(n);
    list.split_off(skip)
}

pub fn add(args: &Args) -> Result<i32, String> {
    let items = concat(parse_json(&input_or_stdin(args.a()))?);
    let (out, pending) = mutate(|d| {
        let mut out: Vec<String> = Vec::new();
        let mut added = 0;
        let mut pending = 0;
        for raw in &items {
            let mut t: Map<String, Value> = raw.as_object().cloned().unwrap_or_default();
            let evento = t.shift_remove("evento");
            if let Some(mapped) = lookup(TASK_KIND, t.get("kind")) {
                t.insert("kind".into(), Value::from(mapped));
            }
            if !truthy(t.get("event")) {
                match evento {
                    Some(v) => {
                        t.insert("event".into(), v);
                    }
                    None => {
                        t.shift_remove("event");
                    }
                }
            }
            let t = Value::Object(t);
            let key = text(t.get("key"));
            let kind = t.get("kind").cloned();
            let previous: Option<Value> = task_of(d, &key).cloned().or_else(|| removed_card(d, &t));
            let used = previous.as_ref().is_some_and(|p| truthy(t.get("event")) && p.get("events").and_then(Value::as_array).is_some_and(|e| e.contains(&t["event"])));
            let comes_back = previous.as_ref().is_some_and(|p| !used && is_one_of(kind.as_ref(), &["returned", "comment"]) && is_one_of(p.get("status"), &["sent", "ignored", "done"]));
            if previous.is_some() && !comes_back {
                out.push(format!("{key}: ya existe, no se toca"));
                continue;
            }
            if previous.is_none() && kind.as_ref().and_then(Value::as_str) == Some("new") && truthy(d.get("deleted").and_then(|x| x.get(key.as_str()))) {
                out.push(format!("{key}: la borraste del tablero, no se vuelve a crear"));
                continue;
            }
            let mut fields: Map<String, Value> = t.as_object().cloned().unwrap_or_default();
            let event = fields.get("event").cloned();
            for k in ["status", "approvedVia", "decidedAt", "sentAt", "event"] {
                fields.shift_remove(k);
            }
            let project = match or(fields.get("project"), previous.as_ref().and_then(|p| p.get("project"))) {
                Some(v) if truthy(Some(&v)) => v,
                _ => Value::from(crate::core::projects::project_of(&Value::Object(fields.clone()))),
            };
            let mut task = fields.clone();
            task.insert("project".into(), project);
            task.insert("status".into(), Value::from("pending"));
            let mut events = previous.as_ref().and_then(|p| p.get("events")).and_then(Value::as_array).cloned().unwrap_or_default();
            if truthy(event.as_ref()) {
                events.push(event.clone().unwrap());
            }
            task.insert("events".into(), Value::Array(tail(events, 20)));
            if previous.as_ref().is_some_and(|p| truthy(p.get("removed"))) && truthy(d.get("deleted")) {
                if let Some(deleted) = d.get_mut("deleted").and_then(Value::as_object_mut) {
                    deleted.shift_remove(&key);
                }
            }
            if task.get("kind").and_then(Value::as_str) == Some("returned") {
                task.insert("returnedAt".into(), Value::from(now()));
            }
            let kind_text = text(kind.as_ref());
            if comes_back {
                let p = previous.as_ref().unwrap();
                let proposed = [fields.get("proposedArea"), p.get("area"), p.get("proposedArea")].into_iter().find(|x| truthy(*x)).flatten().cloned().unwrap_or(Value::from(""));
                task.insert("proposedArea".into(), proposed);
                let rounds = p.get("rounds").and_then(Value::as_f64).filter(|r| *r != 0.0).unwrap_or(0.0) + 1.0;
                task.insert("rounds".into(), num(rounds));
                let task_value = Value::Object(task.clone());
                let previous_area = p.get("area").filter(|a| truthy(Some(a))).map(|a| text(Some(a)));
                let held = match &previous_area {
                    Some(area) => holds::check_task(d, &task_value, Some(area), None),
                    None => String::new(),
                };
                let prev_status = text(p.get("status"));
                if !held.is_empty() {
                    out.push(format!("{key}: ya estaba {prev_status}; tu regla de devueltas la mandaría sola, pero {held} Queda en Pendientes."));
                } else if let Some(area) = previous_area {
                    task.insert("status".into(), Value::from("approved"));
                    task.insert("area".into(), Value::from(area.as_str()));
                    task.insert("decidedAt".into(), Value::from(now()));
                    task.insert("approvedVia".into(), Value::from("rule"));
                    out.push(format!("{key}: ya estaba {prev_status}; vuelve sola a su sesión ({area}) por la regla de devueltas de {}", *ME));
                } else {
                    out.push(format!("{key}: ya estaba {prev_status}; vuelve a Pendientes como {kind_text}"));
                }
            } else if previous.is_none() && is_one_of(task.get("kind"), &["returned", "comment"]) && truthy(task.get("proposedArea")) && truthy(routes().get("areas").and_then(|a| a.get(text(task.get("proposedArea")).as_str()))) {
                let area = text(task.get("proposedArea"));
                let held = holds::check_task(d, &Value::Object(task.clone()), Some(&area), None);
                if !held.is_empty() {
                    out.push(format!("{key}: el tablero no la había enviado; tu regla de devueltas la mandaría a {area}, pero {held} Queda en Pendientes."));
                } else {
                    task.insert("status".into(), Value::from("approved"));
                    task.insert("area".into(), Value::from(area.as_str()));
                    task.insert("decidedAt".into(), Value::from(now()));
                    task.insert("approvedVia".into(), Value::from("rule"));
                    out.push(format!("{key}: el tablero no la había enviado; va sola a la sesión propuesta ({area}) por la regla de devueltas de {}", *ME));
                }
            }
            if task.get("status").and_then(Value::as_str) == Some("pending") {
                pending += 1;
            }
            map_mut(d, "tasks").insert(key, Value::Object(task));
            added += 1;
        }
        out.push(format!("{added} tarjeta(s) añadida(s)"));
        (out, pending)
    });
    println!("{}", out.join("\n"));
    if pending > 0 {
        let text = if pending == 1 { "Hay una tarea nueva en Pendientes".to_string() } else { format!("Hay {pending} tareas nuevas en Pendientes") };
        let n = send_push("tasks", false, Some(&text));
        if n > 0 {
            println!("aviso enviado a {n} dispositivo(s)");
        }
    }
    Ok(0)
}

pub fn task_new(args: &Args) -> Result<i32, String> {
    let argv: Vec<String> = args.from(3).to_vec();
    let at = argv.iter().position(|x| x == "--project");
    let project = at.and_then(|i| argv.get(i + 1).cloned());
    let words: Vec<String> = match at {
        Some(i) => argv.iter().enumerate().filter(|(j, _)| *j != i && *j != i + 1).map(|(_, x)| x.clone()).collect(),
        None => argv.clone(),
    };
    let mut input = Map::new();
    if let Some(p) = project {
        input.insert("project".into(), Value::from(p));
    }
    if let Some(w) = words.first() {
        input.insert("title".into(), Value::from(w.as_str()));
    }
    input.insert("description".into(), Value::from(words.iter().skip(1).cloned().collect::<Vec<_>>().join(" ")));
    let key = mutate(|d| crate::features::manual_tasks::create_task(d, &Value::Object(input)))?;
    println!("{key} creada en Pendientes");
    Ok(0)
}

pub fn list(args: &Args) -> Result<i32, String> {
    let wanted = args.a().filter(|a| !a.is_empty()).map(status);
    if let Some(w) = &wanted {
        if !STATUSES.contains(&w.as_str()) {
            return Err(format!("estado desconocido: {}", args.a_text()));
        }
    }
    let d = load();
    let visible: Vec<Value> = d.get("tasks").and_then(Value::as_object).map(|m| m.values().cloned().collect::<Vec<_>>()).unwrap_or_default().into_iter().filter(|t| wanted.as_deref().is_none_or(|w| t.get("status").and_then(Value::as_str) == Some(w))).collect();
    let unseen = |t: &Value| t.get("status").and_then(Value::as_str) == Some("approved") && !is_one_of(t.get("approvedVia"), &HUMAN_APPROVALS);
    for t in visible.iter().filter(|t| unseen(t)) {
        eprintln!("AVISO: {} figura como aprobada sin pasar por el tablero ni por una orden de {} en el chat. No se envía.", text(t.get("key")), *ME);
    }
    json(&Value::Array(visible.iter().filter(|t| !unseen(t)).cloned().collect()));
    Ok(0)
}

pub fn update(args: &Args) -> Result<i32, String> {
    let mut patch = parse_json(&input_or_stdin(args.b()))?;
    if truthy(patch.get("status")) {
        if let Some(s) = patch.get("status").and_then(Value::as_str) {
            patch["status"] = Value::from(status(s));
        }
    }
    let a = args.a_text();
    let error = mutate(|d| {
        let Some(t) = task_of(d, &a).cloned() else { return format!("no existe {a}") };
        let has = |k: &str| patch.get(k).is_some();
        if has("approvedVia") || has("decidedAt") {
            return "approvedVia y decidedAt solo los pone el tablero".into();
        }
        let st = patch.get("status");
        if truthy(st) && st.and_then(Value::as_str) != Some("sent") {
            return format!("el estado «{}» lo decide {}: en el tablero, o por chat con approve-chat", text(st), *ME);
        }
        let to_sent = st.and_then(Value::as_str) == Some("sent");
        if to_sent && !(t.get("status").and_then(Value::as_str) == Some("approved") && is_one_of(t.get("approvedVia"), &HUMAN_APPROVALS)) {
            return format!("{a} no está aprobada por {}: no se puede marcar como enviada", *ME);
        }
        if to_sent {
            let held = holds::check_task(d, &t, t.get("area").and_then(Value::as_str), None);
            if !held.is_empty() {
                return held;
            }
        }
        if to_sent && !truthy(patch.get("sentAt")) {
            patch["sentAt"] = Value::from(now());
        }
        if let Some(t) = map_mut(d, "tasks").get_mut(&a) {
            crate::commands::args::assign(t, &patch);
        }
        String::new()
    });
    if !error.is_empty() {
        return Err(error);
    }
    println!("{a} actualizada");
    Ok(0)
}

pub fn approve_chat(args: &Args) -> Result<i32, String> {
    crate::commands::caller::only_from("approve-chat", &["orchestrator", "reporter"], None)?;
    let area = args.b().unwrap_or("").to_string();
    let a = args.a_text();
    let error = mutate(|d| {
        let Some(t) = task_of(d, &a).cloned() else { return format!("no existe {a}") };
        if t.get("status").and_then(Value::as_str) == Some("sent") {
            return format!("{a} ya está enviada");
        }
        let routes = load_routes();
        let areas = routes.get("areas").and_then(Value::as_object).cloned().unwrap_or_default();
        if area.is_empty() || !truthy(areas.get(&area)) {
            let shown = if area.is_empty() { "(falta)".to_string() } else { area.clone() };
            return format!("área desconocida: {shown}. Las que hay: {}", areas.keys().cloned().collect::<Vec<_>>().join(", "));
        }
        let held = holds::check_task(d, &t, Some(&area), None);
        if !held.is_empty() {
            return held;
        }
        if let Some(t) = map_mut(d, "tasks").get_mut(&a).and_then(Value::as_object_mut) {
            t.insert("status".into(), Value::from("approved"));
            t.insert("area".into(), Value::from(area.as_str()));
            t.insert("decidedAt".into(), Value::from(now()));
            t.insert("approvedVia".into(), Value::from("chat"));
            t.shift_remove("delivery");
        }
        String::new()
    });
    if !error.is_empty() {
        return Err(error);
    }
    println!("{a} aprobada por orden de {} en el chat -> {area}", *ME);
    Ok(0)
}

pub fn attachments(args: &Args) -> Result<i32, String> {
    let v = crate::jira::client::download_attachments(args.a().unwrap_or(""))?;
    json(&v);
    Ok(0)
}

pub fn delivered(args: &Args) -> Result<i32, String> {
    let keys = key_list(&args.from(3).join(","));
    let n = mutate(|d| {
        let mut k = 0;
        let tasks = map_mut(d, "tasks");
        for c in &keys {
            let Some(t) = tasks.get_mut(c).filter(|t| truthy(Some(t))) else { continue };
            if !truthy(t.get("answer")) || truthy(t["answer"].get("delivered")) {
                continue;
            }
            t["answer"]["delivered"] = Value::Bool(true);
            t["answer"]["deliveredAt"] = Value::from(now());
            let mut history = t.get("history").and_then(Value::as_array).cloned().unwrap_or_default();
            history.push(crate::commands::args::obj(vec![("type", Some(Value::from("answer"))), ("text", t["answer"].get("text").cloned()), ("at", t["answer"].get("at").cloned())]));
            t["history"] = Value::Array(tail(history, 10));
            t["status"] = Value::from("sent");
            k += 1;
        }
        k
    });
    println!("{n} de {} respuesta(s) marcadas como entregadas; la tarea vuelve a Enviadas", keys.len());
    Ok(0)
}

fn time_of(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::String(s)) => crate::core::time::parse(s),
        Some(Value::Number(n)) => n.as_f64().map(|x| x as i64),
        _ => None,
    }
}

pub fn changes(_args: &Args) -> Result<i32, String> {
    let events = concat(parse_json(&read_stdin())?);
    let mut withdrawn = 0;
    let n = mutate(|d| {
        let mut marked = 0;
        for e in &events {
            let key = text(e.get("key"));
            let Some(t) = map_mut(d, "tasks").get_mut(&key).filter(|t| truthy(Some(t))) else { continue };
            if !truthy(e.get("at")) || !truthy(e.get("text")) {
                continue;
            }
            if truthy(e.get("assignee")) {
                t["assignee"] = e["assignee"].clone();
            }
            if truthy(e.get("assignee")) {
                let assignee = text(e.get("assignee"));
                if !MY_FIRST_NAME.is_match(&assignee) && !UNASSIGNED.is_match(&assignee) && is_one_of(t.get("status"), &["pending", "approved", "ignored"]) && !truthy(t.get("withdrawn")) {
                    let at = now();
                    t["withdrawn"] = json!({ "by": e["assignee"], "at": at });
                    t["status"] = Value::from("ignored");
                    t["decidedAt"] = Value::from(at);
                    if let Some(m) = t.as_object_mut() {
                        m.shift_remove("approvedVia");
                    }
                    withdrawn += 1;
                }
            }
            let since = if is_one_of(t.get("status"), &IN_SESSION) { or(t.get("sentAt"), t.get("at")) } else { t.get("at").cloned() };
            let e_text = text(e.get("text"));
            if let Some(c) = TO_STATUS.captures(&e_text) {
                let st = crate::jira::sites::statuses(Some(&crate::jira::sites::for_key(&key)));
                if st.closed_regex.is_match(c[1].trim()) {
                    t["jiraClosedAt"] = e["at"].clone();
                }
            }
            if !truthy(since.as_ref()) {
                continue;
            }
            if let (Some(at), Some(since)) = (time_of(e.get("at")), time_of(since.as_ref())) {
                if at <= since {
                    continue;
                }
            }
            let mut list = t.get("changes").and_then(Value::as_array).cloned().unwrap_or_default();
            if list.iter().any(|c| c.get("at") == e.get("at") && c.get("text") == e.get("text")) {
                t["changes"] = Value::Array(list);
                continue;
            }
            list.push(json!({ "at": e["at"], "text": slice_chars(&e_text, 300), "who": or(e.get("who"), Some(&Value::Null)).unwrap() }));
            list.sort_by(|x, y| text(x.get("at")).cmp(&text(y.get("at"))));
            t["changes"] = Value::Array(tail(list, 12));
            marked += 1;
        }
        marked
    });
    let note = if withdrawn > 0 { format!("; {withdrawn} tarjeta(s) retirada(s) porque otra persona tiene el ticket") } else { String::new() };
    println!("{n} cambio(s) anotado(s) en tarjetas{note}");
    Ok(0)
}

pub fn sessions(args: &Args) -> Result<i32, String> {
    let list = concat(parse_json(&input_or_stdin(args.a()))?);
    mutate(|d| {
        d.insert("sessions".into(), json!({ "list": list, "syncedAt": now() }));
    });
    println!("{} sesión(es) guardada(s)", list.len());
    println!("{} referencia(s) casada(s) con su conversación", assign_refs(&list));
    Ok(0)
}

pub fn epics(args: &Args) -> Result<i32, String> {
    let list = concat(parse_json(&input_or_stdin(args.a()))?);
    mutate(|d| {
        let at = now();
        let seen = map_mut(d, "seenEpics");
        for e in &list {
            if truthy(e.get("key")) {
                let name = or(e.get("name"), e.get("key")).unwrap_or(Value::Null);
                seen.insert(text(e.get("key")), json!({ "name": name, "seenAt": at }));
            }
        }
    });
    println!("{} bloque(s) anotado(s)", list.len());
    Ok(0)
}

pub fn jira_epics(_args: &Args) -> Result<i32, String> {
    match crate::jira::client::sync_jira_epics() {
        Ok(n) => {
            println!("{n} epics leídos de Jira");
            Ok(0)
        }
        Err(e) => Err(format!("Error: {e}")),
    }
}

pub fn open(args: &Args) -> Result<i32, String> {
    let st = crate::server::state::state();
    let as_target = |x: Option<&Value>| -> Option<Value> {
        let x = x.filter(|x| truthy(Some(x)))?;
        Some(crate::commands::args::obj(vec![("name", x.get("title").cloned()), ("conversation", x.get("conversation").cloned()), ("open", x.get("open").cloned()), ("sessionName", x.get("session").cloned())]))
    };
    let a = args.a().unwrap_or("");
    let role = match a {
        "orchestrator" | "orquestador" => as_target(st.get("orchestrator")),
        "followup" | "seguimiento" => as_target(st.get("followUpStatus")),
        "board" | "tablero" => as_target(st.get("boardStatus")),
        _ => None,
    };
    let target = role.or_else(|| st.get("areas").and_then(Value::as_array).and_then(|areas| areas.iter().find(|x| x.get("id").and_then(Value::as_str) == Some(a) || (truthy(x.get("name")) && title_key(&text(x.get("name"))) == title_key(a))).cloned()));
    let Some(target) = target else {
        return Err(format!("sesión desconocida: {}", args.a_text()));
    };
    let name = text(target.get("name"));
    let conversation = str_of(&target, "conversation").to_string();
    if !is_uuid(&conversation) {
        return Err(format!("«{name}» no tiene una conversación enlazada: ábrela a mano en VS Code una vez."));
    }
    if truthy(target.get("open")) {
        println!("«{name}» ya está abierta ({}).", text(target.get("sessionName")));
        return Ok(0);
    }
    open_in_vs_code(Some(&conversation));
    println!("Pedido a VS Code que abra «{name}». Comprueba con `areas` que pasa a open.");
    Ok(0)
}

pub fn areas(_args: &Args) -> Result<i32, String> {
    crate::commands::args::json_of(crate::server::state::state().get("areas"));
    Ok(0)
}

pub fn learning_read(_args: &Args) -> Result<i32, String> {
    let n = crate::jira::learning::read_jira()?;
    println!("{n} ticket(s) leídos de Jira para la pestaña Aprendizaje");
    Ok(0)
}

pub fn cause(args: &Args) -> Result<i32, String> {
    let b = args.b().unwrap_or("");
    let cause = CAUSE.iter().find(|(k, _)| *k == b).map(|(_, v)| v.to_string()).unwrap_or_else(|| b.to_string());
    let note = slice_chars(&args.rest(5), 600);
    let a = args.a().unwrap_or("");
    if a.is_empty() || !["written", "new"].contains(&cause.as_str()) || note.is_empty() {
        return Err("Uso: board.js cause <CLAVE> written|new <dónde estaba escrito, o qué se ha apuntado ahora>".into());
    }
    let with_card = crate::jira::learning::save_cause(a, &cause, Some(&note));
    println!("causa de la devolución de {a} apuntada como «{cause}»{}", if with_card { "" } else { " (sin tarjeta en el tablero)" });
    Ok(0)
}

fn session_notice(args: &Args) -> Result<i32, String> {
    let cmd = args.cmd();
    let rest: Vec<String> = args.from(3).to_vec();
    let keys = key_list(rest.first().map(String::as_str).unwrap_or(""));
    let text_in = slice_chars(rest.iter().skip(1).cloned().collect::<Vec<_>>().join(" ").trim(), if cmd == "comment" { 5000 } else { 1200 });
    if keys.is_empty() || text_in.is_empty() {
        let mention = main_project().jira.as_ref().and_then(|j| j.reviewer.get("mentions")).and_then(|m| m.get(0)).filter(|m| truthy(Some(m))).map(|m| text(Some(m))).unwrap_or_else(|| "@revisor".into());
        return Err(format!("Uso: board.js done <CLAVE>[,<CLAVE>…] <qué se ha hecho y en qué proyectos> | partial <CLAVE>[,…] <motivo claro> | question <CLAVE>[,…] <pregunta para {}> | comment <CLAVE> <comentario propuesto para Jira; {mention} lo menciona>", *ME));
    }
    let new_status = if cmd == "question" || cmd == "comment" { "waiting".to_string() } else { cmd.clone() };
    let notice_type = cmd.clone();
    let errors = mutate(|d| {
        let mut out: Vec<String> = Vec::new();
        for k in &keys {
            let Some(t) = task_of(d, k).cloned() else {
                out.push(format!("{k} no tiene tarjeta en el tablero: cuéntaselo a {} en tu propia sesión", *ME));
                continue;
            };
            let manual = truthy(t.get("manual"));
            if !is_one_of(t.get("status"), &IN_SESSION) || manual {
                out.push(format!("{k} no está en ninguna sesión según el tablero (estado: {}{})", text(t.get("status")), if manual { ", resuelta a mano" } else { "" }));
                continue;
            }
            if cmd == "done" {
                let refusal = done_refusal(d, &t, &format!("«board.js done {k} …»"));
                if !refusal.is_empty() {
                    out.push(refusal.join("\n"));
                    continue;
                }
            }
            let at = now();
            let Some(t) = map_mut(d, "tasks").get_mut(k) else { continue };
            t["status"] = Value::from(new_status.as_str());
            t["notice"] = json!({ "type": notice_type, "text": text_in, "at": at });
            let mut history = t.get("history").and_then(Value::as_array).cloned().unwrap_or_default();
            history.push(json!({ "type": notice_type, "text": text_in, "at": at }));
            t["history"] = Value::Array(tail(history, 10));
            if truthy(t.get("answer")) && truthy(t["answer"].get("delivered")) {
                if let Some(m) = t.as_object_mut() {
                    m.shift_remove("answer");
                }
            }
        }
        out
    });
    for e in &errors {
        eprintln!("{e}");
    }
    println!("{} de {} anotada(s) como «{cmd}» en el tablero", keys.len() - errors.len(), keys.len());
    let what = match cmd.as_str() {
        "partial" => "se ha quedado a medias",
        "question" => "tiene una pregunta para ti",
        "comment" => "propone un comentario para Jira",
        _ => "undefined",
    };
    if cmd != "done" && keys.len() > errors.len() {
        let ok: Vec<String> = keys.iter().filter(|k| !errors.iter().any(|e| e.starts_with(k.as_str()))).cloned().collect();
        send_push("sessions", true, Some(&format!("{} {what}", ok.join(", "))));
    }
    Ok(if errors.is_empty() { 0 } else { 1 })
}

pub fn done(args: &Args) -> Result<i32, String> {
    session_notice(args)
}

pub fn partial(args: &Args) -> Result<i32, String> {
    session_notice(args)
}

pub fn question(args: &Args) -> Result<i32, String> {
    session_notice(args)
}

pub fn comment(args: &Args) -> Result<i32, String> {
    session_notice(args)
}

fn sent_or_reply(args: &Args) -> Result<i32, String> {
    let cmd = args.cmd();
    let rest: Vec<String> = args.from(3).to_vec();
    let keys: Vec<String> = if cmd == "sent" { rest.clone() } else { key_list(rest.first().map(String::as_str).unwrap_or("")) };
    let reply_text = if cmd == "reply" { slice_chars(rest.iter().skip(1).cloned().collect::<Vec<_>>().join(" ").trim(), 600) } else { String::new() };
    if keys.is_empty() || (cmd == "reply" && reply_text.is_empty()) {
        return Err("Uso: board.js sent <CLAVE|id>… | board.js reply <CLAVE|id>[,<CLAVE>…] <texto>".into());
    }
    let errors = mutate(|d| {
        let mut out: Vec<String> = Vec::new();
        for k in &keys {
            let task = task_of(d, k).cloned();
            let deploy_index = list_mut(d, "deployments").iter().position(|y| y.get("id").and_then(Value::as_str) == Some(k.as_str()));
            let deploy = deploy_index.map(|i| d["deployments"][i].clone());
            let Some(item) = task.clone().or(deploy.clone()) else {
                out.push(format!("no existe {k}"));
                continue;
            };
            let patch = if cmd == "reply" {
                Some(json!({ "reply": reply_text }))
            } else {
                let approved = item.get("status").and_then(Value::as_str) == Some("approved") && match &task {
                    Some(t) => is_one_of(t.get("approvedVia"), &HUMAN_APPROVALS),
                    None => deploy.as_ref().and_then(|x| x.get("approvedVia")).and_then(Value::as_str) == Some("board"),
                };
                if !approved {
                    out.push(format!("{k} no está aprobada por {} y esperando envío", *ME));
                    continue;
                }
                let held = match &task {
                    Some(t) => holds::check_task(d, t, t.get("area").and_then(Value::as_str), None),
                    None => holds::check_area(d, &format!("El despliegue {k}"), deploy.as_ref().map(|x| str_of(x, "area")).unwrap_or(""), None),
                };
                if !held.is_empty() {
                    out.push(held);
                    continue;
                }
                None
            };
            let target: Option<&mut Value> = if task.is_some() { map_mut(d, "tasks").get_mut(k) } else { deploy_index.and_then(|i| list_mut(d, "deployments").get_mut(i)) };
            let Some(target) = target else { continue };
            match patch {
                Some(p) => crate::commands::args::assign(target, &p),
                None => {
                    target["status"] = Value::from("sent");
                    target["sentAt"] = Value::from(now());
                    if let Some(m) = target.as_object_mut() {
                        m.shift_remove("changes");
                    }
                }
            }
        }
        out
    });
    for e in &errors {
        eprintln!("{e}");
    }
    let what = if cmd == "sent" { "marcada(s) como enviada(s)" } else { "con la respuesta guardada" };
    println!("{} de {} {what}", keys.len() - errors.len(), keys.len());
    Ok(if errors.is_empty() { 0 } else { 1 })
}

pub fn sent(args: &Args) -> Result<i32, String> {
    sent_or_reply(args)
}

pub fn reply(args: &Args) -> Result<i32, String> {
    sent_or_reply(args)
}

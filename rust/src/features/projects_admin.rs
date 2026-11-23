//! Port of src/features/projects-admin.js.
use crate::core::config::{self, Project, main_project, normalize, projects, slashes};
use crate::core::data::{load, mutate, now};
use crate::core::json::{stringify, stringify_pretty, truthy};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const SECRETS: [&str; 4] = ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"];
const OPEN: [&str; 5] = ["pending", "approved", "sent", "waiting", "partial"];
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,39}$").unwrap());
static PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]{2,10}$").unwrap());
static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_.-]{0,63}$").unwrap());

pub type JiraAsk<'a> = &'a dyn Fn(&str) -> Result<Value, String>;

pub fn secret(p: &Project, name: &str) -> Option<String> {
    if p.index == 0 {
        return p.secret(name);
    }
    config::parse_env(&p.env_file).get(name).cloned()
}

fn error(text: impl Into<String>) -> Value {
    json!({ "error": text.into() })
}

fn js_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => if *b { "true".into() } else { String::new() },
        Some(Value::Number(n)) => {
            if n.as_f64() == Some(0.0) { String::new() } else { stringify(&Value::Number(n.clone())) }
        }
        Some(Value::Array(a)) => a.iter().map(|x| match x {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            other => stringify(other),
        }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn clean(v: Option<&Value>, max: usize) -> String {
    js_text(v).trim().chars().take(max).collect()
}

fn same(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| slashes(&normalize(p).to_string_lossy()).to_lowercase();
    n(a) == n(b)
}

fn is_main(p: &Project) -> bool {
    p.id == main_project().id
}

fn write_local(id: &str, root: Option<&Path>) -> Result<(), String> {
    let mut all = config::local_projects();
    if !all.is_object() {
        all = json!({});
    }
    let map = all.as_object_mut().unwrap();
    match root {
        Some(r) => {
            map.insert(id.into(), json!({ "root": normalize(r).to_string_lossy() }));
        }
        None => {
            map.shift_remove(id);
        }
    }
    std::fs::write(config::local_projects_file(), stringify_pretty(&all, 2) + "\n").map_err(|e| e.to_string())
}

fn open_tasks(id: &str) -> usize {
    let d = load();
    d.get("tasks").and_then(Value::as_object).map(|t| t.values().filter(|t| OPEN.contains(&t.get("status").and_then(Value::as_str).unwrap_or("")) && crate::core::projects::project_of(t) == id).count()).unwrap_or(0)
}

fn name_of(v: &Value) -> Value {
    v.get("name").filter(|n| truthy(Some(n))).cloned().unwrap_or(Value::from(""))
}

pub fn list() -> Value {
    let rows: Vec<Value> = projects()
        .iter()
        .map(|p| {
            let sentry_on = p.sentry.get("org").is_some_and(|o| truthy(Some(o)));
            let modules = json!({ "jira": p.jira.is_some(), "followUp": !p.follow_up.is_empty(), "sentry": sentry_on, "deploy": !p.deploy_projects.is_empty(), "devServers": !p.dev_servers.is_empty(), "daily": p.daily, "context": p.context_tidy });
            let mut credentials = Map::new();
            for k in SECRETS {
                credentials.insert(k.into(), Value::from(secret(p, k).is_some_and(|v| !v.is_empty())));
            }
            let jira_config = p.jira.as_ref().map(|j| {
                let transitions: Vec<Value> = j.transitions.as_object().map(|t| t.keys().map(|k| Value::from(k.clone())).collect()).unwrap_or_default();
                json!({ "projects": j.projects, "me": name_of(&j.me), "reviewer": name_of(&j.reviewer), "transitions": transitions, "connected": j.me.get("id").is_some_and(|i| truthy(Some(i))) })
            });
            let sentry_config = if sentry_on {
                json!({ "org": p.sentry["org"], "projects": p.sentry.get("projects").filter(|x| truthy(Some(x))).cloned().unwrap_or(json!([])), "errorsArea": p.errors_area.clone().unwrap_or_default() })
            } else {
                Value::Null
            };
            let servers: Vec<Value> = p
                .dev_servers
                .iter()
                .map(|x| {
                    let mut words = vec![js_command(x.get("command"))];
                    words.extend(x.get("args").and_then(Value::as_array).into_iter().flatten().map(|a| js_command(Some(a))));
                    json!({ "id": x.get("id").cloned().unwrap_or(Value::Null), "name": x.get("name").cloned().unwrap_or(Value::Null), "port": x.get("port").cloned().unwrap_or(Value::Null), "command": words.join(" ") })
                })
                .collect();
            json!({
                "id": p.id,
                "name": p.name,
                "main": is_main(p),
                "editable": true,
                "fromFile": p.source != "panel",
                "taskPrefix": crate::features::manual_tasks::prefix_of(p),
                "agent": p.agent,
                "root": p.root.as_ref().map(|r| Value::from(slashes(&r.to_string_lossy()))).unwrap_or(Value::Null),
                "rootExists": p.root.as_ref().is_some_and(|r| r.exists()),
                "jira": p.jira.as_ref().map(|j| json!(j.projects)).unwrap_or(Value::Null),
                "modules": modules,
                "credentials": credentials,
                "messages": if truthy(Some(&p.messages)) { p.messages.clone() } else { Value::Null },
                "jiraConfig": jira_config,
                "sentryConfig": sentry_config,
                "devServers": servers,
                "openTasks": open_tasks(&p.id),
            })
        })
        .collect();
    Value::from(rows)
}

fn js_command(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => stringify(other),
    }
}

fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => *b as i32 as f64,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Some(_) => f64::NAN,
    }
}

enum Servers {
    Keep,
    List(Vec<Value>),
}

fn dev_servers_of(input: &Value, id: &str) -> Result<Servers, String> {
    let Some(raw_list) = input.get("devServers").and_then(Value::as_array) else { return Ok(Servers::Keep) };
    let mut out: Vec<Value> = Vec::new();
    let mut taken: Vec<(f64, String)> = Vec::new();
    for p in projects().iter().filter(|p| p.id != id) {
        for x in &p.dev_servers {
            let port = js_number(x.get("port"));
            match taken.iter_mut().find(|(n, _)| *n == port) {
                Some(slot) => slot.1 = p.name.clone(),
                None => taken.push((port, p.name.clone())),
            }
        }
    }
    static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    for raw in raw_list {
        let name = clean(raw.get("name"), 40);
        let port = js_number(raw.get("port"));
        let command = clean(raw.get("command"), 200);
        let words: Vec<String> = SPACES.split(&command).filter(|w| !w.is_empty()).map(str::to_string).collect();
        if name.is_empty() && !truthy(raw.get("port")) && words.is_empty() {
            continue;
        }
        if name.is_empty() {
            return Err("cada servidor necesita un nombre".into());
        }
        if !(port.is_finite() && port.fract() == 0.0) || !(1024.0..=65535.0).contains(&port) {
            return Err(format!("el puerto de {name} va de 1024 a 65535"));
        }
        let port_text = port as i64;
        if let Some((_, owner)) = taken.iter().find(|(n, _)| *n == port) {
            return Err(format!("el puerto {port_text} ya lo usa {owner}"));
        }
        if out.iter().any(|x| x["port"] == json!(port_text)) {
            return Err(format!("el puerto {port_text} está repetido"));
        }
        if words.is_empty() {
            return Err(format!("falta el comando de {name}, por ejemplo «npm run dev»"));
        }
        let mut sid = config::slug(&name);
        if sid.is_empty() {
            sid = format!("web-{port_text}");
        }
        while out.iter().any(|x| x["id"] == sid.as_str()) {
            sid.push_str("-2");
        }
        out.push(json!({ "id": sid, "name": name, "role": "Web", "port": port_text, "url": format!("http://localhost:{port_text}"), "command": words[0], "args": words[1..] }));
    }
    Ok(Servers::List(out))
}

fn words(v: Option<&Value>) -> Vec<String> {
    static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s,]+").unwrap());
    let items: Vec<String> = match v {
        Some(Value::Array(a)) => a.iter().map(|x| js_command(Some(x))).collect(),
        other => SPLIT.split(&js_text(other)).map(str::to_string).collect(),
    };
    items.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

fn unique(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in list {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

enum Section {
    Keep,
    Set(Value, Option<String>),
}

fn jira_of(input: &Value, id: &str, task_prefix: &str, kept: Option<&Value>) -> Result<Section, String> {
    let Some(jira) = input.get("jira") else { return Ok(Section::Keep) };
    if !truthy(Some(jira)) || jira.get("enabled") == Some(&Value::Bool(false)) {
        return Ok(Section::Set(Value::Null, None));
    }
    let keys = unique(words(jira.get("projects")).into_iter().map(|k| k.to_uppercase()).collect());
    if keys.is_empty() {
        return Err("pon al menos un proyecto de Jira, por ejemplo OPS".into());
    }
    for k in &keys {
        if !PREFIX.is_match(k) {
            return Err(format!("{k} no parece la clave de un proyecto de Jira: de 2 a 10 letras"));
        }
        if k == task_prefix {
            return Err(format!("{k} es el prefijo de las tareas a mano: usa otro para ellas"));
        }
        if let Some(other) = projects().iter().find(|p| p.id != id && p.jira.as_ref().is_some_and(|j| j.projects.contains(k))) {
            return Err(format!("{k} ya es de {}: un proyecto de Jira solo puede ir en un proyecto del tablero", other.name));
        }
    }
    let old = kept.cloned().unwrap_or(json!({}));
    let mut value = Map::new();
    value.insert("projects".into(), json!(keys));
    for k in ["me", "reviewer", "transitions"] {
        if let Some(v) = old.get(k).filter(|v| truthy(Some(v))) {
            value.insert(k.into(), v.clone());
        }
    }
    Ok(Section::Set(Value::Object(value), None))
}

fn sentry_of(input: &Value) -> Result<Section, String> {
    let Some(sentry) = input.get("sentry") else { return Ok(Section::Keep) };
    if !truthy(Some(sentry)) || sentry.get("enabled") == Some(&Value::Bool(false)) {
        return Ok(Section::Set(Value::Null, None));
    }
    let org = clean(sentry.get("org"), 64).to_lowercase();
    let list = unique(words(sentry.get("projects")).into_iter().map(|x| x.to_lowercase()).collect());
    if !SLUG.is_match(&org) {
        return Err("la organización de Sentry va como aparece en su dirección, por ejemplo mi-empresa".into());
    }
    if list.is_empty() {
        return Err("pon al menos un proyecto de Sentry".into());
    }
    if let Some(bad) = list.iter().find(|x| !SLUG.is_match(x)) {
        return Err(format!("{bad} no parece el nombre de un proyecto de Sentry"));
    }
    let errors_area = Some(clean(sentry.get("errorsArea"), 80)).filter(|a| !a.is_empty());
    if let Some(area) = &errors_area {
        let state = crate::server::state::state();
        if !state.get("areas").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(area.as_str()))) {
            return Err("esa sesión para los errores no existe".into());
        }
    }
    Ok(Section::Set(json!({ "org": org, "projects": list }), errors_area))
}

fn defs() -> Map<String, Value> {
    load().get("projectDefs").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn try_save(input: &Value) -> Result<Value, String> {
    let name = clean(input.get("name"), 60);
    if name.is_empty() {
        return Err("falta el nombre".into());
    }
    let id = if truthy(input.get("id")) { js_command(input.get("id")) } else { config::slug(&name) };
    if !ID.is_match(&id) {
        return Err("el id solo admite minúsculas, cifras y guiones".into());
    }
    let existing = config::project(&id);
    let from_file = existing.as_ref().is_some_and(|e| e.source != "panel");
    if existing.is_none() && truthy(input.get("id")) && input.get("create") == Some(&Value::Bool(false)) {
        return Err("ese proyecto no existe".into());
    }
    let mut task_prefix = clean(input.get("taskPrefix"), 10).to_uppercase();
    if task_prefix.is_empty() {
        task_prefix = id.to_uppercase().chars().filter(|c| c.is_ascii_uppercase()).take(10).collect();
    }
    if !PREFIX.is_match(&task_prefix) {
        return Err("el prefijo de tareas son de 2 a 10 letras".into());
    }
    let jira_undefined = input.get("jira").is_none();
    let jira_keys: Vec<String> = projects().iter().filter(|p| p.id != id || jira_undefined).flat_map(|p| p.jira.as_ref().map(|j| j.projects.clone()).unwrap_or_default()).collect();
    if jira_keys.contains(&task_prefix) {
        return Err(format!("{task_prefix} ya es un proyecto de Jira"));
    }
    if let Some(clash) = projects().iter().find(|p| p.id != id && crate::features::manual_tasks::prefix_of(p) == task_prefix) {
        return Err(format!("{} ya usa el prefijo {task_prefix}", clash.name));
    }
    let base = config::workspace_base();
    let typed = clean(input.get("root"), 400);
    if from_file && !typed.is_empty() {
        let e = existing.as_ref().unwrap();
        let wanted = normalize(&base.clone().unwrap_or_default().join(&typed));
        if e.root.as_ref().is_none_or(|r| !same(r, &wanted)) {
            return Err(format!("la carpeta de {} se cambia en board.config.json de cada ordenador", e.name));
        }
    }
    let mut root: Option<PathBuf> = None;
    let mut folder: Option<String> = None;
    if !from_file && (!typed.is_empty() || existing.is_none()) {
        let Some(base) = base.clone() else { return Err("no se sabe dónde está workspace en este ordenador".into()) };
        let r = normalize(&base.join(if typed.is_empty() { &id } else { &typed }));
        let base_n = normalize(&base);
        let rel = r.strip_prefix(&base_n).ok().map(|p| slashes(&p.to_string_lossy())).filter(|p| !p.is_empty());
        let Some(rel) = rel else { return Err(format!("la carpeta tiene que estar dentro de {}", slashes(&base.to_string_lossy()))) };
        if r.exists() && !r.is_dir() {
            return Err("ahí hay un fichero, no una carpeta".into());
        }
        if let Some(taken) = projects().iter().find(|p| p.id != id && p.root.as_ref().is_some_and(|pr| same(pr, &r))) {
            return Err(format!("esa carpeta ya es de {}", taken.name));
        }
        folder = Some(rel);
        root = Some(r);
    }
    if !from_file && typed.is_empty() && existing.is_some() {
        folder = defs().get(&id).and_then(|d| d.get("folder")).filter(|f| truthy(Some(f))).map(|f| js_command(Some(f)));
    }
    let servers = dev_servers_of(input, &id)?;
    if from_file && !matches!(servers, Servers::Keep) {
        return Err(format!("los servidores de {} se cambian en board.config.json de cada ordenador", existing.as_ref().unwrap().name));
    }
    let def = defs().get(&id).cloned().unwrap_or(json!({}));
    let jira = jira_of(input, &id, &task_prefix, def.get("jira"))?;
    let sentry = sentry_of(input)?;
    if from_file && (!matches!(jira, Section::Keep) || !matches!(sentry, Section::Keep)) {
        return Err(format!("Jira y Sentry de {} se cambian en board.config.json de cada ordenador", existing.as_ref().unwrap().name));
    }
    let mut integrations = Map::new();
    let jira_value = match &jira {
        Section::Keep => def.get("jira").cloned().unwrap_or(Value::Null),
        Section::Set(v, _) => v.clone(),
    };
    if truthy(Some(&jira_value)) {
        integrations.insert("jira".into(), jira_value);
    }
    let (sentry_value, errors_area) = match &sentry {
        Section::Keep => (def.get("sentry").cloned().unwrap_or(Value::Null), def.get("errorsArea").cloned().unwrap_or(Value::Null)),
        Section::Set(v, a) => (v.clone(), a.clone().map(Value::from).unwrap_or(Value::Null)),
    };
    if truthy(Some(&sentry_value)) {
        integrations.insert("sentry".into(), sentry_value.clone());
        if truthy(Some(&errors_area)) {
            integrations.insert("errorsArea".into(), errors_area);
        }
    }
    let kept_servers: Option<Vec<Value>> = match &servers {
        Servers::Keep => defs().get(&id).and_then(|d| d.get("devServers")).and_then(Value::as_array).cloned(),
        Servers::List(l) => Some(l.clone()),
    };
    let mut messages = Map::new();
    for k in ["review", "cause", "reference"] {
        let v = input.get("messages").map(|m| clean(m.get(k), 1500)).unwrap_or_default();
        if !v.is_empty() {
            messages.insert(k.into(), Value::from(v));
        }
    }
    let daily = truthy(input.get("daily"));
    let context_tidy = truthy(input.get("contextTidy"));
    let record = if from_file {
        let e = existing.as_ref().unwrap();
        let file_messages = e.file_values.as_ref().and_then(|f| f.get("messages").cloned());
        let mut m = Map::new();
        m.insert("id".into(), Value::from(id.clone()));
        m.insert("override".into(), json!(true));
        m.insert("name".into(), Value::from(name.clone()));
        m.insert("taskPrefix".into(), Value::from(task_prefix.clone()));
        m.insert("daily".into(), Value::from(daily));
        m.insert("contextTidy".into(), Value::from(context_tidy));
        if !messages.is_empty() {
            m.insert("messages".into(), Value::Object(messages.clone()));
        } else if let Some(fm) = file_messages {
            m.insert("messages".into(), fm);
        } else if e.file_values.is_none() {
            m.insert("messages".into(), Value::Null);
        }
        m.insert("updatedAt".into(), Value::from(now()));
        Value::Object(m)
    } else {
        let mut m = Map::new();
        m.insert("id".into(), Value::from(id.clone()));
        m.insert("name".into(), Value::from(name.clone()));
        m.insert("taskPrefix".into(), Value::from(task_prefix.clone()));
        m.insert("agent".into(), json!("claude"));
        m.insert("daily".into(), Value::from(daily));
        m.insert("contextTidy".into(), Value::from(context_tidy));
        if let Some(f) = &folder {
            m.insert("folder".into(), Value::from(f.clone()));
        }
        if !messages.is_empty() {
            m.insert("messages".into(), Value::Object(messages.clone()));
        }
        if let Some(list) = kept_servers.as_ref().filter(|l| !l.is_empty()) {
            m.insert("devServers".into(), Value::from(list.clone()));
        }
        m.extend(integrations);
        m.insert("updatedAt".into(), Value::from(now()));
        Value::Object(m)
    };
    mutate(|d| {
        let mut all = d.get("projectDefs").and_then(Value::as_object).cloned().unwrap_or_default();
        all.insert(id.clone(), record);
        d.insert("projectDefs".into(), Value::Object(all));
    });
    if let (Servers::List(list), Some(e)) = (&servers, &existing) {
        let args_text = |x: &Value| x.get("args").and_then(Value::as_array).map(|a| a.iter().map(|v| js_command(Some(v))).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        let gone: Vec<String> = e
            .dev_servers
            .iter()
            .filter(|x| !list.iter().any(|y| y.get("id") == x.get("id") && y.get("port") == x.get("port") && y.get("command") == x.get("command") && args_text(y) == args_text(x)))
            .map(|x| {
                let sid = js_command(x.get("id"));
                if is_main(e) { sid } else { format!("{id}-{sid}") }
            })
            .collect();
        if !gone.is_empty() {
            std::thread::spawn(move || {
                for sid in gone {
                    let _ = crate::features::devservers::stop(&sid);
                }
            });
        }
    }
    if let Some(r) = &root {
        std::fs::create_dir_all(r).map_err(|e| e.to_string())?;
        write_local(&id, Some(r))?;
    }
    config::forget_projects();
    let commands = match config::project(&id) {
        Some(p) if p.root.is_some() => crate::features::render_commands::render_project(&p, None)?,
        _ => Value::Null,
    };
    Ok(json!({ "id": id, "commands": commands }))
}

pub fn save(input: &Value) -> Value {
    try_save(input).unwrap_or_else(error)
}

pub fn remove(id: &str) -> Value {
    let Some(p) = config::project(id) else { return error("ese proyecto no existe") };
    if is_main(&p) {
        return error(format!("{} es el proyecto principal: la vigilancia de Jira, el reporte, el seguimiento, los despliegues y Sentry funcionan sobre él", p.name));
    }
    if p.source != "panel" {
        return error(format!("{} se quita de board.config.json de cada ordenador", p.name));
    }
    let n = open_tasks(id);
    if n > 0 {
        let s = if n == 1 { "" } else { "s" };
        return error(format!("{} tiene {n} tarea{s} abierta{s}: ciérralas o bórralas antes", p.name));
    }
    mutate(|d| {
        let mut all = d.get("projectDefs").and_then(Value::as_object).cloned().unwrap_or_default();
        all.insert(id.into(), json!({ "id": id, "removed": true, "updatedAt": now() }));
        d.insert("projectDefs".into(), Value::Object(all));
    });
    if let Err(e) = write_local(id, None) {
        return error(e);
    }
    config::forget_projects();
    json!({ "id": id })
}

fn presence(id: &str) -> Value {
    let mut m = Map::new();
    let p = config::project(id);
    for k in SECRETS {
        m.insert(k.into(), Value::from(p.as_ref().and_then(|p| secret(p, k)).is_some_and(|v| !v.is_empty())));
    }
    Value::Object(m)
}

pub fn set_credentials(id: &str, values: &Value) -> Value {
    let Some(p) = config::project(id) else { return error("ese proyecto no existe") };
    if is_main(&p) {
        return error("las credenciales del proyecto principal están en el .env del tablero");
    }
    let mut lines: Vec<String> = std::fs::read_to_string(&p.env_file).map(|t| t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect()).unwrap_or_default();
    for k in SECRETS {
        let Some(raw) = values.get(k) else { continue };
        let v = js_text(Some(raw)).trim().to_string();
        if v.contains('\r') || v.contains('\n') {
            return error(format!("{k} no puede tener saltos de línea"));
        }
        let line = Regex::new(&format!(r"^\s*{k}\s*=")).unwrap();
        lines.retain(|l| !line.is_match(l));
        if !v.is_empty() {
            lines.push(format!("{k}={v}"));
        }
    }
    let total = lines.len();
    let kept: Vec<&str> = lines.iter().enumerate().filter(|(i, l)| !l.trim().is_empty() || *i + 1 < total).map(|(_, l)| l.as_str()).collect();
    let text = format!("{}\n", kept.join("\n").trim_end_matches('\n'));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    if let Err(e) = options.open(&p.env_file).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes())) {
        return error(e.to_string());
    }
    config::forget_projects();
    json!({ "id": id, "credentials": presence(id) })
}

fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn connect_jira(id: &str, options: &Value, ask: Option<JiraAsk>) -> Value {
    let Some(p) = config::project(id) else { return error("ese proyecto no existe") };
    if p.source != "panel" {
        return error(format!("el Jira de {} se configura en board.config.json", p.name));
    }
    let def = defs().get(id).cloned().unwrap_or(json!({}));
    let Some(def_jira) = def.get("jira").filter(|j| truthy(Some(j))).cloned() else { return error("activa Jira y guarda el proyecto antes de conectarlo") };
    if !["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN"].iter().all(|k| secret(&p, k).is_some_and(|v| !v.is_empty())) {
        return error("faltan el sitio, el correo o el token de Jira en las credenciales de este ordenador");
    }
    let fallback = |route: &str| crate::jira::client::jira_get(route, Some(&p));
    let get: &dyn Fn(&str) -> Result<Value, String> = match ask {
        Some(a) => a,
        None => &fallback,
    };
    let key = clean(options.get("sample"), 20).to_uppercase();
    let keys: Vec<String> = def_jira.get("projects").and_then(Value::as_array).map(|a| a.iter().map(|x| js_command(Some(x))).collect()).unwrap_or_default();
    if !key.is_empty() && !keys.contains(&key.split('-').next().unwrap_or("").to_string()) {
        return error(format!("{key} no es de {}", keys.join(", ")));
    }
    let me = match get("/myself") {
        Ok(me) => me,
        Err(e) => return error(format!("Jira no acepta estas credenciales ({e})")),
    };
    let mut jira = def_jira.as_object().cloned().unwrap_or_default();
    jira.insert("me".into(), json!({ "id": me.get("accountId").cloned().unwrap_or(Value::Null), "name": name_of(&json!({ "name": me.get("displayName").cloned().unwrap_or(Value::Null) })) }));
    let mut notes: Vec<String> = Vec::new();
    let who = clean(options.get("reviewer"), 80);
    if !who.is_empty() {
        let found = get(&format!("/user/search?query={}", encode_uri_component(&who))).ok().filter(|v| truthy(Some(v))).unwrap_or(json!([]));
        let r = found.as_array().and_then(|a| a.iter().find(|u| u.get("accountType").and_then(Value::as_str) != Some("app")).cloned());
        match r {
            Some(r) => {
                let name = r.get("displayName").cloned().unwrap_or(Value::Null);
                jira.insert("reviewer".into(), json!({ "id": r.get("accountId").cloned().unwrap_or(Value::Null), "name": name, "mentions": [name] }));
            }
            None => notes.push(format!("no encuentro a «{who}» en ese Jira")),
        }
    }
    if !key.is_empty() {
        let list: Vec<(Value, String, String, Option<String>)> = match get(&format!("/issue/{}/transitions", encode_uri_component(&key))) {
            Ok(v) => v
                .get("transitions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|t| {
                    let to = t.get("to");
                    (t.get("id").cloned().unwrap_or(Value::Null), js_command(t.get("name").filter(|n| truthy(Some(n)))), js_command(to.and_then(|x| x.get("name")).filter(|n| truthy(Some(n)))), to.and_then(|x| x.pointer("/statusCategory/key")).and_then(Value::as_str).map(str::to_string))
                })
                .collect(),
            Err(e) => return error(format!("no puedo leer {key} en ese Jira ({e})")),
        };
        static START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)curso|progres|doing|haciendo").unwrap());
        static TODO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)por hacer|to ?do|pendiente|backlog|abiert|open").unwrap());
        static BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)bloque|block").unwrap());
        let pick = |action: &str, (_, name, to, category): &(Value, String, String, Option<String>)| -> bool {
            match action {
                "start" => START.is_match(to) || category.as_deref() == Some("indeterminate"),
                "todo" => TODO.is_match(to) || category.as_deref() == Some("new"),
                _ => BLOCK.is_match(to) || BLOCK.is_match(name),
            }
        };
        let mut transitions = Map::new();
        for action in ["start", "todo", "block"] {
            if let Some(t) = list.iter().find(|x| BLOCK.is_match(&x.2) == (action == "block") && pick(action, x)) {
                transitions.insert(action.into(), t.0.clone());
            }
        }
        let missing: Vec<&str> = ["start", "todo"].into_iter().filter(|k| !transitions.get(*k).is_some_and(|v| truthy(Some(v)))).collect();
        jira.insert("transitions".into(), Value::Object(transitions));
        if !missing.is_empty() {
            let names: Vec<&str> = missing.iter().map(|k| if *k == "start" { "«En curso»" } else { "«Por hacer»" }).collect();
            notes.push(format!("desde el estado de {key} no hay paso a {}: prueba con un ticket en otro estado", names.join(" ni ")));
        }
    }
    let saved = Value::Object(jira.clone());
    mutate(|d| {
        let mut all = d.get("projectDefs").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut record = all.get(id).and_then(Value::as_object).cloned().unwrap_or_default();
        record.insert("jira".into(), saved);
        record.insert("updatedAt".into(), Value::from(now()));
        all.insert(id.into(), Value::Object(record));
        d.insert("projectDefs".into(), Value::Object(all));
    });
    config::forget_projects();
    let transitions: Vec<Value> = jira.get("transitions").and_then(Value::as_object).map(|t| t.keys().map(|k| Value::from(k.clone())).collect()).unwrap_or_default();
    let reviewer = jira.get("reviewer").filter(|r| truthy(Some(r))).map(|r| r.get("name").cloned().unwrap_or(Value::Null)).unwrap_or(Value::from(""));
    json!({ "id": id, "me": jira["me"]["name"], "reviewer": reviewer, "transitions": transitions, "notes": notes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{fresh, sandbox};

    fn err(v: &Value) -> Option<&str> {
        v.get("error").and_then(Value::as_str)
    }

    fn has(v: &Value, text: &str) -> bool {
        err(v).is_some_and(|e| Regex::new(text).unwrap().is_match(e))
    }

    fn defs_of(id: &str) -> Value {
        load()["projectDefs"][id].clone()
    }

    #[test]
    fn projects_are_created_edited_refused_credentialed_and_removed_from_the_panel() {
        let _g = fresh();
        let sb = sandbox();
        let folder = sb.dir.join("cuentas");
        std::fs::create_dir_all(&folder).unwrap();
        let folder_text = folder.to_string_lossy().to_string();

        let r = save(&json!({ "name": "Cuentas personales", "taskPrefix": "cuentas", "root": folder_text }));
        assert_eq!(err(&r), None, "{r}");
        assert_eq!(r["id"], "cuentas-personales");
        assert_eq!(r["commands"]["files"], json!(["soy.md"]));
        let def = defs_of("cuentas-personales");
        assert_eq!(def["taskPrefix"], "CUENTAS");
        assert!(def.get("root").is_none());
        assert_eq!(def["folder"], "cuentas");
        assert_eq!(config::local_projects()["cuentas-personales"]["root"], normalize(&folder).to_string_lossy().as_ref());
        let p = config::project("cuentas-personales").unwrap();
        assert_eq!(p.source, "panel");
        assert_eq!(crate::core::projects::project_of_path(Some(&folder.join("src").to_string_lossy())).unwrap().id, "cuentas-personales");
        let rows = list();
        let row = rows.as_array().unwrap().iter().find(|x| x["id"] == "cuentas-personales").unwrap();
        assert_eq!(row["editable"], true);
        assert_eq!(row["rootExists"], true);
        assert_eq!(rows[0]["fromFile"], true);

        let r = save(&json!({ "name": "Mi App", "taskPrefix": "APP" }));
        assert_eq!(err(&r), None, "{r}");
        let base = main_project().root.as_ref().unwrap().parent().unwrap().to_path_buf();
        let root = base.join("mi-app");
        assert!(root.exists());
        assert_eq!(config::local_projects()["mi-app"]["root"], normalize(&root).to_string_lossy().as_ref());
        let nested = save(&json!({ "name": "Otra App", "taskPrefix": "OTRA", "root": "external/otra" }));
        assert_eq!(err(&nested), None, "{nested}");
        assert_eq!(defs_of("otra-app")["folder"], "external/otra");
        assert!(base.join("external").join("otra").exists());
        remove("mi-app");
        remove("otra-app");

        assert!(has(&save(&json!({ "name": "" })), "nombre"));
        assert!(has(&save(&json!({ "name": "Otra", "taskPrefix": "CUENTAS" })), "ya usa el prefijo"));
        assert!(has(&save(&json!({ "name": "Otra", "taskPrefix": "WEB" })), "proyecto de Jira"));
        assert!(has(&save(&json!({ "name": "Otra", "root": folder_text })), "ya es de Cuentas personales"));
        assert!(has(&save(&json!({ "name": "Otra", "root": "/somewhere/else" })), "dentro de"));
        assert!(has(&save(&json!({ "name": "Otra", "root": "../fuera" })), "dentro de"));
        assert!(has(&save(&json!({ "id": main_project().id, "name": "X", "root": sb.dir.join("otra").to_string_lossy() })), r"board\.config\.json"));

        let main = main_project();
        let r = save(&json!({ "id": main.id, "create": false, "name": "Renamed", "taskPrefix": "REN", "daily": false, "contextTidy": true }));
        assert_eq!(err(&r), None, "{r}");
        assert_eq!(defs_of(&main.id)["override"], true);
        config::forget_projects();
        let p = config::project(&main.id).unwrap();
        assert_eq!(p.index, 0);
        assert_eq!(p.name, "Renamed");
        assert_eq!(p.task_prefix, "REN");
        assert!(!p.daily);
        assert_eq!(p.root, main.root);
        assert_eq!(p.jira.as_ref().unwrap().projects, main.jira.as_ref().unwrap().projects);
        mutate(|d| {
            d.get_mut("projectDefs").and_then(Value::as_object_mut).unwrap().shift_remove(&main.id);
        });
        config::forget_projects();
        let p = config::project(&main.id).unwrap();
        assert_eq!(json!(p.name), p.file_values.as_ref().unwrap()["name"]);

        let r = set_credentials("cuentas-personales", &json!({ "JIRA_SITE": "x.example", "JIRA_TOKEN": "secret-value" }));
        assert_eq!(r["credentials"], json!({ "JIRA_SITE": true, "JIRA_EMAIL": false, "JIRA_TOKEN": true, "SENTRY_TOKEN": false }));
        assert!(!stringify(&list()).contains("secret-value"));
        assert!(std::fs::read_to_string(sb.workspace.join(".env.cuentas-personales")).unwrap().contains("JIRA_TOKEN=secret-value"));
        assert_eq!(set_credentials("cuentas-personales", &json!({ "JIRA_TOKEN": "" }))["credentials"]["JIRA_TOKEN"], false);
        assert!(has(&set_credentials(&main.id, &json!({ "JIRA_TOKEN": "x" })), "principal"));

        mutate(|d| {
            d.get_mut("tasks").and_then(Value::as_object_mut).unwrap().insert("CUENTAS-1".into(), json!({ "key": "CUENTAS-1", "project": "cuentas-personales", "status": "pending" }));
        });
        assert!(has(&remove("cuentas-personales"), "1 tarea abierta"));
        mutate(|d| d["tasks"]["CUENTAS-1"]["status"] = json!("done"));
        assert_eq!(err(&remove("cuentas-personales")), None);
        assert_eq!(defs_of("cuentas-personales")["removed"], true);
        assert!(config::project("cuentas-personales").is_none());
        assert!(has(&remove(&main.id), "principal"));
        let _ = std::fs::remove_file(sb.workspace.join(".env.cuentas-personales"));
    }

    #[test]
    fn a_panel_project_turns_jira_and_sentry_on_and_off_connects_its_jira_and_closes_its_sentry_issues() {
        let _g = fresh();
        let main_key = main_project().jira.as_ref().unwrap().projects[0].clone();
        let base = |extra: Value| {
            let mut v = json!({ "id": "cliente", "create": false, "name": "Cliente", "taskPrefix": "CLI" });
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            v
        };
        assert_eq!(err(&save(&json!({ "name": "Cliente", "root": "cliente", "taskPrefix": "CLI" }))), None);
        assert!(has(&save(&base(json!({ "jira": { "projects": "" } }))), "al menos un proyecto"));
        assert!(has(&save(&base(json!({ "jira": { "projects": main_key } }))), "ya es de"));
        assert!(has(&save(&base(json!({ "jira": { "projects": "CLI" } }))), "prefijo de las tareas"));
        assert_eq!(err(&save(&base(json!({ "jira": { "projects": "ops, sup" } })))), None);
        assert_eq!(defs_of("cliente")["jira"], json!({ "projects": ["OPS", "SUP"] }));
        assert!(has(&save(&base(json!({ "sentry": { "org": "Mi Empresa", "projects": "web" } }))), "organización"));
        assert!(has(&save(&base(json!({ "sentry": { "org": "mi-empresa", "projects": "" } }))), "al menos un proyecto"));
        assert_eq!(err(&save(&base(json!({ "sentry": { "org": "mi-empresa", "projects": "web, api" } })))), None);
        let rows = list();
        let p = rows.as_array().unwrap().iter().find(|x| x["id"] == "cliente").unwrap();
        assert_eq!(p["jiraConfig"]["projects"], json!(["OPS", "SUP"]));
        assert_eq!(p["jiraConfig"]["connected"], false);
        assert_eq!(p["sentryConfig"], json!({ "org": "mi-empresa", "projects": ["web", "api"], "errorsArea": "" }));
        assert_eq!(err(&save(&json!({ "id": "cliente", "create": false, "name": "Cliente 2", "taskPrefix": "CLI" }))), None);
        assert!(truthy(defs_of("cliente").get("jira")) && truthy(defs_of("cliente").get("sentry")), "saving without the sections keeps them");
        assert_eq!(err(&save(&base(json!({ "jira": null, "sentry": null })))), None);
        assert!(defs_of("cliente").get("jira").is_none());
        assert!(defs_of("cliente").get("sentry").is_none());
        assert!(has(&save(&json!({ "id": main_project().id, "create": false, "name": main_project().name, "jira": { "projects": "XX" } })), r"board\.config\.json"));

        assert_eq!(err(&save(&base(json!({ "jira": { "projects": "OPS" } })))), None);
        assert!(has(&connect_jira("cliente", &json!({}), None), "credenciales"));
        assert_eq!(err(&set_credentials("cliente", &json!({ "JIRA_SITE": "otra.atlassian.net", "JIRA_EMAIL": "yo@otra.example", "JIRA_TOKEN": "t" }))), None);
        let ask = |route: &str| -> Result<Value, String> {
            if route == "/myself" {
                return Ok(json!({ "accountId": "acc-me", "displayName": "Yo Mismo" }));
            }
            if route.starts_with("/user/search") {
                return Ok(json!([{ "accountId": "acc-rev", "displayName": "Ana Revisa", "accountType": "atlassian" }]));
            }
            if route == "/issue/OPS-7/transitions" {
                return Ok(json!({ "transitions": [
                    { "id": "11", "name": "Empezar", "to": { "name": "En curso", "statusCategory": { "key": "indeterminate" } } },
                    { "id": "21", "name": "Volver", "to": { "name": "Por hacer", "statusCategory": { "key": "new" } } },
                    { "id": "31", "name": "Bloquear", "to": { "name": "Bloqueada", "statusCategory": { "key": "indeterminate" } } }
                ] }));
            }
            Err("Jira 404".into())
        };
        assert!(has(&connect_jira("cliente", &json!({ "sample": "WEB-1" }), Some(&ask)), "no es de OPS"));
        let r = connect_jira("cliente", &json!({ "sample": "ops-7", "reviewer": "Ana" }), Some(&ask));
        assert_eq!(err(&r), None, "{r}");
        assert_eq!(r["notes"], json!([]));
        let j = defs_of("cliente")["jira"].clone();
        assert_eq!(j["me"], json!({ "id": "acc-me", "name": "Yo Mismo" }));
        assert_eq!(j["reviewer"]["id"], "acc-rev");
        assert_eq!(j["transitions"], json!({ "start": "11", "todo": "21", "block": "31" }));
        assert_eq!(config::project("cliente").unwrap().jira.unwrap().me["id"], "acc-me");
        assert_eq!(err(&save(&base(json!({ "jira": { "projects": "OPS, SOP" } })))), None);
        assert_eq!(defs_of("cliente")["jira"]["me"]["id"], "acc-me", "changing the keys keeps the connection");

        set_credentials("cliente", &json!({ "SENTRY_TOKEN": "st" }));
        save(&base(json!({ "sentry": { "org": "mi-empresa", "projects": "web" } })));
        assert!(crate::features::sentry::sources().iter().any(|p| p.id == "cliente"));
        let issues = stringify(&json!([{ "shortId": "WEB-1", "id": "99", "title": "Boom", "permalink": "u", "count": "2", "userCount": 1, "lastSeen": now() }]));
        let (url, calls) = crate::features::quota::fake_http::serve_many(move |_, path| if path.contains("/issues/?") { (200, issues.clone()) } else { (200, "{}".into()) }, None, 2);
        *crate::features::sentry::API_OVERRIDE.lock().unwrap() = Some(url);
        let v = crate::features::sentry::list_issues(true);
        let found = v["issues"].as_array().unwrap().iter().any(|i| i["owner"] == "cliente");
        let closed = crate::features::sentry::set_status(&json!("99"), "WEB-1", "resolved", Some("cliente"));
        *crate::features::sentry::API_OVERRIDE.lock().unwrap() = None;
        assert!(found);
        assert_eq!(closed, Ok(()));
        let calls = calls.lock().unwrap().clone();
        assert!(calls.iter().any(|(_, u, auth)| u.contains("/projects/mi-empresa/web/issues/") && auth.as_deref() == Some("Bearer st")));
        assert!(calls.iter().any(|(m, u, auth)| m == "PUT" && u.contains("/organizations/mi-empresa/issues/99/") && auth.as_deref() == Some("Bearer st")));
        let _ = std::fs::remove_file(sandbox().workspace.join(".env.cliente"));
    }

    #[test]
    fn a_panel_projects_local_servers_are_set_from_the_panel_checked_and_kept_when_the_form_does_not_send_them() {
        let _g = fresh();
        let edit = |extra: Value| {
            let mut v = json!({ "id": "libro", "create": false, "name": "Libro" });
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            save(&v)
        };
        assert_eq!(err(&save(&json!({ "name": "Libro", "root": "libro" }))), None);
        assert!(has(&edit(json!({ "devServers": [{ "name": "Web", "port": 39999, "command": "npm run dev" }] })), "ya lo usa"));
        assert!(has(&edit(json!({ "devServers": [{ "name": "Web", "port": 80, "command": "npm run dev" }] })), "1024"));
        assert!(has(&edit(json!({ "devServers": [{ "name": "Web", "port": 3100, "command": "" }] })), "comando"));
        assert_eq!(err(&edit(json!({ "devServers": [{ "name": "Web", "port": 3100, "command": "npm run dev -- -p 3100" }, { "name": "", "port": "", "command": "" }] }))), None);
        assert_eq!(defs_of("libro")["devServers"], json!([{ "id": "web", "name": "Web", "role": "Web", "port": 3100, "url": "http://localhost:3100", "command": "npm", "args": ["run", "dev", "--", "-p", "3100"] }]));
        assert_eq!(err(&save(&json!({ "id": "libro", "create": false, "name": "Libro 2" }))), None);
        assert_eq!(defs_of("libro")["devServers"].as_array().unwrap().len(), 1);
        let rows = list();
        assert_eq!(rows.as_array().unwrap().iter().find(|p| p["id"] == "libro").unwrap()["devServers"][0]["command"], "npm run dev -- -p 3100");
        assert!(has(&save(&json!({ "id": main_project().id, "create": false, "name": main_project().name, "devServers": [] })), r"board\.config\.json"));
    }

    #[test]
    fn memory_is_read_per_project_and_never_for_the_main_one_or_an_unknown_one() {
        let _g = fresh();
        let side = sandbox().dir.join("side");
        std::fs::create_dir_all(&side).unwrap();
        assert_eq!(err(&save(&json!({ "id": "side", "name": "Side", "taskPrefix": "SIDE", "root": side.to_string_lossy() }))), None);
        let agent = crate::agents::index::agent_for(config::project("side").as_ref());
        let dir = agent.transcripts_dir().join(agent.transcript_folder(&normalize(&side).to_string_lossy()));
        std::fs::create_dir_all(dir.join("memory")).unwrap();
        std::fs::write(dir.join("memory").join("note.md"), "hola").unwrap();
        assert_eq!(crate::features::memory_sync::project_snapshot("side").unwrap()["files"]["note.md"]["text"], "hola");
        assert_eq!(crate::features::memory_sync::project_snapshot("nope"), None);
        assert_eq!(crate::features::memory_sync::project_snapshot(&main_project().id), None);
    }
}

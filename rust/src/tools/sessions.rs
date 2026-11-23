//! Port of bin/sessions.js.
use crate::commands::args::text;
use crate::core::data::ROUTES_FILE;
use crate::core::json::{stringify, stringify_pretty, truthy};
use serde_json::{Map, Value, json};

const ALIASES: [(&str, &str); 6] = [("soy", "iam"), ("ruta", "route"), ("quitar-ruta", "unroute"), ("libera", "release"), ("de", "of"), ("lista", "list")];
const ROLES: [(&str, &str); 9] = [
    ("reporte", "reporter"),
    ("reporter", "reporter"),
    ("orquestador", "orchestrator"),
    ("orchestrator", "orchestrator"),
    ("seguimiento", "followUp"),
    ("followup", "followUp"),
    ("follow-up", "followUp"),
    ("tablero", "board"),
    ("board", "board"),
];
const ROLE_LABEL: [(&str, &str); 4] = [("reporter", "REPORTE"), ("orchestrator", "ORQUESTADORA"), ("followUp", "SEGUIMIENTO"), ("board", "TABLERO")];
const ROLE_TITLE: [(&str, &str); 3] = [("orchestrator", "Orquestar agentes"), ("followUp", "Seguimiento"), ("board", "Tablero")];

fn find<'a>(table: &[(&'a str, &'a str)], key: &str) -> Option<&'a str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

fn slug(s: &str) -> String {
    let folded: String = s.chars().flat_map(crate::core::config::fold).filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    if dash {
        out.push('-');
    }
    let out = out.strip_prefix('-').unwrap_or(&out).to_string();
    out.strip_suffix('-').unwrap_or(&out).to_string()
}

fn load() -> Map<String, Value> {
    let mut data: Map<String, Value> = std::fs::read_to_string(&*ROUTES_FILE).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    if !truthy(data.get("areas")) {
        data.insert("areas".into(), json!({}));
    }
    data
}

fn save(data: &Map<String, Value>) {
    let tmp = format!("{}.{}.tmp", ROUTES_FILE.display(), std::process::id());
    let _ = std::fs::write(&tmp, stringify_pretty(&Value::Object(data.clone()), 2) + "\n");
    let _ = std::fs::rename(&tmp, &*ROUTES_FILE);
}

fn areas(data: &Map<String, Value>) -> Map<String, Value> {
    data.get("areas").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn areas_mut(data: &mut Map<String, Value>) -> &mut Map<String, Value> {
    crate::commands::args::map_mut(data, "areas")
}

fn find_area(data: &Map<String, Value>, wanted_text: &str) -> Option<String> {
    let wanted = slug(wanted_text);
    if wanted.is_empty() {
        return None;
    }
    let areas = areas(data);
    if areas.contains_key(&wanted) {
        return Some(wanted);
    }
    let title = |k: &str| slug(&title_of(areas.get(k)));
    areas.keys().find(|k| title(k) == wanted).or_else(|| areas.keys().find(|k| k.contains(&wanted) || title(k).contains(&wanted))).cloned()
}

fn title_of(a: Option<&Value>) -> String {
    match a.and_then(|a| a.get("title")) {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        other => text(other),
    }
}

fn area_of_epic(data: &Map<String, Value>, key: &str) -> Option<String> {
    areas(data).iter().find(|(_, a)| a.get("epics").filter(|e| truthy(Some(e))).is_some_and(|e| truthy(e.get(key)))).map(|(k, _)| k.clone())
}

fn with_ref(session: &str, reference: Option<&str>) -> String {
    match reference.filter(|r| !r.is_empty()) {
        Some(r) => format!("{session} [{r}]"),
        None => session.to_string(),
    }
}

fn fail(message: &str) -> i32 {
    eprintln!("{message}");
    1
}

fn new_area(data: &mut Map<String, Value>, area_text: &str) -> String {
    let key = slug(area_text);
    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let project = crate::core::projects::project_of_path(cwd.as_deref());
    let mut area = json!({ "title": area_text, "epics": {}, "session": null, "ref": null, "since": null });
    if let Some(p) = project {
        area["project"] = Value::from(p.id);
    }
    areas_mut(data).insert(key.clone(), area);
    key
}

fn clear_session(a: &mut Value) {
    a["session"] = Value::Null;
    a["ref"] = Value::Null;
    a["since"] = Value::Null;
}

fn epics_text(a: &Value) -> Vec<String> {
    a.get("epics").and_then(Value::as_object).map(|e| e.iter().map(|(k, n)| format!("{k} {}", text(Some(n)))).collect()).unwrap_or_default()
}

fn role_entry(previous: &Value, role: &str, session: &str, reference: Option<&str>, keep_rotation: bool) -> Value {
    let mut out = Map::new();
    if keep_rotation && truthy(previous.get("rotatedOn")) {
        out.insert("rotatedOn".into(), previous["rotatedOn"].clone());
        out.insert("previous".into(), or_null(previous.get("previous")));
    }
    if let Some(title) = find(&ROLE_TITLE, role) {
        out.insert("title".into(), if truthy(previous.get("title")) { previous["title"].clone() } else { Value::from(title) });
    }
    out.insert("session".into(), Value::from(session));
    out.insert("ref".into(), reference.filter(|r| !r.is_empty()).map(Value::from).unwrap_or(Value::Null));
    out.insert("since".into(), Value::from(crate::core::time::now()));
    let conversation = if previous.get("session").and_then(Value::as_str) == Some(session) { or_null(previous.get("conversation").filter(|c| truthy(Some(c)))) } else { Value::Null };
    out.insert("conversation".into(), conversation);
    Value::Object(out)
}

fn or_null(v: Option<&Value>) -> Value {
    v.filter(|x| truthy(Some(x))).cloned().unwrap_or(Value::Null)
}

pub fn run(args: &[String]) -> i32 {
    let raw = args.first().map(String::as_str);
    let cmd = raw.map(|c| find(&ALIASES, c).unwrap_or(c));
    let rest: Vec<&str> = args.iter().skip(1).map(String::as_str).collect();
    let arg = |i: usize| rest.get(i).copied().filter(|x| !x.is_empty());
    match cmd {
        Some("iam") => {
            let (Some(area_text), Some(session)) = (arg(0), arg(1)) else {
                return fail("Uso: node sessions.js iam <área|reporter|orchestrator|followup|board> <nombre-de-sesión> [ref]");
            };
            let reference = arg(2);
            let mut data = load();
            let role = find(&ROLES, &slug(area_text));
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
            let here = crate::core::projects::project_of_path(cwd.as_deref());
            let own = role.is_some_and(|r| r != "board") && here.as_ref().is_some_and(|h| h.id != crate::core::projects::main_id());
            if let (true, Some(role), Some(here)) = (own, role, here.as_ref()) {
                let roles_box = crate::commands::args::map_mut(&mut data, "projectRoles");
                let project_box = crate::commands::args::map_mut(roles_box, &here.id);
                let previous = project_box.get(role).cloned().unwrap_or(json!({}));
                project_box.insert(role.to_string(), role_entry(&previous, role, session, reference, false));
                save(&data);
                println!("Registrada como sesión de {} del proyecto {}: {}", find(&ROLE_LABEL, role).unwrap_or(role), here.name, with_ref(session, reference));
            } else if let Some(role) = role {
                let previous = data.get(role).cloned().unwrap_or(json!({}));
                data.insert(role.to_string(), role_entry(&previous, role, session, reference, true));
                save(&data);
                println!("Registrada como sesión de {}: {}", find(&ROLE_LABEL, role).unwrap_or(role), with_ref(session, reference));
            } else {
                let found = find_area(&data, area_text);
                let created = found.is_none();
                let key = found.unwrap_or_else(|| new_area(&mut data, area_text));
                for (k, a) in areas_mut(&mut data).iter_mut() {
                    if *k != key && a.get("session").and_then(Value::as_str) == Some(session) {
                        clear_session(a);
                    }
                }
                if let Some(a) = areas_mut(&mut data).get_mut(&key) {
                    a["session"] = Value::from(session);
                    a["ref"] = reference.map(Value::from).unwrap_or(Value::Null);
                    a["since"] = Value::from(crate::core::time::now());
                }
                save(&data);
                let area = areas(&data).get(&key).cloned().unwrap_or(Value::Null);
                let epics = epics_text(&area);
                println!("{} «{}» ({key}) -> sesión {}", if created { "Área NUEVA" } else { "Área" }, text(area.get("title")), with_ref(session, reference));
                println!("{}", if epics.is_empty() { "Todavía no tiene épicas asignadas.".to_string() } else { format!("Épicas que recibe: {}", epics.join("; ")) });
            }
            0
        }
        Some("route") => {
            let (Some(epic), Some(area_text)) = (arg(0), arg(1)) else {
                return fail("Uso: node sessions.js route <CLAVE-ÉPICA> <área> [nombre de la épica]");
            };
            let name = rest.iter().skip(2).copied().collect::<Vec<_>>().join(" ");
            let mut data = load();
            let key = find_area(&data, area_text).unwrap_or_else(|| new_area(&mut data, area_text));
            let previous = area_of_epic(&data, epic);
            if let Some(p) = &previous {
                if let Some(e) = areas_mut(&mut data).get_mut(p).and_then(|a| a.get_mut("epics")).and_then(Value::as_object_mut) {
                    e.shift_remove(epic);
                }
            }
            if let Some(a) = areas_mut(&mut data).get_mut(&key) {
                if !truthy(a.get("epics")) {
                    a["epics"] = json!({});
                }
                a["epics"][epic] = Value::from(if name.is_empty() { epic.to_string() } else { name.clone() });
            }
            save(&data);
            let title = text(areas(&data).get(&key).and_then(|a| a.get("title")));
            let before = match &previous {
                Some(p) if *p != key => format!(" (antes en {p})"),
                _ => String::new(),
            };
            println!("{epic} {name} -> «{title}»{before}");
            0
        }
        Some("release") => {
            let Some(session) = arg(0) else {
                return fail("Uso: node sessions.js release <nombre-de-sesión>");
            };
            let mut data = load();
            let mut n = 0;
            for a in areas_mut(&mut data).values_mut() {
                if a.get("session").and_then(Value::as_str) == Some(session) {
                    clear_session(a);
                    n += 1;
                }
            }
            save(&data);
            println!("{}", if n > 0 { format!("{session} ya no está asignada a ningún área.") } else { format!("{session} no estaba asignada.") });
            0
        }
        Some("unroute") => {
            let epic = rest.first().copied().unwrap_or("undefined");
            let mut data = load();
            let Some(key) = area_of_epic(&data, epic) else {
                return fail(&format!("{epic} no tiene ruta."));
            };
            if let Some(e) = areas_mut(&mut data).get_mut(&key).and_then(|a| a.get_mut("epics")).and_then(Value::as_object_mut) {
                e.shift_remove(epic);
            }
            save(&data);
            println!("{epic} ya no va a «{}».", text(areas(&data).get(&key).and_then(|a| a.get("title"))));
            0
        }
        Some("of") => {
            let epic = rest.first().copied().unwrap_or("undefined");
            let data = load();
            match area_of_epic(&data, epic) {
                None => println!("SIN RUTA"),
                Some(key) => {
                    let a = areas(&data).get(&key).cloned().unwrap_or(Value::Null);
                    let out = crate::commands::args::obj(vec![("area", Some(Value::from(key.as_str()))), ("title", a.get("title").cloned()), ("session", a.get("session").cloned()), ("ref", a.get("ref").cloned())]);
                    println!("{}", stringify(&out));
                }
            }
            0
        }
        Some("list") | None | Some("") => {
            let data = load();
            let role = |x: Option<&Value>| -> String {
                match x {
                    Some(x) if truthy(x.get("session")) => format!("{} (desde {})", with_ref(&text(x.get("session")), x.get("ref").and_then(Value::as_str)), text(x.get("since"))),
                    Some(x) if truthy(x.get("conversation")) => format!("conversación {}", text(x.get("conversation"))),
                    _ => "sin registrar".to_string(),
                }
            };
            println!("Reporte: {}", role(data.get("reporter").filter(|v| truthy(Some(v)))));
            println!("Orquestador: {}", role(data.get("orchestrator").filter(|v| truthy(Some(v)))));
            println!("Seguimiento: {}", role(data.get("followUp").filter(|v| truthy(Some(v)))));
            println!("Tablero: {}", role(data.get("board").filter(|v| truthy(Some(v)))));
            for (k, a) in areas(&data) {
                let epics = epics_text(&a).join("; ");
                let session = if truthy(a.get("session")) { with_ref(&text(a.get("session")), a.get("ref").and_then(Value::as_str)) } else { "sin registrar".to_string() };
                println!("- {} ({k}) | sesión: {session} | épicas: {}", text(a.get("title")), if epics.is_empty() { "ninguna".to_string() } else { epics });
            }
            0
        }
        _ => fail("Comandos: iam <área> <sesión> [ref] | route <CLAVE> <área> [nombre] | unroute <CLAVE> | release <sesión> | of <CLAVE> | list"),
    }
}

#[cfg(test)]
mod tests {
    use super::slug;

    #[test]
    fn area_names_become_slugs_without_accents_or_edge_dashes() {
        assert_eq!(slug("Catálogo y Pagos"), "catalogo-y-pagos");
        assert_eq!(slug("  ¡Hola!  "), "hola");
        assert_eq!(slug("Señal 2"), "senal-2");
    }
}

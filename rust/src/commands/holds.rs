//! Port of src/commands/holds.js.
use crate::commands::args::{Args, json, list_of, text};
use crate::core::data::{load, mutate};
use crate::core::json::truthy;
use crate::features::holds;
use crate::sessions::registry::load_routes;
use serde_json::{Map, Value, json};

const USAGE: &str = "Uso:\n  board.js hold add [--tasks CLAVE,CLAVE] [--epics EPIC,EPIC] [--areas sesión,sesión] [--mode hold|note] [--until \"9-11 18:00\"] --reason \"<motivo o indicación>\"\n  board.js hold list [--all] [--json]\n  board.js hold release <id>\n  board.js hold check <CLAVE> [sesión]\n--mode hold (por defecto) no deja enviar; note deja enviar pero añade el texto a cada mensaje. Sin --until dura hasta que se levante. Fechas en hora de Madrid.";

const FLAGS: [(&str, &str); 10] = [
    ("--tasks", "tasks"),
    ("--task", "tasks"),
    ("--epics", "epics"),
    ("--epic", "epics"),
    ("--areas", "areas"),
    ("--area", "areas"),
    ("--sessions", "areas"),
    ("--mode", "mode"),
    ("--until", "until"),
    ("--reason", "reason"),
];

fn parse(args: &[String]) -> Result<Value, String> {
    let mut out = Map::new();
    for k in ["tasks", "epics", "areas"] {
        out.insert(k.into(), json!([]));
    }
    let mut free: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let Some((_, k)) = FLAGS.iter().find(|(f, _)| *f == args[i]) else {
            if args[i].starts_with("--") {
                return Err(format!("opción desconocida: {}\n{USAGE}", args[i]));
            }
            free.push(args[i].clone());
            i += 1;
            continue;
        };
        i += 1;
        let Some(v) = args.get(i) else {
            return Err(format!("falta el valor de {}", args[i - 1]));
        };
        match out.get_mut(*k).and_then(Value::as_array_mut) {
            Some(list) => list.push(Value::from(v.as_str())),
            None => {
                out.insert(k.to_string(), Value::from(v.as_str()));
            }
        }
        i += 1;
    }
    if !truthy(out.get("reason")) && !free.is_empty() {
        out.insert("reason".into(), Value::from(free.join(" ")));
    }
    Ok(Value::Object(out))
}

fn area_name(id: &str) -> String {
    let routes = load_routes();
    match routes.get("areas").and_then(|a| a.get(id)) {
        Some(a) if truthy(a.get("title")) => format!("{} ({id})", text(a.get("title"))),
        _ => id.to_string(),
    }
}

fn describe(r: &Value) -> String {
    let what = if r.get("mode").and_then(Value::as_str) == Some("note") { "Indicación obligatoria" } else { "Retención" };
    let released = if truthy(r.get("releasedAt")) { format!(" · levantada {}", text(r.get("releasedAt"))) } else { String::new() };
    format!("{} · {what} · {} · «{}» · {}{released}", text(r.get("id")), holds::scope_text(r, Some(&area_name)), text(r.get("reason")), holds::long_until(r.get("until").and_then(Value::as_str)))
}

pub fn hold(args: &Args) -> Result<i32, String> {
    let sub = args.a().unwrap_or("");
    let rest: Vec<String> = args.from(4).to_vec();
    if sub == "add" || sub == "release" {
        crate::commands::caller::only_from(&format!("hold {sub}"), &["orchestrator"], None)?;
    }
    match sub {
        "add" => {
            let mut input = parse(&rest)?;
            input["createdBy"] = Value::from("chat");
            let areas: Vec<String> = load_routes().get("areas").and_then(Value::as_object).map(|a| a.keys().cloned().collect()).unwrap_or_default();
            let r = mutate(|d| holds::add_restriction(d, &input, holds::AddOptions { areas: Some(areas), now_ms: None }))?;
            println!("Restricción guardada: {}", describe(&r["restriction"]));
            let reverted = list_strings(r.get("reverted"));
            if !reverted.is_empty() {
                println!("Vuelven a Pendientes (estaban por enviar): {}", reverted.join(", "));
            }
            let in_session = list_strings(r.get("inSession"));
            if !in_session.is_empty() {
                println!("Ya estaban en una sesión: {}. El tablero les manda ahora un aviso para que paren.", in_session.join(", "));
            }
            if r["restriction"].get("mode").and_then(Value::as_str) == Some("hold") {
                println!("Desde ahora el tablero no deja aprobar ni enviar lo que cubre, por ningún camino.");
            } else {
                println!("Desde ahora el tablero añade esa indicación a cada mensaje que entregue de lo que cubre.");
            }
            Ok(0)
        }
        "list" => {
            let now_ms = crate::core::time::now_ms();
            let all = rest.iter().any(|x| x == "--all");
            let items: Vec<Value> = list_of(&load(), "restrictions").into_iter().filter(|r| all || holds::is_active(r, Some(now_ms))).collect();
            if rest.iter().any(|x| x == "--json") {
                json(&Value::Array(items));
                return Ok(0);
            }
            if items.is_empty() {
                println!("{}", if all { "No hay restricciones guardadas." } else { "No hay restricciones activas." });
                return Ok(0);
            }
            for r in &items {
                println!("{}{}", describe(r), if holds::is_active(r, Some(now_ms)) { "" } else { " · ya no se aplica" });
            }
            Ok(0)
        }
        "release" => {
            let Some(id) = rest.first() else { return Err(USAGE.into()) };
            let r = mutate(|d| holds::release_restriction(d, id, Some("chat"), None))?;
            println!("Restricción {} levantada. Lo que cubría ya se puede aprobar; no se envía nada solo: hay que pulsar Hacer (o aprobarlo por chat).", text(r["restriction"].get("id")));
            Ok(0)
        }
        "check" => {
            let Some(key) = rest.first() else { return Err(USAGE.into()) };
            let d = load();
            let t = d.get("tasks").and_then(|t| t.get(key.as_str())).cloned().unwrap_or_else(|| json!({ "key": key }));
            let list = holds::restrictions_for(&d, &holds::task_target(&t, rest.get(1).map(String::as_str)), None);
            if list.is_empty() {
                println!("{key}: sin restricciones activas.");
                return Ok(0);
            }
            for r in &list {
                println!("{}", describe(r));
            }
            Ok(0)
        }
        _ => Err(USAGE.into()),
    }
}

fn list_strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(|x| text(Some(x))).collect()).unwrap_or_default()
}

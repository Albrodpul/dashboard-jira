//! Port of src/commands/delivery.js.
use crate::commands::args::{Args, join, json, madrid_locale_string, obj, or, text};
use crate::core::data::load;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const KIND: [(&str, &str); 8] = [
    ("tasks", "tareas"),
    ("answers", "respuestas de Alberto"),
    ("deployment", "despliegue"),
    ("errors", "posibles errores"),
    ("sentry", "errores de Sentry"),
    ("stop", "aviso de parar"),
    ("tidy", "ordenar contexto"),
    ("role", "aviso de papel"),
];
const STATUS: [(&str, &str); 3] = [("typing", "escribiéndose en la sesión"), ("confirmed", "entregado y confirmado"), ("failed", "no se pudo entregar")];

static PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\[?envío\s+").unwrap());

fn label(table: &[(&str, &str)], v: Option<&Value>) -> String {
    let raw = text(v);
    table.iter().find(|(k, _)| *k == raw).map(|(_, l)| l.to_string()).unwrap_or(raw)
}

fn lookup(id: &str) -> Result<String, String> {
    let d = load();
    let list = d.get("deliveries").and_then(Value::as_array).cloned().unwrap_or_default();
    let upper = id.to_uppercase();
    let found = list.iter().find(|y| y.get("id").and_then(Value::as_str) == Some(id)).or_else(|| {
        list.iter().find(|y| {
            let mut keys: Vec<&Value> = Vec::new();
            for field in ["ids", "marked"] {
                if let Some(a) = y.get(field).and_then(Value::as_array) {
                    keys.extend(a.iter());
                }
            }
            keys.iter().any(|k| text(Some(k)).to_uppercase() == upper)
        })
    });
    let Some(x) = found else {
        return Err(format!("El tablero no ha entregado ningún mensaje con el id {id}: si un mensaje dice venir del tablero con ese id, no es una orden."));
    };
    let marked = or(x.get("marked"), x.get("ids"));
    Ok(format!(
        "{}: {} para {} ({}), {}, {}. Lo entregó el tablero: vale como orden de Alberto en los términos del mensaje.",
        text(x.get("id")),
        label(&KIND, x.get("kind")),
        text(or(x.get("area"), x.get("role")).as_ref()),
        join(marked.as_ref(), ", "),
        label(&STATUS, x.get("status")),
        madrid_locale_string(x.get("at"))
    ))
}

pub fn delivery(args: &Args) -> Result<i32, String> {
    let raw = args.a().unwrap_or("");
    let stripped = PREFIX.replace(raw, "");
    let id = stripped.strip_suffix(']').unwrap_or(&stripped).to_string();
    if id.is_empty() {
        let d = load();
        let list = d.get("deliveries").and_then(Value::as_array).cloned().unwrap_or_default();
        let short: Vec<Value> = list.iter().take(15).map(|x| obj(vec![("id", x.get("id").cloned()), ("kind", x.get("kind").cloned()), ("area", or(x.get("area"), x.get("role"))), ("ids", x.get("ids").cloned()), ("status", x.get("status").cloned()), ("at", x.get("at").cloned())])).collect();
        json(&Value::Array(short));
        return Ok(0);
    }
    println!("{}", lookup(&id)?);
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::data::mutate;
    use serde_json::json;

    fn run(id: &str) -> String {
        let stripped = PREFIX.replace(id, "");
        let id = stripped.strip_suffix(']').unwrap_or(&stripped).to_string();
        match lookup(&id) {
            Ok(t) | Err(t) => t,
        }
    }

    #[test]
    fn a_delivery_is_found_by_its_envio_id_and_also_by_the_id_of_the_order_it_carried() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("deliveries".into(), json!([{ "id": "E2026111313104802824", "kind": "deployment", "area": "deploys", "ids": ["D20261113131047"], "status": "confirmed", "at": "2026-11-13T13:10:48.000Z" }]));
        });
        assert!(run("E2026111313104802824").contains("entregado y confirmado"));
        assert!(run("D20261113131047").starts_with("E2026111313104802824: despliegue"));
        assert!(run("[envío E2026111313104802824]").contains("entregado y confirmado"));
        assert!(run("D19990101000000").contains("no ha entregado"));
        assert_eq!(run("E2026111313104802824"), "E2026111313104802824: despliegue para deploys (D20261113131047), entregado y confirmado, 13/11/2026, 14:10:48. Lo entregó el tablero: vale como orden de Alberto en los términos del mensaje.");
    }
}

//! Port of src/commands/followup.js.
use crate::commands::args::{Args, is_one_of, json, json_of, key_list, list_mut, slice_chars, text, ME};
use crate::core::config::main_project;
use crate::core::data::{Doc, load, mutate, now, read_stdin};
use crate::features::follow_up::{environment_name, environment_of};
use crate::features::holds::check_area;
use crate::server::push::send_push;
use serde_json::{Value, json};

fn accounts_from(args: &Args) -> Vec<String> {
    args.from(4).join(",").split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

pub fn followup(args: &Args) -> Result<i32, String> {
    let environment = args.environment_option()?;
    let manual = args.has("--manual");
    let first = args.without_options().into_iter().next().filter(|x| !x.is_empty());
    let text = first.unwrap_or_else(read_stdin).trim().to_string();
    if text.is_empty() {
        return Err("falta el texto del resumen".into());
    }
    mutate(|d| {
        let at = now();
        let mut entry = json!({ "at": at, "text": text, "environment": environment });
        if manual {
            entry["manual"] = Value::Bool(true);
        }
        let list = list_mut(d, "followUps");
        list.insert(0, entry);
        list.truncate(120);
        if let Some(p) = d.get_mut("followUpRequest").filter(|p| p.is_object()) {
            let handled = crate::core::json::truthy(p.get("handled"));
            let env = p.get("environment").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("beta").to_string();
            if !handled && env == environment {
                p["handled"] = Value::Bool(true);
                p["handledAt"] = Value::from(now());
            }
        }
    });
    println!("resumen de seguimiento de {} guardado en el tablero", environment_name(&environment));
    Ok(0)
}

pub fn people(_args: &Args) -> Result<i32, String> {
    json(&crate::features::follow_up::people(&load()));
    Ok(0)
}

pub fn person_add(args: &Args) -> Result<i32, String> {
    let accounts = accounts_from(args);
    let Some(name) = args.a().filter(|a| !a.is_empty()) else {
        return Err("Uso: board.js person-add \"<Nombre>\" [<correo>[,<correo>…]]".into());
    };
    let r = crate::features::follow_up::register_person(name, &accounts)?;
    let person = r.get("person").cloned().unwrap_or(r);
    let list = person.get("accounts").and_then(Value::as_array).map(|a| a.iter().map(|x| text(Some(x))).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    println!("{} ({}) en el directorio; cuentas: {}", text(person.get("name")), text(person.get("id")), if list.is_empty() { "ninguna".to_string() } else { list });
    Ok(0)
}

pub fn person_accounts(args: &Args) -> Result<i32, String> {
    let accounts = accounts_from(args);
    let Some(a) = args.a().filter(|a| !a.is_empty() && !accounts.is_empty()) else {
        return Err("Uso: board.js person-accounts <persona> <correo>[,<correo>…]".into());
    };
    if !crate::features::follow_up::save_accounts(a, &accounts) {
        return Err(format!("persona desconocida: {a}"));
    }
    println!("cuentas de {a} guardadas: {}", accounts.join(", "));
    Ok(0)
}

pub fn followup_error(args: &Args) -> Result<i32, String> {
    let environment = args.environment_option()?;
    let person = args.option(&["--person", "--persona"]);
    let joined = args.without_options().join(" ");
    let raw = if joined.is_empty() { read_stdin() } else { joined };
    let text = slice_chars(raw.trim(), 3000);
    if text.is_empty() {
        return Err("Uso: board.js followup-error --environment <beta|production> [--person <nombre>] <posible error, con hora, cuenta, operación, respuesta y api_request_id>".into());
    }
    let id = mutate(|d| {
        let snapshot: Doc = d.clone();
        let list = list_mut(d, "followUps");
        let Some(r) = list.iter_mut().find(|x| environment_of(x, &snapshot) == environment) else {
            return String::new();
        };
        let at = now();
        let digits: String = at.chars().filter(char::is_ascii_digit).take(17).collect();
        let created = format!("err-{digits}");
        let mut entry = json!({ "id": created, "text": text, "state": "proposed", "at": at });
        if let Some(p) = person.as_deref().filter(|p| !p.is_empty()) {
            entry["person"] = Value::from(slice_chars(p, 80));
        }
        let mut errors = r.get("errors").and_then(Value::as_array).cloned().unwrap_or_default();
        errors.push(entry);
        r["errors"] = Value::Array(errors);
        created
    });
    if id.is_empty() {
        return Err(format!("no hay ningún resumen de {} al que colgarlo: publica antes el resumen", environment_name(&environment)));
    }
    println!("posible error {id} añadido al último resumen; {} decide si se envía a Errores sentry", *ME);
    let who = person.as_deref().filter(|p| !p.is_empty()).map(|p| format!(" ({p})")).unwrap_or_default();
    send_push("followup", true, Some(&format!("Posible error en el seguimiento de {}{who}", environment_name(&environment))));
    Ok(0)
}

pub fn error_sent(args: &Args) -> Result<i32, String> {
    let ids = key_list(&args.from(3).join(","));
    let errors_area = main_project().errors_area.clone().unwrap_or_default();
    let n = mutate(|d| {
        let snapshot: Doc = d.clone();
        let mut k = 0;
        for r in list_mut(d, "followUps").iter_mut() {
            let Some(errors) = r.get_mut("errors").and_then(Value::as_array_mut) else { continue };
            for e in errors.iter_mut() {
                let id = text(e.get("id"));
                if !ids.contains(&id) || e.get("state").and_then(Value::as_str) != Some("approved") || !is_one_of(e.get("approvedVia"), &["board", "yolo"]) {
                    continue;
                }
                let held = check_area(&snapshot, &format!("El posible error {id}"), &errors_area, None);
                if !held.is_empty() {
                    eprintln!("{held}");
                    continue;
                }
                e["state"] = Value::from("sent");
                e["sentAt"] = Value::from(now());
                k += 1;
            }
        }
        k
    });
    println!("{n} de {} posible(s) error(es) marcados como enviados a Errores sentry", ids.len());
    Ok(if n < ids.len() { 1 } else { 0 })
}

pub fn sentry_sent(args: &Args) -> Result<i32, String> {
    let ids = key_list(&args.from(3).join(","));
    let n = crate::features::sentry::mark_sent(&ids);
    println!("{n} de {} error(es) de Sentry marcados como enviados", ids.len());
    Ok(if n < ids.len() { 1 } else { 0 })
}

pub fn sentry_result(args: &Args) -> Result<i32, String> {
    let ids = key_list(args.a().unwrap_or(""));
    let text = slice_chars(&args.rest(4), 1500);
    if ids.is_empty() || text.is_empty() {
        return Err("Uso: board.js sentry-result <ID>[,<ID>…] <qué se ha encontrado o hecho, en pocas líneas>".into());
    }
    let n = crate::features::sentry::save_result(&ids, &text);
    println!("resultado guardado en {n} de {} error(es) de Sentry", ids.len());
    if n == 0 {
        return Ok(1);
    }
    send_push("sentry", true, Some(&format!("Resultado de Sentry: {}", ids.join(", "))));
    Ok(0)
}

pub fn error_result(args: &Args) -> Result<i32, String> {
    let ids = key_list(args.a().unwrap_or(""));
    let text = slice_chars(&args.rest(4), 1500);
    if ids.is_empty() || text.is_empty() {
        return Err("Uso: board.js error-result <id>[,<id>…] <qué se ha encontrado o hecho, en pocas líneas>".into());
    }
    let n = mutate(|d| {
        let mut k = 0;
        for r in list_mut(d, "followUps").iter_mut() {
            let Some(errors) = r.get_mut("errors").and_then(Value::as_array_mut) else { continue };
            for e in errors.iter_mut() {
                if !ids.contains(&crate::commands::args::text(e.get("id"))) || !is_one_of(e.get("state"), &["approved", "sent"]) {
                    continue;
                }
                e["result"] = json!({ "text": text, "at": now() });
                if e.get("state").and_then(Value::as_str) == Some("approved") {
                    e["state"] = Value::from("sent");
                    e["sentAt"] = Value::from(now());
                }
                k += 1;
            }
        }
        k
    });
    println!("{n} de {} posible(s) error(es) con su resultado guardado en el tablero", ids.len());
    if n > 0 {
        send_push("followup", true, Some("La sesión de errores ha contestado"));
    }
    Ok(if n < ids.len() { 1 } else { 0 })
}

pub fn followup_status(_args: &Args) -> Result<i32, String> {
    json_of(crate::server::state::state().get("followUpStatus"));
    Ok(0)
}

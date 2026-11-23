//! Port of src/sessions/rotate.js.
use crate::core::json::truthy;
use crate::core::time::Clock;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

const ROLES: [(&str, &str); 2] = [("reporter", "Reporte JIRA"), ("orchestrator", "Orquestar agentes")];
const BUSY_MS: u64 = 10 * 60 * 1000;
static BUSY: AtomicBool = AtomicBool::new(false);

fn log(message: &str) {
    crate::core::logfile::append_log(&crate::core::data::DATA_DIR.join("startup.log"), &format!("{} {message}\n", crate::core::time::now()));
}

fn today() -> String {
    crate::core::time::madrid_now().day
}

fn text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => crate::core::json::stringify(other),
    }
}

fn fresh_conversation(role: &str, fallback_name: &str) -> bool {
    use crate::sessions::{host, registry};
    let Some(r) = registry::load_routes().get(role).filter(|r| truthy(Some(r))).cloned() else { return false };
    if !truthy(r.get("conversation")) || r.get("rotatedOn").and_then(|x| x.as_str()) == Some(today().as_str()) {
        return false;
    }
    let name = if truthy(r.get("session")) { text(r.get("session")) } else { fallback_name.to_string() };
    let Some(id) = registry::create_conversation(&name, None) else {
        log(&format!("no se pudo empezar la conversación del día de {name}: sigue la de ayer"));
        return false;
    };
    let previous = r.get("conversation").cloned().unwrap_or(Value::Null);
    let stale: Vec<Value> = host::read_config().into_iter().filter(|e| e.get("conversation").and_then(|c| c.as_str()) != Some(id.as_str()) && (e.get("conversation") == Some(&previous) || e.get("name").and_then(|n| n.as_str()) == Some(name.as_str()))).collect();
    for e in stale {
        let _ = host::host_request("POST", "/release", Some(&json!({ "conversation": e.get("conversation").cloned().unwrap_or(Value::Null) })));
    }
    registry::change_routes(|x| {
        let mut entry = x.get(role).and_then(|v| v.as_object()).cloned().unwrap_or_default();
        entry.insert("conversation".into(), Value::String(id.clone()));
        entry.insert("session".into(), Value::String(name.clone()));
        entry.insert("ref".into(), Value::Null);
        entry.insert("previous".into(), previous.clone());
        entry.insert("rotatedOn".into(), Value::String(today()));
        entry.insert("since".into(), Value::String(crate::core::time::now()));
        if let Some(o) = x.as_object_mut() {
            o.insert(role.to_string(), Value::Object(entry));
        }
        true
    });
    host::ensure_host();
    let _ = host::host_request("POST", "/start", Some(&json!({ "conversation": id, "name": name })));
    log(&format!("{name}: conversación nueva del día ({id}); la de ayer era {}", text(Some(&previous))));
    true
}

pub fn morning(t: Option<&Clock>) -> bool {
    let owned;
    let t = match t {
        Some(t) => t,
        None => {
            owned = crate::core::hours::clock();
            &owned
        }
    };
    !t.weekend && t.min < crate::core::hours::start_min() + 150
}

pub fn in_rotation_window(t: Option<&Clock>) -> bool {
    let owned;
    let t = match t {
        Some(t) => t,
        None => {
            owned = crate::core::hours::clock();
            &owned
        }
    };
    !t.weekend && t.min >= crate::core::hours::start_min() && morning(Some(t))
}

pub fn rotate_daily() {
    if !morning(None) {
        return;
    }
    for (role, name) in ROLES {
        fresh_conversation(role, name);
    }
}

pub fn rotate_if_morning() {
    if BUSY.load(Ordering::SeqCst) || !crate::cluster::cluster::is_primary() {
        return;
    }
    if !in_rotation_window(None) {
        return;
    }
    let routes = crate::sessions::registry::load_routes();
    let today = today();
    if ROLES.iter().all(|(role, _)| !truthy(routes.get(*role)) || routes[*role].get("rotatedOn").and_then(|x| x.as_str()) == Some(today.as_str())) {
        return;
    }
    BUSY.store(true, Ordering::SeqCst);
    crate::server::startup::launch_startup(false, false);
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(BUSY_MS));
        BUSY.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(local: &str) -> Clock {
        crate::testkit::sandbox();
        let ms = crate::core::time::parse(&format!("{local}+01:00")).unwrap();
        crate::core::time::madrid(ms)
    }

    #[test]
    fn daily_rotation_only_happens_on_weekday_mornings_from_07_30_to_10_00() {
        let _g = crate::testkit::fresh();
        assert!(!in_rotation_window(Some(&at("2026-11-09T07:29:00"))));
        assert!(in_rotation_window(Some(&at("2026-11-09T07:30:00"))));
        assert!(in_rotation_window(Some(&at("2026-11-09T09:59:00"))));
        assert!(!in_rotation_window(Some(&at("2026-11-09T10:00:00"))));
        assert!(!in_rotation_window(Some(&at("2026-11-09T10:30:00"))));
        assert!(!in_rotation_window(Some(&at("2026-11-14T08:00:00"))));
    }

    #[test]
    fn a_startup_rotates_any_time_before_10_00_on_weekdays() {
        let _g = crate::testkit::fresh();
        assert!(morning(Some(&at("2026-11-09T06:00:00"))));
        assert!(morning(Some(&at("2026-11-09T09:59:00"))));
        assert!(!morning(Some(&at("2026-11-09T10:00:00"))));
        assert!(!morning(Some(&at("2026-11-15T08:00:00"))));
    }
}

//! Port of src/sessions/hostfresh.js.
use crate::core::json::truthy;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

static QUIET_CHECKS: AtomicU32 = AtomicU32::new(0);

fn log(message: &str) {
    crate::core::logfile::append_log(&crate::core::data::DATA_DIR.join("host.log"), &format!("[{}] {message}\n", crate::core::time::now()));
}

pub fn host_is_behind(host_build: Option<&str>) -> bool {
    let Some(current) = crate::sessions::host::binary_build() else { return false };
    host_build != Some(current.as_str())
}

pub fn refresh_host_when_quiet() {
    use crate::sessions::host::{ensure_host, host_request};
    let version = host_request("GET", "/version", None).ok();
    let hosted = host_request("GET", "/sessions", None).ok();
    let build = version.as_ref().and_then(|v| v.get("build")).and_then(|b| b.as_str()).map(String::from);
    let Some(Value::Array(hosted)) = hosted else {
        QUIET_CHECKS.store(0, Ordering::SeqCst);
        return;
    };
    if !host_is_behind(build.as_deref()) {
        QUIET_CHECKS.store(0, Ordering::SeqCst);
        return;
    }
    let s = crate::server::state::state();
    let live: HashMap<String, &Value> = s.get("sessions").and_then(|x| x.get("list")).and_then(|l| l.as_array()).into_iter().flatten().map(|x| (x.get("conversation").and_then(|c| c.as_str()).unwrap_or("").to_string(), x)).collect();
    let quiet = hosted.iter().filter(|h| truthy(h.get("running"))).all(|h| match live.get(h.get("conversation").and_then(|c| c.as_str()).unwrap_or("")) {
        None => true,
        Some(l) => l.get("status").and_then(|x| x.as_str()) == Some("idle") && !truthy(l.get("background")),
    });
    let asking = s.get("permissions").and_then(|p| p.get("pending")).and_then(|p| p.as_array()).is_some_and(|p| !p.is_empty());
    let checks = if quiet && !asking { QUIET_CHECKS.fetch_add(1, Ordering::SeqCst) + 1 } else {
        QUIET_CHECKS.store(0, Ordering::SeqCst);
        0
    };
    if checks < 2 {
        return;
    }
    QUIET_CHECKS.store(0, Ordering::SeqCst);
    log("el gestor de sesiones va con código viejo y todas las sesiones están paradas: lo reinicio");
    let _ = host_request("POST", "/quit", None);
    std::thread::sleep(std::time::Duration::from_millis(4000));
    ensure_host();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_built_from_another_binary_is_behind() {
        let current = crate::sessions::host::binary_build().unwrap();
        assert!(!host_is_behind(Some(&current)));
        assert!(host_is_behind(Some("0-0")));
        assert!(host_is_behind(None));
    }
}

//! Port of bin/permission-hook.js.
use crate::commands::args::{obj, text};
use crate::core::json::{stringify, truthy};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

const POLL_MS: u64 = 2000;
static PORT: LazyLock<f64> = LazyLock::new(|| {
    let raw = ["TOWER_PORT", "TABLERO_PORT"].iter().filter_map(|n| std::env::var(n).ok()).find(|v| !v.is_empty()).unwrap_or_default();
    let n = raw.trim().parse::<f64>().unwrap_or(if raw.trim().is_empty() { 0.0 } else { f64::NAN });
    if n.is_nan() || n == 0.0 { 4747.0 } else { n }
});
static BASE: LazyLock<String> = LazyLock::new(|| format!("http://127.0.0.1:{}", stringify(&crate::core::json::num(*PORT))));

struct Hook {
    event: Value,
    rewritten: Option<Value>,
}

fn data_dir() -> Option<PathBuf> {
    std::env::var("TOWER_WORKSPACE").ok().filter(|w| !w.is_empty()).map(|w| PathBuf::from(w).join("data"))
}

fn call(method: &str, url: &str, body: Option<&Value>) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_millis(5000))).http_status_as_error(false).build().into();
    let full = format!("{}{url}", *BASE);
    let response = match body {
        Some(b) => agent.post(&full).header("origin", BASE.as_str()).header("content-type", "application/json").send(stringify(b)),
        None if method == "GET" => agent.get(&full).header("origin", BASE.as_str()).header("content-type", "application/json").call(),
        None => agent.post(&full).header("origin", BASE.as_str()).header("content-type", "application/json").send_empty(),
    };
    let mut response = response.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(status.to_string());
    }
    let body = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(if body.is_empty() { "{}" } else { &body }).map_err(|e| e.to_string())
}

fn trace(event: &Value, result: &str) {
    if let Some(dir) = data_dir() {
        let session: String = text(event.get("session_id").filter(|s| truthy(Some(s)))).chars().take(8).collect();
        let session = if truthy(event.get("session_id")) { session } else { String::new() };
        crate::core::logfile::append_log(&dir.join("hook.log"), &format!("{} {session} {} {result}\n", crate::core::time::now(), text(event.get("tool_name"))));
    }
}

fn write_out(v: &Value) {
    let mut out = std::io::stdout();
    let _ = out.write_all(stringify(v).as_bytes());
    let _ = out.flush();
}

impl Hook {
    fn decide(&self, decision: &str, reason: &str) -> i32 {
        trace(&self.event, decision);
        let mut inner = json!({ "hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": reason });
        if let Some(r) = &self.rewritten {
            inner["updatedInput"] = r.clone();
        }
        write_out(&json!({ "hookSpecificOutput": inner }));
        0
    }

    fn pass(&self) -> i32 {
        if let Some(r) = &self.rewritten {
            write_out(&json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "updatedInput": r } }));
        }
        0
    }

    fn tell_test_wait(&self, waiting: bool) {
        let session = text(self.event.get("session_id"));
        if session.is_empty() {
            return;
        }
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_millis(1500))).http_status_as_error(false).build().into();
        let _ = agent.post(&format!("{}/api/test-wait", *BASE)).header("origin", BASE.as_str()).header("content-type", "application/json").send(stringify(&json!({ "conversation": session, "waiting": waiting })));
    }

    fn browser_turn(&mut self) -> Option<i32> {
        let tool = self.event.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
        let command = self.event.get("tool_input").and_then(|i| i.get("command")).and_then(Value::as_str).map(String::from);
        if !crate::sessions::test_turn::is_browser_launch(&tool, command.as_deref()) {
            return None;
        }
        let load = crate::sessions::test_turn::measure();
        let reason = crate::sessions::test_turn::browser_wait(load.as_ref())?;
        Some(self.decide("deny", &reason))
    }

    fn test_turn(&mut self) -> Option<i32> {
        if self.event.get("tool_name").and_then(Value::as_str) != Some("Bash") {
            return None;
        }
        let command = self.event.get("tool_input").filter(|i| truthy(Some(i))).and_then(|i| i.get("command")).and_then(Value::as_str)?.to_string();
        let file = match data_dir() {
            Some(dir) => dir.join("test-turn.json"),
            None => std::env::temp_dir().join("tower-test-turn.json"),
        };
        let options = crate::sessions::test_turn::DecideOptions { list: None, file: Some(file), now_ms: None, load: None };
        let plan = std::panic::catch_unwind(|| crate::sessions::test_turn::decide(&command, &options)).ok()?;
        if plan.kind == "wait" {
            self.tell_test_wait(true);
            return Some(self.decide("deny", plan.reason.as_deref().unwrap_or("")));
        }
        if plan.kind == "go" {
            self.tell_test_wait(false);
            if let Some(new_command) = plan.command.filter(|c| !c.is_empty()) {
                let mut rewritten = self.event["tool_input"].clone();
                rewritten["command"] = Value::from(new_command.as_str());
                self.event["tool_input"] = rewritten.clone();
                self.rewritten = Some(rewritten);
                let processes = regex::Regex::new(r"--processes[=\s]+\d+").unwrap().find(&new_command).map(|m| m.as_str().to_string()).unwrap_or_else(|| "null".into());
                trace(&self.event, &format!("tests: {processes}"));
            }
        }
        None
    }

    fn without_board(&self) -> i32 {
        let event = self.event.clone();
        let verdict = std::panic::catch_unwind(move || {
            let tool = event.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
            let input = event.get("tool_input").cloned().unwrap_or(Value::Null);
            let cwd = event.get("cwd").and_then(Value::as_str).map(String::from);
            crate::sessions::permissions::classify(&tool, &input, cwd.as_deref())
        })
        .ok();
        let Some(c) = verdict else {
            trace(&self.event, "sin-tablero sin-filtro");
            return self.pass();
        };
        if c.kind == "allow" {
            trace(&self.event, "sin-tablero");
            return self.pass();
        }
        let label = c.label.filter(|l| !l.is_empty()).unwrap_or_else(|| text(self.event.get("tool_name")));
        self.decide("ask", &format!("El tablero no responde y esto lo protege el filtro: {label}. Decide tú aquí."))
    }
}

pub fn run(_args: &[String]) -> i32 {
    std::panic::set_hook(Box::new(|_| {}));
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let Ok(event) = serde_json::from_str::<Value>(&input) else {
        return 0;
    };
    let mut hook = Hook { event, rewritten: None };
    if let Some(code) = hook.test_turn() {
        return code;
    }
    if let Some(code) = hook.browser_turn() {
        return code;
    }
    let e = &hook.event;
    let body = obj(vec![("session_id", e.get("session_id").cloned()), ("tool_name", e.get("tool_name").cloned()), ("tool_input", e.get("tool_input").cloned()), ("cwd", e.get("cwd").cloned())]);
    let r = match call("POST", "/api/permission/check", Some(&body)) {
        Ok(r) => r,
        Err(_) => return hook.without_board(),
    };
    let decision = r.get("decision").and_then(Value::as_str);
    if decision == Some("allow") {
        return hook.decide("allow", "Permitido por el filtro del tablero");
    }
    if decision != Some("wait") {
        return hook.pass();
    }
    let minutes = r.get("waitMinutes").and_then(Value::as_f64).filter(|m| *m != 0.0 && !m.is_nan()).unwrap_or(55.0);
    let until = crate::core::time::now_ms() as f64 + minutes * 60000.0;
    let id = text(r.get("id"));
    while (crate::core::time::now_ms() as f64) < until {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        let Ok(p) = call("GET", &format!("/api/permission/{id}"), None) else { continue };
        match p.get("status").and_then(Value::as_str) {
            Some("allowed") => return hook.decide("allow", "Alberto lo ha permitido en el tablero"),
            Some("denied") => {
                let reason = if truthy(p.get("reason")) { format!(": {}", text(p.get("reason"))) } else { String::new() };
                return hook.decide("deny", &format!("Alberto lo ha denegado en el tablero{reason}. No lo intentes por otro camino; si hace falta, pregúntale."));
            }
            Some("expired") | Some("missing") => break,
            _ => {}
        }
    }
    hook.decide("deny", "Sin respuesta de Alberto en el tablero («Te esperan» → Permisos). Para aquí y avísale de qué necesitas; no lo intentes por otro camino.")
}

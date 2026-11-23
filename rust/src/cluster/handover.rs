use crate::cluster::peer::{peer_get, peer_post};
use crate::cluster::power::{keep_awake, let_sleep};
use crate::cluster::role::{CLUSTER, cluster_field, elapsed, is_primary, log, save, st_get, st_set};
use crate::cluster::snapshot::{merge_peer, pull_snapshot};
use crate::cluster::transcripts::{refresh_from_peer, running_conversations};
use crate::core::json::truthy;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

const TAKEOVER_MS: i64 = 3 * 60_000;
const SLEPT_MS: i64 = 2 * 60_000;
const RESUME_DELAY_MS: u64 = 25_000;
const ACTIVE_TASKS: [&str; 2] = ["sent", "approved"];
const BACK_PULL_MS: i64 = 3 * 60 * 1000;
const SNAPSHOT_MS: i64 = 60_000;
const ROLES: [(&str, &str); 4] = [("reporter", "Reporte JIRA"), ("orchestrator", "Orquestar agentes"), ("followUp", "Seguimiento"), ("board", "Tablero")];
const RESUME_NOTICE: &str = "Tablero: el tablero ha cambiado de ordenador y esta sesión se cortó a medias. Sigue con tus tareas pendientes desde donde lo dejaste; revisa antes el estado del repo por si algo quedó a medio hacer.";

static LAST_TICK: AtomicI64 = AtomicI64::new(0);
static LAST_BACK_PULL: AtomicI64 = AtomicI64::new(0);
static LAST_PULL: AtomicI64 = AtomicI64::new(0);
static BUSY: AtomicBool = AtomicBool::new(false);

fn now() -> String {
    crate::core::time::now()
}

fn text_of(v: Option<&Value>) -> Option<String> {
    v.filter(|x| truthy(Some(x))).and_then(Value::as_str).map(str::to_string)
}

fn start_session(conversation: &str, name: &str) {
    let _ = crate::sessions::host::host_request("POST", "/start", Some(&json!({ "conversation": conversation, "name": name })));
}

fn start_roles() {
    crate::sessions::host::ensure_host();
    for (role, name) in ROLES {
        let r = crate::sessions::registry::load_routes().get(role).cloned().filter(|v| truthy(Some(v)));
        let mut conversation = r.as_ref().and_then(|r| text_of(r.get("conversation")));
        if conversation.is_none() {
            let Some(created) = crate::sessions::registry::create_conversation(name, None) else {
                log(&format!("no se pudo crear la sesión {name}"));
                continue;
            };
            let c = created.clone();
            crate::sessions::registry::change_routes(|x| {
                let mut entry = x.get(role).and_then(Value::as_object).cloned().unwrap_or_default();
                entry.insert("session".into(), json!(name));
                entry.insert("title".into(), json!(name));
                entry.insert("conversation".into(), json!(c));
                entry.insert("since".into(), json!(now()));
                x[role] = Value::Object(entry);
                true
            });
            log(&format!("sesión {name} creada ({created})"));
            conversation = Some(created);
        }
        let session = r.as_ref().and_then(|r| text_of(r.get("session"))).unwrap_or_else(|| name.to_string());
        start_session(conversation.as_deref().unwrap_or(""), &session);
    }
    let routes = crate::sessions::registry::load_routes();
    let ids = [crate::server::state::deployer_area(&routes), crate::core::config::main_project().errors_area.clone()];
    for id in ids.into_iter().flatten().filter(|i| !i.is_empty()) {
        if let Some(a) = routes.get("areas").and_then(|a| a.get(&id)).filter(|a| truthy(a.get("conversation"))) {
            let name = text_of(a.get("session")).or_else(|| text_of(a.get("title"))).unwrap_or_else(|| id.clone());
            start_session(a["conversation"].as_str().unwrap_or(""), &name);
        }
    }
}

fn stop_roles() {
    let running = running_conversations();
    for e in crate::sessions::host::read_config() {
        let conversation = e.get("conversation").and_then(Value::as_str).unwrap_or("").to_string();
        if running.contains(&conversation) {
            let _ = crate::sessions::host::host_request("POST", "/stop", Some(&json!({ "conversation": conversation })));
        }
        crate::sessions::host::mark_on_demand(&conversation);
    }
}

fn resume_work() {
    let routes = crate::sessions::registry::load_routes();
    let doc = crate::core::data::load();
    let mut ids: Vec<String> = Vec::new();
    for t in doc.get("tasks").and_then(Value::as_object).map(|m| m.values().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if ACTIVE_TASKS.contains(&t.get("status").and_then(Value::as_str).unwrap_or("")) {
            if let Some(area) = text_of(t.get("area")) {
                if !ids.contains(&area) {
                    ids.push(area);
                }
            }
        }
    }
    let areas: Vec<(String, Value)> = ids.into_iter().filter_map(|id| routes.get("areas").and_then(|a| a.get(&id)).filter(|a| truthy(Some(a)) && truthy(a.get("conversation"))).cloned().map(|a| (id, a))).collect();
    if areas.is_empty() {
        return;
    }
    for (id, a) in &areas {
        let name = text_of(a.get("session")).or_else(|| text_of(a.get("title"))).unwrap_or_else(|| id.clone());
        start_session(a["conversation"].as_str().unwrap_or(""), &name);
    }
    log(&format!("relanzo {} sesión(es) con tareas en curso: {}", areas.len(), areas.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>().join(", ")));
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(RESUME_DELAY_MS));
        let live = crate::sessions::registry::live_sessions().unwrap_or_default();
        for (_, a) in &areas {
            let conversation = a["conversation"].as_str().unwrap_or("").to_string();
            if let Some(l) = live.iter().find(|x| x.get("conversation").and_then(Value::as_str) == Some(conversation.as_str())) {
                if l.get("status").and_then(Value::as_str) != Some("idle") {
                    continue;
                }
            }
            let _ = crate::sessions::host::host_request("POST", "/input", Some(&json!({ "conversation": conversation, "data": RESUME_NOTICE })));
            std::thread::sleep(std::time::Duration::from_millis(600));
            let _ = crate::sessions::host::host_request("POST", "/input", Some(&json!({ "conversation": conversation, "data": "\r" })));
        }
    });
}

fn promote(reason: &str, manual: bool) {
    st_set("role", json!("primary"));
    st_set("since", json!(now()));
    st_set("manual", json!(manual));
    save();
    log(&format!("paso a mandar: {reason}"));
    if manual {
        peer_post("/api/cluster/yield", &json!({ "force": true }));
        pull_snapshot();
        refresh_from_peer(None, false);
    }
    let text = format!("{} pasa a mandar: {reason}", crate::core::platform::hostname());
    std::thread::spawn(move || {
        crate::server::push::send_push("sessions", true, Some(&text));
    });
    crate::features::tunnel::guard();
    start_roles();
    resume_work();
    let board = crate::sessions::registry::load_routes().get("board").cloned();
    if let Some(session) = board.as_ref().and_then(|b| text_of(b.get("session"))) {
        std::thread::spawn(move || {
            crate::server::startup::notice_board(Some(&session), false);
        });
    }
    let overtime = crate::core::hours::overtime().is_some();
    crate::server::startup::launch_startup(false, overtime);
    if overtime {
        std::thread::spawn(|| {
            let _ = crate::features::devservers::start_all(true, None);
        });
    }
}

fn demote(reason: &str) {
    st_set("role", json!("follower"));
    st_set("since", json!(now()));
    st_set("manual", json!(false));
    save();
    log(&format!("dejo de mandar: {reason}"));
    stop_roles();
    let _ = crate::features::devservers::stop_all(None);
    if !crate::core::hours::work_hours(None) {
        let_sleep();
    }
}

fn label() -> String {
    cluster_field("label").unwrap_or_default()
}

fn tick_body(slept: bool) {
    let peer = peer_get("/api/cluster", None);
    if slept && peer.as_ref().map_or(false, |p| p.get("role").and_then(Value::as_str) == Some("primary")) && is_primary() {
        demote("este ordenador ha estado dormido y el otro tomó el mando mientras");
        return;
    }
    if let Some(mp) = peer.as_ref().and_then(|p| p.get("macPower")).filter(|v| truthy(Some(v))) {
        if !cfg!(target_os = "macos") {
            st_set("peerMacPower", mp.clone());
        }
    }
    let Some(peer) = peer else {
        if !truthy(Some(&st_get("peerDownSince"))) {
            st_set("peerDownSince", json!(now()));
        }
        st_set("noneSince", Value::Null);
        if !is_primary() && elapsed(st_get("peerDownSince").as_str().unwrap_or("")) > TAKEOVER_MS {
            st_set("pendingPull", json!(now()));
            promote("el otro ordenador no responde desde hace un minuto", false);
        }
        return;
    };
    st_set("peerDownSince", Value::Null);
    let peer_primary = peer.get("role").and_then(Value::as_str) == Some("primary");
    if peer_primary && is_primary() {
        if keeps_command(&peer) {
            if !truthy(Some(&st_get("pendingPull"))) {
                st_set("pendingPull", json!(now()));
            }
            log("los dos mandaban: sigo yo, que mandaba desde antes; el otro cede");
        } else {
            demote("los dos mandaban y el otro mandaba desde antes");
        }
    }
    let now_ms = crate::core::time::now_ms();
    if peer_primary && !is_primary() {
        st_set("noneSince", Value::Null);
        if now_ms - LAST_PULL.load(Ordering::SeqCst) > SNAPSHOT_MS {
            LAST_PULL.store(now_ms, Ordering::SeqCst);
            pull_snapshot();
        }
        if !truthy(peer.get("pendingPull")) {
            refresh_from_peer(None, false);
        }
        return;
    }
    if !is_primary() {
        if !truthy(Some(&st_get("noneSince"))) {
            st_set("noneSince", json!(now()));
        }
        let peer_label = peer.get("label").and_then(Value::as_str).unwrap_or("").to_string();
        if label() < peer_label || elapsed(st_get("noneSince").as_str().unwrap_or("")) > TAKEOVER_MS {
            st_set("noneSince", Value::Null);
            promote("ninguno mandaba", false);
        }
        return;
    }
    st_set("noneSince", Value::Null);
    if !peer_primary && now_ms - LAST_PULL.load(Ordering::SeqCst) > SNAPSHOT_MS {
        LAST_PULL.store(now_ms, Ordering::SeqCst);
        if merge_peer(peer_get("/api/cluster/snapshot", Some(30000)).as_ref()) {
            st_set("lastFollowerMerge", json!(now()));
        }
    }
    if !truthy(Some(&st_get("pendingPull"))) && !peer_primary && now_ms - LAST_BACK_PULL.load(Ordering::SeqCst) > BACK_PULL_MS {
        LAST_BACK_PULL.store(now_ms, Ordering::SeqCst);
        refresh_from_peer(Some(crate::cluster::transcripts::recent_since()), true);
    }
    if truthy(Some(&st_get("pendingPull"))) && !peer_primary && refresh_from_peer(None, false) >= 0 {
        log("conversaciones del otro ordenador traídas tras el relevo");
        st_set("pendingPull", Value::Null);
    }
}

pub fn tick() {
    if CLUSTER.is_none() || BUSY.load(Ordering::SeqCst) {
        return;
    }
    keep_awake();
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let now_ms = crate::core::time::now_ms();
    let last = LAST_TICK.swap(now_ms, Ordering::SeqCst);
    let slept = last != 0 && now_ms - last > SLEPT_MS;
    let result = std::panic::catch_unwind(|| tick_body(slept));
    save();
    BUSY.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

fn time_or_nan(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_str).and_then(crate::core::time::parse).map(|t| t as f64).unwrap_or(f64::NAN)
}

pub fn keeps_command(peer: &Value) -> bool {
    let manual = truthy(Some(&st_get("manual")));
    if manual != truthy(peer.get("manual")) {
        return manual;
    }
    let mine = time_or_nan(Some(&st_get("since")));
    let theirs = time_or_nan(peer.get("since"));
    if mine != theirs { mine < theirs } else { label() < peer.get("label").and_then(Value::as_str).unwrap_or("").to_string() }
}

pub fn handle_yield(input: &Value) {
    if CLUSTER.is_none() || !is_primary() || !truthy(input.get("force")) {
        return;
    }
    demote("el otro ordenador toma el mando porque lo has pedido");
}

pub fn take_here() -> Value {
    if CLUSTER.is_none() {
        return json!({ "ok": false, "error": "no hay dos ordenadores configurados" });
    }
    if is_primary() {
        st_set("manual", json!(true));
        save();
        log("sigo mandando, ahora porque lo has pedido");
        return json!({ "ok": true });
    }
    std::thread::spawn(|| {
        if let Err(e) = std::panic::catch_unwind(|| promote("lo has pedido desde el tablero", true)) {
            let message = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            log(&format!("error al tomar el mando: {message}"));
        }
    });
    json!({ "ok": true })
}

pub fn back_to_auto() -> Value {
    if !truthy(Some(&st_get("manual"))) {
        return json!({ "ok": true });
    }
    st_set("manual", json!(false));
    save();
    log("vuelvo al automático");
    json!({ "ok": true })
}

pub fn command(target: Option<&str>, action: &str) -> Value {
    let me = cluster_field("label");
    if let Some(t) = target.filter(|t| !t.is_empty()) {
        if Some(t.to_string()) != me {
            let ok = peer_post(if action == "auto" { "/api/cluster/auto" } else { "/api/cluster/take" }, &json!({}));
            return if ok { json!({ "ok": true }) } else { json!({ "ok": false, "error": format!("el {t} no responde") }) };
        }
    }
    if action == "auto" { back_to_auto() } else { take_here() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(role: &str, since: &str, manual: bool) {
        st_set("role", json!(role));
        st_set("since", json!(since));
        st_set("manual", json!(manual));
    }

    #[test]
    fn when_both_computers_command_the_one_that_commanded_first_keeps_it_and_one_taken_by_hand_wins() {
        let _g = crate::testkit::fresh();
        set("primary", "2026-11-18T05:00:00.000Z", false);
        assert!(keeps_command(&json!({ "role": "primary", "since": "2026-11-18T16:17:41.000Z", "manual": false })));
        set("primary", "2026-11-18T16:17:41.000Z", false);
        assert!(!keeps_command(&json!({ "role": "primary", "since": "2026-11-18T05:00:00.000Z", "manual": false })));
        set("primary", "2026-11-18T16:29:00.000Z", true);
        assert!(keeps_command(&json!({ "role": "primary", "since": "2026-11-18T05:00:00.000Z", "manual": false })));
        set("primary", "2026-11-18T05:00:00.000Z", false);
        assert!(!keeps_command(&json!({ "role": "primary", "since": "2026-11-18T16:29:00.000Z", "manual": true })));
    }
}

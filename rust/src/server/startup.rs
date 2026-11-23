//! Port of src/server/startup.js.
use crate::core::data::{DATA_DIR, is_uuid, load, mutate};
use crate::core::json::truthy;
use crate::core::logfile::append_log;
use crate::core::time::{madrid_now, now, now_ms};
use crate::server::state::{ping, state, wait};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

pub static STARTUP_LOG: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("startup.log"));
pub static STARTUP_LOCK: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("startup.lock"));
pub const FOLLOW_UP_NOTICE: &str = "Aviso del arranque: arranca el seguimiento. Eres la sesión de seguimiento registrada: ejecuta ahora .claude/commands/seguimiento.md (regla de AGENTS.md).";
pub const BOARD_NOTICE: &str = "Aviso del tablero: arranca la sesión del tablero. Eres la sesión del tablero registrada: ejecuta ahora .claude/commands/tablero.md (regla de AGENTS.md).";
pub const NOTICE_GAP_MS: i64 = 15 * 60000;

fn log(text: &str) {
    append_log(&STARTUP_LOG, &format!("{} {text}\n", now()));
}

fn panic_text(e: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = e.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = e.downcast_ref::<String>() {
        s.clone()
    } else {
        "error".to_string()
    }
}

fn guarded<R>(f: impl FnOnce() -> R) -> Result<R, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(|e| panic_text(&*e))
}

fn is_open(e: &Value) -> bool {
    truthy(e.get("open"))
}

fn session_of(e: &Value) -> String {
    match e.get("session") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".to_string(),
        None => "undefined".to_string(),
        Some(other) => crate::core::json::stringify(other),
    }
}

fn open_and_wait(read: &dyn Fn() -> Value, who: &str) -> Option<Value> {
    let mut e = read();
    if is_open(&e) {
        return Some(e);
    }
    crate::sessions::registry::open_in_vs_code(e.get("conversation").and_then(|c| c.as_str()));
    log(&format!("abro {who} en VS Code"));
    let mut i = 0;
    while i < 24 && !is_open(&e) {
        wait(5000);
        e = read();
        i += 1;
    }
    if !is_open(&e) {
        return None;
    }
    wait(8000);
    Some(e)
}

fn follow_up_status() -> Value {
    state().get("followUpStatus").cloned().unwrap_or(Value::Null)
}

fn reporter_status() -> Value {
    state().get("reporterStatus").cloned().unwrap_or(Value::Null)
}

fn start_follow_up(force: bool) {
    if !crate::cluster::cluster::is_primary() {
        return log("este ordenador no manda: no arranco el seguimiento");
    }
    let t = madrid_now();
    if !force && (t.weekend || t.min < crate::core::hours::start_min() + 20 || t.min >= crate::core::hours::end_min()) {
        return;
    }
    let e0 = follow_up_status();
    if e0.is_null() {
        return log("no hay sesión de seguimiento registrada");
    }
    if truthy(e0.get("paused")) {
        return log("revisiones en pausa desde el tablero: no se arranca el seguimiento");
    }
    if let Some(last) = e0.get("last").and_then(|l| l.as_str()).and_then(crate::core::time::parse) {
        if now_ms() - last < 70 * 60000 {
            return log("el seguimiento está al día");
        }
    }
    let Some(e) = open_and_wait(&follow_up_status, "la sesión de seguimiento") else { return log("la sesión de seguimiento no se abre") };
    match notice_follow_up(&e) {
        None => log("aviso de arranque al seguimiento ya enviado hace nada: no lo repito"),
        Some(ok) => log(&format!("aviso de arranque a la sesión de seguimiento ({}): {}", session_of(&e), if ok { "enviado" } else { "falló" })),
    }
}

fn recent(d: &crate::core::data::Doc, key: &str) -> bool {
    d.get(key).and_then(|v| v.as_str()).and_then(crate::core::time::parse).map_or(false, |at| now_ms() - at < NOTICE_GAP_MS)
}

fn claim(key: &'static str) -> bool {
    mutate(|d| {
        if recent(d, key) {
            return false;
        }
        d.insert(key.to_string(), Value::String(now()));
        true
    })
}

fn release(key: &'static str) {
    mutate(|d| {
        d.insert(key.to_string(), Value::Null);
    });
}

pub fn notice_follow_up(e: &Value) -> Option<bool> {
    notice_follow_up_with(e, &|s, n| crate::sessions::registry::wake_session(s, Some(n)))
}

pub fn notice_follow_up_with(e: &Value, wake: &dyn Fn(&str, &str) -> bool) -> Option<bool> {
    if !claim("followUpNoticeAt") {
        return None;
    }
    let ok = wake(&session_of(e), FOLLOW_UP_NOTICE);
    if !ok {
        release("followUpNoticeAt");
    }
    Some(ok)
}

pub fn notice_reporter(session: Option<&str>) -> Option<bool> {
    notice_reporter_with(session, &|s| crate::sessions::registry::wake_session(s, None))
}

pub fn notice_reporter_with(session: Option<&str>, wake: &dyn Fn(&str) -> bool) -> Option<bool> {
    let session = session.filter(|s| !s.is_empty())?;
    if !claim("reporterNoticeAt") {
        return None;
    }
    let ok = wake(session);
    if !ok {
        release("reporterNoticeAt");
    }
    Some(ok)
}

pub fn claim_orchestrator_notice() -> bool {
    claim("orchestratorNoticeAt")
}

fn local_day(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

pub fn notice_board(session: Option<&str>, respawn: bool) -> Option<bool> {
    notice_board_with(session, respawn, &|s, n| crate::sessions::registry::wake_session(s, Some(n)))
}

pub fn notice_board_with(session: Option<&str>, respawn: bool, wake: &dyn Fn(&str, &str) -> bool) -> Option<bool> {
    let session = session.filter(|s| !s.is_empty())?;
    let claimed = mutate(|d| {
        let last = d.get("boardNoticeAt").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
        if recent(d, "boardNoticeAt") {
            return false;
        }
        if respawn {
            if let Some(at) = last.as_deref().and_then(crate::core::time::parse) {
                if local_day(at) == local_day(now_ms()) {
                    return false;
                }
            }
        }
        d.insert("boardNoticeAt".to_string(), Value::String(now()));
        true
    });
    if !claimed {
        return None;
    }
    let ok = wake(session, BOARD_NOTICE);
    if !ok {
        release("boardNoticeAt");
    }
    Some(ok)
}

fn spawn_self(args: &[&str]) {
    let Ok(exe) = crate::core::platform::self_exe() else { return };
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    crate::core::platform::spawn_detached(&exe.to_string_lossy(), &args, None);
}

fn write_lock() {
    let _ = std::fs::write(&*STARTUP_LOCK, std::process::id().to_string());
}

fn start_reporter(force: bool) -> bool {
    if !ping() {
        spawn_self(&["serve"]);
    }
    if let Ok(modified) = std::fs::metadata(&*STARTUP_LOCK).and_then(|m| m.modified()) {
        if modified.elapsed().map_or(true, |e| e.as_millis() < 10 * 60000) {
            return false;
        }
    }
    write_lock();
    let t = madrid_now();
    if force {
        log("fuera de horario activado a mano: arranco todo");
    } else if t.weekend || t.min >= crate::core::hours::end_min() {
        log("fuera de horario: no se arranca nada");
        return true;
    }
    let ready = crate::core::hours::start_min() + 25;
    if !force && t.min < ready {
        log(&format!("antes de las {:02}:{:02}: espero", ready / 60, ready % 60));
        while madrid_now().min < ready {
            wait(60000);
            write_lock();
        }
    }
    wait(25000);
    if !ping() {
        spawn_self(&["serve"]);
        wait(1500);
    }
    if !crate::cluster::cluster::is_primary() {
        log("este ordenador no manda: no arranco el reporte");
        return true;
    }
    if truthy(reporter_status().get("paused")) {
        log("revisiones en pausa desde el tablero: no se arranca el reporte");
        return true;
    }
    if let Err(e) = guarded(crate::sessions::rotate::rotate_daily) {
        log(&format!("error al empezar las conversaciones del día: {e}"));
    }
    let today = madrid_now().day;
    for _attempt in 1..=3 {
        let rep0 = reporter_status();
        if load().get("reporterStartedOn").and_then(|v| v.as_str()) == Some(today.as_str()) {
            log("la sesión de reporte ya arrancó hoy");
            return true;
        }
        if rep0.is_null() || !is_uuid(rep0.get("conversation").and_then(|c| c.as_str()).unwrap_or("")) {
            log("no hay sesión de reporte registrada: lanza /resumen-jira una vez a mano");
            return true;
        }
        let Some(rep) = open_and_wait(&reporter_status, "la sesión de reporte") else {
            log("la sesión de reporte no se abre");
            continue;
        };
        let session = rep.get("session").and_then(|s| s.as_str()).map(|s| s.to_string());
        let mark_started = || {
            let today = today.clone();
            mutate(move |d| {
                d.insert("reporterStartedOn".to_string(), Value::String(today));
            })
        };
        match notice_reporter(session.as_deref()) {
            None => {
                log("aviso de arranque al reporte ya enviado hace nada: no lo repito");
                mark_started();
                return true;
            }
            Some(ok) => {
                log(&format!("aviso de arranque a {}: {}", session_of(&rep), if ok { "enviado" } else { "falló" }));
                if ok {
                    mark_started();
                    return true;
                }
            }
        }
        wait(30000);
    }
    log("no se consiguió arrancar el reporte en tres intentos");
    true
}

pub fn launch_startup(child: bool, force: bool) {
    if !child {
        let mut args = vec!["startup", "--child"];
        if force {
            args.push("--force");
        }
        spawn_self(&args);
        println!("Arranque del reporte lanzado en segundo plano (registro en {}).", STARTUP_LOG.to_string_lossy().replace('\\', "/"));
        return;
    }
    let mine = match guarded(|| start_reporter(force)) {
        Ok(r) => r,
        Err(e) => {
            log(&format!("error: {e}"));
            true
        }
    };
    let follow = guarded(|| {
        if mine {
            start_follow_up(force)
        } else {
            log("otro arranque ya está en marcha: no aviso al seguimiento")
        }
    });
    if let Err(e) = follow {
        log(&format!("error en el seguimiento: {e}"));
    }
    if mine {
        let _ = std::fs::remove_file(&*STARTUP_LOCK);
    }
    std::process::exit(0);
}

pub fn wake_follow_up() {
    let e0 = follow_up_status();
    if e0.is_null() {
        return;
    }
    if let Some(e) = open_and_wait(&follow_up_status, "la sesión de seguimiento") {
        if notice_follow_up(&e).is_none() {
            log("la sesión de seguimiento se reabrió, pero el aviso de arranque ya salió hace nada: no lo repito");
        }
    }
}

pub fn set_overtime(on: bool) -> Value {
    let value = crate::core::hours::set_overtime(on).unwrap_or(Value::Null);
    if on {
        crate::cluster::cluster::keep_awake();
        launch_startup(false, true);
        let _ = guarded(|| crate::features::devservers::start_all(true, None));
    } else {
        crate::cluster::cluster::let_sleep();
        let _ = guarded(|| crate::features::devservers::stop_all(None));
        let _ = guarded(|| crate::sessions::autosleep::sleep_idle_sessions(true));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn ago(minutes: i64) -> Value {
        Value::String(crate::core::time::iso(now_ms() - minutes * 60000))
    }

    #[test]
    fn the_board_session_gets_its_startup_notice_once_however_many_paths_fire() {
        let _g = crate::testkit::fresh();
        let sent = RefCell::new(Vec::<(String, String)>::new());
        let wake = |s: &str, n: &str| {
            sent.borrow_mut().push((s.to_string(), n.to_string()));
            true
        };
        assert_eq!(notice_board_with(Some("Tablero"), false, &wake), Some(true));
        assert_eq!(notice_board_with(Some("Tablero"), false, &wake), None);
        assert_eq!(notice_board_with(Some("Tablero"), true, &wake), None);
        assert_eq!(sent.borrow().len(), 1);
        assert!(sent.borrow()[0].1.contains("arranca la sesión del tablero"));
    }

    #[test]
    fn a_reopened_board_session_is_not_told_again_the_same_day_but_taking_command_later_is() {
        let _g = crate::testkit::fresh();
        let sent = RefCell::new(0);
        let wake = |_: &str, _: &str| {
            *sent.borrow_mut() += 1;
            true
        };
        let at = ago(20);
        let same_day = local_day(crate::core::time::parse(at.as_str().unwrap()).unwrap()) == local_day(now_ms());
        mutate(|d| {
            d.insert("boardNoticeAt".to_string(), at.clone());
        });
        assert_eq!(notice_board_with(Some("Tablero"), true, &wake), if same_day { None } else { Some(true) });
        if same_day {
            assert_eq!(notice_board_with(Some("Tablero"), false, &wake), Some(true));
        }
        assert_eq!(*sent.borrow(), 1);
    }

    #[test]
    fn a_failed_notice_can_be_retried_at_once() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("boardNoticeAt".to_string(), Value::Null);
        });
        assert_eq!(notice_board_with(Some("Tablero"), false, &|_, _| false), Some(false));
        assert_eq!(notice_board_with(Some("Tablero"), false, &|_, _| true), Some(true));
    }

    #[test]
    fn the_reporter_gets_its_startup_notice_once_when_the_daily_start_and_the_respawn_both_fire() {
        let _g = crate::testkit::fresh();
        let sent = RefCell::new(0);
        let wake = |_: &str| {
            *sent.borrow_mut() += 1;
            true
        };
        assert_eq!(notice_reporter_with(Some("Reporte JIRA"), &wake), Some(true));
        assert_eq!(notice_reporter_with(Some("Reporte JIRA"), &wake), None);
        assert_eq!(*sent.borrow(), 1);
        mutate(|d| {
            d.insert("reporterNoticeAt".to_string(), Value::Null);
        });
        assert_eq!(notice_reporter_with(Some("Reporte JIRA"), &|_| false), Some(false));
        assert_eq!(notice_reporter_with(Some("Reporte JIRA"), &wake), Some(true));
    }

    #[test]
    fn the_orchestrator_startup_notice_goes_out_once_per_quarter_hour() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("orchestratorNoticeAt".to_string(), Value::Null);
        });
        assert!(claim_orchestrator_notice());
        assert!(!claim_orchestrator_notice());
    }

    #[test]
    fn the_follow_up_startup_notice_goes_out_once_even_when_several_paths_ask_for_it_at_the_same_time() {
        let _g = crate::testkit::fresh();
        let sent = std::sync::Arc::new(std::sync::Mutex::new(0));
        let e = serde_json::json!({ "session": "palc-de" });
        let results: Vec<Option<bool>> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..3)
                .map(|_| {
                    let sent = sent.clone();
                    let e = e.clone();
                    s.spawn(move || {
                        notice_follow_up_with(&e, &|_, _| {
                            *sent.lock().unwrap() += 1;
                            true
                        })
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(*sent.lock().unwrap(), 1);
        assert_eq!(results.iter().filter(|r| r.is_none()).count(), 2);
        assert_eq!(notice_follow_up_with(&e, &|_, _| true), None);
    }

    #[test]
    fn a_failed_follow_up_notice_can_be_retried_and_a_later_notice_goes_out_again() {
        let _g = crate::testkit::fresh();
        let e = serde_json::json!({ "session": "palc-de" });
        let sent = RefCell::new(0);
        let answer = |ok: bool| {
            let sent = &sent;
            move |_: &str, _: &str| {
                *sent.borrow_mut() += 1;
                ok
            }
        };
        assert_eq!(notice_follow_up_with(&e, &answer(false)), Some(false));
        assert_eq!(notice_follow_up_with(&e, &answer(true)), Some(true));
        mutate(|d| {
            d.insert("followUpNoticeAt".to_string(), ago(20));
        });
        assert_eq!(notice_follow_up_with(&e, &answer(true)), Some(true));
        assert_eq!(*sent.borrow(), 3);
    }
}

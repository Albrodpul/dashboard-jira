//! Port of src/features/mac-power.js.
use crate::core::data::{DATA_DIR, mutate, read_key};
use crate::core::json::{parse, stringify, truthy};
use crate::core::logfile::append_log;
use crate::core::time::{Clock, madrid_now, now, now_ms};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

const DEFAULT_WAKE: &str = "06:00";
const DEFAULT_SLEEP: &str = "21:00";
const DEFAULT_DAYS: &str = "MTWRF";
const DEFAULT_WEEKLY_OFF: bool = true;
const IS_MAC: bool = cfg!(target_os = "macos");
static STATE_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("mac-power.json"));

static BATTERY_CACHE: LazyLock<Mutex<Option<(i64, Option<Value>)>>> = LazyLock::new(|| Mutex::new(None));
static SUDO_CACHE: LazyLock<Mutex<Option<(i64, bool)>>> = LazyLock::new(|| Mutex::new(None));
static SCREEN_KEEPER: LazyLock<Mutex<Option<Child>>> = LazyLock::new(|| Mutex::new(None));
static AUTO_LOGIN_CACHE: LazyLock<Mutex<Option<(i64, bool)>>> = LazyLock::new(|| Mutex::new(None));
static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap());

fn log(m: &str) {
    append_log(&DATA_DIR.join("mac-power.log"), &format!("[{}] {}\n", now(), m));
}

fn run(program: &str, args: &[&str], ms: u64) -> Option<std::process::Output> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    crate::features::devservers::run_with_timeout(&mut cmd, None, ms).ok()
}

pub fn schedule() -> Value {
    let s = read_key("config").and_then(|c| c.get("macSchedule").cloned()).unwrap_or(json!({}));
    let ok = |k: &str| s.get(k).and_then(Value::as_str).filter(|t| TIME.is_match(t)).map(str::to_string);
    let weekly_off = s.get("weeklyOff").and_then(Value::as_bool).unwrap_or(DEFAULT_WEEKLY_OFF);
    json!({ "wake": ok("wake").unwrap_or(DEFAULT_WAKE.into()), "sleep": ok("sleep").unwrap_or(DEFAULT_SLEEP.into()), "days": DEFAULT_DAYS, "weeklyOff": weekly_off })
}

pub fn set_schedule(input: &Value) -> Value {
    let current = schedule();
    mutate(|d| {
        let mut config = d.get("config").filter(|c| truthy(Some(c))).and_then(Value::as_object).cloned().unwrap_or_default();
        let mut s: Map<String, Value> = current.as_object().cloned().unwrap_or_default();
        for k in ["wake", "sleep"] {
            if let Some(v) = input.get(k).filter(|v| truthy(Some(v))) {
                s.insert(k.into(), v.clone());
            }
        }
        if let Some(b) = input.get("weeklyOff").filter(|v| v.is_boolean()) {
            s.insert("weeklyOff".into(), b.clone());
        }
        config.insert("macSchedule".into(), Value::Object(s));
        d.insert("config".into(), Value::Object(config));
    });
    schedule()
}

fn minutes(t: &str) -> u32 {
    t.get(0..2).and_then(|h| h.parse::<u32>().ok()).unwrap_or(0) * 60 + t.get(3..).and_then(|m| m.parse::<u32>().ok()).unwrap_or(0)
}

fn field(s: &Value, k: &str) -> String {
    s.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn in_window(clock: &Clock) -> bool {
    let s = schedule();
    !clock.weekend && clock.min >= minutes(&field(&s, "wake")) && clock.min < minutes(&field(&s, "sleep"))
}

pub fn battery() -> Option<Value> {
    if !IS_MAC {
        return None;
    }
    if let Some((t, v)) = BATTERY_CACHE.lock().unwrap().clone() {
        if now_ms() - t < 30000 {
            return v;
        }
    }
    let mut value = None;
    if let Some(out) = run("/usr/bin/pmset", &["-g", "batt"], 5000).filter(|o| o.status.success()) {
        let out = String::from_utf8_lossy(&out.stdout).to_string();
        static BATT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)%;\s*([^;]+);").unwrap());
        static CHARGING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^charging|finishing charge").unwrap());
        if let Some(m) = BATT.captures(&out) {
            let state = m[2].trim().to_string();
            value = Some(json!({ "percent": m[1].parse::<f64>().map(crate::core::json::num).unwrap_or(Value::Null), "state": state, "charging": CHARGING.is_match(&state), "onAC": out.contains("AC Power"), "at": now() }));
        }
    }
    *BATTERY_CACHE.lock().unwrap() = Some((now_ms(), value.clone()));
    value
}

fn read_state() -> Value {
    std::fs::read_to_string(&*STATE_FILE).ok().and_then(|t| parse(&t)).filter(Value::is_object).unwrap_or(json!({}))
}

fn write_state(s: &Value) {
    let _ = std::fs::write(&*STATE_FILE, stringify(s));
}

fn sudo_pmset(args: &[&str]) -> bool {
    if cfg!(test) {
        return false;
    }
    let mut all = vec!["-n", "/usr/bin/pmset"];
    all.extend_from_slice(args);
    run("/usr/bin/sudo", &all, 10000).is_some_and(|o| o.status.success())
}

fn can_sudo() -> bool {
    if cfg!(test) {
        return false;
    }
    if let Some((t, ok)) = *SUDO_CACHE.lock().unwrap() {
        if now_ms() - t < 10 * 60000 {
            return ok;
        }
    }
    let ok = run("/usr/bin/sudo", &["-n", "-l", "/usr/bin/pmset"], 5000).is_some_and(|o| o.status.success());
    *SUDO_CACHE.lock().unwrap() = Some((now_ms(), ok));
    ok
}

fn sleep_disabled() -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"SleepDisabled\s+1").unwrap());
    run("/usr/bin/pmset", &["-g"], 5000).filter(|o| o.status.success()).is_some_and(|o| RE.is_match(&String::from_utf8_lossy(&o.stdout)))
}

fn lid_open() -> bool {
    run("/usr/sbin/ioreg", &["-r", "-k", "AppleClamshellState", "-d", "1"], 5000).filter(|o| o.status.success()).is_some_and(|o| String::from_utf8_lossy(&o.stdout).contains("\"AppleClamshellState\" = No"))
}

fn keep_screen(on: bool) {
    let mut keeper = SCREEN_KEEPER.lock().unwrap();
    if keeper.as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_some()) {
        *keeper = None;
    }
    if on && keeper.is_none() {
        if let Ok(child) = Command::new("/usr/bin/caffeinate").args(["-d", "-w", &std::process::id().to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
            *keeper = Some(child);
        }
        log("tapa abierta en horario: la pantalla no se apaga");
    } else if !on {
        if let Some(mut child) = keeper.take() {
            let _ = child.kill();
            let _ = child.wait();
            log("la pantalla vuelve a apagarse sola");
        }
    }
}

fn sleep_now() {
    std::thread::spawn(|| {
        let _ = Command::new("/usr/bin/pmset").arg("sleepnow").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    });
}

pub fn tick() {
    if !IS_MAC {
        return;
    }
    let clock = crate::core::hours::clock();
    let s = schedule();
    let (wake, sleep) = (field(&s, "wake"), field(&s, "sleep"));
    let weekly_off = s["weeklyOff"].as_bool().unwrap_or(true);
    let mut st = read_state();
    let today = madrid_now().day;
    let key = format!("{wake}-{sleep}-{}", if weekly_off { "off" } else { "on" });
    if st.get("repeat").and_then(Value::as_str) != Some(key.as_str()) && can_sudo() {
        let wake_at = format!("{wake}:00");
        let sleep_at = format!("{sleep}:00");
        let mut args = vec!["repeat", "wakeorpoweron", DEFAULT_DAYS, wake_at.as_str()];
        if weekly_off {
            args.extend(["shutdown", "F", sleep_at.as_str()]);
        }
        if sudo_pmset(&args) {
            st["repeat"] = Value::from(key.clone());
            log(&format!("despertar programado de lunes a viernes a las {wake}{}", if weekly_off { format!("; apagado los viernes a las {sleep}") } else { String::new() }));
        }
    }
    let primary = crate::cluster::cluster::is_primary();
    let overtime = truthy(crate::core::hours::overtime().as_ref()) && primary;
    let awake = in_window(&clock) || overtime;
    let bat = battery();
    let nearly_empty = bat.as_ref().is_some_and(|b| !truthy(b.get("onAC")) && !truthy(b.get("charging")) && b.get("percent").and_then(Value::as_f64).is_some_and(|p| p < 10.0));
    let lid_awake = awake && !nearly_empty;
    if lid_awake != sleep_disabled() && can_sudo() && sudo_pmset(&["-a", "disablesleep", if lid_awake { "1" } else { "0" }]) {
        log(if lid_awake {
            "no se duerme ni con la tapa cerrada (en horario)"
        } else if nearly_empty && awake {
            "batería por debajo del 10 %: se deja dormir"
        } else {
            "vuelve a dormirse al cerrar la tapa"
        });
    }
    keep_screen(lid_awake && lid_open());
    let sleep_min = minutes(&sleep);
    if !clock.weekend && !overtime && clock.min >= sleep_min && clock.min < sleep_min + 30 && st.get("sleptOn").and_then(Value::as_str) != Some(today.as_str()) {
        st["sleptOn"] = Value::from(today);
        keep_screen(false);
        write_state(&st);
        crate::cluster::cluster::let_sleep();
        if sleep_disabled() {
            sudo_pmset(&["-a", "disablesleep", "0"]);
        }
        if weekly_off && clock.weekday == "Fri" {
            log(&format!("son las {sleep} del viernes: se apaga hasta el lunes a las {wake}; si algo frena el apagado, se duerme y el tablero no manda nada hasta el lunes"));
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_secs(3 * 60));
                sleep_now();
            });
            return;
        }
        log(&format!("son las {sleep}: a dormir"));
        sleep_now();
        return;
    }
    write_state(&st);
}

fn auto_login() -> Option<bool> {
    if !IS_MAC {
        return None;
    }
    if let Some((t, v)) = *AUTO_LOGIN_CACHE.lock().unwrap() {
        if now_ms() - t < 60000 {
            return Some(v);
        }
    }
    let v = run("/usr/bin/defaults", &["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"], 5000).filter(|o| o.status.success()).is_some_and(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty());
    *AUTO_LOGIN_CACHE.lock().unwrap() = Some((now_ms(), v));
    Some(v)
}

pub fn status() -> Value {
    json!({ "schedule": schedule(), "allowed": if IS_MAC { Value::from(can_sudo()) } else { Value::Null }, "battery": battery(), "autoLogin": auto_login() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::fresh;

    fn clock(weekend: bool, min: u32) -> Clock {
        Clock { weekday: if weekend { "Sat" } else { "Mon" }, weekend, hour: min / 60, minute: min % 60, min, day: String::new() }
    }

    #[test]
    fn the_schedule_falls_back_to_the_defaults_and_keeps_valid_changes() {
        let _g = fresh();
        assert_eq!(schedule(), json!({ "wake": "06:00", "sleep": "21:00", "days": "MTWRF", "weeklyOff": true }));
        let s = set_schedule(&json!({ "wake": "07:15", "weeklyOff": false }));
        assert_eq!(s, json!({ "wake": "07:15", "sleep": "21:00", "days": "MTWRF", "weeklyOff": false }));
        mutate(|d| d.insert("config".into(), json!({ "macSchedule": { "wake": "25:00", "sleep": "nope" } })));
        assert_eq!(schedule()["wake"], "06:00");
        assert_eq!(schedule()["sleep"], "21:00");
    }

    #[test]
    fn the_window_is_working_days_between_wake_and_sleep() {
        let _g = fresh();
        assert!(in_window(&clock(false, 6 * 60)));
        assert!(in_window(&clock(false, 20 * 60 + 59)));
        assert!(!in_window(&clock(false, 21 * 60)));
        assert!(!in_window(&clock(false, 5 * 60 + 59)));
        assert!(!in_window(&clock(true, 10 * 60)));
    }
}

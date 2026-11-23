//! Port of src/features/jira-watch.js.
use crate::core::data::{Doc, load, mutate, now};
use crate::core::json::{parse, truthy};
use crate::core::time::Clock;
use serde_json::Value;
use std::process::Command;
use std::sync::{LazyLock, Mutex};

static ME: LazyLock<String> = LazyLock::new(|| crate::core::config::main_project().jira.as_ref().and_then(|j| j.me.get("name")).and_then(|v| v.as_str()).unwrap_or_default().to_string());
const DOC: &str = ".claude/commands/resumen-jira.md";
const WAIT_MS: i64 = 5 * 60000;
const CHECK_MS: i64 = 15000;

#[derive(Clone)]
struct Waiting {
    last: Option<String>,
    at: i64,
}

struct Watch {
    last_quiet: String,
    last_check: i64,
    waiting: Option<Waiting>,
    running: bool,
}

struct Parts {
    weekday: String,
    hour: String,
    minute: String,
}

struct Deps {
    primary: Box<dyn Fn() -> bool + Send>,
    fresh: Box<dyn Fn() -> Option<i64> + Send>,
    quiet: Box<dyn Fn(&str, Option<&str>) -> bool + Send>,
    notify: Box<dyn Fn(&str) + Send>,
    clock: Box<dyn Fn() -> Clock + Send>,
    overtime: Box<dyn Fn() -> bool + Send>,
    parts: Box<dyn Fn() -> Parts + Send>,
    ms: Box<dyn Fn() -> i64 + Send>,
}

static WATCH: LazyLock<Mutex<Watch>> = LazyLock::new(|| Mutex::new(Watch { last_quiet: String::new(), last_check: 0, waiting: None, running: false }));
static DEPS: LazyLock<Mutex<Option<Deps>>> = LazyLock::new(|| Mutex::new(None));

fn default_deps() -> Deps {
    Deps {
        primary: Box::new(crate::cluster::cluster::primary_now),
        fresh: Box::new(fresh_in_jira),
        quiet: Box::new(quiet_review),
        notify: Box::new(|text| crate::features::mailman::notify_role("reporter", text)),
        clock: Box::new(crate::core::hours::clock),
        overtime: Box::new(|| truthy(crate::core::hours::overtime().as_ref())),
        parts: Box::new(|| {
            let c = crate::core::time::madrid_now();
            Parts { weekday: c.weekday.to_string(), hour: format!("{:02}", c.hour), minute: format!("{:02}", c.minute) }
        }),
        ms: Box::new(crate::core::time::now_ms),
    }
}

fn with_deps<R>(f: impl FnOnce(&Deps) -> R) -> R {
    let guard = DEPS.lock().unwrap();
    match guard.as_ref() {
        Some(d) => f(d),
        None => {
            drop(guard);
            f(&default_deps())
        }
    }
}

pub fn review_hours(t: Option<&Clock>) -> bool {
    let owned;
    let t = match t {
        Some(t) => t,
        None => {
            owned = crate::core::hours::clock();
            &owned
        }
    };
    !t.weekend && t.min >= crate::core::hours::start_min() && t.min <= crate::core::hours::end_min()
}

fn last_of(d: &Doc) -> Option<String> {
    let review = d.get("lastReview").and_then(|r| r.get("at")).filter(|a| truthy(Some(a)));
    let report = d.get("reports").and_then(|r| r.get(0)).and_then(|r| r.get("at")).filter(|a| truthy(Some(a)));
    review.or(report).and_then(Value::as_str).map(str::to_string)
}

fn hhmm(iso: &str) -> String {
    crate::core::time::parse(iso).map(crate::core::time::madrid_hhmm).unwrap_or_else(|| "Invalid Date".into())
}

fn self_command(args: &[String]) -> Command {
    let exe = crate::core::platform::self_exe().unwrap_or_else(|_| "tower".into());
    let mut cmd = Command::new(exe);
    cmd.args(args).env("TOWER_WORKSPACE", crate::core::config::workspace());
    cmd
}

pub fn fresh_in_jira() -> Option<i64> {
    let mut cmd = self_command(&["jira-window".into(), "--check".into()]);
    let out = crate::features::devservers::run_with_timeout(&mut cmd, None, 90000).ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let last = text.trim().split('\n').last()?.trim_end_matches('\r').to_string();
    let v = parse(&last)?;
    let n = v.get("fresh")?;
    n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
}

fn quiet_review(label: &str, last: Option<&str>) -> bool {
    let since = last.map(|l| format!(" desde las {}", hhmm(l))).unwrap_or_default();
    let text = format!("**Revisión de las {label}: sin novedades{since}.**");
    let mut cmd = self_command(&["report".into(), text]);
    crate::features::devservers::run_with_timeout(&mut cmd, None, 30000).is_ok_and(|o| o.status.success())
}

fn review_text(n: Option<i64>) -> String {
    let what = match n {
        None => "cambios por revisar".to_string(),
        Some(1) => "1 novedad sin contar".to_string(),
        Some(n) => format!("{n} novedades sin contar"),
    };
    format!("Tablero: hay {what} en Jira. Haz «Cada revisión» de {DOC} y publica el reporte con «{} report».", crate::core::config::cli())
}

fn refresh_text() -> String {
    format!("Tablero: {} ha pulsado Refrescar. Haz «Cada revisión» de {DOC} aunque no haya novedades y publica el reporte con «{} report».", *ME, crate::core::config::cli())
}

fn refresh(e: &Deps) -> bool {
    let d = load();
    let Some(p) = d.get("refreshRequest").filter(|p| truthy(Some(p))) else { return false };
    if truthy(p.get("handled")) || truthy(p.get("notifiedAt")) {
        return false;
    }
    let id = p.get("id").cloned();
    mutate(|x| {
        if let Some(r) = x.get_mut("refreshRequest").filter(|r| truthy(Some(r))) {
            if r.get("id").cloned() == id {
                r["notifiedAt"] = Value::from(now());
            }
        }
    });
    (e.notify)(&refresh_text());
    WATCH.lock().unwrap().waiting = Some(Waiting { last: last_of(&d), at: (e.ms)() });
    true
}

pub fn tick() {
    with_deps(|e| {
        if WATCH.lock().unwrap().running || !(e.primary)() {
            return;
        }
        if refresh(e) {
            return;
        }
        if !review_hours(Some(&(e.clock)())) && !(e.overtime)() {
            return;
        }
        let d = load();
        if d.get("config").is_some_and(|c| truthy(c.get("paused"))) {
            return;
        }
        let t = (e.ms)();
        let last = last_of(&d);
        {
            let mut w = WATCH.lock().unwrap();
            if t - w.last_check < CHECK_MS {
                return;
            }
            if let Some(waiting) = &w.waiting {
                if waiting.last == last && t - waiting.at < WAIT_MS {
                    return;
                }
            }
            w.waiting = None;
            w.last_check = t;
            w.running = true;
        }
        struct Done;
        impl Drop for Done {
            fn drop(&mut self) {
                WATCH.lock().unwrap().running = false;
            }
        }
        let _done = Done;
        let n = (e.fresh)();
        if n == Some(0) {
            let p = (e.parts)();
            let minute = format!("{}{}{}", p.weekday, p.hour, p.minute);
            let already = WATCH.lock().unwrap().last_quiet == minute;
            if !already && (e.quiet)(&format!("{}:{}", p.hour, p.minute), last.as_deref()) {
                WATCH.lock().unwrap().last_quiet = minute;
            }
            return;
        }
        WATCH.lock().unwrap().waiting = Some(Waiting { last, at: (e.ms)() });
        (e.notify)(&review_text(n));
    })
}

#[cfg(test)]
fn set_deps(d: Deps) {
    *DEPS.lock().unwrap() = Some(d);
}

#[cfg(test)]
fn reset() {
    *WATCH.lock().unwrap() = Watch { last_quiet: String::new(), last_check: 0, waiting: None, running: false };
    *DEPS.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    #[derive(Clone)]
    struct Probe {
        notes: Arc<Mutex<Vec<String>>>,
        quiets: Arc<Mutex<Vec<String>>>,
        fresh: Arc<Mutex<Option<i64>>>,
        minute: Arc<AtomicI64>,
        ms: Arc<AtomicI64>,
        checks: Arc<AtomicUsize>,
    }

    struct Setup {
        primary: bool,
        n: Option<i64>,
        clock_min: u32,
        weekend: bool,
        overtime: bool,
    }

    impl Default for Setup {
        fn default() -> Self {
            Setup { primary: true, n: Some(0), clock_min: 10 * 60, weekend: false, overtime: false }
        }
    }

    fn setup(s: Setup) -> Probe {
        reset();
        let probe = Probe { notes: Default::default(), quiets: Default::default(), fresh: Arc::new(Mutex::new(s.n)), minute: Default::default(), ms: Arc::new(AtomicI64::new(1_000_000_000_000)), checks: Default::default() };
        let p = probe.clone();
        set_deps(Deps {
            primary: Box::new(move || s.primary),
            fresh: {
                let p = p.clone();
                Box::new(move || {
                    p.checks.fetch_add(1, Ordering::SeqCst);
                    *p.fresh.lock().unwrap()
                })
            },
            quiet: {
                let p = p.clone();
                Box::new(move |label, _| {
                    p.quiets.lock().unwrap().push(label.to_string());
                    mutate(|d| d.insert("lastReview".into(), json!({ "at": crate::core::time::iso(crate::core::time::now_ms() - 120000), "text": "sin novedades", "empty": true })));
                    true
                })
            },
            notify: {
                let p = p.clone();
                Box::new(move |text| p.notes.lock().unwrap().push(text.to_string()))
            },
            clock: Box::new(move || Clock { weekday: if s.weekend { "Sat" } else { "Mon" }, weekend: s.weekend, hour: s.clock_min / 60, minute: s.clock_min % 60, min: s.clock_min, day: String::new() }),
            overtime: Box::new(move || s.overtime),
            parts: {
                let p = p.clone();
                Box::new(move || Parts { weekday: "Mon".into(), hour: "10".into(), minute: format!("{:02}", p.minute.load(Ordering::SeqCst)) })
            },
            ms: {
                let p = p.clone();
                Box::new(move || p.ms.load(Ordering::SeqCst))
            },
        });
        mutate(|d| {
            d.insert("config".into(), json!({}));
            d.insert("refreshRequest".into(), Value::Null);
            d.insert("lastReview".into(), json!({ "at": crate::core::time::iso(crate::core::time::now_ms() - 120000), "text": "x", "empty": true }));
        });
        probe
    }

    impl Probe {
        fn notes(&self) -> Vec<String> {
            self.notes.lock().unwrap().clone()
        }
        fn quiets(&self) -> Vec<String> {
            self.quiets.lock().unwrap().clone()
        }
    }

    #[test]
    fn no_news_the_server_writes_the_quiet_review_itself_and_wakes_nobody() {
        let _g = crate::testkit::fresh();
        let p = setup(Setup::default());
        tick();
        assert_eq!(p.quiets(), vec!["10:00"]);
        assert_eq!(p.notes().len(), 0);
        reset();
    }

    #[test]
    fn news_the_reporter_is_told_once_and_not_again_while_it_works() {
        let _g = crate::testkit::fresh();
        let p = setup(Setup { n: Some(3), ..Default::default() });
        tick();
        assert_eq!(p.notes().len(), 1);
        assert!(p.notes()[0].starts_with("Tablero: hay 3 novedades sin contar en Jira"));
        p.minute.store(1, Ordering::SeqCst);
        p.ms.fetch_add(60000, Ordering::SeqCst);
        tick();
        assert_eq!(p.notes().len(), 1);
        reset();
    }

    #[test]
    fn jira_is_checked_every_15_seconds_the_quiet_review_is_written_once_a_minute() {
        let _g = crate::testkit::fresh();
        let p = setup(Setup::default());
        tick();
        p.ms.fetch_add(5000, Ordering::SeqCst);
        tick();
        assert_eq!(p.checks.load(Ordering::SeqCst), 1);
        p.ms.fetch_add(10000, Ordering::SeqCst);
        tick();
        assert_eq!(p.checks.load(Ordering::SeqCst), 2);
        assert_eq!(p.quiets(), vec!["10:00"]);
        *p.fresh.lock().unwrap() = Some(2);
        p.ms.fetch_add(15000, Ordering::SeqCst);
        tick();
        assert_eq!(p.notes().len(), 1);
        reset();
    }

    #[test]
    fn a_failed_check_still_wakes_the_reporter() {
        let _g = crate::testkit::fresh();
        let p = setup(Setup { n: None, ..Default::default() });
        tick();
        assert_eq!(p.notes().len(), 1);
        reset();
    }

    #[test]
    fn outside_hours_paused_or_on_the_follower_nothing_is_checked() {
        let _g = crate::testkit::fresh();
        let mut total = 0;
        let p = setup(Setup { n: Some(2), clock_min: 19 * 60, ..Default::default() });
        tick();
        total += p.notes().len() + p.quiets().len();
        let p = setup(Setup { n: Some(2), weekend: true, ..Default::default() });
        tick();
        total += p.notes().len() + p.quiets().len();
        assert_eq!(total, 0);
        let p = setup(Setup { n: Some(2), ..Default::default() });
        mutate(|d| d.insert("config".into(), json!({ "paused": true })));
        tick();
        assert_eq!(p.notes().len() + p.quiets().len(), 0);
        let p = setup(Setup { n: Some(2), primary: false, ..Default::default() });
        tick();
        assert_eq!(p.notes().len() + p.quiets().len(), 0);
        reset();
    }

    #[test]
    fn overtime_keeps_checking_outside_hours() {
        let _g = crate::testkit::fresh();
        let p = setup(Setup { n: Some(1), clock_min: 20 * 60, overtime: true, ..Default::default() });
        tick();
        assert_eq!(p.notes().len(), 1);
        reset();
    }

    #[test]
    fn refrescar_reaches_the_reporter_once_even_when_paused_or_outside_hours() {
        let _g = crate::testkit::fresh();
        let p = setup(Setup { clock_min: 20 * 60, ..Default::default() });
        mutate(|d| {
            d.insert("config".into(), json!({ "paused": true }));
            d.insert("refreshRequest".into(), json!({ "id": "r1", "at": now(), "handled": false }));
        });
        tick();
        tick();
        assert_eq!(p.notes().len(), 1);
        assert!(p.notes()[0].contains("ha pulsado Refrescar"));
        assert!(truthy(load()["refreshRequest"].get("notifiedAt")));
        reset();
    }
}

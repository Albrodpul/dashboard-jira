//! Port of src/features/board-alive.js.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::core::data::BASE_URL;

const PROBE_MS: i64 = 60 * 1000;
const TIMEOUT_MS: u64 = 20 * 1000;
const RENOTIFY_MS: i64 = 60 * 60 * 1000;
const SLEEP_GAP_MS: i64 = 3 * PROBE_MS;

pub type PushFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct CheckerState {
    pub last_ok: i64,
    pub last_probe: i64,
    pub alerted_at: Option<i64>,
}

pub struct Checker {
    pub state: CheckerState,
    limit_ms: i64,
    push: PushFn,
    now_ms: NowFn,
}

fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

impl Checker {
    pub fn record(&mut self, ok: bool) -> &'static str {
        let t = (self.now_ms)();
        let s = &mut self.state;
        if t - s.last_probe > SLEEP_GAP_MS {
            s.last_ok = s.last_ok.max(t - PROBE_MS);
        }
        s.last_probe = t;
        if ok {
            let was = s.alerted_at;
            let down = js_round((t - s.last_ok) as f64 / 60000.0);
            s.last_ok = t;
            s.alerted_at = None;
            if was.is_some() {
                (self.push)(&format!("El tablero vuelve a responder (llevaba unos {down} min sin hacerlo)."));
                return "recovered";
            }
            return "ok";
        }
        if t - s.last_ok < self.limit_ms {
            return "waiting";
        }
        if let Some(at) = s.alerted_at {
            if t - at < RENOTIFY_MS {
                return "alerted";
            }
        }
        s.alerted_at = Some(t);
        let minutes = js_round((t - s.last_ok) as f64 / 60000.0);
        (self.push)(&format!("El tablero no responde desde hace {minutes} min. Si no vuelve solo, reinícialo (en el Mac lo relanza launchd)."));
        "alert"
    }
}

#[derive(Default)]
pub struct StartOptions {
    pub minutes: Option<f64>,
    pub log: Option<LogFn>,
}

pub fn probe(url: Option<&str>, timeout_ms: Option<u64>) -> bool {
    let url = url.map(str::to_string).unwrap_or_else(|| format!("{}/manifest.webmanifest", *BASE_URL));
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_millis(timeout_ms.unwrap_or(TIMEOUT_MS)))).http_status_as_error(false).build().into();
    agent.get(&url).call().is_ok()
}

pub fn create_checker(minutes: f64, push: PushFn, now_ms: Option<NowFn>) -> Checker {
    let now_ms: NowFn = now_ms.unwrap_or_else(|| Arc::new(crate::core::time::now_ms));
    let t = now_ms();
    Checker { state: CheckerState { last_ok: t, last_probe: t, alerted_at: None }, limit_ms: (minutes * 60000.0) as i64, push, now_ms }
}

pub fn start(options: StartOptions) -> Arc<Mutex<Checker>> {
    let minutes = options.minutes.unwrap_or_else(crate::core::config::board_alive_minutes);
    let log: LogFn = options.log.unwrap_or_else(|| Arc::new(|_: &str| {}));
    let push_log = log.clone();
    let push: PushFn = Arc::new(move |text: &str| {
        let n = crate::server::push::send_push("board", true, Some(text));
        push_log(&format!("board-alive push ({n}): {text}"));
    });
    let checker = Arc::new(Mutex::new(create_checker(minutes, push, None)));
    let shared = checker.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(PROBE_MS as u64));
            let ok = probe(None, None);
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                shared.lock().unwrap_or_else(|p| p.into_inner()).record(ok);
            }));
            if let Err(e) = outcome {
                let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                log(&format!("board-alive: {msg}"));
            }
        }
    });
    checker
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    const MIN: i64 = 60_000;

    struct Rig {
        checker: Checker,
        clock: Arc<AtomicI64>,
        pushes: Arc<Mutex<Vec<String>>>,
    }

    fn clock_checker(minutes: f64) -> Rig {
        let clock = Arc::new(AtomicI64::new(0));
        let pushes = Arc::new(Mutex::new(Vec::new()));
        let c = clock.clone();
        let p = pushes.clone();
        let checker = create_checker(minutes, Arc::new(move |x: &str| p.lock().unwrap().push(x.to_string())), Some(Arc::new(move || c.load(Ordering::SeqCst))));
        Rig { checker, clock, pushes }
    }

    impl Rig {
        fn step(&mut self, ok: bool) -> &'static str {
            self.step_by(ok, MIN)
        }
        fn step_by(&mut self, ok: bool, ms: i64) -> &'static str {
            self.clock.fetch_add(ms, Ordering::SeqCst);
            self.checker.record(ok)
        }
        fn pushes(&self) -> Vec<String> {
            self.pushes.lock().unwrap().clone()
        }
    }

    #[test]
    fn one_push_when_the_board_stops_answering_for_n_minutes_one_when_it_comes_back() {
        let mut r = clock_checker(5.0);
        assert_eq!(r.step(true), "ok");
        for _ in 0..4 {
            assert_eq!(r.step(false), "waiting");
        }
        assert_eq!(r.step(false), "alert");
        assert!(r.pushes()[0].contains("El tablero no responde desde hace 5 min"));
        for _ in 0..10 {
            assert_eq!(r.step(false), "alerted");
        }
        assert_eq!(r.pushes().len(), 1);
        assert_eq!(r.step(true), "recovered");
        assert!(r.pushes()[1].contains("vuelve a responder"));
        assert_eq!(r.step(true), "ok");
        assert_eq!(r.pushes().len(), 2);
    }

    #[test]
    fn a_long_outage_is_reminded_every_hour_and_a_short_blip_says_nothing() {
        let mut r = clock_checker(5.0);
        r.step(false);
        r.step(true);
        assert_eq!(r.pushes().len(), 0);
        for _ in 0..5 {
            r.step(false);
        }
        assert_eq!(r.pushes().len(), 1);
        for _ in 0..60 {
            r.step(false);
        }
        assert_eq!(r.pushes().len(), 2);
    }

    #[test]
    fn waking_from_sleep_does_not_count_the_sleep_as_minutes_without_answer() {
        let mut r = clock_checker(5.0);
        r.step(true);
        assert_eq!(r.step_by(false, 8 * 60 * MIN), "waiting");
        assert_eq!(r.pushes().len(), 0);
    }

    #[test]
    fn probe_sees_a_server_that_answers_and_not_one_that_hangs_or_is_down() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                let _ = req.respond(tiny_http::Response::from_string("{}"));
            }
        });
        let hung = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let hung_port = hung.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut keep = Vec::new();
            for s in hung.incoming().take(1) {
                keep.push(s);
                std::thread::sleep(Duration::from_secs(5));
            }
        });
        assert!(probe(Some(&format!("http://127.0.0.1:{port}/x")), Some(2000)));
        assert!(!probe(Some(&format!("http://127.0.0.1:{hung_port}/x")), Some(300)));
        assert!(!probe(Some("http://127.0.0.1:1/x"), Some(300)));
    }
}

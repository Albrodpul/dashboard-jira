//! Port of src/features/claude-token.js.
use crate::core::json::{parse, stringify};
use crate::core::time::{madrid, now, now_ms};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};

const NAME: &str = "CLAUDE_CODE_OAUTH_TOKEN";
const WARN_DAYS: [i64; 6] = [30, 14, 7, 3, 1, 0];
static AGENT: LazyLock<PathBuf> = LazyLock::new(|| std::env::home_dir().unwrap_or_default().join("Library").join("LaunchAgents").join("com.nutria.claude-token.plist"));
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"sk-ant-[A-Za-z0-9_-]{20,}").unwrap());
static MASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"sk-ant-[A-Za-z0-9_-]+").unwrap());
static OSC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap());
static FORWARD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[(\d*)C").unwrap());
static BREAKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[\d*[BEFH]|\x1b\[\d+;\d+[Hf]|\x1b\[\d*[JK]").unwrap());
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]").unwrap());

struct Cached {
    at: i64,
    value: Value,
}

struct Job {
    state: Map<String, Value>,
    writer: Option<Box<dyn Write + Send>>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

static CACHED: LazyLock<Mutex<Option<Cached>>> = LazyLock::new(|| Mutex::new(None));
static JOB: LazyLock<Mutex<Option<Arc<Mutex<Job>>>>> = LazyLock::new(|| Mutex::new(None));

fn quiet(program: &str, args: &[&str]) -> bool {
    crate::core::platform::cmd(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

fn windows(token: Option<&str>) -> Result<(), String> {
    let script = if token.is_some() { format!("[Environment]::SetEnvironmentVariable('{NAME}', $env:NEW_VALUE, 'User')") } else { format!("[Environment]::SetEnvironmentVariable('{NAME}', $null, 'User')") };
    let ok = crate::core::platform::cmd("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]).env("NEW_VALUE", token.unwrap_or("")).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| e.to_string())?;
    if ok.success() { Ok(()) } else { Err(format!("Command failed: powershell.exe -NoProfile -NonInteractive -Command {script}")) }
}

fn agent_plist(label: &str, args: &[&str]) -> String {
    let items: String = args.iter().map(|x| format!("<string>{x}</string>")).collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key><string>{label}</string>\n  <key>ProgramArguments</key>\n  <array><string>/bin/launchctl</string>{items}</array>\n  <key>RunAtLoad</key><true/>\n</dict>\n</plist>\n"
    )
}

fn write_private(file: &std::path::Path, text: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(file)?.write_all(text.as_bytes())
}

fn mac(token: Option<&str>) -> Result<(), String> {
    #[cfg(unix)]
    let uid = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    let uid = 0;
    let domain = format!("gui/{uid}");
    let agent = AGENT.to_string_lossy().to_string();
    quiet("/bin/launchctl", &["bootout", &domain, &agent]);
    std::fs::create_dir_all(AGENT.parent().unwrap()).map_err(|e| e.to_string())?;
    let launch = |args: &[&str]| -> Result<(), String> { if quiet("/bin/launchctl", args) { Ok(()) } else { Err(format!("Command failed: /bin/launchctl {}", args.join(" "))) } };
    let Some(token) = token else {
        let _ = std::fs::remove_file(&*AGENT);
        let once = agent.replace(".plist", "-remove.plist");
        std::fs::write(&once, agent_plist("com.nutria.claude-token-remove", &["unsetenv", NAME])).map_err(|e| e.to_string())?;
        launch(&["bootstrap", &domain, &once])?;
        std::thread::sleep(std::time::Duration::from_secs(1));
        quiet("/bin/launchctl", &["bootout", &domain, &once]);
        let _ = std::fs::remove_file(&once);
        return Ok(());
    };
    let clean: String = token.chars().filter(|c| !matches!(c, '<' | '>' | '&')).collect();
    write_private(&AGENT, &agent_plist("com.nutria.claude-token", &["setenv", NAME, &clean])).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::set_permissions(&*AGENT, std::os::unix::fs::PermissionsExt::from_mode(0o600)).map_err(|e| e.to_string())?;
    launch(&["bootstrap", &domain, &agent])
}

pub fn apply_user_token(remove: bool) -> Result<bool, String> {
    let token = if remove { None } else { crate::sessions::registry::session_token() };
    if !remove && token.is_none() {
        return Err(format!("No hay {NAME} en el .env del workspace: genéralo con «claude setup-token» y añádelo allí."));
    }
    if cfg!(windows) {
        windows(token.as_deref())?;
    } else if cfg!(target_os = "macos") {
        mac(token.as_deref())?;
    } else {
        return Err("Solo Windows y macOS".into());
    }
    Ok(token.is_some())
}

fn in_user_environment() -> bool {
    if cfg!(target_os = "macos") {
        return AGENT.exists();
    }
    if !cfg!(windows) {
        return false;
    }
    quiet("reg.exe", &["query", "HKCU\\Environment", "/v", NAME])
}

fn env_file() -> PathBuf {
    crate::core::config::workspace().join(".env")
}

pub fn token_status() -> Value {
    if let Some(c) = CACHED.lock().unwrap().as_ref() {
        if now_ms() - c.at < 60000 {
            return c.value.clone();
        }
    }
    static EXPIRES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?m)^[ \t]*CLAUDE_TOKEN_EXPIRES[ \t]*=[ \t]*["']?(\d{4}-\d{2}-\d{2})["']?[ \t]*\r?$"#).unwrap());
    let expires = std::fs::read_to_string(env_file()).ok().and_then(|t| EXPIRES.captures(&t).map(|m| m[1].to_string()));
    let value = json!({ "sessions": crate::sessions::registry::session_token().is_some(), "vscode": in_user_environment(), "expires": expires });
    *CACHED.lock().unwrap() = Some(Cached { at: now_ms(), value: value.clone() });
    value
}

fn screen_text(raw: &str) -> String {
    let t = OSC.replace_all(raw, " ");
    let t = FORWARD.replace_all(&t, |c: &regex::Captures| " ".repeat(c[1].parse::<usize>().ok().filter(|n| *n > 0).unwrap_or(1)));
    let t = BREAKS.replace_all(&t, "\n");
    ANSI.replace_all(&t, "").into_owned()
}

fn mask(s: &str) -> String {
    MASK.replace_all(s, "sk-ant-…(oculto)").into_owned()
}

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(std::time::Duration::from_secs(300))).build())
}

fn auth_status(token: &str) -> Result<u16, String> {
    let body = json!({ "model": "claude-haiku-4-5", "max_tokens": 1, "system": "You are Claude Code, Anthropic's official CLI for Claude.", "messages": [{ "role": "user", "content": "ok" }] });
    let r = agent()
        .post("https://api.anthropic.com/v1/messages")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .send(stringify(&body))
        .map_err(|e| e.to_string())?;
    Ok(r.status().as_u16())
}

fn working_token(token: &str) -> Option<String> {
    let len = token.len();
    let low = 90.max(len.saturating_sub(30));
    let mut n = len;
    while n >= low && n > 0 {
        let candidate = &token[..n];
        match auth_status(candidate) {
            Ok(401) => {}
            Ok(_) => return Some(candidate.to_string()),
            Err(_) => return Some(token.to_string()),
        }
        n -= 1;
    }
    None
}

fn save_token(token: &str) -> Result<String, String> {
    let expires = madrid(now_ms() + 364 * 86400000).day;
    let text = std::fs::read_to_string(env_file()).unwrap_or_default();
    static OLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[ \t]*(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_TOKEN_EXPIRES)[ \t]*=").unwrap());
    let mut lines: Vec<String> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).filter(|l| !OLD.is_match(l)).collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    lines.push(format!("{NAME}={token}"));
    lines.push(format!("CLAUDE_TOKEN_EXPIRES={expires}"));
    lines.push(String::new());
    write_private(&env_file(), &lines.join("\n")).map_err(|e| e.to_string())?;
    *CACHED.lock().unwrap() = None;
    apply_user_token(false)?;
    Ok(expires)
}

struct RelayMasked<F: FnMut(&str)> {
    pending: String,
    write: F,
}

impl<F: FnMut(&str)> RelayMasked<F> {
    fn flush(&mut self, all: bool) {
        static TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"s(?:k(?:-(?:a(?:n(?:t(?:-[A-Za-z0-9_-]*)?)?)?)?)?)?$").unwrap());
        let mut masked = mask(&self.pending);
        let mut keep = String::new();
        if !all {
            if let Some(m) = TAIL.find(&self.pending) {
                keep = self.pending[m.start()..].to_string();
                masked = mask(&self.pending[..m.start()]);
            }
        }
        self.pending = keep;
        if !masked.is_empty() {
            (self.write)(&masked);
        }
    }

    fn push(&mut self, d: &str) {
        self.pending.push_str(d);
        self.flush(false);
    }

    fn end(&mut self) {
        self.flush(true);
    }
}

struct Term {
    _master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn spawn_setup() -> Result<Term, String> {
    let pair = portable_pty::native_pty_system().openpty(PtySize { rows: 40, cols: 400, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut env = crate::sessions::registry::clean_env();
    env.remove(NAME);
    let (exe, args) = crate::core::platform::claude(&["setup-token".to_string()], None);
    let mut cmd = CommandBuilder::new(exe);
    cmd.args(args);
    cmd.cwd(std::env::home_dir().unwrap_or_default());
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    Ok(Term { _master: pair.master, reader, writer, child })
}

fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

#[cfg(unix)]
struct RawMode(Option<libc::termios>);

#[cfg(unix)]
impl RawMode {
    fn on() -> RawMode {
        unsafe {
            if libc::isatty(0) != 1 {
                return RawMode(None);
            }
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut t) != 0 {
                return RawMode(None);
            }
            let saved = t;
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(0, libc::TCSANOW, &t);
            RawMode(Some(saved))
        }
    }
}

#[cfg(unix)]
impl Drop for RawMode {
    fn drop(&mut self) {
        if let Some(t) = self.0 {
            unsafe {
                libc::tcsetattr(0, libc::TCSANOW, &t);
            }
        }
    }
}

pub fn setup_token() -> Result<String, String> {
    let Term { _master, mut reader, writer, mut child } = spawn_setup()?;
    let writer = Arc::new(Mutex::new(writer));
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    #[cfg(unix)]
    let raw = RawMode::on();
    {
        let writer = writer.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut stdin = std::io::stdin();
            while let Ok(n) = stdin.read(&mut buf) {
                if n == 0 || done.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                let _ = writer.lock().unwrap().write_all(&buf[..n]);
            }
        });
    }
    let mut out = RelayMasked {
        pending: String::new(),
        write: |s: &str| {
            let mut o = std::io::stdout();
            let _ = o.write_all(s.as_bytes());
            let _ = o.flush();
        },
    };
    let mut seen = String::new();
    let mut token: Option<String> = None;
    let mut buf = [0u8; 4096];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                carry.extend_from_slice(&buf[..n]);
                let valid = match std::str::from_utf8(&carry) {
                    Ok(_) => carry.len(),
                    Err(e) => e.valid_up_to(),
                };
                let d = String::from_utf8_lossy(&carry[..valid]).into_owned();
                carry.drain(..valid);
                seen = tail_chars(&(seen + &d), 20000);
                if let Some(m) = TOKEN.find(&screen_text(&seen)) {
                    token = Some(m.as_str().to_string());
                }
                out.push(&d);
            }
        }
    }
    let _ = child.wait();
    out.end();
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    #[cfg(unix)]
    drop(raw);
    let Some(token) = token else { return Err("No he visto el token en la salida de claude setup-token: no se ha instalado nada.".into()) };
    let Some(good) = working_token(&token) else { return Err("El token que dio claude setup-token no funciona contra la API: no se ha instalado nada.".into()) };
    save_token(&good)
}

pub fn import_token(text: &str) -> Result<String, String> {
    let token = TOKEN.find(text).map(|m| m.as_str().to_string()).ok_or("No llega ningún token por la entrada estándar.")?;
    save_token(&token)
}

fn copy_to_peer() -> bool {
    match crate::sessions::registry::session_token() {
        Some(token) => crate::cluster::cluster::send_claude_token(&token),
        None => false,
    }
}

fn start_job() -> Result<(), String> {
    if let Some(job) = JOB.lock().unwrap().as_ref() {
        if job.lock().unwrap().state.get("state").and_then(Value::as_str) == Some("running") {
            return Ok(());
        }
    }
    let Term { _master, mut reader, writer, mut child } = spawn_setup()?;
    let killer = child.clone_killer();
    let mut state = Map::new();
    for (k, v) in [("state", json!("running")), ("startedAt", json!(now())), ("url", Value::Null), ("asksCode", json!(false)), ("expires", Value::Null), ("peer", Value::Null), ("error", Value::Null), ("tail", json!(""))] {
        state.insert(k.into(), v);
    }
    let current = Arc::new(Mutex::new(Job { state, writer: Some(writer), killer: Some(killer) }));
    *JOB.lock().unwrap() = Some(current.clone());
    let token: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let current = current.clone();
        let finished = finished.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(15 * 60));
            if !finished.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(k) = current.lock().unwrap().killer.as_mut() {
                    let _ = k.kill();
                }
            }
        });
    }
    let reading = {
        let current = current.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)https://[^\s"'<>]*(?:oauth|authorize)[^\s"'<>]*"#).unwrap());
            static ASKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)paste[^\n]{0,30}code|enter[^\n]{0,20}code|authorization code").unwrap());
            let mut seen = String::new();
            let mut buf = [0u8; 4096];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                carry.extend_from_slice(&buf[..n]);
                let valid = match std::str::from_utf8(&carry) {
                    Ok(_) => carry.len(),
                    Err(e) => e.valid_up_to(),
                };
                let d = String::from_utf8_lossy(&carry[..valid]).into_owned();
                carry.drain(..valid);
                seen = tail_chars(&(seen + &d), 30000);
                let plain = screen_text(&seen);
                if let Some(m) = TOKEN.find(&plain) {
                    *token.lock().unwrap() = Some(m.as_str().to_string());
                }
                let mut job = current.lock().unwrap();
                if let Some(u) = URL.find(&plain) {
                    job.state.insert("url".into(), Value::from(u.as_str()));
                }
                if ASKS.is_match(&tail_chars(&plain, 600)) && token.lock().unwrap().is_none() {
                    job.state.insert("asksCode".into(), Value::from(true));
                }
                let masked = mask(&plain);
                let lines: Vec<&str> = masked.split('\n').map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
                let tail = lines[lines.len().saturating_sub(6)..].join("\n");
                job.state.insert("tail".into(), Value::from(tail_chars(&tail, 600)));
            }
        })
    };
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = reading.join();
        finished.store(true, std::sync::atomic::Ordering::SeqCst);
        let fail = |text: String| {
            let mut job = current.lock().unwrap();
            job.state.insert("state".into(), json!("failed"));
            job.state.insert("error".into(), Value::from(text));
        };
        {
            let mut job = current.lock().unwrap();
            job.writer = None;
            job.killer = None;
        }
        let token = token.lock().unwrap().clone();
        let Some(token) = token else {
            let cancelled = current.lock().unwrap().state.get("cancelled") == Some(&json!(true));
            fail(if cancelled { "Cancelado.".into() } else { "claude setup-token terminó sin dar un token.".into() });
            return;
        };
        let Some(good) = working_token(&token) else {
            fail("El token que dio claude setup-token no funciona contra la API: no se ha instalado nada.".into());
            return;
        };
        match save_token(&good) {
            Ok(expires) => {
                let mut job = current.lock().unwrap();
                job.state.insert("expires".into(), Value::from(expires));
                job.state.insert("state".into(), json!("done"));
            }
            Err(e) => {
                fail(format!("Token recibido, pero no se pudo guardar: {e}"));
                return;
            }
        }
        let peer = if crate::cluster::cluster::cluster_enabled() { Value::from(copy_to_peer()) } else { Value::Null };
        current.lock().unwrap().state.insert("peer".into(), peer);
    });
    Ok(())
}

pub fn job_status() -> Value {
    match JOB.lock().unwrap().as_ref() {
        None => json!({ "state": "idle" }),
        Some(job) => Value::Object(job.lock().unwrap().state.clone()),
    }
}

pub fn handle_setup(input: &Value) -> Result<Value, String> {
    let action = input.get("action").and_then(Value::as_str).unwrap_or("");
    let job = JOB.lock().unwrap().clone();
    match action {
        "start" => start_job()?,
        "code" if job.as_ref().is_some_and(|j| j.lock().unwrap().writer.is_some()) => {
            let code = match input.get("code") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(other) => stringify(other),
            };
            let job = job.unwrap();
            let mut j = job.lock().unwrap();
            if let Some(w) = j.writer.as_mut() {
                let _ = w.write_all(format!("{}\r", code.trim()).as_bytes());
                let _ = w.flush();
            }
        }
        "cancel" if job.as_ref().is_some_and(|j| j.lock().unwrap().killer.is_some()) => {
            let job = job.unwrap();
            let mut j = job.lock().unwrap();
            j.state.insert("cancelled".into(), json!(true));
            if let Some(k) = j.killer.as_mut() {
                let _ = k.kill();
            }
        }
        "copy" => match job {
            Some(job) => {
                let peer = copy_to_peer();
                job.lock().unwrap().state.insert("peer".into(), Value::from(peer));
            }
            None => {
                let mut status = job_status();
                status["peer"] = Value::from(copy_to_peer());
                return Ok(status);
            }
        },
        _ => {}
    }
    Ok(job_status())
}

pub fn warn_expiry() -> Result<(), String> {
    if !crate::cluster::cluster::is_primary() {
        return Ok(());
    }
    let Some(expires) = token_status().get("expires").and_then(Value::as_str).map(str::to_string) else { return Ok(()) };
    let Some(at) = crate::core::time::parse(&format!("{expires}T00:00:00")) else { return Ok(()) };
    let days = ((at - now_ms()) as f64 / 86400000.0).ceil() as i64;
    let Some(step) = WARN_DAYS.iter().rev().copied().find(|d| days <= *d) else { return Ok(()) };
    let file = crate::core::data::DATA_DIR.join("claude-token-warned.json");
    let saved = std::fs::read_to_string(&file).ok().and_then(|t| parse(&t)).unwrap_or(json!({}));
    if saved.get("expires").and_then(Value::as_str) == Some(expires.as_str()) && saved.get("step").and_then(Value::as_i64).is_some_and(|s| s <= step) {
        return Ok(());
    }
    let text = if days <= 0 {
        "El token de Claude ha caducado: renuévalo en Ajustes → Cuenta de Claude.".to_string()
    } else {
        format!("El token de Claude caduca en {days} {}. Renuévalo en Ajustes → Cuenta de Claude mientras tu navegador siga dentro de claude.ai.", if days == 1 { "día" } else { "días" })
    };
    crate::server::push::send_push("token", true, Some(&text));
    std::fs::write(&file, stringify(&json!({ "expires": expires, "step": step, "at": now() }))).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_screen_text_drops_terminal_codes_and_keeps_the_token() {
        let raw = "\x1b[2J\x1b[1;1HToken:\x1b[3Csk-ant-oat01-abcdefghijklmnopqrstuvwxyz\x1b[0m\x1b]0;title\x07";
        let plain = screen_text(raw);
        assert_eq!(TOKEN.find(&plain).unwrap().as_str(), "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
        assert!(plain.contains("Token:   sk-ant"));
    }

    #[test]
    fn the_relay_never_prints_a_token_even_split_across_chunks() {
        let printed = std::cell::RefCell::new(String::new());
        let mut relay = RelayMasked { pending: String::new(), write: |s: &str| printed.borrow_mut().push_str(s) };
        relay.push("hola s");
        relay.push("k-an");
        relay.push("t-oat01-secret");
        relay.push(" fin");
        relay.end();
        assert_eq!(printed.borrow().as_str(), "hola sk-ant-…(oculto) fin");
    }

    #[test]
    fn the_launch_agent_sets_the_variable_for_the_session() {
        let plist = agent_plist("com.nutria.claude-token", &["setenv", NAME, "tok"]);
        assert!(plist.contains("<array><string>/bin/launchctl</string><string>setenv</string><string>CLAUDE_CODE_OAUTH_TOKEN</string><string>tok</string></array>"));
    }
}

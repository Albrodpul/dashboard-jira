//! Port of src/features/tunnel.js.
use crate::core::data::DATA_DIR;
use crate::core::json::{parse, stringify, truthy};
use crate::core::time::{now, now_ms};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

static STATE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("tunnel.json"));
static LOG: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("tunnel.log"));
static PEER_CACHE: LazyLock<Mutex<(i64, Option<Value>)>> = LazyLock::new(|| Mutex::new((0, None)));

#[cfg(test)]
pub(crate) static PRIMARY_OVERRIDE: Mutex<Option<bool>> = Mutex::new(None);
#[cfg(test)]
pub(crate) static REMOTE_OVERRIDE: Mutex<Option<Value>> = Mutex::new(None);

fn primary_now() -> bool {
    #[cfg(test)]
    if let Some(v) = *PRIMARY_OVERRIDE.lock().unwrap() {
        return v;
    }
    crate::cluster::cluster::primary_now()
}

static LISTEN_ROW: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING").unwrap());
const MAX_EXTRA: usize = 6;

fn loopback(host: &str) -> bool {
    matches!(host, "*" | "0.0.0.0" | "[::]" | "[::1]" | "::" | "::1") || host.starts_with("127.")
}

pub fn parse_lsof(text: &str, only_loopback: bool) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    let mut board = false;
    for line in text.lines() {
        if let Some(c) = line.strip_prefix('c') {
            board = c == "tower";
            continue;
        }
        if line.starts_with('p') {
            board = false;
        }
        if board {
            continue;
        }
        let Some(name) = line.strip_prefix('n') else { continue };
        let Some((host, port)) = name.rsplit_once(':') else { continue };
        let Ok(port) = port.parse::<u16>() else { continue };
        if port != 0 && (!only_loopback || loopback(host)) && !out.contains(&port) {
            out.push(port);
        }
    }
    out.sort_unstable();
    out
}

pub fn parse_netstat(text: &str, only_loopback: bool) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for line in text.lines() {
        let Some(m) = LISTEN_ROW.captures(line) else { continue };
        let Ok(port) = m[2].parse::<u16>() else { continue };
        if port != 0 && (!only_loopback || loopback(&m[1])) && !out.contains(&port) {
            out.push(port);
        }
    }
    out.sort_unstable();
    out
}

pub fn listening(only_loopback: bool) -> Vec<u16> {
    if cfg!(windows) {
        let mut cmd = crate::core::platform::cmd("netstat");
        cmd.args(["-an"]);
        let Ok(out) = crate::features::devservers::run_with_timeout(&mut cmd, None, 20000) else { return Vec::new() };
        return parse_netstat(&String::from_utf8_lossy(&out.stdout), only_loopback);
    }
    let mut cmd = crate::core::platform::cmd("lsof");
    cmd.args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"]);
    let Ok(out) = crate::features::devservers::run_with_timeout(&mut cmd, None, 20000) else { return Vec::new() };
    parse_lsof(&String::from_utf8_lossy(&out.stdout), only_loopback)
}

fn peer_ports() -> Vec<u16> {
    let Some(v) = crate::cluster::cluster::peer_get("/api/cluster/ports", Some(4000)) else { return Vec::new() };
    v.get("ports").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).filter(|p| *p > 0 && *p <= 65535).map(|p| p as u16).collect()).unwrap_or_default()
}

fn wanted() -> Vec<u16> {
    let mut out = ports();
    for p in peer_ports() {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out.sort_unstable();
    out
}

fn free_here(port: u16, busy: &[u16]) -> bool {
    port != *crate::core::data::PORT && port != *crate::sessions::host::HOST_PORT && !busy.contains(&port) && std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn port_list(v: Option<&Value>) -> Vec<u16> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).map(|p| p as u16).collect()).unwrap_or_default()
}

fn extras(t: &Value) -> Vec<Value> {
    t.get("extra").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn forwarded(t: &Value) -> Vec<u16> {
    let mut out = port_list(t.get("ports"));
    for e in extras(t) {
        for p in port_list(e.get("ports")) {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out.sort_unstable();
    out
}

fn ports() -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for s in crate::features::devservers::servers(None, true) {
        let port = s.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
        if truthy(s.get("url")) && port != 0 && !out.contains(&port) {
            out.push(port);
        }
    }
    out
}

fn read() -> Option<Value> {
    parse(&std::fs::read_to_string(&*STATE).ok()?)
}

fn pid_of(t: &Value) -> Option<u32> {
    t.get("pid").and_then(Value::as_u64).filter(|p| *p != 0).map(|p| p as u32)
}

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        crate::core::platform::processes().iter().any(|p| p.pid == pid)
    }
}

fn current() -> Option<Value> {
    let t = read();
    if let Some(t) = &t {
        if pid_of(t).is_some_and(alive) {
            return Some(t.clone());
        }
        let _ = std::fs::remove_file(&*STATE);
    }
    None
}

fn last_error() -> Option<String> {
    let text = std::fs::read_to_string(&*LOG).ok()?;
    let lines: Vec<&str> = text.trim().split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !l.is_empty() && !l.starts_with("Warning: Permanently added")).collect();
    let start = lines.len().saturating_sub(2);
    let joined: String = lines[start..].join(" ").chars().take(300).collect();
    (!joined.is_empty()).then_some(joined)
}

pub fn status() -> Value {
    let t = current();
    let field = |k: &str| t.as_ref().and_then(|t| t.get(k).cloned()).unwrap_or(Value::Null);
    let ports = match &t {
        Some(t) => forwarded(t),
        None => ports(),
    };
    json!({ "open": t.is_some(), "host": field("host"), "since": field("since"), "ports": ports, "error": if t.is_some() { Value::Null } else { last_error().map(Value::from).unwrap_or(Value::Null) } })
}

fn hostname_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    if host.starts_with('[') {
        return host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default().to_lowercase();
    }
    host.split(':').next().unwrap_or("").to_lowercase()
}

fn username() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

fn target() -> Result<(String, String), String> {
    let c = crate::core::config::cluster().cloned().unwrap_or(json!({}));
    let peer_url = c.get("peer").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("no hay otro ordenador configurado")?.to_string();
    let peer = crate::cluster::cluster::peer_get("/api/cluster", Some(5000)).ok_or("el otro ordenador no responde")?;
    if peer.get("role").and_then(Value::as_str) != Some("primary") {
        return Err("el otro ordenador no manda: los proyectos están aquí".into());
    }
    let host = match c.get("peerSsh").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(h) => h.to_string(),
        None => {
            let user = peer.get("sshUser").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(username);
            format!("{user}@{}", hostname_of(&peer_url))
        }
    };
    let label = peer.get("label").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("el otro ordenador").to_string();
    Ok((host, label))
}

fn ssh_under(parent: u32) -> Option<u32> {
    let script = format!("(Get-CimInstance Win32_Process -Filter \"ParentProcessId={parent} AND Name='ssh.exe'\" | Select-Object -First 1).ProcessId");
    let mut cmd = crate::core::platform::cmd("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    let out = crate::features::devservers::run_with_timeout(&mut cmd, None, 20000).ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok().filter(|p| *p != 0)
}

fn spawn_ssh(host: &str, ports: &[u16], log_path: &std::path::Path) -> Result<u32, String> {
    let mut args: Vec<String> = ["-N", "-C", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=no", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"].iter().map(|s| s.to_string()).collect();
    for p in ports {
        args.push("-L".into());
        args.push(format!("{p}:localhost:{p}"));
    }
    args.push(host.to_string());
    let fail = || last_error().unwrap_or_else(|| "ssh no arranca".into());
    if cfg!(windows) {
        std::fs::write(log_path, "").map_err(|e| e.to_string())?;
        let home = std::env::home_dir().unwrap_or_default();
        let wrapper = crate::features::devservers::spawn_hidden("ssh", &args, &home.to_string_lossy(), &log_path.to_string_lossy())?;
        std::thread::sleep(Duration::from_millis(3500));
        let pid = if alive(wrapper) { ssh_under(wrapper) } else { None };
        return pid.ok_or_else(fail);
    }
    let log = std::fs::File::create(log_path).map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = crate::core::platform::cmd("ssh");
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(err));
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|_| fail())?;
    let deadline = std::time::Instant::now() + Duration::from_millis(3500);
    while std::time::Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return Err(fail());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

pub fn open() -> Result<Value, String> {
    if current().is_some() {
        return Ok(status());
    }
    if primary_now() {
        return Err("este ordenador manda: los proyectos se abren aquí directamente".into());
    }
    let (host, label) = target()?;
    let _ = crate::features::devservers::standby();
    let busy = listening(false);
    let ports: Vec<u16> = wanted().into_iter().filter(|p| free_here(*p, &busy)).collect();
    let pid = spawn_ssh(&host, &ports, &LOG)?;
    std::fs::write(&*STATE, stringify(&json!({ "pid": pid, "host": host, "label": label, "since": now(), "ports": ports, "extra": [] }))).map_err(|e| e.to_string())?;
    Ok(status())
}

pub fn follow() {
    let Some(mut t) = current() else { return };
    if primary_now() {
        return;
    }
    let Some(host) = t.get("host").and_then(Value::as_str).map(str::to_string) else { return };
    let before = extras(&t);
    let live: Vec<Value> = before.iter().filter(|e| pid_of(e).is_some_and(alive)).cloned().collect();
    t["extra"] = Value::Array(live.clone());
    let have = forwarded(&t);
    let busy = listening(false);
    let new: Vec<u16> = wanted().into_iter().filter(|p| !have.contains(p) && free_here(*p, &busy)).collect();
    if new.is_empty() {
        if live.len() != before.len() {
            let _ = std::fs::write(&*STATE, stringify(&t));
        }
        return;
    }
    if live.len() >= MAX_EXTRA {
        close();
        let _ = open();
        return;
    }
    let free_log = (0..MAX_EXTRA).map(|i| DATA_DIR.join(format!("tunnel-extra-{i}.log"))).find(|f| std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(f).is_ok());
    let Some(log_path) = free_log else { return };
    let Ok(pid) = spawn_ssh(&host, &new, &log_path) else { return };
    let mut list = live;
    list.push(json!({ "pid": pid, "ports": new }));
    t["extra"] = Value::Array(list);
    let _ = std::fs::write(&*STATE, stringify(&t));
}

pub fn remote() -> Result<Option<Value>, String> {
    #[cfg(test)]
    if let Some(v) = REMOTE_OVERRIDE.lock().unwrap().clone() {
        return Ok(Some(v));
    }
    if !crate::cluster::cluster::cluster_enabled() || primary_now() {
        return Ok(None);
    }
    let mut cache = PEER_CACHE.lock().unwrap();
    if now_ms() - cache.0 > 60000 {
        let peer = crate::cluster::cluster::peer_get("/api/cluster", Some(3000));
        let value = peer.filter(|p| p.get("role").and_then(Value::as_str) == Some("primary")).map(|p| json!({ "label": p.get("label").filter(|l| truthy(Some(l))).cloned().unwrap_or(Value::from("el otro ordenador")) }));
        *cache = (now_ms(), value);
    }
    Ok(cache.1.clone())
}

pub fn close() -> Value {
    for pid in pids() {
        crate::core::platform::kill_tree(pid);
    }
    let _ = std::fs::remove_file(&*STATE);
    status()
}

pub fn guard() {
    if current().is_some() && primary_now() {
        close();
    }
}

pub fn pids() -> Vec<u32> {
    let Some(t) = read() else { return Vec::new() };
    pid_of(&t).into_iter().chain(extras(&t).iter().filter_map(pid_of)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::fresh;

    struct Overrides;
    impl Drop for Overrides {
        fn drop(&mut self) {
            *PRIMARY_OVERRIDE.lock().unwrap() = None;
            *REMOTE_OVERRIDE.lock().unwrap() = None;
        }
    }

    fn primary(v: bool) -> Overrides {
        *PRIMARY_OVERRIDE.lock().unwrap() = Some(v);
        Overrides
    }

    fn fake_tunnel() -> std::process::Child {
        let child = crate::core::platform::cmd("sleep").arg("60").stdin(Stdio::null()).spawn().unwrap();
        std::fs::write(&*STATE, stringify(&json!({ "pid": child.id(), "host": "u@peer", "label": "Mac", "since": "2026-11-09T10:00:00.000Z" }))).unwrap();
        child
    }

    fn exited(child: &mut std::process::Child) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("the fake tunnel did not exit");
    }

    #[test]
    fn status_lists_the_dev_server_ports_with_a_url() {
        let _g = fresh();
        assert_eq!(status()["ports"], json!([39999]));
        assert_eq!(status()["open"], false);
    }

    #[test]
    fn guard_leaves_the_tunnel_open_while_this_machine_does_not_lead() {
        let _g = fresh();
        let _o = primary(false);
        let mut child = fake_tunnel();
        guard();
        assert!(alive(child.id()));
        assert_eq!(status()["open"], true);
        assert_eq!(status()["host"], "u@peer");
        close();
        exited(&mut child);
        assert!(!STATE.exists());
    }

    #[test]
    fn guard_closes_the_tunnel_as_soon_as_this_machine_leads() {
        let _g = fresh();
        let _o = primary(true);
        let mut child = fake_tunnel();
        guard();
        exited(&mut child);
        assert!(!STATE.exists());
    }

    #[test]
    fn a_tunnel_whose_process_died_is_forgotten() {
        let _g = fresh();
        let _o = primary(true);
        std::fs::write(&*STATE, r#"{"pid":999999,"host":"u@peer"}"#).unwrap();
        guard();
        assert!(!STATE.exists());
        assert_eq!(status()["open"], false);
    }

    #[test]
    fn listening_ports_are_read_from_lsof_and_netstat() {
        let lsof = "p100\ncnode\nf12\nn127.0.0.1:3000\nf13\nn*:8000\np200\ncmysqld\nf5\nn[::1]:5432\nf6\nn100.64.0.3:9000\nf7\nn*:8000\np300\nctower\nf3\nn127.0.0.1:4747\nf4\nn127.0.0.1:61000\n";
        assert_eq!(parse_lsof(lsof, true), vec![3000, 5432, 8000]);
        assert_eq!(parse_lsof(lsof, false), vec![3000, 5432, 8000, 9000]);
        let netstat = "  Proto  Local Address          Foreign Address        State\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING\n  TCP    127.0.0.1:4747         0.0.0.0:0              LISTENING\n  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING\n  TCP    127.0.0.1:50000        127.0.0.1:3000         ESTABLISHED\n  TCP    [::1]:3306             [::]:0                 LISTENING\n";
        assert_eq!(parse_netstat(netstat, true), vec![135, 3306, 4747]);
        assert_eq!(parse_netstat(netstat, false), vec![135, 139, 3306, 4747]);
    }

    #[test]
    fn an_open_tunnel_reports_every_port_it_forwards_and_close_kills_the_extras() {
        let _g = fresh();
        let _o = primary(false);
        let mut main = crate::core::platform::cmd("sleep").arg("60").stdin(Stdio::null()).spawn().unwrap();
        let mut extra = crate::core::platform::cmd("sleep").arg("60").stdin(Stdio::null()).spawn().unwrap();
        std::fs::write(&*STATE, stringify(&json!({ "pid": main.id(), "host": "u@peer", "ports": [3000, 3001], "extra": [{ "pid": extra.id(), "ports": [8000, 3001] }] }))).unwrap();
        assert_eq!(status()["ports"], json!([3000, 3001, 8000]));
        assert_eq!(pids().len(), 2);
        close();
        exited(&mut main);
        exited(&mut extra);
    }

    #[test]
    fn open_refuses_on_the_leading_machine() {
        let _g = fresh();
        let _o = primary(true);
        assert!(open().unwrap_err().contains("este ordenador manda"));
    }

    #[test]
    fn the_standby_machine_does_not_start_projects_and_stops_its_own() {
        let _g = fresh();
        let _o = Overrides;
        *REMOTE_OVERRIDE.lock().unwrap() = Some(json!({ "label": "Mac" }));
        assert!(crate::features::devservers::start("web").unwrap_err().contains("no manda: los proyectos corren en el Mac"));
        assert_eq!(crate::features::devservers::start_all(true, None).unwrap(), Vec::<String>::new());
        assert_eq!(crate::features::devservers::schedule(), Ok(()));
    }
}

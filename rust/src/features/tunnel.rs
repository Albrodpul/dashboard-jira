//! Port of src/features/tunnel.js.
use crate::core::data::DATA_DIR;
use crate::core::json::{parse, stringify, truthy};
use crate::core::time::{now, now_ms};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::{Command, Stdio};
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
    json!({ "open": t.is_some(), "host": field("host"), "since": field("since"), "ports": ports(), "error": if t.is_some() { Value::Null } else { last_error().map(Value::from).unwrap_or(Value::Null) } })
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
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    let out = crate::features::devservers::run_with_timeout(&mut cmd, None, 20000).ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok().filter(|p| *p != 0)
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
    let mut args: Vec<String> = ["-N", "-C", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"].iter().map(|s| s.to_string()).collect();
    for p in ports() {
        args.push("-L".into());
        args.push(format!("{p}:127.0.0.1:{p}"));
    }
    args.push(host.clone());
    let fail = || last_error().unwrap_or_else(|| "ssh no arranca".into());
    let pid = if cfg!(windows) {
        std::fs::write(&*LOG, "").map_err(|e| e.to_string())?;
        let home = std::env::home_dir().unwrap_or_default();
        let wrapper = crate::features::devservers::spawn_hidden("ssh", &args, &home.to_string_lossy(), &LOG.to_string_lossy())?;
        std::thread::sleep(Duration::from_millis(3500));
        let pid = if alive(wrapper) { ssh_under(wrapper) } else { None };
        pid.ok_or_else(fail)?
    } else {
        let log = std::fs::File::create(&*LOG).map_err(|e| e.to_string())?;
        let err = log.try_clone().map_err(|e| e.to_string())?;
        let mut cmd = Command::new("ssh");
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(err));
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        let mut child = cmd.spawn().map_err(|_| fail())?;
        let deadline = std::time::Instant::now() + Duration::from_millis(3500);
        let mut exited = false;
        while std::time::Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if exited {
            return Err(fail());
        }
        let pid = child.id();
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        pid
    };
    std::fs::write(&*STATE, stringify(&json!({ "pid": pid, "host": host, "label": label, "since": now() }))).map_err(|e| e.to_string())?;
    Ok(status())
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
    if let Some(pid) = read().as_ref().and_then(pid_of) {
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

pub fn pid() -> Option<u32> {
    read().as_ref().and_then(pid_of)
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
        let child = Command::new("sleep").arg("60").stdin(Stdio::null()).spawn().unwrap();
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

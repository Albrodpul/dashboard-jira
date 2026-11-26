//! Port of src/features/devservers.js.
use crate::core::config::{main_project, projects};
use crate::core::data::{DATA_DIR, Doc, load, mutate, now};
use crate::core::json::truthy;
use crate::core::time::{madrid, now_ms, parse};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

static LOG_DIR: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("devservers"));
const STOP_WINDOW_MIN: u32 = 10;
static STARTING: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn run_with_timeout(cmd: &mut Command, input: Option<&[u8]>, ms: u64) -> std::io::Result<Output> {
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
        let data = data.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let out_reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let err_reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let deadline = std::time::Instant::now() + Duration::from_millis(ms);
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(Output { status, stdout: out_reader.join().unwrap_or_default(), stderr: err_reader.join().unwrap_or_default() })
}

fn port_of(s: &Value) -> u16 {
    s.get("port").and_then(Value::as_u64).unwrap_or(0) as u16
}

fn text(s: &Value, k: &str) -> String {
    s.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn args_of(s: &Value) -> Vec<String> {
    s.get("args").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x))).collect()).unwrap_or_default()
}

pub fn servers(project: Option<&str>, anywhere: bool) -> Vec<Value> {
    let main = main_project().id.clone();
    let mut out = Vec::new();
    for p in projects() {
        if project.is_some_and(|id| id != p.id) || !(anywhere || p.root.as_ref().is_some_and(|r| r.exists())) {
            continue;
        }
        for s in &p.dev_servers {
            let mut x = s.as_object().cloned().unwrap_or_default();
            let sid = text(s, "id");
            x.insert("id".into(), Value::from(if p.id == main { sid } else { format!("{}-{}", p.id, sid) }));
            x.insert("project".into(), Value::from(p.id.clone()));
            x.insert("root".into(), p.root.as_ref().map(|r| Value::from(r.to_string_lossy().to_string())).unwrap_or(Value::Null));
            out.push(Value::Object(x));
        }
    }
    out
}

fn find(id: &str) -> Option<Value> {
    servers(None, false).into_iter().find(|s| s["id"] == id)
}

pub fn auto_projects(d: Option<&Doc>) -> Value {
    let loaded;
    let d = match d {
        Some(d) => d,
        None => {
            loaded = load();
            &loaded
        }
    };
    let set = d.get("devServers").and_then(|x| x.get("autoProjects")).cloned().unwrap_or(json!({}));
    let main = &main_project().id;
    let mut out = Map::new();
    for s in servers(None, false) {
        let id = text(&s, "project");
        if out.contains_key(&id) {
            continue;
        }
        let on = match set.get(&id) {
            Some(v) => truthy(Some(v)),
            None => &id == main,
        };
        out.insert(id, Value::from(on));
    }
    Value::Object(out)
}

pub fn set_auto_project(project: &str, on: bool) -> Result<Value, String> {
    if servers(Some(project), false).is_empty() {
        return Err(format!("ese proyecto no tiene servidores: {project}"));
    }
    mutate(|x| {
        let mut ds = x.get("devServers").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut auto = ds.get("autoProjects").and_then(Value::as_object).cloned().unwrap_or_default();
        auto.insert(project.to_string(), Value::from(on));
        ds.insert("autoProjects".into(), Value::Object(auto));
        x.insert("devServers".into(), Value::Object(ds));
    });
    Ok(auto_projects(None))
}

fn port_open(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
}

fn log_file(id: &str) -> PathBuf {
    LOG_DIR.join(format!("{id}.log"))
}

pub fn status() -> Value {
    let mut out = Vec::new();
    for s in servers(None, false) {
        let up = port_open(port_of(&s));
        let id = text(&s, "id");
        let st = STARTING.lock().unwrap().get(&id).copied();
        let seconds = s.get("startSeconds").and_then(Value::as_f64).filter(|n| *n != 0.0).unwrap_or(90.0);
        let state = if up {
            "up"
        } else if st.is_some_and(|t| ((now_ms() - t) as f64) < seconds * 1000.0) {
            "starting"
        } else {
            "down"
        };
        let role = s.get("role").filter(|r| truthy(Some(r))).cloned().unwrap_or(Value::from(""));
        let url = s.get("url").filter(|r| truthy(Some(r))).cloned().unwrap_or(Value::Null);
        out.push(json!({ "id": id, "project": s["project"], "name": s.get("name").cloned().unwrap_or(Value::Null), "role": role, "port": s.get("port").cloned().unwrap_or(Value::Null), "url": url, "autoStart": s.get("autoStart") != Some(&Value::Bool(false)), "state": state }));
    }
    let d = load();
    let ds = d.get("devServers").cloned().unwrap_or(json!({}));
    let or_null = |k: &str| ds.get(k).filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
    json!({ "servers": out, "autoProjects": auto_projects(None), "autoStartedOn": or_null("autoStartedOn"), "autoStoppedOn": or_null("autoStoppedOn"), "at": now() })
}

pub fn spawn_hidden(command: &str, args: &[String], cwd: &str, log: &str) -> Result<u32, String> {
    let special = regex::Regex::new(r#"[\s"&|<>^]"#).unwrap();
    let arg = |a: &str| if special.is_match(a) { format!("\"{}\"", a.replace('"', "\\\"")) } else { a.to_string() };
    let exe = if command.contains('/') || command.contains('\\') { crate::core::config::normalize(Path::new(command)).to_string_lossy().to_string() } else { command.to_string() };
    let mut words = vec![arg(&exe)];
    words.extend(args.iter().map(|a| arg(a)));
    let line = format!("/d /s /c \"{} >> \"{}\" 2>&1\"", words.join(" "), log);
    let lit = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let ps = format!("(Start-Process -FilePath cmd.exe -ArgumentList {} -WorkingDirectory {} -WindowStyle Hidden -PassThru).Id", lit(&line), lit(cwd));
    let mut cmd = crate::core::platform::cmd("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
    match run_with_timeout(&mut cmd, None, 30000) {
        Ok(r) => {
            let stdout = String::from_utf8_lossy(&r.stdout).trim().to_string();
            match stdout.parse::<u32>() {
                Ok(pid) if pid > 0 => Ok(pid),
                _ => {
                    let stderr = String::from_utf8_lossy(&r.stderr).to_string();
                    let detail = if !stderr.is_empty() { stderr } else { stdout };
                    let code = r.status.code().map(|c| c.to_string()).unwrap_or_else(|| "null".into());
                    Err(format!("no arranca (powershell {code}): {}", detail.trim().chars().take(300).collect::<String>()))
                }
            }
        }
        Err(e) => Err(format!("no arranca (powershell null): {}", e.to_string().trim().chars().take(300).collect::<String>())),
    }
}

fn pid_file(id: &str) -> PathBuf {
    LOG_DIR.join(format!("{id}.pid"))
}

fn kill_started(id: &str) {
    if let Some(pid) = std::fs::read_to_string(pid_file(id)).ok().and_then(|t| t.trim().parse::<u32>().ok()) {
        crate::core::platform::kill_tree(pid);
    }
    let _ = std::fs::remove_file(pid_file(id));
}

fn open_log(id: &str) -> std::io::Result<std::fs::File> {
    match std::fs::File::create(log_file(id)) {
        Ok(f) => Ok(f),
        Err(_) => {
            kill_started(id);
            std::fs::OpenOptions::new().create(true).append(true).open(log_file(id))
        }
    }
}

fn own_pids() -> Vec<String> {
    let mut out = vec![std::process::id().to_string()];
    out.extend(crate::features::tunnel::pids().into_iter().map(|p| p.to_string()));
    out
}

fn foreign_pids(port: u16) -> Vec<String> {
    let own = own_pids();
    crate::core::platform::listening_pids(port).into_iter().filter(|p| !own.contains(p)).collect()
}

fn leader() -> Option<Value> {
    crate::features::tunnel::remote().ok().flatten()
}

fn resolve(base: &str, rel: &str) -> PathBuf {
    crate::core::config::normalize(&Path::new(base).join(rel))
}

pub fn start(id: &str) -> Result<bool, String> {
    let s = find(id).ok_or_else(|| format!("proyecto desconocido: {id}"))?;
    if let Some(lead) = leader() {
        return Err(format!("este ordenador no manda: los proyectos corren en el {}", text(&lead, "label")));
    }
    if port_open(port_of(&s)) {
        return Ok(false);
    }
    std::fs::create_dir_all(&*LOG_DIR).map_err(|e| e.to_string())?;
    let mut fd = open_log(id).map_err(|e| e.to_string())?;
    let command = text(&s, "command");
    let args = args_of(&s);
    let _ = write!(fd, "[{}] {} {}\n", now(), command, args.join(" "));
    let cwd = resolve(&text(&s, "root"), s.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("."));
    let command = if command.starts_with('.') { cwd.join(&command).to_string_lossy().to_string() } else { command };
    if cfg!(windows) {
        drop(fd);
        let pid = spawn_hidden(&command, &args, &cwd.to_string_lossy(), &log_file(id).to_string_lossy())?;
        std::fs::write(pid_file(id), pid.to_string()).map_err(|e| e.to_string())?;
    } else {
        let mut cmd = if truthy(s.get("shell")) {
            let mut c = crate::core::platform::cmd("/bin/sh");
            c.arg("-c").arg(std::iter::once(command.clone()).chain(args.iter().cloned()).collect::<Vec<_>>().join(" "));
            c
        } else {
            let mut c = crate::core::platform::cmd(&command);
            c.args(&args);
            c
        };
        let err = fd.try_clone().map_err(|e| e.to_string())?;
        cmd.current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::from(fd)).stderr(Stdio::from(err));
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        match cmd.spawn() {
            Ok(mut child) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
            Err(e) => {
                if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(log_file(id)) {
                    let _ = write!(f, "\n{}\n", e);
                }
            }
        }
    }
    STARTING.lock().unwrap().insert(id.to_string(), now_ms());
    Ok(true)
}

pub fn stop(id: &str) -> Result<bool, String> {
    let s = find(id).ok_or_else(|| format!("proyecto desconocido: {id}"))?;
    STARTING.lock().unwrap().remove(id);
    let port = port_of(&s);
    if let Some(st) = s.get("stop").filter(|v| truthy(Some(v))) {
        let cwd = resolve(&text(&s, "root"), s.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("."));
        let mut cmd = crate::core::platform::cmd(text(st, "command"));
        cmd.args(args_of(st)).current_dir(cwd);
        let _ = run_with_timeout(&mut cmd, None, 30000);
        let mut i = 0;
        while i < 20 && port_open(port) {
            std::thread::sleep(Duration::from_millis(500));
            i += 1;
        }
        if !port_open(port) {
            kill_started(id);
            return Ok(true);
        }
    }
    let pids = foreign_pids(port);
    for p in &pids {
        if let Ok(n) = p.parse::<u32>() {
            crate::core::platform::kill_tree(n);
        }
    }
    kill_started(id);
    Ok(!pids.is_empty())
}

pub fn restart(id: &str) -> Result<bool, String> {
    stop(id)?;
    let mut i = 0;
    while i < 10 && find(id).is_some_and(|s| port_open(port_of(&s))) {
        std::thread::sleep(Duration::from_millis(500));
        i += 1;
    }
    start(id)
}

pub fn start_all(auto: bool, project: Option<&str>) -> Result<Vec<String>, String> {
    let mut started = Vec::new();
    if truthy(crate::features::tunnel::status().get("open")) || leader().is_some() {
        return Ok(started);
    }
    let pick = if auto { auto_projects(None) } else { Value::Null };
    for s in servers(project, false) {
        let skip = auto && (s.get("autoStart") == Some(&Value::Bool(false)) || !truthy(pick.get(text(&s, "project"))));
        let id = text(&s, "id");
        if !skip && start(&id)? {
            started.push(id);
        }
    }
    Ok(started)
}

pub fn stop_all(project: Option<&str>) -> Result<Vec<String>, String> {
    let mut stopped = Vec::new();
    for s in servers(project, false).into_iter().rev() {
        let id = text(&s, "id");
        if stop(&id)? {
            stopped.push(id);
        }
    }
    Ok(stopped)
}

fn first_report_today(d: &Doc, day: &str) -> bool {
    let at = [d.get("lastReview").and_then(|x| x.get("at")), d.get("reports").and_then(|r| r.get(0)).and_then(|x| x.get("at"))];
    at.iter().flatten().filter(|x| truthy(Some(x))).any(|x| x.as_str().and_then(parse).is_some_and(|ms| madrid(ms).day == day))
}

pub fn standby() -> Result<Vec<String>, String> {
    let mut stopped = Vec::new();
    for s in servers(None, false).into_iter().rev() {
        let id = text(&s, "id");
        if !foreign_pids(port_of(&s)).is_empty() && stop(&id)? {
            stopped.push(id);
        }
    }
    Ok(stopped)
}

pub fn schedule() -> Result<(), String> {
    if servers(None, false).is_empty() {
        return Ok(());
    }
    if leader().is_some() {
        return standby().map(|_| ());
    }
    let t = crate::core::time::madrid_now();
    if t.weekend {
        return Ok(());
    }
    let d = load();
    let ds = d.get("devServers").cloned().unwrap_or(json!({}));
    let stop_at = crate::core::hours::end_min();
    if t.min < stop_at && ds.get("autoStartedOn").and_then(Value::as_str) != Some(t.day.as_str()) && first_report_today(&d, &t.day) {
        set_day("autoStartedOn", &t.day);
        start_all(true, None)?;
    }
    if t.min >= stop_at && t.min < stop_at + STOP_WINDOW_MIN && ds.get("autoStoppedOn").and_then(Value::as_str) != Some(t.day.as_str()) && crate::core::hours::overtime().is_none() {
        set_day("autoStoppedOn", &t.day);
        stop_all(None)?;
    }
    Ok(())
}

fn set_day(key: &str, day: &str) {
    mutate(|x| {
        let mut ds = x.get("devServers").and_then(Value::as_object).cloned().unwrap_or_default();
        ds.insert(key.into(), Value::from(day));
        x.insert("devServers".into(), Value::Object(ds));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::fresh;

    fn add_project(id: &str, name: &str, prefix: &str, port: u16, url: bool) -> PathBuf {
        let folder = main_project().root.as_ref().unwrap().parent().unwrap().join(id);
        std::fs::create_dir_all(&folder).unwrap();
        let mut server = json!({ "id": "web", "name": "Web", "port": port, "command": "true" });
        if url {
            server = json!({ "id": "web", "name": "Web", "port": port, "url": format!("http://localhost:{port}"), "command": "true" });
        }
        mutate(|d| {
            let mut defs = d.get("projectDefs").and_then(Value::as_object).cloned().unwrap_or_default();
            defs.insert(id.into(), json!({ "id": id, "name": name, "taskPrefix": prefix, "folder": id, "devServers": [server] }));
            d.insert("projectDefs".into(), Value::Object(defs));
        });
        crate::core::config::forget_projects();
        folder
    }

    #[test]
    fn dev_servers_come_from_every_project_tagged_with_it_and_a_projects_own_run_in_its_folder() {
        let _g = fresh();
        let main = main_project();
        let folder = add_project("otra", "Otra", "OTRA", 39998, true);
        let list = servers(None, false);
        let mine: Vec<&Value> = list.iter().filter(|s| s["project"] == main.id.as_str()).collect();
        assert!(!mine.is_empty());
        assert!(mine.iter().all(|s| main.dev_servers.iter().any(|x| x["id"] == s["id"])));
        let other = list.iter().find(|s| s["project"] == "otra").unwrap();
        assert_eq!(other["id"], "otra-web");
        assert_eq!(other["root"], crate::core::config::normalize(&folder).to_string_lossy().as_ref());
        assert_eq!(servers(Some("otra"), false).iter().map(|s| s["id"].clone()).collect::<Vec<_>>(), vec![json!("otra-web")]);
        let st = status();
        assert_eq!(st["servers"].as_array().unwrap().iter().find(|s| s["id"] == "otra-web").unwrap()["project"], "otra");
        std::fs::remove_dir_all(&folder).unwrap();
        crate::core::config::forget_projects();
        assert!(!servers(None, false).iter().any(|s| s["project"] == "otra"));
        assert!(crate::features::tunnel::status()["ports"].as_array().unwrap().contains(&json!(39998)));
    }

    #[test]
    fn only_the_projects_marked_to_auto_start_come_up_on_their_own_the_main_one_is_marked_by_default() {
        let _g = fresh();
        let main = main_project().id.clone();
        let folder = add_project("dos", "Dos", "DOS", 39997, false);
        let mut expected = Map::new();
        expected.insert(main.clone(), json!(true));
        expected.insert("dos".into(), json!(false));
        assert_eq!(auto_projects(None), Value::Object(expected));
        set_auto_project("dos", true).unwrap();
        set_auto_project(&main, false).unwrap();
        let mut expected = Map::new();
        expected.insert(main.clone(), json!(false));
        expected.insert("dos".into(), json!(true));
        assert_eq!(auto_projects(None), Value::Object(expected));
        assert_eq!(status()["autoProjects"]["dos"], true);
        assert!(set_auto_project("nope", true).unwrap_err().contains("no tiene servidores"));
        std::fs::remove_dir_all(&folder).unwrap();
        crate::core::config::forget_projects();
    }
}

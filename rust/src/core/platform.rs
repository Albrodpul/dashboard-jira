use regex::Regex;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

pub const IS_WIN: bool = cfg!(windows);
pub const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

#[derive(Clone, Debug, PartialEq)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub command: String,
}

#[derive(Clone, Debug, Default)]
pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub fn home_dir() -> PathBuf {
    let var = if IS_WIN { "USERPROFILE" } else { "HOME" };
    std::env::var(var).or_else(|_| std::env::var("HOME")).map(PathBuf::from).unwrap_or_default()
}

pub fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = vec![0u8; 256];
        let r = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if r == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).to_string();
        }
        String::new()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

pub fn username() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

pub fn run_output(cmd: &str, args: &[String], timeout_ms: u64, cwd: Option<&Path>, env: &[(&str, &str)]) -> Output {
    let mut c = crate::core::platform::cmd(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    let Ok(mut child) = c.spawn() else { return Output::default() };
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut s);
        }
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut s);
        }
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if start.elapsed() < Duration::from_millis(timeout_ms) => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).to_string();
    Output { ok: status.map_or(false, |s| s.success()), stdout, stderr }
}

fn run(cmd: &str, args: &[&str], timeout_ms: u64) -> String {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let o = run_output(cmd, &args, timeout_ms, None, &[]);
    if o.ok { o.stdout } else { String::new() }
}

pub fn spawn_detached(cmd: &str, args: &[String], env: Option<&HashMap<String, String>>) -> Option<u32> {
    let mut c = crate::core::platform::cmd(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(env) = env {
        c.env_clear().envs(env);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    stop_inheriting_std_handles();
    let mut child = c.spawn().ok()?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Some(pid)
}

static PS_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$").unwrap());
static NETSTAT_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)").unwrap());

pub fn processes() -> Vec<Process> {
    if IS_WIN {
        let text = run("powershell", &["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"], 20000);
        let text = text.trim_start_matches('\u{feff}');
        let Some(rows) = crate::core::json::parse(if text.is_empty() { "[]" } else { text }) else { return Vec::new() };
        let rows = match rows {
            serde_json::Value::Array(a) => a,
            other => vec![other],
        };
        return rows
            .iter()
            .map(|r| Process {
                pid: r.get("ProcessId").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                ppid: r.get("ParentProcessId").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                name: {
                    let n = r.get("Name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let lower = n.to_lowercase();
                    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
                },
                command: r.get("CommandLine").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
            .collect();
    }
    run("ps", &["-A", "-o", "pid=,ppid=,comm=,args="], 20000)
        .split('\n')
        .filter_map(|line| PS_LINE.captures(line))
        .map(|m| Process {
            pid: m[1].parse().unwrap_or(0),
            ppid: m[2].parse().unwrap_or(0),
            name: Path::new(&m[3]).file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or_default(),
            command: m[4].to_string(),
        })
        .collect()
}

pub fn command_line(pid: u32) -> String {
    if IS_WIN {
        return run("powershell", &["-NoProfile", "-Command", &format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine")], 8000);
    }
    run("ps", &["-o", "args=", "-p", &pid.to_string()], 20000)
}

pub fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    if IS_WIN {
        run("taskkill", &["/PID", &pid.to_string(), "/T", "/F"], 20000);
        return;
    }
    let all = processes();
    let mut doomed = vec![pid];
    let mut i = 0;
    while i < doomed.len() {
        for p in &all {
            if p.ppid == doomed[i] {
                doomed.push(p.pid);
            }
        }
        i += 1;
    }
    for p in doomed.iter().rev() {
        #[cfg(unix)]
        unsafe {
            libc::kill(*p as libc::pid_t, libc::SIGKILL);
        }
    }
}

pub fn listening_pids(port: u16) -> Vec<String> {
    if IS_WIN {
        let mut pids: Vec<String> = Vec::new();
        for line in run("netstat", &["-ano", "-p", "tcp"], 20000).lines() {
            if let Some(m) = NETSTAT_LINE.captures(line) {
                if m[1].parse::<u16>().ok() == Some(port) && &m[2] != "0" && !pids.contains(&m[2].to_string()) {
                    pids.push(m[2].to_string());
                }
            }
        }
        return pids;
    }
    run("lsof", &["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"], 20000).split('\n').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

pub fn open_url(url: &str, env: Option<&HashMap<String, String>>) {
    if IS_WIN {
        spawn_detached("cmd", &["/c".into(), "start".into(), String::new(), url.into()], env);
    } else {
        spawn_detached("open", &[url.into()], env);
    }
}

pub fn open_folder_in_editor(folder: &str, env: Option<&HashMap<String, String>>) {
    if IS_WIN {
        spawn_detached("cmd", &["/c".into(), "code".into(), folder.into()], env);
    } else {
        spawn_detached("open", &["-a".into(), "Visual Studio Code".into(), folder.into()], env);
    }
}

pub fn claude_cli() -> String {
    crate::agents::claude::cli()
}

pub fn claude(args: &[String], fallback: Option<&str>) -> (String, Vec<String>) {
    crate::agents::claude::command(args, fallback)
}

pub fn is_shell(name: &str) -> bool {
    ["node", "bash", "sh", "zsh", "cmd", "powershell", "pwsh", "conhost", "timeout"].contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_a_command_and_gives_up_after_the_timeout() {
        let o = run_output("sh", &["-c".into(), "echo hi".into()], 5000, None, &[]);
        assert!(o.ok);
        assert_eq!(o.stdout, "hi\n");
        let slow = run_output("sh", &["-c".into(), "sleep 5".into()], 200, None, &[]);
        assert!(!slow.ok);
    }

    #[test]
    fn lists_this_process() {
        let me = std::process::id();
        assert!(processes().iter().any(|p| p.pid == me));
    }
}

pub fn self_exe() -> std::io::Result<std::path::PathBuf> {
    match std::env::var_os("TOWER_EXE") {
        Some(p) if !p.is_empty() => Ok(std::path::PathBuf::from(p)),
        _ => std::env::current_exe(),
    }
}

#[cfg(windows)]
pub fn stop_inheriting_std_handles() {
    unsafe extern "system" {
        fn GetStdHandle(which: u32) -> *mut std::ffi::c_void;
        fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    for which in [-10i32, -11, -12] {
        unsafe {
            let h = GetStdHandle(which as u32);
            if !h.is_null() && h as isize != -1 {
                SetHandleInformation(h, 1, 0);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn stop_inheriting_std_handles() {}

pub fn cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}

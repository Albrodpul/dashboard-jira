use crate::cluster::role::{CLUSTER, is_primary, log};
use crate::core::data::DATA_DIR;
use serde_json::Value;

fn caffeinate_running(pid: i64) -> Result<bool, ()> {
    let out = std::process::Command::new("/bin/ps").args(["-o", "comm=", "-p", &pid.to_string()]).output().map_err(|_| ())?;
    if !out.status.success() {
        return Err(());
    }
    Ok(String::from_utf8_lossy(&out.stdout).contains("caffeinate"))
}

fn read_pid(file: &std::path::Path) -> Option<i64> {
    std::fs::read_to_string(file).ok()?.trim().parse().ok()
}

#[cfg(unix)]
fn signal(pid: i64, sig: i32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, sig) == 0 }
}

#[cfg(not(unix))]
fn signal(_pid: i64, _sig: i32) -> bool {
    false
}

pub fn keep_awake() {
    if CLUSTER.is_none() {
        return;
    }
    let now = crate::core::hours::clock();
    let min = now.min as i64;
    let want = crate::features::mac_power::in_window(&now);
    let extra = crate::core::hours::overtime().is_some() && is_primary();
    if !cfg!(target_os = "macos") {
        return;
    }
    let extra_file = DATA_DIR.join("caffeinate.extra");
    if !extra && extra_file.exists() {
        let_sleep();
    }
    if !want && !extra {
        return;
    }
    let pid_file = DATA_DIR.join("caffeinate.pid");
    if let Some(pid) = read_pid(&pid_file) {
        if signal(pid, 0) && caffeinate_running(pid) == Ok(true) {
            return;
        }
    }
    let end = crate::features::mac_power::schedule().get("sleep").and_then(Value::as_str).unwrap_or("21:00").to_string();
    let end_min = crate::core::hours::to_min(&end) as i64;
    let seconds = ((end_min - min) * 60).max(60);
    let args: Vec<String> = if extra { vec!["-i".into()] } else { vec!["-i".into(), "-t".into(), seconds.to_string()] };
    let Some(pid) = crate::core::platform::spawn_detached("/usr/bin/caffeinate", &args, None) else { return };
    let _ = std::fs::write(&pid_file, pid.to_string());
    if extra {
        let _ = std::fs::write(&extra_file, pid.to_string());
    }
    log(&if extra { "caffeinate: fuera de horario activado, el Mac no se dormirá hasta que lo termines".to_string() } else { format!("caffeinate: el Mac no se dormirá solo hasta las {end}") });
}

pub fn let_sleep() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let pid_file = DATA_DIR.join("caffeinate.pid");
    let attempt = || -> Result<(), ()> {
        let pid = read_pid(&pid_file).ok_or(())?;
        if caffeinate_running(pid)? && !signal(pid, 15) {
            return Err(());
        }
        std::fs::remove_file(&pid_file).map_err(|_| ())?;
        log("caffeinate: parado, el Mac ya puede dormirse");
        Ok(())
    };
    let _ = attempt();
    let _ = std::fs::remove_file(DATA_DIR.join("caffeinate.extra"));
}

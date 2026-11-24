use serde_json::{Value, json};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};

static LOAD: LazyLock<Mutex<Value>> = LazyLock::new(|| Mutex::new(Value::Null));

fn run(cmd: &str, args: &[&str]) -> String {
    crate::core::platform::cmd(cmd).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default()
}

fn cores() -> f64 {
    std::thread::available_parallelism().map(|n| n.get() as f64).unwrap_or(1.0)
}

fn sample() -> Option<(f64, f64)> {
    if cfg!(target_os = "macos") {
        let cpu: f64 = run("/bin/ps", &["-A", "-o", "%cpu="]).lines().filter_map(|l| l.trim().replace(',', ".").parse::<f64>().ok()).sum();
        let free = run("/usr/bin/memory_pressure", &[]).lines().find(|l| l.contains("free percentage")).and_then(|l| l.rsplit(':').next()).and_then(|v| v.trim().trim_end_matches('%').parse::<f64>().ok())?;
        return Some(((cpu / cores()).clamp(0.0, 100.0), (100.0 - free).clamp(0.0, 100.0)));
    }
    if cfg!(windows) {
        let out = run("powershell", &["-NoProfile", "-Command", "$c=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $o=Get-CimInstance Win32_OperatingSystem; \"$c $($o.FreePhysicalMemory) $($o.TotalVisibleMemorySize)\""]);
        let n: Vec<f64> = out.split_whitespace().filter_map(|x| x.replace(',', ".").parse().ok()).collect();
        if n.len() == 3 && n[2] > 0.0 {
            return Some((n[0].clamp(0.0, 100.0), (100.0 - n[1] / n[2] * 100.0).clamp(0.0, 100.0)));
        }
    }
    None
}

pub fn tick() {
    let value = match sample() {
        Some((cpu, mem)) => json!({ "cpu": cpu.round() as i64, "mem": mem.round() as i64, "at": crate::core::time::now() }),
        None => Value::Null,
    };
    *LOAD.lock().unwrap() = value;
}

pub fn for_page() -> Value {
    let mut v = LOAD.lock().unwrap().clone();
    if let Some(o) = v.as_object_mut() {
        let label = crate::core::config::cluster().and_then(|c| c.get("label")).and_then(|l| l.as_str()).unwrap_or("").to_string();
        o.insert("label".into(), Value::from(label));
    }
    v
}

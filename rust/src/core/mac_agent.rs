use std::path::{Path, PathBuf};

use std::sync::LazyLock;

pub const LABEL: &str = "com.nutria.board";
pub static PLIST: LazyLock<PathBuf> = LazyLock::new(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library").join("LaunchAgents").join(format!("{LABEL}.plist")));
pub const IS_MAC: bool = cfg!(target_os = "macos");

fn uid() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn target() -> String {
    format!("gui/{}/{LABEL}", uid())
}

pub fn under_agent() -> bool {
    std::env::var("NUTRIA_AGENT").as_deref() == Ok("1")
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn plist_body(exe: &Path, workspace: &Path, log_file: &Path) -> String {
    let home = crate::core::platform::home_dir().to_string_lossy().to_string();
    let path = std::env::var("PATH").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "/usr/bin:/bin".to_string());
    let ws = workspace.to_string_lossy().to_string();
    let env = [("NUTRIA_AGENT", "1".to_string()), ("TOWER_WORKSPACE", ws.clone()), ("PATH", path), ("HOME", home)];
    let env_xml: String = env.iter().map(|(k, v)| format!("<key>{k}</key><string>{}</string>", xml(v))).collect();
    let log = xml(&log_file.to_string_lossy());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>{env_xml}</dict>
  <key>WorkingDirectory</key><string>{}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
",
        xml(&exe.to_string_lossy()),
        xml(&ws)
    )
}

fn launchctl(args: &[&str], timeout_ms: u64) -> bool {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    crate::core::platform::run_output("/bin/launchctl", &args, timeout_ms, None, &[]).ok
}

pub fn loaded() -> bool {
    if !IS_MAC {
        return false;
    }
    launchctl(&["print", &target()], 5000)
}

pub fn kickstart() -> bool {
    launchctl(&["kickstart", &target()], 5000)
}

pub fn restart_agent() -> bool {
    launchctl(&["kickstart", "-k", &target()], 10000)
}

pub fn install(workspace: &Path, log_file: &Path) -> bool {
    if !IS_MAC || under_agent() {
        return false;
    }
    let Ok(exe) = crate::core::platform::self_exe() else { return false };
    let body = plist_body(&exe, workspace, log_file);
    let current = std::fs::read_to_string(&*PLIST).unwrap_or_default();
    if current != body {
        if let Some(dir) = PLIST.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if std::fs::write(&*PLIST, &body).is_err() {
            return false;
        }
        if loaded() {
            launchctl(&["bootout", &target()], 10000);
        }
    }
    if !loaded() && !launchctl(&["bootstrap", &format!("gui/{}", uid()), &PLIST.to_string_lossy()], 10000) {
        return false;
    }
    for _ in 0..10 {
        if running() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    kickstart();
    true
}

fn running() -> bool {
    let out = crate::core::platform::run_output("/bin/launchctl", &["print".to_string(), target()], 5000, None, &[]);
    out.ok && out.stdout.lines().any(|l| l.trim_start().starts_with("pid = "))
}

//! Port of src/server/watcher.js.
use crate::core::data::{BOARD_HEARTBEAT, load};
use crate::server::state::message_notice;
use std::collections::HashSet;
use std::io::Write;
use std::time::Duration;

const MODES: [(&str, &str); 6] = [("reports", "reports"), ("reportes", "reports"), ("dispatches", "dispatches"), ("envios", "dispatches"), ("board", "board"), ("tablero", "board")];

fn me() -> String {
    crate::core::config::main_project().jira.as_ref().and_then(|j| j.me.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn commands_dir() -> String {
    crate::core::config::main_project().commands_dir.clone().unwrap_or_else(|| "undefined".to_string())
}

fn say(line: &str) {
    let mut out = std::io::stdout();
    if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

fn forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(1 << 20));
    }
}

fn every(ms: u64, mut f: impl FnMut() + Send + 'static) {
    std::thread::spawn(move || {
        loop {
            f();
            std::thread::sleep(Duration::from_millis(ms));
        }
    });
}

fn heartbeat(file: std::path::PathBuf) {
    every(15000, move || {
        let _ = std::fs::write(&file, crate::core::time::now());
    });
}

fn watch_messages(to: &'static str) -> impl FnMut() + Send + 'static {
    let mut seen: HashSet<String> = HashSet::new();
    move || {
        let d = load();
        let fresh: Vec<String> = d
            .get("messages")
            .and_then(|m| m.as_array())
            .into_iter()
            .flatten()
            .filter(|m| m.get("to").and_then(|t| t.as_str()) == Some(to) && !crate::core::json::truthy(m.get("readAt")))
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
            .filter(|id| !seen.contains(id))
            .collect();
        for id in fresh.into_iter().rev() {
            seen.insert(id.clone());
            say(&format!("MESSAGE {id}: {}", message_notice(&id)));
        }
    }
}

fn watch_reports() -> ! {
    say(&format!(
        "RETIRED: el servidor del tablero mira Jira cada 15 segundos y te escribe «Tablero: hay novedades en Jira…» cuando hay algo (o «{} ha pulsado Refrescar»). Este Monitor no dará más eventos: páralo, no lo vuelvas a armar y relee {}/resumen-jira.md.",
        me(),
        commands_dir()
    ));
    forever()
}

fn watch_dispatches() -> ! {
    say(&format!(
        "RETIRED: el tablero ya entrega él mismo lo que {} aprueba (tareas, respuestas, despliegues, errores y Ordenar contexto). Este Monitor no dará más eventos: páralo, no lo vuelvas a armar y relee {}/orquesta.md.",
        me(),
        commands_dir()
    ));
    forever()
}

fn watch_board() -> ! {
    every(1000, watch_messages("board"));
    heartbeat(BOARD_HEARTBEAT.clone());
    forever()
}

fn exit_when_orphaned() {
    #[cfg(unix)]
    {
        let parent = std::os::unix::process::parent_id() as libc::pid_t;
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(15000));
                let alive = unsafe { libc::kill(parent, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
                if !alive {
                    std::process::exit(0);
                }
            }
        });
    }
}

fn head() -> Option<String> {
    let out = crate::core::platform::cmd("git")
        .arg("-C")
        .arg(crate::core::config::repo())
        .args(["rev-parse", "HEAD"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

fn exit_when_code_changes() {
    let Some(start) = head() else { return };
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(15000));
            let Some(now) = head() else { continue };
            if now == start {
                continue;
            }
            say(&format!(
                "RESTART: hay código nuevo del tablero (commit {}). Vuelve a armar este Monitor con el mismo comando y relee tu comando de .claude/commands por si ha cambiado.",
                now.chars().take(7).collect::<String>()
            ));
            std::process::exit(0);
        }
    });
}

pub fn watch(mode: Option<&str>) {
    exit_when_orphaned();
    exit_when_code_changes();
    let mode = mode.filter(|m| !m.is_empty());
    let m = mode.and_then(|mode| MODES.iter().find(|(k, _)| *k == mode).map(|(_, v)| *v));
    if mode.is_some() && m.is_none() {
        eprintln!("Uso: board.js watch [reports|dispatches|board]");
        std::process::exit(1);
    }
    match m {
        Some("board") => watch_board(),
        Some("dispatches") => watch_dispatches(),
        _ => watch_reports(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mode_has_its_spanish_alias() {
        for (alias, mode) in [("reportes", "reports"), ("envios", "dispatches"), ("tablero", "board")] {
            assert_eq!(MODES.iter().find(|(k, _)| *k == alias).map(|(_, v)| *v), Some(mode));
        }
    }

    #[test]
    fn the_message_notice_tells_how_to_read_and_answer() {
        let _g = crate::testkit::fresh();
        let text = message_notice("M2");
        assert!(text.starts_with("Mensaje de Tester Person desde el tablero (M2)."));
        assert!(text.contains("message M2"));
        assert!(text.contains("answer-message M2"));
    }
}

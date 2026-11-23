use crate::core::data::{load, mutate};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

static RUNNING: AtomicBool = AtomicBool::new(false);
static RUNNING_HEAD: LazyLock<Option<String>> = LazyLock::new(|| {
    let o = crate::core::platform::run_output("git", &["-C".into(), crate::core::config::repo().to_string_lossy().to_string(), "rev-parse".into(), "HEAD".into()], 20000, None, &[]);
    o.ok.then(|| o.stdout.trim().to_string())
});
static LAST_BEAT: LazyLock<AtomicI64> = LazyLock::new(|| AtomicI64::new(crate::core::time::now_ms()));

struct Git {
    ok: bool,
    out: String,
}

fn root() -> PathBuf {
    crate::core::config::main_project().root.clone().unwrap_or_default()
}

fn git_in(dir: &Path, args: &[&str]) -> Git {
    let mut all: Vec<String> = vec!["-C".into(), dir.to_string_lossy().to_string()];
    all.extend(args.iter().map(|s| s.to_string()));
    let o = crate::core::platform::run_output("git", &all, 120_000, None, &[]);
    Git { ok: o.ok, out: o.stdout + &o.stderr }
}

fn git(args: &[&str]) -> Git {
    git_in(&root(), args)
}

fn repo_git(args: &[&str]) -> Git {
    git_in(&crate::core::config::repo(), args)
}

fn merge_into(key: &str, patch: Value) {
    mutate(|d| {
        let mut next: Map<String, Value> = d.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
        for (k, v) in patch.as_object().cloned().unwrap_or_default() {
            next.insert(k, v);
        }
        next.insert("at".into(), json!(crate::core::time::now()));
        d.insert(key.to_string(), Value::Object(next));
    });
}

fn record(patch: Value) {
    merge_into("contextSync", patch);
}

fn board_update(patch: Value) {
    merge_into("boardUpdate", patch);
}

fn cut(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    String::from_utf16_lossy(&units[..units.len().min(n)])
}

fn push_later(text: String) {
    std::thread::spawn(move || {
        crate::server::push::send_push("sessions", true, Some(&text));
    });
}

static OFFLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Could not resolve host|unable to access|Network is unreachable|timed out").unwrap());
static PACKAGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"package(-lock)?\.json").unwrap());
static TEMPLATES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|\n)(templates/|install\.js)").unwrap());
static CLASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)CONFLICT|could not apply|Resolve all conflicts|needs merge").unwrap());

fn update_board() {
    let pull = repo_git(&["pull", "--ff-only", "-q"]);
    if !pull.ok {
        let first = !crate::core::json::truthy(load().get("boardUpdate").and_then(|b| b.get("error")));
        let trimmed = pull.out.trim().to_string();
        let error = if trimmed.is_empty() { "no se pudo bajar el tablero de GitHub".to_string() } else { cut(&trimmed, 300) };
        board_update(json!({ "state": "error", "error": error }));
        if first && !OFFLINE.is_match(&pull.out) {
            push_later(format!("El tablero de {} no se puede poner al día solo: {}", crate::core::platform::hostname(), cut(trimmed.split('\n').next().unwrap_or(""), 120)));
        }
        return;
    }
    let after = repo_git(&["rev-parse", "HEAD"]);
    let head = after.out.trim().to_string();
    board_update(json!({ "state": "ok", "error": null, "head": cut(&head, 7), "lastOk": crate::core::time::now() }));
    let Some(running) = RUNNING_HEAD.as_ref() else { return };
    if !after.ok || *running == head {
        return;
    }
    let changed = repo_git(&["diff", "--name-only", running, &head]);
    let repo = crate::core::config::repo();
    if PACKAGES.is_match(&changed.out) {
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        crate::core::platform::run_output(npm, &["ci".into(), "--no-audit".into(), "--no-fund".into()], 300_000, Some(&repo), &[]);
    }
    if TEMPLATES.is_match(&changed.out) {
        let workspace = crate::core::config::workspace().to_string_lossy().to_string();
        crate::core::platform::run_output("node", &[repo.join("install.js").to_string_lossy().to_string(), workspace, "--rust".into()], 60_000, None, &[]);
    }
    if changed.out.split('\n').any(|f| f.starts_with("rust/")) {
        let candidates = [crate::core::platform::home_dir().join(".cargo").join("bin").join(if cfg!(windows) { "cargo.exe" } else { "cargo" }), std::path::PathBuf::from("/opt/homebrew/opt/rustup/bin/cargo")];
        let cargo = candidates.iter().find(|c| c.exists()).map(|c| c.to_string_lossy().to_string()).unwrap_or_else(|| "cargo".to_string());
        let dir = std::path::Path::new(&cargo).parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
        let path = format!("{dir}{}{}", if cfg!(windows) { ";" } else { ":" }, std::env::var("PATH").unwrap_or_default());
        let staging = repo.join("rust").join("target-next");
        let target_dir = if cfg!(windows) { staging.to_string_lossy().to_string() } else { repo.join("rust").join("target").to_string_lossy().to_string() };
        let built = crate::core::platform::run_output(&cargo, &["build".into(), "--release".into()], 900_000, Some(&repo.join("rust")), &[("PATH", path.as_str()), ("CARGO_TARGET_DIR", target_dir.as_str())]);
        if built.ok && cfg!(windows) {
            let live = repo.join("rust").join("target").join("release").join("tower.exe");
            let old = live.with_extension("exe.old");
            let _ = std::fs::remove_file(&old);
            let swapped = std::fs::rename(&live, &old).is_ok() || !live.exists();
            if !swapped || std::fs::copy(staging.join("release").join("tower.exe"), &live).is_err() {
                let _ = std::fs::rename(&old, &live);
                push_later(format!("El tablero de {} no se puede poner al día solo: no se pudo cambiar tower.exe", crate::core::platform::hostname()));
                return;
            }
        }
        if !built.ok {
            push_later(format!("El tablero de {} no se puede poner al día solo: no compila ({})", crate::core::platform::hostname(), cut(built.stderr.trim().split('\n').last().unwrap_or(""), 120)));
            return;
        }
    }
    if let Ok(exe) = crate::core::platform::self_exe() {
        let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
        env.insert("TOWER_WORKSPACE".into(), crate::core::config::workspace().to_string_lossy().to_string());
        crate::core::platform::spawn_detached(&exe.to_string_lossy(), &["restart".into()], Some(&env));
    }
}

pub fn sync_context() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    if context_sync_enabled() {
        sync_context_repo();
    }
    update_board();
    RUNNING.store(false, Ordering::SeqCst);
}

fn sync_context_repo() {
    let status = git(&["status", "--porcelain"]);
    if !status.ok {
        return record(json!({ "state": "error", "error": cut(&status.out, 300) }));
    }
    if !status.out.trim().is_empty() {
        git(&["add", "-A"]);
        let message = format!("Contexto desde {}", crate::core::platform::hostname());
        let commit = git(&["commit", "-q", "-m", &message]);
        if !commit.ok && !commit.out.contains("nothing to commit") {
            return record(json!({ "state": "error", "error": cut(&commit.out, 300) }));
        }
    }
    let pull = git(&["pull", "--rebase", "--autostash", "-q"]);
    if !pull.ok {
        let clash = CLASH.is_match(&pull.out);
        git(&["rebase", "--abort"]);
        if !clash {
            let trimmed = pull.out.trim();
            let error = if trimmed.is_empty() { "no se pudo hablar con GitHub (¿sin conexión al despertar?)".to_string() } else { cut(trimmed, 300) };
            return record(json!({ "state": "error", "error": error }));
        }
        let already = load().get("contextSync").and_then(|c| c.get("state")).and_then(Value::as_str) == Some("conflict");
        record(json!({ "state": "conflict", "error": cut(&pull.out, 500) }));
        if !already {
            push_later("El contexto compartido tiene un choque entre los dos ordenadores: hay que resolverlo a mano".to_string());
        }
        return;
    }
    let ahead = git(&["rev-list", "--count", "@{u}..HEAD"]);
    if ahead.ok && ahead.out.trim().parse::<i64>().unwrap_or(0) > 0 {
        let pushed = git(&["push", "-q"]);
        if !pushed.ok {
            return record(json!({ "state": "error", "error": cut(&pushed.out, 300) }));
        }
    }
    record(json!({ "state": "ok", "error": null, "lastOk": crate::core::time::now() }));
}

pub fn wake_check() {
    let now = crate::core::time::now_ms();
    let gap = now - LAST_BEAT.swap(now, Ordering::SeqCst);
    if gap > 3 * 60_000 {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(20_000));
            sync_context();
        });
    }
}

pub fn context_sync_enabled() -> bool {
    root().join(".git").exists()
}

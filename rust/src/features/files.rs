//! Port of src/features/files.js.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use crate::core::time::now_ms;
use crate::sessions::registry::{RunOptions, run_bounded};

const TTL_MS: i64 = 60000;

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::main_project().root.clone().unwrap_or_default());

#[derive(Default)]
struct FileIndex {
    files: Option<Vec<String>>,
    built_at: i64,
    building: bool,
}

static INDEX: LazyLock<Mutex<FileIndex>> = LazyLock::new(|| Mutex::new(FileIndex::default()));

fn list_repo(dir: &Path, prefix: &str) -> Vec<String> {
    let args: Vec<String> = vec!["-C".into(), dir.to_string_lossy().into_owned(), "ls-files".into(), "-co".into(), "--exclude-standard".into()];
    let r = run_bounded("git", &args, &RunOptions { cwd: None, env: None }, 30000);
    if !r.ok {
        return Vec::new();
    }
    r.out.split('\n').filter(|f| !f.is_empty()).map(|f| if prefix.is_empty() { f.to_string() } else { format!("{prefix}/{f}") }).collect()
}

fn build() -> Option<Vec<String>> {
    let mut dirs: Vec<(PathBuf, String)> = vec![(ROOT.clone(), String::new())];
    let mut names: Vec<String> = std::fs::read_dir(&*ROOT).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for name in names {
        let full = ROOT.join(&name);
        if full.join(".git").exists() {
            dirs.push((full, name));
        }
    }
    let lists: Vec<Vec<String>> = std::thread::scope(|s| {
        let handles: Vec<_> = dirs.iter().map(|(d, p)| s.spawn(move || list_repo(d, p))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut seen = std::collections::HashSet::new();
    let index: Vec<String> = lists.into_iter().flatten().filter(|f| seen.insert(f.clone())).collect();
    Some(index)
}

fn rebuild() -> Vec<String> {
    let built = build();
    let mut idx = INDEX.lock().unwrap_or_else(|p| p.into_inner());
    idx.building = false;
    match built {
        Some(list) => {
            idx.files = Some(list.clone());
            idx.built_at = now_ms();
            list
        }
        None => idx.files.clone().unwrap_or_default(),
    }
}

fn files() -> Vec<String> {
    {
        let mut idx = INDEX.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(f) = &idx.files {
            if now_ms() - idx.built_at < TTL_MS {
                return f.clone();
            }
            let stale = f.clone();
            if !idx.building {
                idx.building = true;
                std::thread::spawn(rebuild);
            }
            return stale;
        }
        idx.building = true;
    }
    rebuild()
}

pub fn search_files(q: &str) -> Vec<String> {
    let query = q.to_lowercase().replace('\\', "/").trim().to_string();
    if query.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, String)> = Vec::new();
    for f in files() {
        let lower = f.to_lowercase();
        if !lower.contains(&query) {
            continue;
        }
        let base = &lower[lower.rfind('/').map(|i| i + 1).unwrap_or(0)..];
        let rank = if base.starts_with(&query) { 0 } else if base.contains(&query) { 1 } else { 2 };
        scored.push((rank * 1000 + f.encode_utf16().count(), f));
        if scored.len() > 5000 {
            break;
        }
    }
    scored.sort_by_key(|x| x.0);
    scored.into_iter().take(12).map(|x| x.1).collect()
}

pub fn warm_files() {
    files();
}

//! Port of src/features/memory-sync.js.
use crate::core::data::DATA_DIR;
use crate::core::json::{num, parse, stringify};
use crate::core::time::now_ms;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::LazyLock;

const INDEX: &str = "MEMORY.md";
const TOMB_MS: f64 = 30.0 * 24.0 * 3600.0 * 1000.0;
const MAIN_PEER: &str = "/api/cluster/memory";

#[derive(Clone)]
struct Context {
    dir: PathBuf,
    state: PathBuf,
    peer: String,
}

thread_local! {
    static CTX: RefCell<Option<Context>> = const { RefCell::new(None) };
}

static NOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+\.md$").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\]\(([A-Za-z0-9_.-]+\.md)\)").unwrap());

fn main_context() -> Context {
    Context { dir: crate::cluster::cluster::project_dir().join("memory"), state: DATA_DIR.join("memory-sync.json"), peer: MAIN_PEER.to_string() }
}

fn ctx() -> Context {
    CTX.with(|c| c.borrow().clone()).unwrap_or_else(main_context)
}

fn with_context<R>(c: Context, f: impl FnOnce() -> R) -> R {
    let before = CTX.with(|x| x.replace(Some(c)));
    struct Restore(Option<Context>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let before = self.0.take();
            CTX.with(|x| *x.borrow_mut() = before);
        }
    }
    let _restore = Restore(before);
    f()
}

fn is_note(name: &str) -> bool {
    NOTE.is_match(name)
}

struct State {
    known: Option<Vec<String>>,
    deleted: Map<String, Value>,
}

fn read_state() -> State {
    match std::fs::read_to_string(ctx().state).ok().and_then(|t| parse(&t)) {
        Some(s) => State {
            known: s.get("known").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()),
            deleted: s.get("deleted").and_then(Value::as_object).cloned().unwrap_or_default(),
        },
        None => State { known: None, deleted: Map::new() },
    }
}

fn write_state(known: &[String], deleted: &Map<String, Value>) {
    let _ = std::fs::write(ctx().state, stringify(&json!({ "known": known, "deleted": deleted })));
}

fn at_of(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

fn mtime_ms(file: &std::path::Path) -> Option<f64> {
    let m = std::fs::metadata(file).ok()?.modified().ok()?;
    Some(m.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0)
}

fn tombstones(names: Option<Vec<String>>) -> Map<String, Value> {
    let names = names.unwrap_or_else(|| memory_files().as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default());
    let mut st = read_state();
    let now = now_ms() as f64;
    if let Some(known) = &st.known {
        for n in known {
            if n != INDEX && !names.contains(n) && at_of(st.deleted.get(n)) == 0.0 {
                st.deleted.insert(n.clone(), num(now));
            }
        }
    }
    let dir = ctx().dir;
    for n in &names {
        if n != INDEX && at_of(st.deleted.get(n)) != 0.0 {
            if let Some(m) = mtime_ms(&dir.join(n)) {
                if m > at_of(st.deleted.get(n)) {
                    st.deleted.shift_remove(n);
                }
            }
        }
    }
    st.deleted.retain(|_, at| now - at_of(Some(at)) <= TOMB_MS);
    write_state(&names, &st.deleted);
    st.deleted
}

fn links_of(text: &str) -> HashSet<String> {
    LINK.captures_iter(text).map(|m| m[1].to_string()).collect()
}

fn lines(text: &str) -> Vec<&str> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

pub fn drop_from_index(text: &str, gone: &HashSet<String>) -> Option<String> {
    let all = lines(text);
    let kept: Vec<&str> = all.iter().copied().filter(|line| !links_of(line).iter().any(|l| gone.contains(l))).collect();
    if kept.len() == all.len() { None } else { Some(kept.join("\n")) }
}

pub fn snapshot() -> Value {
    let files = memory_files();
    let names = files.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    json!({ "files": files, "deleted": tombstones(Some(names)) })
}

pub fn memory_files() -> Value {
    let dir = ctx().dir;
    let mut files = Map::new();
    let Ok(entries) = std::fs::read_dir(&dir) else { return Value::Object(files) };
    let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_note(n)).collect();
    names.sort();
    for name in names {
        let file = dir.join(&name);
        if let (Ok(text), Some(mtime)) = (std::fs::read_to_string(&file), mtime_ms(&file)) {
            files.insert(name, json!({ "text": text, "mtime": num(mtime) }));
        }
    }
    Value::Object(files)
}

pub fn merge_index(local: &str, peer: &str, gone: &HashSet<String>) -> Option<String> {
    let have = links_of(local);
    let extra: Vec<&str> = lines(peer)
        .into_iter()
        .filter(|line| {
            let links = links_of(line);
            !links.is_empty() && links.iter().all(|l| !have.contains(l) && !gone.contains(l))
        })
        .collect();
    if extra.is_empty() {
        return None;
    }
    let base = if local.trim().is_empty() { "# Memory Index\n\n".to_string() } else { format!("{}\n", local.trim_end()) };
    Some(base + &extra.join("\n") + "\n")
}

fn project_context(p: &crate::core::config::Project) -> Context {
    let agent = crate::agents::index::agent_for(Some(p));
    let root = p.root.as_ref().map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
    Context { dir: agent.transcripts_dir().join(agent.transcript_folder(&root)).join("memory"), state: DATA_DIR.join(format!("memory-sync-{}.json", p.id)), peer: format!("/api/cluster/memory/{}", p.id) }
}

pub fn project_snapshot(id: &str) -> Option<Value> {
    let p = crate::core::config::project(id)?;
    if p.root.is_none() || p.id == crate::core::config::main_project().id {
        return None;
    }
    Some(with_context(project_context(&p), snapshot))
}

pub fn sync_memory() -> Result<(), String> {
    if !crate::cluster::cluster::cluster_enabled() {
        return Ok(());
    }
    sync_one(main_context())?;
    let main = crate::core::config::main_project().id.clone();
    for p in crate::core::config::projects() {
        if p.id != main && p.root.is_some() {
            sync_one(project_context(&p))?;
        }
    }
    Ok(())
}

fn sync_one(c: Context) -> Result<(), String> {
    with_context(c.clone(), || tombstones(None));
    let Some(peer) = crate::cluster::cluster::peer_get(&c.peer, Some(15000)) else { return Ok(()) };
    if peer.get("files").is_none_or(|f| !crate::core::json::truthy(Some(f))) {
        return Ok(());
    }
    with_context(c, || apply_peer(&peer))
}

fn apply_peer(peer: &Value) -> Result<(), String> {
    tombstones(None);
    let Some(their_files) = peer.get("files").filter(|f| crate::core::json::truthy(Some(f))).and_then(Value::as_object) else { return Ok(()) };
    let dir = ctx().dir;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut local = memory_files().as_object().cloned().unwrap_or_default();
    let mut deleted = tombstones(Some(local.keys().cloned().collect()));
    for (n, at) in peer.get("deleted").and_then(Value::as_object).into_iter().flatten() {
        let at = match at {
            Value::String(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
            other => other.as_f64().unwrap_or(f64::NAN),
        };
        if is_note(n) && n != INDEX && at > at_of(deleted.get(n)) {
            deleted.insert(n.clone(), num(at));
        }
    }
    let mut gone: HashSet<String> = HashSet::new();
    for (n, at) in deleted.clone() {
        let at = at_of(Some(&at));
        if local.get(&n).is_some_and(|f| at_of(f.get("mtime")) <= at) {
            let _ = std::fs::remove_file(dir.join(&n));
            local.shift_remove(&n);
        }
        if !local.contains_key(&n) {
            gone.insert(n);
        }
    }
    let mut merged_deleted = read_state().deleted;
    for (k, v) in &deleted {
        merged_deleted.insert(k.clone(), v.clone());
    }
    write_state(&local.keys().cloned().collect::<Vec<_>>(), &merged_deleted);
    if let Some(index) = local.get(INDEX).cloned() {
        if !gone.is_empty() {
            if let Some(pruned) = drop_from_index(index["text"].as_str().unwrap_or(""), &gone) {
                std::fs::write(dir.join(INDEX), &pruned).map_err(|e| e.to_string())?;
                local.insert(INDEX.into(), json!({ "text": pruned, "mtime": index["mtime"] }));
            }
        }
    }
    for (name, theirs) in their_files {
        let Some(text) = theirs.get("text").and_then(Value::as_str) else { continue };
        if !is_note(name) {
            continue;
        }
        let file = dir.join(name);
        if name == INDEX {
            let mine = local.get(name).and_then(|f| f["text"].as_str()).unwrap_or("");
            if let Some(merged) = merge_index(mine, text, &gone) {
                std::fs::write(&file, merged).map_err(|e| e.to_string())?;
            }
            continue;
        }
        let their_mtime = theirs.get("mtime").and_then(Value::as_f64).unwrap_or(f64::NAN);
        if gone.contains(name) && their_mtime <= at_of(deleted.get(name)) {
            continue;
        }
        if let Some(mine) = local.get(name) {
            if mine["text"].as_str() == Some(text) || at_of(mine.get("mtime")) >= their_mtime {
                continue;
            }
        }
        std::fs::write(&file, text).map_err(|e| e.to_string())?;
        if their_mtime.is_finite() {
            let when = std::time::UNIX_EPOCH + std::time::Duration::from_millis(their_mtime.max(0.0) as u64);
            let f = std::fs::File::options().write(true).open(&file).map_err(|e| e.to_string())?;
            f.set_times(std::fs::FileTimes::new().set_accessed(when).set_modified(when)).map_err(|e| e.to_string())?;
        }
    }
    tombstones(None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn index_merge_skips_lines_for_notes_deleted_on_either_machine() {
        let local = "- [A](a.md) — a\n";
        let peer = "- [A](a.md) — a\n- [B](b.md) — b\n- [C](c.md) — c\n";
        assert_eq!(merge_index(local, peer, &set(&["b.md"])).as_deref(), Some("- [A](a.md) — a\n- [C](c.md) — c\n"));
        assert_eq!(merge_index(local, "- [B](b.md) — b\n", &set(&["b.md"])), None);
    }

    #[test]
    fn deleted_notes_are_dropped_from_the_local_index() {
        assert_eq!(drop_from_index("- [A](a.md)\n- [N](nfl.md)\n", &set(&["nfl.md"])).as_deref(), Some("- [A](a.md)\n"));
        assert_eq!(drop_from_index("- [A](a.md)\n", &set(&["nfl.md"])), None);
    }

    #[test]
    fn a_peer_note_lands_here_and_a_note_deleted_there_goes_here() {
        let _g = crate::testkit::fresh();
        let dir = crate::testkit::sandbox().dir.join("memory-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = Context { dir: dir.clone(), state: DATA_DIR.join("memory-sync-test.json"), peer: String::new() };
        std::fs::write(dir.join("old.md"), "old").unwrap();
        with_context(c.clone(), snapshot);
        let later = now_ms() + 60000;
        let peer = json!({ "files": { "new.md": { "text": "nueva", "mtime": 1000 } }, "deleted": { "old.md": later } });
        with_context(c, || apply_peer(&peer)).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("new.md")).unwrap(), "nueva");
        assert!(!dir.join("old.md").exists());
    }
}

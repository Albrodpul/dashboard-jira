use crate::cluster::peer::peer_get;
use crate::cluster::role::{cluster_field, is_primary, log, st_set};
use crate::core::json::truthy;
use crate::sessions::transcriptmerge::{Merge, merge_transcript};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const RECENT_MS: i64 = 14 * 24 * 3600 * 1000;
const TAIL: u64 = 4096;

pub static PROJECTS: LazyLock<PathBuf> = LazyLock::new(|| crate::agents::index::main().transcripts_dir());

struct TailEntry {
    size: u64,
    mtime: f64,
    hash: String,
}

static TAIL_CACHE: LazyLock<Mutex<HashMap<PathBuf, TailEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static KEPT: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CONVERSATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f-]{36}$").unwrap());
static UUID_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$").unwrap());

pub struct ServedTranscript {
    pub tail: String,
    pub body: Vec<u8>,
}

struct Changed {
    conversation: String,
    name: Option<String>,
    size: u64,
    append: bool,
    body: Vec<u8>,
    file: PathBuf,
}

pub fn recent_since() -> i64 {
    crate::core::time::now_ms() - RECENT_MS
}

fn main_root() -> String {
    crate::core::config::main_project().root.clone().unwrap_or_default().to_string_lossy().to_string()
}

pub fn project_dir() -> PathBuf {
    PROJECTS.join(crate::agents::index::main().transcript_folder(&main_root()))
}

pub fn transcript_path(conversation: &str) -> Option<PathBuf> {
    let own = project_dir().join(format!("{conversation}.jsonl"));
    if own.exists() {
        return Some(own);
    }
    for e in std::fs::read_dir(&*PROJECTS).ok()?.flatten() {
        let f = PROJECTS.join(e.file_name()).join(format!("{conversation}.jsonl"));
        if f.exists() {
            return Some(f);
        }
    }
    None
}

fn read_range(file: &Path, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(file)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; len as usize];
    let mut read = 0;
    while read < buf.len() {
        let n = f.read(&mut buf[read..])?;
        if n == 0 {
            break;
        }
        read += n;
    }
    buf.truncate(read);
    Ok(buf)
}

fn has_text(content: &Value) -> bool {
    content.is_string() || content.as_array().map_or(false, |a| a.iter().any(|c| c.get("type").and_then(Value::as_str) == Some("text")))
}

pub fn last_reply(conversation: &str) -> Option<String> {
    if !CONVERSATION.is_match(conversation) {
        return None;
    }
    let f = transcript_path(conversation)?;
    let size = std::fs::metadata(&f).ok()?.len();
    let len = size.min(4 * 1024 * 1024);
    let buf = read_range(&f, size - len, len).ok()?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let lines: Vec<&str> = text.split('\n').collect();
    let mut parts: Vec<String> = Vec::new();
    for line in lines.iter().rev() {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        if truthy(e.get("isSidechain")) {
            continue;
        }
        let content = e.get("message").and_then(|m| m.get("content"));
        let kind = e.get("type").and_then(Value::as_str);
        if kind == Some("user") && !truthy(e.get("isMeta")) && content.map_or(false, has_text) {
            if !parts.is_empty() {
                break;
            }
            continue;
        }
        if kind == Some("assistant") {
            if let Some(items) = content.and_then(Value::as_array) {
                for c in items.iter().rev() {
                    if c.get("type").and_then(Value::as_str) == Some("text") {
                        let t = c.get("text").and_then(Value::as_str).unwrap_or("").trim();
                        if !t.is_empty() {
                            parts.insert(0, t.to_string());
                        }
                    }
                }
            }
        }
    }
    Some(parts.join("\n\n"))
}

fn project_of_file(f: &Path) -> String {
    let folder = f.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string());
    crate::core::projects::project_of_folder(folder.as_deref()).map(|p| p.id).unwrap_or_else(|| crate::core::config::main_project().id.clone())
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

pub fn transcripts() -> Vec<Value> {
    let mut out: Vec<(String, Value)> = Vec::new();
    let add = |out: &mut Vec<(String, Value)>, conversation: &str, name: Value, f: &Path, hosted: bool| {
        let Ok(meta) = std::fs::metadata(f) else { return };
        let size = meta.len();
        let mtime = mtime_ms(&meta);
        let tail = if size > 0 { cached_tail_hash(f, size, mtime) } else { String::new() };
        let entry = json!({ "conversation": conversation, "name": name, "size": size, "mtime": crate::core::json::num(mtime), "tail": tail, "project": project_of_file(f), "hosted": hosted });
        match out.iter_mut().find(|(c, _)| c == conversation) {
            Some(slot) => slot.1 = entry,
            None => out.push((conversation.to_string(), entry)),
        }
    };
    for e in crate::sessions::host::read_config() {
        let Some(conversation) = e.get("conversation").and_then(Value::as_str) else { continue };
        if let Some(f) = transcript_path(conversation) {
            add(&mut out, conversation, e.get("name").cloned().unwrap_or(Value::Null), &f, true);
        }
    }
    let since = (crate::core::time::now_ms() - RECENT_MS) as f64;
    for p in crate::core::config::projects() {
        let Some(root) = &p.root else { continue };
        let dir = PROJECTS.join(crate::agents::index::main().transcript_folder(&root.to_string_lossy()));
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for n in entries.flatten() {
            let name = n.file_name().to_string_lossy().to_string();
            let Some(m) = UUID_FILE.captures(&name) else { continue };
            let conversation = m[1].to_string();
            if out.iter().any(|(c, _)| *c == conversation) {
                continue;
            }
            let f = dir.join(&name);
            if std::fs::metadata(&f).map(|meta| mtime_ms(&meta) >= since).unwrap_or(false) {
                add(&mut out, &conversation, Value::Null, &f, false);
            }
        }
    }
    out.into_iter().map(|(_, v)| v).collect()
}

fn cached_tail_hash(file: &Path, size: u64, mtime: f64) -> String {
    if let Some(hit) = TAIL_CACHE.lock().unwrap().get(file) {
        if hit.size == size && hit.mtime == mtime {
            return hit.hash.clone();
        }
    }
    let hash = tail_hash(file, size);
    TAIL_CACHE.lock().unwrap().insert(file.to_path_buf(), TailEntry { size, mtime, hash: hash.clone() });
    hash
}

fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    Sha1::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn tail_hash(file: &Path, end: u64) -> String {
    let start = end.saturating_sub(TAIL);
    let mut buf = read_range(file, start, end - start).unwrap_or_default();
    buf.resize((end - start) as usize, 0);
    sha1_hex(&buf)
}

pub fn serve_transcript(conversation: &str, from: u64) -> Option<ServedTranscript> {
    if !CONVERSATION.is_match(conversation) {
        return None;
    }
    let f = transcript_path(conversation)?;
    let size = std::fs::metadata(&f).ok()?.len();
    let at = if from > 0 && from <= size { from } else { 0 };
    let mut body = read_range(&f, at, size - at).ok()?;
    body.resize((size - at) as usize, 0);
    Some(ServedTranscript { tail: if at > 0 { tail_hash(&f, at) } else { String::new() }, body })
}

fn local_folder_for(t: &Value) -> Option<PathBuf> {
    let id = t.get("project").filter(|v| truthy(Some(v))).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| crate::core::config::main_project().id.clone());
    let p = crate::core::config::project(&id)?;
    let root = p.root.as_ref()?;
    Some(PROJECTS.join(crate::agents::index::main().transcript_folder(&root.to_string_lossy())))
}

fn pull_transcripts(only_newer_than: Option<i64>, skip: &HashSet<String>) -> (Vec<Changed>, Vec<Option<String>>) {
    let Some(Value::Array(list)) = peer_get("/api/cluster/transcripts", Some(15000)) else { return (Vec::new(), vec![Some("la lista".to_string())]) };
    let peer = cluster_field("peer").unwrap_or_default();
    let mut changed = Vec::new();
    let mut failed: Vec<Option<String>> = Vec::new();
    for t in &list {
        let conversation = t.get("conversation").and_then(Value::as_str).unwrap_or("").to_string();
        let name = t.get("name").and_then(Value::as_str).map(str::to_string);
        let t_size = t.get("size").and_then(Value::as_f64).unwrap_or(0.0);
        if let Some(limit) = only_newer_than.filter(|l| *l != 0) {
            if t.get("mtime").and_then(Value::as_f64).unwrap_or(0.0) < limit as f64 {
                continue;
            }
        }
        if skip.contains(&conversation) {
            continue;
        }
        let Some(folder) = local_folder_for(t) else { continue };
        let local = transcript_path(&conversation);
        let size: f64 = local.as_ref().and_then(|l| std::fs::metadata(l).ok()).map(|m| m.len() as f64).unwrap_or(-1.0);
        if size == t_size || KEPT.lock().unwrap().get(&conversation).map(|k| *k as f64) == Some(t_size) {
            continue;
        }
        let tail = t.get("tail").and_then(Value::as_str).unwrap_or("");
        if let Some(l) = &local {
            if size > t_size && !tail.is_empty() && t_size > 0.0 && tail_hash(l, t_size as u64) == tail {
                continue;
            }
        }
        let get = |from: u64| crate::jira::client::http("GET", &format!("{peer}/api/cluster/transcript/{conversation}?from={from}"), &[], None, Some(15 * 60000));
        let file = local.clone().unwrap_or_else(|| folder.join(format!("{conversation}.jsonl")));
        let attempt = || -> Result<Option<(bool, Vec<u8>)>, String> {
            let mut r = if size > 0.0 && size < t_size { Some(get(size as u64)?) } else { None };
            let append = match (&r, &local) {
                (Some(resp), Some(l)) => resp.ok() && resp.header("x-tail-hash") == Some(tail_hash(l, size as u64).as_str()),
                _ => false,
            };
            if !append {
                r = Some(get(0)?);
            }
            let resp = r.unwrap();
            if !resp.ok() {
                return Ok(None);
            }
            Ok(Some((append, resp.body)))
        };
        match attempt() {
            Ok(Some((append, body))) => changed.push(Changed { conversation: conversation.clone(), name: name.clone(), size: t_size as u64, append, body, file }),
            Ok(None) => {
                failed.push(name.clone());
                continue;
            }
            Err(_) => failed.push(name.clone()),
        }
        if t.get("hosted") != Some(&Value::Bool(false)) {
            if let Some(n) = name.as_deref().filter(|n| !n.is_empty()) {
                crate::sessions::host::adopt(&conversation, n);
            }
        }
    }
    if !failed.is_empty() {
        log(&format!("no se pudieron traer: {}", failed.iter().map(|x| x.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "sin nombre".to_string())).collect::<Vec<_>>().join(", ")));
    }
    (changed, failed)
}

fn write_transcripts(changed: &[Changed]) {
    for c in changed {
        if let Some(dir) = c.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if c.append {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&c.file) {
                let _ = f.write_all(&c.body);
            }
            continue;
        }
        let mut body = c.body.clone();
        if c.file.exists() {
            let local = std::fs::read(&c.file).unwrap_or_default();
            match merge_transcript(&local, &c.body) {
                Merge::Keep => {
                    KEPT.lock().unwrap().insert(c.conversation.clone(), c.size);
                    continue;
                }
                Merge::Merge { body: merged, local_only, peer_only } => {
                    body = merged;
                    log(&format!("{}: siguió en los dos ordenadores; junto {local_only} líneas de aquí y {peer_only} del otro", c.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| c.conversation.clone())));
                }
                Merge::Take => {}
            }
            let _ = std::fs::copy(&c.file, format!("{}.prev", c.file.display()));
        }
        let sync = PathBuf::from(format!("{}.sync", c.file.display()));
        if std::fs::write(&sync, &body).is_ok() {
            let _ = std::fs::rename(&sync, &c.file);
        }
    }
}

pub fn running_conversations() -> HashSet<String> {
    let list = crate::sessions::host::host_request("GET", "/sessions", None).unwrap_or(Value::Array(Vec::new()));
    list.as_array().cloned().unwrap_or_default().iter().filter(|x| truthy(x.get("running"))).filter_map(|x| x.get("conversation").and_then(Value::as_str).map(str::to_string)).collect()
}

pub fn refresh_from_peer(only_newer_than: Option<i64>, skip_running: bool) -> i64 {
    let mut skip = if skip_running { running_conversations() } else { HashSet::new() };
    let hosted: HashSet<String> = crate::sessions::host::read_config().iter().filter_map(|e| e.get("conversation").and_then(Value::as_str).map(str::to_string)).collect();
    for s in crate::sessions::registry::live_sessions().unwrap_or_default() {
        if let Some(c) = s.get("conversation").and_then(Value::as_str) {
            if !hosted.contains(c) {
                skip.insert(c.to_string());
            }
        }
    }
    let (changed, failed) = pull_transcripts(only_newer_than, &skip);
    st_set("lastTranscripts", json!(crate::core::time::now()));
    if changed.is_empty() {
        return if failed.is_empty() { 0 } else { -1 };
    }
    let running = running_conversations();
    let restart: Vec<&Changed> = if is_primary() { changed.iter().filter(|c| running.contains(&c.conversation)).collect() } else { Vec::new() };
    for c in &restart {
        let _ = crate::sessions::host::host_request("POST", "/stop", Some(&json!({ "conversation": c.conversation })));
    }
    write_transcripts(&changed);
    for c in &restart {
        let _ = crate::sessions::host::host_request("POST", "/start", Some(&json!({ "conversation": c.conversation, "name": c.name })));
    }
    let peer = cluster_field("peer").unwrap_or_default();
    let resumed = if restart.is_empty() { String::new() } else { format!(", {} retomadas", restart.len()) };
    log(&format!("{} conversaciones traídas de {peer}{resumed}", changed.len()));
    if failed.is_empty() { changed.len() as i64 } else { -1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONV: &str = "0a1b2c3d-0000-4000-8000-000000000001";

    fn user(text: &str) -> Value {
        json!({ "type": "user", "message": { "content": text } })
    }

    fn assistant(texts: &[Value]) -> Value {
        json!({ "type": "assistant", "message": { "content": texts.iter().map(|t| if t.is_string() { json!({ "type": "text", "text": t }) } else { t.clone() }).collect::<Vec<_>>() } })
    }

    fn write_transcript(conv: &str, entries: &[Value]) {
        let dir = project_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let text: Vec<String> = entries.iter().map(|e| crate::core::json::stringify(e)).collect();
        std::fs::write(dir.join(format!("{conv}.jsonl")), text.join("\n") + "\n").unwrap();
    }

    #[test]
    fn transcripts_reading_and_serving() {
        let sb = crate::testkit::sandbox();
        assert!(project_dir().starts_with(sb.home.join(".claude").join("projects")));
        write_transcript(
            CONV,
            &[
                user("first question"),
                assistant(&[json!("old answer")]),
                user("second question"),
                assistant(&[json!("Looking."), json!({ "type": "tool_use", "name": "Bash", "input": {} })]),
                json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "content": "out" }] } }),
                json!({ "type": "user", "isMeta": true, "message": { "content": "meta text" } }),
                json!({ "type": "assistant", "isSidechain": true, "message": { "content": [{ "type": "text", "text": "subagent noise" }] } }),
                assistant(&[json!("  "), json!("Done: all good.")]),
                json!("not json at all"),
            ],
        );
        assert_eq!(last_reply(CONV).as_deref(), Some("Looking.\n\nDone: all good."));
        assert_eq!(last_reply("../../etc/passwd"), None);
        assert_eq!(last_reply("0a1b2c3d-0000-4000-8000-00000000ffff"), None);

        let other = "0a1b2c3d-0000-4000-8000-000000000002";
        let dir = sb.home.join(".claude").join("projects").join("elsewhere");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{other}.jsonl")), [user("q"), assistant(&[json!("from elsewhere")])].iter().map(crate::core::json::stringify).collect::<Vec<_>>().join("\n")).unwrap();
        assert_eq!(last_reply(other).as_deref(), Some("from elsewhere"));

        let whole = std::fs::read(project_dir().join(format!("{CONV}.jsonl"))).unwrap();
        let full = serve_transcript(CONV, 0).unwrap();
        assert_eq!(full.tail, "");
        assert_eq!(full.body, whole);
        let part = serve_transcript(CONV, 10).unwrap();
        assert_eq!(part.body, whole[10..].to_vec());
        assert_eq!(part.tail, sha1_hex(&whole[..10]));
        assert_eq!(serve_transcript(CONV, whole.len() as u64 + 5).unwrap().body, whole);
        assert!(serve_transcript("nope", 0).is_none());
    }
}

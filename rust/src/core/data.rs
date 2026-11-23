//! Port of src/core/data.js: one JSON document per key in the `documents` table of board.db.
use crate::core::json::{parse, stringify};
use crate::core::records::{STAMPS_KEY, stamp_records};
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{LazyLock, Once};

pub type Doc = Map<String, Value>;

pub static WORKSPACE: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::workspace());
pub static DATA_DIR: LazyLock<PathBuf> = LazyLock::new(|| std::env::var("TOWER_DATA").map(PathBuf::from).unwrap_or_else(|_| crate::core::migrate::migrate_data_dir(&WORKSPACE)));
pub static DB_FILE: LazyLock<PathBuf> = LazyLock::new(|| std::env::var("TOWER_DB").map(PathBuf::from).unwrap_or_else(|_| DATA_DIR.join("board.db")));
pub static REPORTER_HEARTBEAT: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("heartbeat-reporter"));
pub static BOARD_HEARTBEAT: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("heartbeat-board"));
pub static ROUTES_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("sessions.json"));
pub static SESSIONS_CLI: LazyLock<PathBuf> = LazyLock::new(|| WORKSPACE.join("sessions.js"));
pub static SEEN_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("jira-seen.json"));
pub static TO_COUNT_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("jira-to-count.json"));
pub static PORT: LazyLock<u16> = LazyLock::new(|| ["TOWER_PORT", "TABLERO_PORT"].iter().find_map(|n| std::env::var(n).ok()?.parse().ok()).unwrap_or(4747));
pub static BASE_URL: LazyLock<String> = LazyLock::new(|| format!("http://127.0.0.1:{}", *PORT));

pub const STATUSES: [&str; 7] = ["pending", "approved", "sent", "waiting", "partial", "done", "ignored"];
pub const IN_SESSION: [&str; 4] = ["sent", "waiting", "partial", "done"];
pub const HUMAN_APPROVALS: [&str; 4] = ["board", "chat", "rule", "yolo"];

pub fn is_uuid(s: &str) -> bool {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$").unwrap());
    RE.is_match(s)
}

pub fn is_empty_report(text: &str) -> bool {
    static LINE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?m)^\s*[-*] \d{1,2}:\d{2} · ").unwrap());
    text.split('\n').next().unwrap_or("").to_lowercase().contains("sin novedades") && !LINE.is_match(text)
}

pub fn now() -> String {
    crate::core::time::now()
}

pub fn pause(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

fn defaults() -> [(&'static str, Value); 14] {
    [
        ("tasks", json!({})),
        ("aliases", json!({})),
        ("sessions", json!({ "list": [], "syncedAt": null })),
        ("seenEpics", json!({})),
        ("reports", json!([])),
        ("refreshRequest", Value::Null),
        ("jiraEpics", json!([])),
        ("deployments", json!([])),
        ("followUps", json!([])),
        ("messages", json!([])),
        ("restrictions", json!([])),
        ("deliveries", json!([])),
        ("reminders", json!([])),
        ("github", json!({ "events": [], "names": {} })),
    ]
}

thread_local! {
    static CONN: std::cell::RefCell<Option<Rc<Connection>>> = const { std::cell::RefCell::new(None) };
}
static MIGRATED: Once = Once::new();

fn migrate_table(conn: &Connection) -> rusqlite::Result<()> {
    let legacy: Option<String> = conn.query_row("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'datos'", [], |r| r.get(0)).ok();
    if legacy.is_none() {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let r = (|| {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)")?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))?;
        if n == 0 {
            conn.execute_batch("INSERT INTO documents (key, value) SELECT clave, valor FROM datos")?;
        }
        conn.execute_batch("DROP TABLE datos")
    })();
    conn.execute_batch(if r.is_ok() { "COMMIT" } else { "ROLLBACK" })?;
    r
}

fn open() -> Connection {
    let conn = Connection::open(&*DB_FILE).unwrap_or_else(|e| panic!("no puedo abrir {}: {e}", DB_FILE.display()));
    conn.busy_timeout(std::time::Duration::from_millis(8000)).ok();
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    migrate_table(&conn).expect("migrar la tabla datos");
    conn.execute_batch("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)").expect("tabla documents");
    crate::core::migrate::migrate_learning_table(&conn);
    conn
}

/// Runs `f` with this thread's connection (opened on first use; the document is migrated once per process).
/// SQLite serialises writers across threads and processes through `BEGIN IMMEDIATE` and the busy timeout.
pub fn with_db<R>(f: impl FnOnce(&Connection) -> R) -> R {
    let conn = CONN.with(|c| c.borrow_mut().get_or_insert_with(|| Rc::new(open())).clone());
    MIGRATED.call_once(|| mutate_on(&conn, |d| crate::core::migrate::migrate_document(d), false));
    f(&conn)
}

fn read_raw(conn: &Connection) -> HashMap<String, String> {
    let mut stmt = conn.prepare_cached("SELECT key, value FROM documents").expect("leer documents");
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).expect("leer documents").filter_map(Result::ok).collect()
}

fn read_ordered(conn: &Connection) -> (Doc, HashMap<String, String>) {
    let mut stmt = conn.prepare_cached("SELECT key, value FROM documents").expect("leer documents");
    let rows: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).expect("leer documents").filter_map(Result::ok).collect();
    let mut d = Doc::new();
    let mut raw = HashMap::new();
    for (k, v) in rows {
        d.insert(k.clone(), parse(&v).unwrap_or(Value::Null));
        raw.insert(k, v);
    }
    for (k, fallback) in defaults() {
        if d.get(k).map_or(true, |v| v.is_null()) {
            d.insert(k.to_string(), fallback);
        }
    }
    (d, raw)
}

/// Whole document, with defaults, like `load()`.
pub fn load() -> Doc {
    with_db(|c| read_ordered(c).0)
}

/// One key, like `readKey(key)`; None when missing.
pub fn read_key(key: &str) -> Option<Value> {
    with_db(|c| c.query_row("SELECT value FROM documents WHERE key = ?", [key], |r| r.get::<_, String>(0)).ok().and_then(|t| parse(&t)))
}

fn stamp_tasks(before: &Value, after: &mut Value) {
    let Some(after) = after.as_object_mut() else { return };
    let at = now();
    let bare = |t: &Value| {
        let mut t = t.clone();
        if let Some(o) = t.as_object_mut() {
            o.insert("updatedAt".into(), Value::Null);
        }
        stringify(&t)
    };
    for (k, t) in after.iter_mut() {
        if !t.is_object() {
            continue;
        }
        let changed = match before.get(k) {
            Some(b) if crate::core::json::truthy(Some(b)) => bare(b) != bare(t),
            _ => true,
        };
        if changed {
            t.as_object_mut().unwrap().insert("updatedAt".into(), Value::from(at.clone()));
        }
    }
}

fn mutate_on<R>(conn: &Connection, f: impl FnOnce(&mut Doc) -> R, keep_stamps: bool) -> R {
    conn.execute_batch("BEGIN IMMEDIATE").expect("BEGIN IMMEDIATE");
    let (mut d, raw) = read_ordered(conn);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mut d)));
    let result = match result {
        Ok(r) => r,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            std::panic::resume_unwind(e);
        }
    };
    if !keep_stamps {
        if let Some(tasks) = d.get("tasks") {
            if raw.get("tasks").map(String::as_str) != Some(stringify(tasks).as_str()) {
                let before = raw.get("tasks").and_then(|t| parse(t)).unwrap_or(json!({}));
                let mut t = d.remove("tasks").unwrap();
                stamp_tasks(&before, &mut t);
                d.insert("tasks".into(), t);
            }
        }
    }
    let mut texts: HashMap<String, String> = d.iter().map(|(k, v)| (k.clone(), stringify(v))).collect();
    if !keep_stamps && stamp_records(&raw, &mut d, Some(&texts), &now()) {
        texts.insert(STAMPS_KEY.into(), stringify(&d[STAMPS_KEY]));
    }
    let write = (|| -> rusqlite::Result<()> {
        let mut put = conn.prepare_cached("INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?;
        for (k, text) in &texts {
            if raw.get(k) != Some(text) {
                put.execute(params![k, text])?;
            }
        }
        let mut remove = conn.prepare_cached("DELETE FROM documents WHERE key = ?")?;
        for k in raw.keys() {
            if !d.contains_key(k) {
                remove.execute([k])?;
            }
        }
        Ok(())
    })();
    match write {
        Ok(()) => {
            conn.execute_batch("COMMIT").expect("COMMIT");
            result
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            panic!("no se pudo guardar: {e}");
        }
    }
}

/// Read-modify-write of the whole document in one transaction, like `mutate(fn)`.
/// Removing a key from the map deletes it, like setting it to `undefined` in JS.
pub fn mutate<R>(f: impl FnOnce(&mut Doc) -> R) -> R {
    with_db(|c| mutate_on(c, f, false))
}

/// `mutate(fn, { keepStamps: true })`.
pub fn mutate_keep_stamps<R>(f: impl FnOnce(&mut Doc) -> R) -> R {
    with_db(|c| mutate_on(c, f, true))
}

/// Raw texts of every key, for code that compares stored JSON.
pub fn raw_texts() -> HashMap<String, String> {
    with_db(read_raw)
}

pub fn read_json(file: &std::path::Path, fallback: Value) -> Value {
    std::fs::read_to_string(file).ok().and_then(|t| parse(&t)).unwrap_or(fallback)
}

pub fn write_json_pretty(file: &std::path::Path, v: &Value, indent: usize) -> std::io::Result<()> {
    std::fs::write(file, crate::core::json::stringify_pretty(v, indent))
}

pub fn mark_counted() -> usize {
    let pending = read_json(&TO_COUNT_FILE, Value::Null);
    let Some(ids) = pending.get("ids").and_then(|v| v.as_array()) else { return 0 };
    let mut seen = read_json(&SEEN_FILE, json!({})).get("ids").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let stamp = now();
    for id in ids.iter().filter_map(|x| x.as_str()) {
        if !seen.get(id).map_or(false, |v| crate::core::json::truthy(Some(v))) {
            seen.insert(id.to_string(), Value::from(stamp.clone()));
        }
    }
    let limit = crate::core::time::now_ms() - 10 * 24 * 3600 * 1000;
    seen.retain(|_, at| at.as_str().and_then(crate::core::time::parse).map_or(true, |t| t >= limit));
    let _ = write_json_pretty(&SEEN_FILE, &json!({ "ids": seen }), 1);
    let _ = std::fs::remove_file(&*TO_COUNT_FILE);
    ids.len()
}

pub fn read_stdin() -> String {
    let mut s = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut s);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutate_saves_only_what_changed_and_stamps_tasks_and_records() {
        let _g = crate::testkit::fresh();
        mutate(|d| {
            d.insert("tasks".into(), json!({ "WEB-1": { "key": "WEB-1", "status": "pending" } }));
            d.insert("deployments".into(), json!([{ "id": "d1", "at": "2026-11-20T10:00:00.000Z" }]));
        });
        let d = load();
        assert!(d["tasks"]["WEB-1"]["updatedAt"].is_string());
        assert!(d["syncStamps"]["deployments"]["d1"].is_string());
        assert_eq!(d["reminders"], json!([]));
        let before = raw_texts();
        mutate(|_| {});
        assert_eq!(raw_texts(), before);
        mutate(|d| {
            d.remove("deployments");
        });
        assert!(read_key("deployments").is_none());
    }

    #[test]
    fn load_inside_mutate_does_not_block() {
        let _g = crate::testkit::fresh();
        let n = mutate(|d| {
            d.insert("reminders".into(), json!([1]));
            load().len()
        });
        assert!(n > 0);
    }
}

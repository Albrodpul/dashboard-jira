const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");
const migrate = require("./migrate");

const WORKSPACE = config.workspace;
const ROOT = config.root;
const DATA_DIR = process.env.TOWER_DATA || migrate.migrateDataDir(WORKSPACE);
const DB_FILE = process.env.TOWER_DB || path.join(DATA_DIR, "board.db");
const ORCHESTRATOR_HEARTBEAT = path.join(DATA_DIR, "heartbeat-orchestrator");
const REPORTER_HEARTBEAT = path.join(DATA_DIR, "heartbeat-reporter");
const BOARD_HEARTBEAT = path.join(DATA_DIR, "heartbeat-board");
const ROUTES_FILE = path.join(DATA_DIR, "sessions.json");
const SESSIONS_CLI = path.join(WORKSPACE, "sessions.js");
const PORT = Number(process.env.TOWER_PORT || process.env.TABLERO_PORT) || 4747;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ENTRY = process.argv[1];
const SEEN_FILE = path.join(DATA_DIR, "jira-seen.json");
const TO_COUNT_FILE = path.join(DATA_DIR, "jira-to-count.json");

const STATUSES = ["pending", "approved", "sent", "waiting", "partial", "done", "ignored"];
const IN_SESSION = ["sent", "waiting", "partial", "done"];
const HUMAN_APPROVALS = ["board", "chat", "rule"];
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const isEmptyReport = (text) => /sin novedades/i.test(String(text || "").split("\n")[0]) && !/^\s*[-*] \d{1,2}:\d{2} · /m.test(String(text || ""));
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const now = () => new Date().toISOString();

const DEFAULTS = {
  tasks: () => ({}),
  aliases: () => ({}),
  sessions: () => ({ list: [], syncedAt: null }),
  seenEpics: () => ({}),
  reports: () => [],
  refreshRequest: () => null,
  jiraEpics: () => [],
  deployments: () => [],
  followUps: () => [],
  messages: () => [],
};

let db = null;

function migrateTable(conn) {
  const legacy = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'datos'").get();
  if (!legacy) return;
  conn.exec("BEGIN IMMEDIATE");
  try {
    conn.exec("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (conn.prepare("SELECT COUNT(*) AS n FROM documents").get().n === 0) conn.exec("INSERT INTO documents (key, value) SELECT clave, valor FROM datos");
    conn.exec("DROP TABLE datos");
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

function database() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA busy_timeout = 8000");
  db.exec("PRAGMA journal_mode = WAL");
  migrateTable(db);
  db.exec("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate.migrateLearningTable(db);
  mutate((d) => {
    migrate.migrateDocument(d);
  });
  return db;
}

function read() {
  const raw = {};
  for (const row of database().prepare("SELECT key, value FROM documents").all()) raw[row.key] = row.value;
  const d = {};
  for (const [k, v] of Object.entries(raw)) d[k] = JSON.parse(v);
  for (const [k, fallback] of Object.entries(DEFAULTS)) if (d[k] == null) d[k] = fallback();
  return { d, raw };
}

function load() {
  return read().d;
}

function mutate(fn) {
  const conn = database();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const { d, raw } = read();
    const result = fn(d);
    const put = conn.prepare("INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [k, v] of Object.entries(d)) {
      if (v === undefined) continue;
      const text = JSON.stringify(v);
      if (text !== raw[k]) put.run(k, text);
    }
    const remove = conn.prepare("DELETE FROM documents WHERE key = ?");
    for (const k of Object.keys(raw)) if (d[k] === undefined) remove.run(k);
    conn.exec("COMMIT");
    return result;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function markCounted() {
  const pending = (readJson(TO_COUNT_FILE, null) || {}).ids;
  if (!pending) return 0;
  const seen = (readJson(SEEN_FILE, {}) || {}).ids || {};
  const stamp = now();
  for (const id of pending) seen[id] = seen[id] || stamp;
  const limit = Date.now() - 10 * 24 * 3600 * 1000;
  for (const [id, at] of Object.entries(seen)) if (new Date(at).getTime() < limit) delete seen[id];
  fs.writeFileSync(SEEN_FILE, JSON.stringify({ ids: seen }, null, 1));
  try {
    fs.unlinkSync(TO_COUNT_FILE);
  } catch (e) {}
  return pending.length;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (e) {
    return "";
  }
}

module.exports = {
  WORKSPACE,
  ROOT,
  DATA_DIR,
  DB_FILE,
  SEEN_FILE,
  TO_COUNT_FILE,
  ORCHESTRATOR_HEARTBEAT,
  REPORTER_HEARTBEAT,
  BOARD_HEARTBEAT,
  ROUTES_FILE,
  SESSIONS_CLI,
  PORT,
  BASE_URL,
  ENTRY,
  STATUSES,
  IN_SESSION,
  HUMAN_APPROVALS,
  UUID,
  isEmptyReport,
  pause,
  now,
  database,
  load,
  mutate,
  readJson,
  markCounted,
  readStdin,
};

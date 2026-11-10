const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("../core/config");
const { mergeTranscript } = require("../sessions/transcriptmerge");
const { now } = require("../core/data");
const { CLUSTER, st, log, isPrimary } = require("./role");
const { peerGet } = require("./peer");

const agent = () => require("../agents").main();
const PROJECTS = agent().transcriptsDir();
const projectDir = () => path.join(PROJECTS, agent().transcriptFolder(config.root));

function transcriptPath(conversation) {
  const own = path.join(projectDir(), `${conversation}.jsonl`);
  if (fs.existsSync(own)) return own;
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const f = path.join(PROJECTS, dir, `${conversation}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch (e) {}
  return null;
}

function lastReply(conversation) {
  if (!/^[0-9a-f-]{36}$/.test(conversation)) return null;
  const f = transcriptPath(conversation);
  if (!f) return null;
  const size = fs.statSync(f).size;
  const fd = fs.openSync(f, "r");
  const len = Math.min(size, 4 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const lines = buf.toString("utf8").split("\n");
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch (x) {
      continue;
    }
    if (e.isSidechain) continue;
    const content = e.message && e.message.content;
    if (e.type === "user" && !e.isMeta && (typeof content === "string" || (Array.isArray(content) && content.some((c) => c.type === "text")))) {
      if (parts.length) break;
      continue;
    }
    if (e.type === "assistant" && Array.isArray(content)) for (const c of [...content].reverse()) if (c.type === "text" && c.text.trim()) parts.unshift(c.text.trim());
  }
  return parts.join("\n\n");
}

const RECENT_MS = 14 * 24 * 3600 * 1000;
const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function projectOfFile(f) {
  const p = require("../core/projects").projectOfFolder(path.basename(path.dirname(f)));
  return p ? p.id : config.mainProject.id;
}

function transcripts() {
  const out = new Map();
  const add = (conversation, name, f, hosted) => {
    const st2 = fs.statSync(f);
    out.set(conversation, { conversation, name, size: st2.size, mtime: st2.mtimeMs, tail: st2.size ? tailHash(f, st2.size) : "", project: projectOfFile(f), hosted });
  };
  for (const e of require("../sessions/host").readConfig()) {
    const f = transcriptPath(e.conversation);
    if (f) add(e.conversation, e.name, f, true);
  }
  const since = Date.now() - RECENT_MS;
  for (const p of config.projects) {
    if (!p.root) continue;
    const dir = path.join(PROJECTS, agent().transcriptFolder(p.root));
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const n of names) {
      const m = UUID_FILE.exec(n);
      if (!m || out.has(m[1])) continue;
      const f = path.join(dir, n);
      try {
        if (fs.statSync(f).mtimeMs >= since) add(m[1], null, f, false);
      } catch (e) {}
    }
  }
  return [...out.values()];
}

const TAIL = 4096;

function tailHash(file, end) {
  const start = Math.max(0, end - TAIL);
  const buf = Buffer.alloc(end - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return require("crypto").createHash("sha1").update(buf).digest("hex");
}

function serveTranscript(conversation, from) {
  if (!/^[0-9a-f-]{36}$/.test(conversation || "")) return null;
  const f = transcriptPath(conversation);
  if (!f) return null;
  const size = fs.statSync(f).size;
  const at = from > 0 && from <= size ? from : 0;
  const body = Buffer.alloc(size - at);
  const fd = fs.openSync(f, "r");
  try {
    fs.readSync(fd, body, 0, body.length, at);
  } finally {
    fs.closeSync(fd);
  }
  return { tail: at ? tailHash(f, at) : "", body };
}

const kept = new Map();

function localFolderFor(t) {
  const p = config.project(t.project || config.mainProject.id);
  if (!p || !p.root) return null;
  return path.join(PROJECTS, agent().transcriptFolder(p.root));
}

async function pullTranscripts(onlyNewerThan, skip = new Set()) {
  const list = await peerGet("/api/cluster/transcripts", 15000);
  if (!Array.isArray(list)) return { changed: [], failed: ["la lista"] };
  const host = require("../sessions/host");
  const changed = [];
  const failed = [];
  for (const t of list) {
    if (onlyNewerThan && t.mtime < onlyNewerThan) continue;
    if (skip.has(t.conversation)) continue;
    const folder = localFolderFor(t);
    if (!folder) continue;
    const local = transcriptPath(t.conversation);
    const size = local ? fs.statSync(local).size : -1;
    if (size === t.size || kept.get(t.conversation) === t.size) continue;
    if (local && size > t.size && t.tail && t.size > 0 && tailHash(local, t.size) === t.tail) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15 * 60000);
    try {
      const get = (from) => fetch(`${CLUSTER.peer}/api/cluster/transcript/${t.conversation}?from=${from}`, { signal: ctrl.signal, cache: "no-store" });
      const file = local || path.join(folder, `${t.conversation}.jsonl`);
      let r = size > 0 && size < t.size ? await get(size) : null;
      let append = !!(r && r.ok && r.headers.get("x-tail-hash") === tailHash(local, size));
      if (!append) r = await get(0);
      if (!r.ok) {
        failed.push(t.name);
        continue;
      }
      changed.push({ ...t, append, body: Buffer.from(await r.arrayBuffer()), file });
    } catch (e) {
      failed.push(t.name);
    } finally {
      clearTimeout(timer);
    }
    if (t.hosted !== false && t.name) host.adopt(t.conversation, t.name);
  }
  if (failed.length) log(`no se pudieron traer: ${failed.map((x) => x || "sin nombre").join(", ")}`);
  return { changed, failed };
}

function writeTranscripts(changed) {
  for (const c of changed) {
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    if (c.append) {
      fs.appendFileSync(c.file, c.body);
      continue;
    }
    let body = c.body;
    if (fs.existsSync(c.file)) {
      const m = mergeTranscript(fs.readFileSync(c.file), c.body);
      if (m.action === "keep") {
        kept.set(c.conversation, c.size);
        continue;
      }
      if (m.action === "merge") {
        body = m.body;
        log(`${c.name || c.conversation}: siguió en los dos ordenadores; junto ${m.localOnly} líneas de aquí y ${m.peerOnly} del otro`);
      }
      fs.copyFileSync(c.file, c.file + ".prev");
    }
    fs.writeFileSync(c.file + ".sync", body);
    fs.renameSync(c.file + ".sync", c.file);
  }
}

async function runningConversations() {
  const list = await require("../sessions/host").hostRequest("GET", "/sessions").catch(() => []);
  return new Set((list || []).filter((x) => x.running).map((x) => x.conversation));
}

async function refreshFromPeer(onlyNewerThan, { skipRunning = false } = {}) {
  const skip = skipRunning ? await runningConversations() : new Set();
  const hosted = new Set(require("../sessions/host").readConfig().map((e) => e.conversation));
  for (const s of require("../sessions/registry").liveSessions() || []) if (!hosted.has(s.conversation)) skip.add(s.conversation);
  const { changed, failed } = await pullTranscripts(onlyNewerThan, skip);
  st.lastTranscripts = now();
  if (!changed.length) return failed.length ? -1 : 0;
  const host = require("../sessions/host");
  const running = await runningConversations();
  const restart = isPrimary() ? changed.filter((c) => running.has(c.conversation)) : [];
  for (const c of restart) await host.hostRequest("POST", "/stop", { conversation: c.conversation }).catch(() => {});
  writeTranscripts(changed);
  for (const c of restart) await host.hostRequest("POST", "/start", { conversation: c.conversation, name: c.name }).catch(() => {});
  log(`${changed.length} conversaciones traídas de ${CLUSTER.peer}${restart.length ? `, ${restart.length} retomadas` : ""}`);
  return failed.length ? -1 : changed.length;
}

const recentSince = () => Date.now() - RECENT_MS;

module.exports = { recentSince, projectDir, transcriptPath, lastReply, transcripts, serveTranscript, refreshFromPeer, runningConversations };

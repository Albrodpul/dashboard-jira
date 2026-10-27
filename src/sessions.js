const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const crypto = require("crypto");
const { ROOT, ROUTES_FILE, SESSIONS_CLI, mutate } = require("./data");
const config = require("./config");

const HOME = os.homedir();
const REGISTRY = path.join(HOME, ".claude", "sessions");
const TRANSCRIPTS = path.join(HOME, ".claude", "projects");
const STOP_WORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "a", "en", "the", "of", "and"]);
const STARTUP_NOTICE = "Aviso del arranque: arranca el reporte. Eres la sesión de reporte registrada: ejecuta ahora .claude/commands/resumen-jira.md (regla de AGENTS.md).";
const CLAUDE_VARIABLES = /^(CLAUDE_CODE_|CLAUDECODE|CLAUDE_PID|CLAUDE_ENV_FILE|CLAUDE_AGENT_SDK|CLAUDE_EFFORT|AI_AGENT|ELECTRON_RUN_AS_NODE)/;

const titleKey = (s) =>
  String(s || "")
    .normalize("NFD")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .join("-");

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function transcriptOf(sessionId) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(TRANSCRIPTS);
  } catch (e) {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(TRANSCRIPTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const titleCache = new Map();

function conversationTitle(sessionId) {
  const file = transcriptOf(sessionId);
  if (!file) return null;
  const st = fs.statSync(file);
  const mark = `${st.size}:${st.mtimeMs}`;
  const previous = titleCache.get(sessionId);
  if (previous && previous.mark === mark) return previous.title;
  const length = Math.min(st.size, 512 * 1024);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, length, st.size - length);
  } finally {
    fs.closeSync(fd);
  }
  const found = buf.toString("utf8").match(/"customTitle":"((?:[^"\\]|\\.)*)"/g);
  let title = previous ? previous.title : null;
  if (found) {
    try {
      title = JSON.parse(`{${found[found.length - 1]}}`).customTitle;
    } catch (e) {}
  }
  titleCache.set(sessionId, { mark, title });
  return title;
}

const SUBAGENT_MAX_AGE = 30 * 60000;
const subagentCache = new Map();

function subagentRunning(file, st) {
  const mark = `${st.size}:${st.mtimeMs}`;
  const previous = subagentCache.get(file);
  if (previous && previous.mark === mark) return previous.running;
  const length = Math.min(st.size, 256 * 1024);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, length, st.size - length);
  } finally {
    fs.closeSync(fd);
  }
  let running = true;
  const lines = buf.toString("utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    try {
      running = JSON.parse(lines[i]).message.stop_reason !== "end_turn";
      break;
    } catch (e) {}
  }
  subagentCache.set(file, { mark, running });
  return running;
}

function runningSubagents(sessionId) {
  const transcript = transcriptOf(sessionId);
  if (!transcript) return 0;
  const dir = path.join(path.dirname(transcript), sessionId, "subagents");
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch (e) {
    return 0;
  }
  let n = 0;
  for (const f of files) {
    try {
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < SUBAGENT_MAX_AGE && subagentRunning(file, st)) n++;
    } catch (e) {}
  }
  return n;
}

function liveSessions() {
  let files;
  try {
    files = fs.readdirSync(REGISTRY).filter((f) => /^\d+\.json$/.test(f));
  } catch (e) {
    return null;
  }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(REGISTRY, f), "utf8"));
      if (j.kind !== "interactive" || !j.name || !j.sessionId || !processAlive(j.pid)) continue;
      const subagents = runningSubagents(j.sessionId);
      out.push({
        name: j.name,
        conversation: j.sessionId,
        started: new Date(Number(j.startedAt)).toISOString(),
        status: subagents ? "busy" : j.status || "",
        subagents,
        statusSince: j.statusUpdatedAt ? new Date(Number(j.statusUpdatedAt)).toISOString() : null,
        title: conversationTitle(j.sessionId),
      });
    } catch (e) {}
  }
  return out;
}

function assignRefs(list) {
  const live = liveSessions();
  if (!live) return 0;
  const groups = {};
  for (const v of live) (groups[v.name] = groups[v.name] || []).push(v);
  const refs = {};
  const time = (x) => new Date(x.started).getTime();
  for (const [name, group] of Object.entries(groups)) {
    const rows = list.filter((s) => s.name === name && s.ref && s.started);
    if (rows.length !== group.length) continue;
    group.sort((x, y) => time(x) - time(y));
    rows.sort((x, y) => time(x) - time(y));
    if (rows.some((r, i) => i > 0 && time(r) === time(rows[i - 1]))) continue;
    group.forEach((v, i) => {
      refs[v.conversation] = { ref: rows[i].ref, started: v.started };
    });
  }
  mutate((d) => {
    d.refs = Object.assign(d.refs || {}, refs);
  });
  return Object.keys(refs).length;
}

function writeRoutes(r) {
  const tmp = `${ROUTES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
  fs.renameSync(tmp, ROUTES_FILE);
}

function loadRoutes() {
  try {
    const r = JSON.parse(fs.readFileSync(ROUTES_FILE, "utf8"));
    r.areas = r.areas || {};
    return r;
  } catch (e) {
    return { areas: {} };
  }
}

function changeRoutes(fn) {
  const r = loadRoutes();
  const out = fn(r);
  writeRoutes(r);
  return out;
}

function renameArea(id, title) {
  return changeRoutes((r) => {
    if (!r.areas[id]) return false;
    r.areas[id].title = title;
    return true;
  });
}

function reconcile(live) {
  if (!fs.existsSync(ROUTES_FILE)) return;
  const r = loadRoutes();
  let changed = false;
  const taken = new Set(Object.values(r.areas).map((a) => a.conversation).filter(Boolean));
  for (const role of [r.reporter, r.orchestrator, r.followUp]) if (role && role.conversation) taken.add(role.conversation);
  const single = (l) => (l.length === 1 ? l[0] : null);
  const registeredInThisProcess = (x, v) => x.session === v.name && x.since && new Date(x.since).getTime() >= new Date(v.started).getTime() - 2000;
  const link = (x, v) => {
    if (x.conversation !== v.conversation) {
      x.conversation = v.conversation;
      taken.add(v.conversation);
      changed = true;
    }
    if (x.session !== v.name) {
      Object.assign(x, { session: v.name, ref: null, since: new Date().toISOString() });
      changed = true;
    }
  };
  for (const role of [r.reporter, r.orchestrator]) {
    if (!role) continue;
    const v = live.find((x) => x.conversation === role.conversation) || single(live.filter((x) => !taken.has(x.conversation) && registeredInThisProcess(role, x)));
    if (v) link(role, v);
  }
  for (const a of Object.values(r.areas)) {
    let v = a.conversation ? live.find((x) => x.conversation === a.conversation) : null;
    if (!v && !a.conversation) {
      v =
        single(live.filter((x) => !taken.has(x.conversation) && registeredInThisProcess(a, x))) ||
        single(live.filter((x) => !taken.has(x.conversation) && x.title && titleKey(x.title) === titleKey(a.title)));
    }
    if (v) link(a, v);
  }
  if (changed) writeRoutes(r);
}

function sessionsCli(...args) {
  return cp.execFileSync(process.execPath, [SESSIONS_CLI, ...args], { encoding: "utf8", windowsHide: true });
}

function currentRef(refs, live) {
  const x = live && live.conversation ? refs[live.conversation] : null;
  return x && typeof x === "object" && x.started === live.started ? x.ref : null;
}

function targets(d, r) {
  const open = d.sessions.list || [];
  const refs = d.refs || {};
  const count = {};
  for (const s of open) count[s.name] = (count[s.name] || 0) + 1;
  const byConversation = new Map(open.filter((s) => s.conversation).map((s) => [s.conversation, s]));
  const openNames = new Set(open.map((s) => s.name));
  const roles = [r.reporter, r.orchestrator, r.followUp].filter(Boolean);
  const out = [];
  const usedConversations = new Set();
  const usedNames = new Set();
  for (const [id, a] of Object.entries(r.areas)) {
    if (a.conversation) usedConversations.add(a.conversation);
    else if (a.session) usedNames.add(a.session);
    out.push({
      id,
      name: a.title || id,
      sessionName: a.session || null,
      conversation: a.conversation || null,
      ref: currentRef(refs, byConversation.get(a.conversation)),
      open: a.conversation ? byConversation.has(a.conversation) : !!a.session && openNames.has(a.session),
      repeatedName: !!a.session && count[a.session] > 1,
      epics: a.epics || {},
    });
  }
  for (const s of open) {
    const isRole = roles.some((x) => (x.conversation ? s.conversation === x.conversation : !!x.session && s.name === x.session));
    if (isRole || (s.conversation ? usedConversations.has(s.conversation) : usedNames.has(s.name))) continue;
    out.push({
      id: "conv:" + (s.conversation || s.name),
      name: "",
      sessionName: s.name,
      conversation: s.conversation || null,
      ref: currentRef(refs, s),
      open: true,
      repeatedName: count[s.name] > 1,
      epics: {},
      unnamed: true,
      vsCodeTitle: s.title || null,
    });
  }
  return out;
}

const realArea = (id) => (/^(conv|sesion|session):/.test(String(id)) ? null : id);

function envWithoutVsCode() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!CLAUDE_VARIABLES.test(k)) env[k] = v;
  return env;
}

function openInVsCode(conversation) {
  const url = conversation ? `vscode://anthropic.claude-code/open?session=${conversation}` : "vscode://anthropic.claude-code/open";
  const env = envWithoutVsCode();
  const launch = () => cp.spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
  try {
    cp.spawn("cmd", ["/c", "code", ROOT], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
    setTimeout(launch, 2500);
  } catch (e) {
    launch();
  }
}

function claudeBinary() {
  const folder = path.join(HOME, ".vscode", "extensions");
  let dirs = [];
  try {
    dirs = fs.readdirSync(folder).filter((d) => d.startsWith("anthropic.claude-code-"));
  } catch (e) {
    return null;
  }
  const version = (d) => (d.match(/\d+/g) || []).slice(0, 3).map(Number);
  dirs.sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
  for (const d of dirs) {
    const exe = path.join(folder, d, "resources", "native-binary", "claude.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function createConversation(name) {
  return new Promise((resolve) => {
    const exe = claudeBinary();
    if (!exe) return resolve(null);
    const id = crypto.randomUUID();
    const env = cleanEnv();
    env.CLAUDE_CODE_ENTRYPOINT = "claude-vscode";
    const args = ["-p", "--session-id", id, "--name", name, "--model", config.sessionModel, `Sesión «${name}» creada desde el tablero de Jira. Responde solo «ok».`];
    const child = cp.execFile(exe, args, { cwd: ROOT, env, timeout: 90000, windowsHide: true }, (err) => resolve(!err && transcriptOf(id) ? id : null));
    if (child.stdin) child.stdin.end();
  });
}

function wakeSession(name, notice) {
  return new Promise((resolve) => {
    const exe = claudeBinary();
    if (!exe) return resolve(false);
    const prompt = `Usa la herramienta SendMessage (cárgala con ToolSearch si hace falta) con to «${name}» y message exactamente «${notice || STARTUP_NOTICE}». No hagas nada más y responde solo ok.`;
    const args = ["-p", prompt, "--no-session-persistence", "--model", "claude-haiku-4-5-20251001", "--allowedTools=SendMessage,ListAgents,ToolSearch"];
    const child = cp.execFile(exe, args, { cwd: ROOT, env: cleanEnv(), timeout: 120000, windowsHide: true }, (err, out) => resolve(!err && /ok/i.test(String(out))));
    if (child.stdin) child.stdin.end();
  });
}

module.exports = {
  STARTUP_NOTICE,
  titleKey,
  conversationTitle,
  liveSessions,
  assignRefs,
  loadRoutes,
  changeRoutes,
  renameArea,
  reconcile,
  sessionsCli,
  currentRef,
  targets,
  realArea,
  openInVsCode,
  createConversation,
  wakeSession,
};

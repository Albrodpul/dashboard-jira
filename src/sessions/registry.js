const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const crypto = require("crypto");
const { ROOT, ROUTES_FILE, SESSIONS_CLI, mutate } = require("../core/data");
const config = require("../core/config");

const agent = () => require("../agents").main();
const TRANSCRIPTS = agent().transcriptsDir();
const STOP_WORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "a", "en", "the", "of", "and"]);
const STARTUP_NOTICE = "Aviso del arranque: arranca el reporte. Eres la sesión de reporte registrada: ejecuta ahora .claude/commands/resumen-jira.md (regla de AGENTS.md).";

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

const transcriptPaths = new Map();

function transcriptOf(sessionId) {
  const known = transcriptPaths.get(sessionId);
  if (known && fs.existsSync(known)) return known;
  transcriptPaths.delete(sessionId);
  let dirs = [];
  try {
    dirs = fs.readdirSync(TRANSCRIPTS);
  } catch (e) {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(TRANSCRIPTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) {
      transcriptPaths.set(sessionId, file);
      return file;
    }
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
  // Only the bytes appended since the last read can hold a newer title (with a little overlap for a title split at the edge).
  const from = previous && previous.size <= st.size ? Math.max(0, previous.size - 1024) : 0;
  const length = Math.min(st.size - from, 512 * 1024);
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
  titleCache.set(sessionId, { mark, size: st.size, title });
  return title;
}

const SUBAGENT_MAX_AGE = 30 * 60000;
const SUBAGENT_BACKGROUND_AGE = 3 * 3600000;
const subagentCache = new Map();
let shellCommands = [];
let shellTimer = null;

const keepShells = (list) => list.filter((x) => typeof x === "string" && x.includes("shell-snapshots"));

function refreshShellCommands() {
  if (process.platform !== "win32") {
    cp.execFile("ps", ["-axww", "-o", "command="], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (!err) shellCommands = keepShells(String(out).split("\n"));
    });
    return;
  }
  const script = "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | ForEach-Object { $_.CommandLine } | ConvertTo-Json -Compress";
  cp.execFile("powershell", ["-NoProfile", "-Command", script], { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err) return;
    try {
      const list = JSON.parse(String(out).trim() || "[]");
      shellCommands = keepShells(Array.isArray(list) ? list : [list]);
    } catch (e) {}
  });
}

function watchShells() {
  if (shellTimer) return;
  refreshShellCommands();
  shellTimer = setInterval(refreshShellCommands, 20000);
  shellTimer.unref();
}

function commandMark(command) {
  const parts = String(command || "").split(/['"`]|&&|\|\||[;|<>]/).map((x) => x.trim());
  return parts.sort((a, b) => b.length - a.length)[0] || "";
}

function subagentState(file, st) {
  const mark = `${st.size}:${st.mtimeMs}`;
  const previous = subagentCache.get(file);
  if (previous && previous.mark === mark) return previous;
  let ended = false;
  const background = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"type":"assistant"')) continue;
    try {
      const message = JSON.parse(line).message;
      ended = message.stop_reason === "end_turn";
      for (const c of message.content || []) {
        if (c.type !== "tool_use" || !c.input || !c.input.command) continue;
        if (c.name !== "Monitor" && !c.input.run_in_background) continue;
        const m = commandMark(c.input.command);
        if (m.length >= 12) background.push(m);
      }
    } catch (e) {}
  }
  const state = { mark, ended, background };
  subagentCache.set(file, state);
  return state;
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
      const age = Date.now() - st.mtimeMs;
      if (age > SUBAGENT_BACKGROUND_AGE) continue;
      const s = subagentState(file, st);
      if (!s.ended) {
        if (age < SUBAGENT_MAX_AGE) n++;
        continue;
      }
      if (!s.background.length) continue;
      watchShells();
      if (s.background.some((m) => shellCommands.some((c) => c.includes(m)))) n++;
    } catch (e) {}
  }
  return n;
}

const { projectOfPath } = require("../core/projects");

const liveStatus = (status, subagents) => (subagents ? "busy" : status === "shell" ? "idle" : status || "");

function liveSessions() {
  const entries = agent().liveEntries();
  if (!entries) return null;
  const out = [];
  for (const e of entries) {
    try {
      const project = projectOfPath(e.cwd);
      if (!project || !processAlive(e.pid)) continue;
      const subagents = runningSubagents(e.conversation);
      out.push({
        name: e.name,
        conversation: e.conversation,
        started: new Date(e.startedMs).toISOString(),
        status: liveStatus(e.status, subagents),
        subagents,
        background: e.background,
        project: project.id,
        statusSince: e.statusSinceMs ? new Date(e.statusSinceMs).toISOString() : null,
        title: conversationTitle(e.conversation),
      });
    } catch (x) {}
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
  for (const role of [r.reporter, r.orchestrator, r.followUp, r.board]) if (role && role.conversation) taken.add(role.conversation);
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
  const roles = [r.reporter, r.orchestrator, r.followUp, r.board, ...Object.values(r.projectRoles || {}).flatMap((box) => Object.values(box || {}))].filter(Boolean);
  const { mainId } = require("../core/projects");
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
      project: a.project || mainId(),
      keepOpen: !!a.keepOpen,
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
      project: s.project || mainId(),
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
  for (const [k, v] of Object.entries(process.env)) if (!agent().ENV_VARIABLES.test(k)) env[k] = v;
  const token = sessionToken();
  if (token) env[agent().TOKEN_VARIABLE] = token;
  return env;
}

function sessionToken() {
  try {
    const m = /^[ \t]*CLAUDE_CODE_OAUTH_TOKEN[ \t]*=[ \t]*["']?([^"'\s]+)["']?[ \t]*\r?$/m.exec(require("fs").readFileSync(require("path").join(require("../core/config").workspace, ".env"), "utf8"));
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function openInVsCode(conversation) {
  const host = require("./host");
  if (conversation && host.hostedConversations().includes(conversation)) {
    host.ensureHost().then(() => host.hostRequest("POST", "/start", { conversation }).catch(() => {}));
    return;
  }
  const url = agent().editorUrl(conversation);
  const env = envWithoutVsCode();
  const platform = require("../core/platform");
  const launch = () => platform.openUrl(url, env);
  try {
    platform.openFolderInEditor(ROOT, env);
    setTimeout(launch, 2500);
  } catch (e) {
    launch();
  }
}

function createConversation(name, cwd = ROOT) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const env = cleanEnv();
    env.CLAUDE_CODE_ENTRYPOINT = "claude-vscode";
    const [exe, args] = agent().command(agent().createArgs({ id, name, model: config.sessionModel, prompt: `Sesión «${name}» creada desde el tablero de Jira. Responde solo «ok».` }), agent().editorBinary());
    runBounded(exe, args, { cwd, env }, 90000).then((r) => resolve(r.ok && transcriptOf(id) ? id : null));
  });
}

function wakeSession(name, notice) {
  const prompt = `Usa la herramienta SendMessage (cárgala con ToolSearch si hace falta) con to «${name}» y message exactamente «${notice || STARTUP_NOTICE}». No hagas nada más y responde solo ok.`;
  const [exe, args] = agent().command(agent().wakeArgs(prompt), agent().editorBinary());
  return runBounded(exe, args, { cwd: ROOT, env: cleanEnv() }, 120000).then((r) => r.ok && /ok/i.test(r.out));
}

function runBounded(exe, args, opts, ms) {
  return new Promise((resolve) => {
    const posix = process.platform !== "win32";
    let out = "";
    let settled = false;
    let child = null;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, out });
    };
    const kill = () => {
      if (!child || !child.pid) return;
      try {
        if (posix) process.kill(-child.pid, "SIGKILL");
        else cp.execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
      } catch (e) {
        try {
          child.kill("SIGKILL");
        } catch (e2) {}
      }
    };
    try {
      child = cp.spawn(exe, args, { ...opts, detached: posix, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      return finish(false);
    }
    timer = setTimeout(() => {
      kill();
      finish(false);
    }, ms);
    child.stdout.on("data", (b) => (out += b));
    child.stdout.on("error", () => {});
    child.on("error", () => finish(false));
    child.on("exit", (code) => setTimeout(() => finish(code === 0), 300));
  });
}

module.exports = {
  liveStatus,
  cleanEnv,
  sessionToken,
  STARTUP_NOTICE,
  titleKey,
  conversationTitle,
  transcriptOf,
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
  runBounded,
};

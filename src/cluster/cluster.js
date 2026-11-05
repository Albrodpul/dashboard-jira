const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("../core/config");
const { mergeTranscript } = require("../sessions/transcriptmerge");
const { DATA_DIR, SEEN_FILE, load, mutate, now } = require("../core/data");

const CLUSTER = config.cluster || null;
const STATE_FILE = path.join(DATA_DIR, "cluster.json");
const TAKEOVER_MS = 60000;
const SNAPSHOT_MS = 60000;
const ROLES = [
  ["reporter", "Reporte JIRA"],
  ["orchestrator", "Orquestar agentes"],
  ["followUp", "Seguimiento"],
  ["board", "Tablero"],
];
const ROUTE_ROLES = ["reporter", "orchestrator", "followUp", "board"];
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const projectDir = () => path.join(PROJECTS, config.root.replace(/\\/g, "/").replace(/^([A-Z]):/, (m, d) => `${d.toLowerCase()}:`).replace(/[^a-zA-Z0-9]/g, "-"));
const SYNC_KEYS = ["tasks", "aliases", "seenEpics", "reports", "refreshRequest", "jiraEpics", "deployments", "followUps", "messages", "lastReview", "config", "contextTidy", "deleted", "permissionRules", "sentry", "sessionOverrides"];

const STALE_STATE_MS = 5 * 60000;
const elapsed = (iso) => Date.now() - new Date(iso).getTime();
const readState = () => {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {}
  if (!CLUSTER) return s || { role: "primary", since: now() };
  if (!s) return { role: "follower", since: now() };
  if (s.role === "primary" && s.savedAt && elapsed(s.savedAt) > STALE_STATE_MS) return { ...s, role: "follower", since: now(), manual: false, pendingPull: null, wokeStale: true };
  return s;
};
let st = readState();
const save = () => {
  st.savedAt = now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
};
const log = (m) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "cluster.log"), `[${now()}] ${m}\n`);
  } catch (e) {}
};

const isPrimary = () => !CLUSTER || st.role === "primary";
const info = () => ({ label: CLUSTER ? CLUSTER.label || null : null, role: isPrimary() ? "primary" : "follower", since: st.since, manual: !!(isPrimary() && st.manual), lastSnapshot: st.lastSnapshot || null, lastTranscripts: st.lastTranscripts || null, pendingPull: st.pendingPull || null, host: os.hostname(), self: CLUSTER ? CLUSTER.self : null, peer: CLUSTER ? CLUSTER.peer : null, claudeToken: require("../features/claude-token").tokenStatus() });

async function peerGet(route, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(CLUSTER.peer + route, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function peerPost(route, body) {
  try {
    const r = await fetch(CLUSTER.peer + route, { method: "POST", headers: { "content-type": "application/json", origin: CLUSTER.peer }, body: JSON.stringify(body || {}) });
    return r.ok;
  } catch (e) {
    return false;
  }
}

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

function transcripts() {
  const out = [];
  for (const e of require("../sessions/host").readConfig()) {
    const f = transcriptPath(e.conversation);
    if (!f) continue;
    const st2 = fs.statSync(f);
    out.push({ conversation: e.conversation, name: e.name, size: st2.size, mtime: st2.mtimeMs });
  }
  return out;
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

async function pullTranscripts(onlyNewerThan) {
  const list = await peerGet("/api/cluster/transcripts", 15000);
  if (!Array.isArray(list)) return { changed: [], failed: ["la lista"] };
  const host = require("../sessions/host");
  const changed = [];
  const failed = [];
  for (const t of list) {
    if (onlyNewerThan && t.mtime < onlyNewerThan) continue;
    const local = transcriptPath(t.conversation);
    const size = local ? fs.statSync(local).size : -1;
    if (size === t.size || kept.get(t.conversation) === t.size) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15 * 60000);
    try {
      const get = (from) => fetch(`${CLUSTER.peer}/api/cluster/transcript/${t.conversation}?from=${from}`, { signal: ctrl.signal, cache: "no-store" });
      const file = local || path.join(projectDir(), `${t.conversation}.jsonl`);
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
    host.adopt(t.conversation, t.name);
  }
  if (failed.length) log(`no se pudieron traer: ${failed.join(", ")}`);
  return { changed, failed };
}

function writeTranscripts(changed) {
  fs.mkdirSync(projectDir(), { recursive: true });
  for (const c of changed) {
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
        log(`${c.name}: siguió en los dos ordenadores; junto ${m.localOnly} líneas de aquí y ${m.peerOnly} del otro`);
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

async function refreshFromPeer(onlyNewerThan) {
  const { changed, failed } = await pullTranscripts(onlyNewerThan);
  st.lastTranscripts = now();
  if (!changed.length) return failed.length ? -1 : 0;
  const host = require("../sessions/host");
  const running = await runningConversations();
  const restart = changed.filter((c) => running.has(c.conversation));
  for (const c of restart) await host.hostRequest("POST", "/stop", { conversation: c.conversation }).catch(() => {});
  writeTranscripts(changed);
  for (const c of restart) await host.hostRequest("POST", "/start", { conversation: c.conversation, name: c.name }).catch(() => {});
  log(`${changed.length} conversaciones traídas de ${CLUSTER.peer}${restart.length ? `, ${restart.length} retomadas` : ""}`);
  return failed.length ? -1 : changed.length;
}

function snapshot() {
  const d = load();
  const docs = {};
  for (const k of SYNC_KEYS) if (d[k] !== undefined) docs[k] = d[k];
  let seen = null;
  try {
    seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch (e) {}
  const routes = require("../sessions/registry").loadRoutes();
  const areas = {};
  for (const [id, a] of Object.entries(routes.areas || {})) areas[id] = { title: a.title, epics: a.epics || {} };
  for (const [id, a] of Object.entries(routes.areas || {})) if (a.conversation) Object.assign(areas[id], { conversation: a.conversation, session: a.session || null });
  const roles = {};
  for (const role of ROUTE_ROLES) if (routes[role] && routes[role].conversation) roles[role] = { conversation: routes[role].conversation, session: routes[role].session || null, title: routes[role].title || null, since: routes[role].since || null, rotatedOn: routes[role].rotatedOn || null };
  return { at: now(), host: os.hostname(), docs, seen, areas, roles, deployer: routes.deployer || null };
}

function applySnapshot(s) {
  if (!s || !s.docs) return false;
  mutate((d) => {
    for (const k of SYNC_KEYS) if (s.docs[k] !== undefined) d[k] = s.docs[k];
  });
  if (s.seen) fs.writeFileSync(SEEN_FILE, JSON.stringify(s.seen, null, 1));
  require("../sessions/registry").changeRoutes((r) => {
    r.areas = r.areas || {};
    for (const [id, a] of Object.entries(s.areas || {})) {
      const next = { ...(r.areas[id] || {}), title: a.title, epics: a.epics };
      if (a.conversation) Object.assign(next, { conversation: a.conversation, session: a.session || next.session, ref: null });
      r.areas[id] = next;
    }
    for (const [role, v] of Object.entries(s.roles || {})) r[role] = { ...(r[role] || {}), ...v, ref: null };
    if (s.deployer) r.deployer = s.deployer;
    return true;
  });
  st.lastSnapshot = s.at;
  save();
  return true;
}

async function pullSnapshot() {
  const s = await peerGet("/api/cluster/snapshot", 30000);
  if (s && applySnapshot(s)) log(`snapshot de ${s.host} (${s.at})`);
  return !!s;
}

async function startRoles() {
  const sessions = require("../sessions/registry");
  const host = require("../sessions/host");
  await host.ensureHost();
  for (const [role, name] of ROLES) {
    let r = sessions.loadRoutes()[role];
    let conversation = r && r.conversation;
    if (!conversation) {
      conversation = await sessions.createConversation(name);
      if (!conversation) {
        log(`no se pudo crear la sesión ${name}`);
        continue;
      }
      sessions.changeRoutes((x) => {
        x[role] = { ...(x[role] || {}), session: name, title: name, conversation, since: now() };
        return true;
      });
      log(`sesión ${name} creada (${conversation})`);
    }
    await host.hostRequest("POST", "/start", { conversation, name: (r && r.session) || name }).catch(() => {});
  }
  const routes = sessions.loadRoutes();
  for (const id of [require("../server/state").deployerArea(routes), config.errorsArea]) {
    const a = id && (routes.areas || {})[id];
    if (a && a.conversation) await host.hostRequest("POST", "/start", { conversation: a.conversation, name: a.session || a.title || id }).catch(() => {});
  }
}

async function stopRoles() {
  const host = require("../sessions/host");
  const running = await runningConversations();
  for (const e of host.readConfig()) {
    if (running.has(e.conversation)) await host.hostRequest("POST", "/stop", { conversation: e.conversation }).catch(() => {});
    host.markOnDemand(e.conversation);
  }
}

async function promote(reason, manual) {
  st = { ...st, role: "primary", since: now(), manual: !!manual };
  save();
  log(`paso a mandar: ${reason}`);
  if (manual) {
    await peerPost("/api/cluster/yield", { force: true });
    await pullSnapshot();
    await refreshFromPeer();
  }
  require("../server/push")
    .sendPush("sessions", true, `${os.hostname()} pasa a mandar: ${reason}`)
    .catch(() => {});
  await startRoles();
  const board = require("../sessions/registry").loadRoutes().board;
  if (board && board.session) require("../sessions/registry").wakeSession(board.session, "Aviso del tablero: arranca la sesión del tablero. Eres la sesión del tablero registrada: ejecuta ahora .claude/commands/tablero.md (regla de AGENTS.md).").catch(() => {});
  require("../server/startup").launchStartup();
}

async function demote(reason) {
  st = { ...st, role: "follower", since: now(), manual: false };
  save();
  log(`dejo de mandar: ${reason}`);
  await stopRoles();
}



function keepAwake() {
  if (!CLUSTER || process.platform !== "darwin") return;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const min = Number(p.hour) * 60 + Number(p.minute);
  const want = !["Sat", "Sun"].includes(p.weekday) && min >= 7 * 60 + 30 && min < 18 * 60 + 30;
  const hours = require("../core/hours");
  const ot = hours.overtime();
  const day = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
  if (ot && want && day(ot.since) !== day(new Date())) {
    hours.setOvertime(false);
    letSleep();
    log("fuera de horario: se desactiva solo al empezar la jornada");
  }
  const extra = !!hours.overtime();
  if (!want && !extra) return;
  const cp = require("child_process");
  const pidFile = path.join(DATA_DIR, "caffeinate.pid");
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    process.kill(pid, 0);
    if (/caffeinate/.test(cp.execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)]).toString())) return;
  } catch (e) {}
  const seconds = (18 * 60 + 30 - min) * 60;
  const child = cp.spawn("/usr/bin/caffeinate", extra ? ["-i"] : ["-i", "-t", String(seconds)], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  log(extra ? "caffeinate: fuera de horario activado, el Mac no se dormirá hasta que lo termines" : "caffeinate: el Mac no se dormirá solo hasta las 18:30");
}

function letSleep() {
  if (process.platform !== "darwin") return;
  const pidFile = path.join(DATA_DIR, "caffeinate.pid");
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (/caffeinate/.test(require("child_process").execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)]).toString())) process.kill(pid);
    fs.unlinkSync(pidFile);
    log("caffeinate: parado, el Mac ya puede dormirse");
  } catch (e) {}
}

let busy = false;
let lastPull = 0;

async function tick() {
  if (!CLUSTER || busy) return;
  keepAwake();
  busy = true;
  try {
    const peer = await peerGet("/api/cluster");
    if (!peer) {
      st.peerDownSince = st.peerDownSince || now();
      st.noneSince = null;
      if (!isPrimary() && elapsed(st.peerDownSince) > TAKEOVER_MS) {
        st.pendingPull = now();
        await promote("el otro ordenador no responde desde hace un minuto");
      }
      return;
    }
    st.peerDownSince = null;
    if (peer.role === "primary" && isPrimary()) {
      if (tookLater(peer)) {
        st.pendingPull = st.pendingPull || now();
        log("los dos mandaban: sigo yo, que tomé el mando después; el otro cede");
      } else await demote("los dos mandaban y el otro tomó el mando después");
    }
    if (peer.role === "primary" && !isPrimary()) {
      st.noneSince = null;
      if (Date.now() - lastPull > SNAPSHOT_MS) {
        lastPull = Date.now();
        await pullSnapshot();
      }
      if (!peer.pendingPull) await refreshFromPeer();
      return;
    }
    if (!isPrimary()) {
      st.noneSince = st.noneSince || now();
      if ((CLUSTER.label || "") < (peer.label || "") || elapsed(st.noneSince) > TAKEOVER_MS) {
        st.noneSince = null;
        await promote("ninguno mandaba");
      }
      return;
    }
    st.noneSince = null;
    if (st.pendingPull && peer.role !== "primary" && (await refreshFromPeer()) >= 0) {
      log("conversaciones del otro ordenador traídas tras el relevo");
      st.pendingPull = null;
    }
  } finally {
    try {
      save();
    } catch (e) {}
    busy = false;
  }
}

function tookLater(peer) {
  const mine = new Date(st.since).getTime();
  const theirs = new Date(peer.since).getTime();
  return mine !== theirs ? mine > theirs : (CLUSTER.label || "") > (peer.label || "");
}

async function handleYield(input) {
  if (!CLUSTER || !isPrimary() || !(input && input.force)) return;
  await demote("el otro ordenador toma el mando porque lo has pedido");
}

async function takeHere() {
  if (!CLUSTER) return { ok: false, error: "no hay dos ordenadores configurados" };
  if (isPrimary()) {
    st.manual = true;
    save();
    log("sigo mandando, ahora porque lo has pedido");
    return { ok: true };
  }
  promote("lo has pedido desde el tablero", true).catch((e) => log("error al tomar el mando: " + (e.message || e)));
  return { ok: true };
}

function backToAuto() {
  if (!st.manual) return { ok: true };
  st.manual = false;
  save();
  log("vuelvo al automático");
  return { ok: true };
}

async function command(target, action) {
  const self = CLUSTER && CLUSTER.label;
  if (target && target !== self) {
    const ok = await peerPost(action === "auto" ? "/api/cluster/auto" : "/api/cluster/take", {});
    return ok ? { ok: true } : { ok: false, error: `el ${target} no responde` };
  }
  return action === "auto" ? backToAuto() : takeHere();
}

function tailscaleDevices() {
  const exe = process.platform === "darwin" ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : "tailscale";
  return new Promise((resolve) =>
    require("child_process").execFile(exe, ["status", "--json"], { windowsHide: true, timeout: 10000, env: { ...process.env, TERM: process.env.TERM || "xterm-256color" } }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out);
        resolve(
          [j.Self, ...Object.values(j.Peer || {})]
            .filter((d) => d && !/^(android|ios)$/i.test(d.OS || ""))
            .map((d) => ({ name: d.HostName, os: d.OS, online: d === j.Self || !!d.Online, lastSeen: d.LastSeen && !d.LastSeen.startsWith("0001") ? d.LastSeen : null, ip: (d.TailscaleIPs || [])[0] || null, dns: String(d.DNSName || "").replace(/\.$/, ""), self: d === j.Self }))
        );
      } catch (e) {
        resolve(null);
      }
    })
  );
}

const sendClaudeToken = (token) => (CLUSTER ? peerPost("/api/cluster/claude-token", { token }) : Promise.resolve(false));

async function machines() {
  const [devices, peer] = await Promise.all([tailscaleDevices(), CLUSTER ? peerGet("/api/cluster", 5000) : null]);
  return { self: info(), peer, devices };
}

module.exports = { isPrimary, info, peerGet, projectDir, keepAwake, letSleep, snapshot, transcripts, serveTranscript, tick, handleYield, command, takeHere, backToAuto, machines, sendClaudeToken, clusterEnabled: () => !!CLUSTER };

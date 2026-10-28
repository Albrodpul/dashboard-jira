const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("./config");
const { DATA_DIR, SEEN_FILE, load, mutate, now } = require("./data");

const CLUSTER = config.cluster || null;
const STATE_FILE = path.join(DATA_DIR, "cluster.json");
const TAKEOVER_MS = 5 * 60000;
const SNAPSHOT_MS = 60000;
const ROLES = [
  ["reporter", "Reporte JIRA"],
  ["orchestrator", "Orquestar agentes"],
  ["followUp", "Seguimiento"],
  ["board", "Tablero"],
];
const SYNC_KEYS = ["tasks", "aliases", "seenEpics", "reports", "refreshRequest", "jiraEpics", "deployments", "followUps", "messages", "lastReview", "config", "contextTidy", "deleted", "permissionRules", "sentry"];

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return { role: CLUSTER && !CLUSTER.preferred ? "follower" : "primary", since: now() };
  }
};
let st = readState();
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
const log = (m) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "cluster.log"), `[${now()}] ${m}\n`);
  } catch (e) {}
};

const isPrimary = () => !CLUSTER || st.role === "primary";
const info = () => ({ role: isPrimary() ? "primary" : "follower", since: st.since, preferred: !!(CLUSTER && CLUSTER.preferred), host: os.hostname(), self: CLUSTER ? CLUSTER.self : null, peer: CLUSTER ? CLUSTER.peer : null });

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

function snapshot() {
  const d = load();
  const docs = {};
  for (const k of SYNC_KEYS) if (d[k] !== undefined) docs[k] = d[k];
  let seen = null;
  try {
    seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch (e) {}
  const routes = require("./sessions").loadRoutes();
  const areas = {};
  for (const [id, a] of Object.entries(routes.areas || {})) areas[id] = { title: a.title, epics: a.epics || {} };
  return { at: now(), host: os.hostname(), docs, seen, areas, deployer: routes.deployer || null };
}

function applySnapshot(s) {
  if (!s || !s.docs) return false;
  mutate((d) => {
    for (const k of SYNC_KEYS) if (s.docs[k] !== undefined) d[k] = s.docs[k];
  });
  if (s.seen) fs.writeFileSync(SEEN_FILE, JSON.stringify(s.seen, null, 1));
  require("./sessions").changeRoutes((r) => {
    r.areas = r.areas || {};
    for (const [id, a] of Object.entries(s.areas || {})) r.areas[id] = { ...(r.areas[id] || {}), title: a.title, epics: a.epics };
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
  const sessions = require("./sessions");
  const host = require("./host");
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
}

async function stopRoles() {
  const sessions = require("./sessions");
  const host = require("./host");
  const r = sessions.loadRoutes();
  for (const [role] of ROLES) {
    const c = r[role] && r[role].conversation;
    if (!c) continue;
    await host.hostRequest("POST", "/stop", { conversation: c }).catch(() => {});
    host.adopt(c, r[role].session || role);
    host.markOnDemand(c);
  }
}

async function promote(reason) {
  st = { ...st, role: "primary", since: now() };
  save();
  log(`paso a mandar: ${reason}`);
  require("./push")
    .sendPush("sessions", true, `${os.hostname()} pasa a mandar: ${reason}`)
    .catch(() => {});
  await startRoles();
}

async function demote(reason) {
  st = { ...st, role: "follower", since: now() };
  save();
  log(`dejo de mandar: ${reason}`);
  await stopRoles();
}

let busy = false;
let lastPull = 0;

async function tick() {
  if (!CLUSTER || busy) return;
  busy = true;
  try {
    const peer = await peerGet("/api/cluster");
    if (CLUSTER.preferred) {
      if (peer && peer.role === "primary") {
        await pullSnapshot();
        await peerPost("/api/cluster/yield", { from: os.hostname() });
        if (!isPrimary()) await promote("el ordenador preferido vuelve y recupera el mando");
        else log("el otro ordenador mandaba mientras yo no respondía: datos traídos y le pido que ceda");
      } else if (!isPrimary()) await promote("ordenador preferido");
      st.peerDownSince = null;
      save();
      return;
    }
    if (peer) {
      st.peerDownSince = null;
      if (peer.role === "primary") {
        if (isPrimary()) await demote("el otro ordenador manda");
        if (Date.now() - lastPull > SNAPSHOT_MS) {
          lastPull = Date.now();
          await pullSnapshot();
        }
      } else if (!isPrimary()) await promote("ninguno mandaba");
      save();
      return;
    }
    st.peerDownSince = st.peerDownSince || now();
    save();
    if (!isPrimary() && Date.now() - new Date(st.peerDownSince).getTime() > TAKEOVER_MS) await promote("el otro ordenador no responde desde hace 5 minutos");
  } finally {
    busy = false;
  }
}

async function handleYield() {
  if (CLUSTER && !CLUSTER.preferred && isPrimary()) await demote("el ordenador preferido ha vuelto");
}

module.exports = { isPrimary, info, snapshot, tick, handleYield, clusterEnabled: () => !!CLUSTER };

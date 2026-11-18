const os = require("os");
const config = require("../core/config");
const { now } = require("../core/data");
const { CLUSTER, st, save, log, elapsed, isPrimary } = require("./role");
const { peerGet, peerPost } = require("./peer");
const { refreshFromPeer, runningConversations } = require("./transcripts");
const { pullSnapshot, mergePeer } = require("./snapshot");
const { keepAwake, letSleep } = require("./power");

const TAKEOVER_MS = 3 * 60000;
const SLEPT_MS = 2 * 60000;
const RESUME_DELAY_MS = 25000;
const ACTIVE_TASKS = ["sent", "approved"];
let lastTick = 0;
const BACK_PULL_MS = 3 * 60 * 1000;
let lastBackPull = 0;
const SNAPSHOT_MS = 60000;
const ROLES = [
  ["reporter", "Reporte JIRA"],
  ["orchestrator", "Orquestar agentes"],
  ["followUp", "Seguimiento"],
  ["board", "Tablero"],
];

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

async function resumeWork() {
  const host = require("../sessions/host");
  const registry = require("../sessions/registry");
  const routes = registry.loadRoutes();
  const tasks = Object.values(require("../core/data").load().tasks || {});
  const areas = [...new Set(tasks.filter((t) => ACTIVE_TASKS.includes(t.status) && t.area).map((t) => t.area))].map((id) => [id, (routes.areas || {})[id]]).filter(([, a]) => a && a.conversation);
  if (!areas.length) return;
  for (const [id, a] of areas) await host.hostRequest("POST", "/start", { conversation: a.conversation, name: a.session || a.title || id }).catch(() => {});
  log(`relanzo ${areas.length} sesión(es) con tareas en curso: ${areas.map(([id]) => id).join(", ")}`);
  setTimeout(async () => {
    const live = new Map((registry.liveSessions() || []).map((x) => [x.conversation, x]));
    for (const [, a] of areas) {
      const l = live.get(a.conversation);
      if (l && l.status !== "idle") continue;
      await host.hostRequest("POST", "/input", { conversation: a.conversation, data: RESUME_NOTICE }).catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      await host.hostRequest("POST", "/input", { conversation: a.conversation, data: "\r" }).catch(() => {});
    }
  }, RESUME_DELAY_MS).unref();
}

const RESUME_NOTICE = "Tablero: el tablero ha cambiado de ordenador y esta sesión se cortó a medias. Sigue con tus tareas pendientes desde donde lo dejaste; revisa antes el estado del repo por si algo quedó a medio hacer.";

async function promote(reason, manual) {
  Object.assign(st, { role: "primary", since: now(), manual: !!manual });
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
  require("../features/tunnel").guard();
  await startRoles();
  await resumeWork().catch((e) => log(`no pude relanzar las sesiones con tareas en curso: ${e.message}`));
  const board = require("../sessions/registry").loadRoutes().board;
  if (board && board.session) require("../server/startup").noticeBoard(board.session, false).catch(() => {});
  const overtime = !!require("../core/hours").overtime();
  require("../server/startup").launchStartup(false, overtime);
  if (overtime) require("../features/devservers").startAll(true).catch(() => {});
}

async function demote(reason) {
  Object.assign(st, { role: "follower", since: now(), manual: false });
  save();
  log(`dejo de mandar: ${reason}`);
  await stopRoles();
  await require("../features/devservers").stopAll().catch(() => {});
  if (!require("../core/hours").workHours()) letSleep();
}

let busy = false;
let lastPull = 0;

async function tick() {
  if (!CLUSTER || busy) return;
  keepAwake();
  busy = true;
  const slept = lastTick && Date.now() - lastTick > SLEPT_MS;
  lastTick = Date.now();
  try {
    const peer = await peerGet("/api/cluster");
    if (slept && peer && peer.role === "primary" && isPrimary()) {
      await demote("este ordenador ha estado dormido y el otro tomó el mando mientras");
      return;
    }
    if (peer && peer.macPower && process.platform !== "darwin") st.peerMacPower = peer.macPower;
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
      if (keepsCommand(peer)) {
        st.pendingPull = st.pendingPull || now();
        log("los dos mandaban: sigo yo, que mandaba desde antes; el otro cede");
      }
      else await demote("los dos mandaban y el otro mandaba desde antes");
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
    if (peer.role !== "primary" && Date.now() - lastPull > SNAPSHOT_MS) {
      lastPull = Date.now();
      if (mergePeer(await peerGet("/api/cluster/snapshot", 30000))) st.lastFollowerMerge = now();
    }
    if (!st.pendingPull && peer.role !== "primary" && Date.now() - lastBackPull > BACK_PULL_MS) {
      lastBackPull = Date.now();
      await refreshFromPeer(require("./transcripts").recentSince(), { skipRunning: true });
    }
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

function keepsCommand(peer) {
  if (!!st.manual !== !!peer.manual) return !!st.manual;
  const mine = new Date(st.since).getTime();
  const theirs = new Date(peer.since).getTime();
  return mine !== theirs ? mine < theirs : (CLUSTER.label || "") < (peer.label || "");
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

module.exports = { tick, handleYield, command, takeHere, backToAuto, keepsCommand };

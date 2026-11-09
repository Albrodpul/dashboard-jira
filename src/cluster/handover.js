const os = require("os");
const config = require("../core/config");
const { now } = require("../core/data");
const { CLUSTER, st, save, log, elapsed, isPrimary } = require("./role");
const { peerGet, peerPost } = require("./peer");
const { refreshFromPeer, runningConversations } = require("./transcripts");
const { pullSnapshot, mergePeer } = require("./snapshot");
const { keepAwake, letSleep } = require("./power");

const TAKEOVER_MS = 60000;
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
  const board = require("../sessions/registry").loadRoutes().board;
  if (board && board.session) require("../sessions/registry").wakeSession(board.session, "Aviso del tablero: arranca la sesión del tablero. Eres la sesión del tablero registrada: ejecuta ahora .claude/commands/tablero.md (regla de AGENTS.md).").catch(() => {});
  const overtime = !!require("../core/hours").overtime();
  require("../server/startup").launchStartup(false, overtime);
  if (overtime) require("../features/devservers").startAll(true).catch(() => {});
}

async function demote(reason) {
  Object.assign(st, { role: "follower", since: now(), manual: false });
  save();
  log(`dejo de mandar: ${reason}`);
  await stopRoles();
  const hours = require("../core/hours");
  if (!hours.workHours()) {
    letSleep();
    await require("../features/devservers").stopAll().catch(() => {});
  }
}

let busy = false;
let lastPull = 0;

async function tick() {
  if (!CLUSTER || busy) return;
  keepAwake();
  busy = true;
  try {
    const peer = await peerGet("/api/cluster");
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
    if (peer.role !== "primary" && Date.now() - lastPull > SNAPSHOT_MS) {
      lastPull = Date.now();
      if (mergePeer(await peerGet("/api/cluster/snapshot", 30000))) st.lastFollowerMerge = now();
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

module.exports = { tick, handleYield, command, takeHere, backToAuto };

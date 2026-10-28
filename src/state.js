const fs = require("fs");
const path = require("path");
const http = require("http");
const { ROOT, ORCHESTRATOR_HEARTBEAT, REPORTER_HEARTBEAT, BOARD_HEARTBEAT, BASE_URL, UUID, isEmptyReport, load } = require("./data");
const { readQuota } = require("./quota");
const { liveSessions, reconcile, currentRef, loadRoutes, targets, openInVsCode, wakeSession } = require("./sessions");
const { people } = require("./follow-up");
const config = require("./config");

const ERRORS_AREA = config.errorsArea;
const MESSAGE_TARGETS = { reporter: "la sesión de reporte", orchestrator: "la orquestadora", board: "la sesión del tablero" };
const ORCHESTRATOR_NOTICE = "Aviso del reporte: arranca la orquestación. Eres la sesión orquestadora registrada: ejecuta ahora .claude/commands/orquesta.md (regla de AGENTS.md).";

function heartbeatAge(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch (e) {
    return Infinity;
  }
}

function liveOf(d, role) {
  return (d.sessions.list || []).find((s) => (role.conversation ? s.conversation === role.conversation : s.name === role.session));
}

const isPaused = (d) => !!(d.config && d.config.paused);

function orchestrator(d, r) {
  const o = r.orchestrator;
  if (!o || !(o.conversation || o.session)) return null;
  const live = liveOf(d, o);
  return {
    title: o.title || "Orquestar agentes",
    session: live ? live.name : o.session || null,
    conversation: o.conversation || null,
    ref: live ? currentRef(d.refs || {}, live) : null,
    open: !!live,
    watching: !!live && heartbeatAge(ORCHESTRATOR_HEARTBEAT) < 60000,
    since: o.since || null,
  };
}

function reporter(d, r) {
  const o = r.reporter;
  if (!o || !(o.conversation || o.session)) return null;
  const live = liveOf(d, o);
  return { session: live ? live.name : o.session || null, conversation: o.conversation || null, open: !!live, watching: heartbeatAge(REPORTER_HEARTBEAT) < 60000, paused: isPaused(d) };
}

function boardStatus(d, r) {
  const o = r.board;
  if (!o || !(o.conversation || o.session)) return null;
  const live = liveOf(d, o);
  return { title: o.title || "Tablero", session: live ? live.name : o.session || null, conversation: o.conversation || null, open: !!live, watching: !!live && heartbeatAge(BOARD_HEARTBEAT) < 60000 };
}

const talkTarget = (s, to) => ({ reporter: s.reporterStatus, orchestrator: s.orchestrator, board: s.boardStatus })[to] || null;

function followUpStatus(d, r) {
  const o = r.followUp;
  if (!o || !o.conversation) return null;
  const live = (d.sessions.list || []).find((s) => s.conversation === o.conversation);
  const request = d.followUpRequest && !d.followUpRequest.handled ? d.followUpRequest : null;
  return { title: o.title || `Seguimiento de ${config.jira.reviewer.name}`, session: live ? live.name : null, conversation: o.conversation, open: !!live, last: (d.followUps[0] || {}).at || null, request, paused: isPaused(d) };
}

function deployerArea(r) {
  if (r.deployer && r.areas[r.deployer]) return r.deployer;
  return Object.keys(r.areas).find((k) => /subir|desplieg|deploy/i.test(r.areas[k].title || "")) || null;
}

function tidyBlockers(d) {
  const labels = { pending: "en Pendientes", approved: "por enviar", sent: "en Enviadas", waiting: "esperándote", partial: "a medias" };
  const count = {};
  for (const t of Object.values(d.tasks)) {
    if (!labels[t.status] || (t.status === "sent" && t.manual)) continue;
    count[t.status] = (count[t.status] || 0) + 1;
  }
  const out = Object.entries(count).map(([s, n]) => `${n} tarea${n === 1 ? "" : "s"} ${labels[s]}`);
  const deploys = d.deployments.filter((x) => x.status === "approved" || (x.status === "sent" && !x.reply)).length;
  if (deploys) out.push(`${deploys} despliegue${deploys === 1 ? "" : "s"} sin terminar`);
  if (d.contextTidy && ["approved", "in-progress"].includes(d.contextTidy.status)) out.push("ya hay una ordenación en marcha");
  return out;
}

function lastContextPass() {
  try {
    const m = /Última pasada de `\/ordena-contexto`: (\d{4}-\d{2}-\d{2})/.exec(fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"));
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function followUpErrors(d) {
  return d.followUps.flatMap((r) => (r.errors || []).map((e) => ({ ...e, summaryAt: r.at })));
}

function state() {
  const d = load();
  const live = liveSessions();
  if (live) {
    reconcile(live);
    for (const v of live) v.ref = currentRef(d.refs || {}, v);
    d.sessions = { list: live, syncedAt: new Date().toISOString() };
  }
  const r = loadRoutes();
  const areas = targets(d, r);
  const epics = {};
  for (const [key, e] of Object.entries(d.seenEpics)) epics[key] = { key, name: e.name, seenAt: e.seenAt, area: null };
  for (const a of areas) for (const [key, name] of Object.entries(a.epics)) epics[key] = { key, name, seenAt: (epics[key] || {}).seenAt || null, area: a.id };
  const areaOfEpic = {};
  for (const a of areas) for (const k of Object.keys(a.epics)) areaOfEpic[k] = a.id;
  const allEpics = d.jiraEpics.filter((e) => !config.statuses.closedRegex.test(e.status)).map((e) => ({ key: e.key, name: e.name, area: areaOfEpic[e.key] || null }));
  return {
    allEpics,
    areas,
    tasks: Object.values(d.tasks),
    sessions: d.sessions,
    aliases: d.aliases,
    reporterRoute: r.reporter || null,
    orchestrator: orchestrator(d, r),
    reporterStatus: reporter(d, r),
    boardStatus: boardStatus(d, r),
    followUps: d.followUps.slice(0, 80),
    people: people(d),
    followUpStatus: followUpStatus(d, r),
    epics: Object.values(epics),
    reports: d.reports.filter((x) => !isEmptyReport(x.text)).slice(0, 10),
    lastReview: d.lastReview || null,
    config: d.config || {},
    contextTidy: d.contextTidy || null,
    messages: d.messages.slice(0, 30),
    tidyBlockers: tidyBlockers(d),
    lastContextPass: lastContextPass(),
    refreshRequest: d.refreshRequest,
    deployments: d.deployments.slice(0, 12),
    deployerArea: deployerArea(r),
    quota: readQuota(),
    jiraSetup: config.forPage(),
  };
}

function openIfClosed(areaId, areas) {
  const target = (areas || state().areas).find((x) => x.id === areaId);
  if (target && !target.open && UUID.test(target.conversation || "")) {
    openInVsCode(target.conversation);
    return true;
  }
  return false;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let lastOrchestratorNotice = 0;

async function startOrchestrator(force) {
  let o = state().orchestrator;
  if (!o || !UUID.test(o.conversation || "") || o.watching) return false;
  if (!force && Date.now() - lastOrchestratorNotice < 5 * 60000) return false;
  lastOrchestratorNotice = Date.now();
  if (!o.open) {
    openInVsCode(o.conversation);
    for (let i = 0; i < 24 && !(o = state().orchestrator).open; i++) await wait(5000);
    if (!o.open) return false;
    await wait(8000);
  }
  return wakeSession(o.session, ORCHESTRATOR_NOTICE);
}

function wakeOrchestrator() {
  startOrchestrator(false).catch(() => {});
}

function messageNotice(id) {
  return `Mensaje de ${config.jira.me.name} desde el tablero (${id}). Léelo con «${config.cli} message ${id}» y contéstale con «${config.cli} answer-message ${id} "<respuesta>"». Si te lleva más de un minuto, ve contándole en qué estás con «${config.cli} progress ${id} "<en qué estás>"». Vale como si lo hubiera escrito él en esta sesión (regla de AGENTS.md).`;
}

async function wakeReporter(notice) {
  let e = state().reporterStatus;
  if (!e || !UUID.test(e.conversation || "")) return false;
  if (!e.open) {
    openInVsCode(e.conversation);
    for (let i = 0; i < 24 && !(e = state().reporterStatus).open; i++) await wait(5000);
    if (!e.open) return false;
    await wait(8000);
  }
  return wakeSession(e.session, notice);
}

function ping(cb) {
  http
    .get(`${BASE_URL}/api/state`, (r) => {
      r.resume();
      cb(r.statusCode === 200);
    })
    .on("error", () => cb(false));
}

module.exports = {
  ERRORS_AREA,
  MESSAGE_TARGETS,
  talkTarget,
  state,
  tidyBlockers,
  lastContextPass,
  deployerArea,
  followUpErrors,
  openIfClosed,
  wakeOrchestrator,
  startOrchestrator,
  messageNotice,
  isPaused,
  wakeReporter,
  ping,
  wait,
};

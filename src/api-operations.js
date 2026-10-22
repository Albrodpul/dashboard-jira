const { UUID, now, load, mutate } = require("./data");
const { loadRoutes, changeRoutes, realArea, openInVsCode, wakeSession } = require("./sessions");
const { ERRORS_AREA, MESSAGE_TARGETS, state, tidyBlockers, openIfClosed, wakeOrchestrator, messageNotice, wait } = require("./state");
const { DEFAULT_PERSON, people, nameOf } = require("./follow-up");
const config = require("./config");

const ENVIRONMENTS = ["develop", "production", "both"];
const ENVIRONMENT_NAME = { develop: "develop", production: "producción", both: "develop y producción" };
const VERSIONS = ["z", "y", "x"];
const FOLLOW_UP_NOTICE = `Aviso del tablero: ${config.jira.me.name} pide ahora un resumen de seguimiento. Compruébalo con «${config.cli} followup-status» (campo request, con la persona) y sigue «Pedido desde el tablero» de .claude/commands/seguimiento.md.`;
const stamp = (at, n) => at.replace(/\D/g, "").slice(0, n);

function handleDeploy(res, { projects, environment, version, area, cancel }, send) {
  if (cancel) {
    const ok = mutate((d) => {
      const x = d.deployments.find((y) => y.id === cancel);
      if (!x || x.status !== "approved") return false;
      Object.assign(x, { status: "cancelled", cancelledAt: now() });
      return true;
    });
    return ok ? send(res, 200) : send(res, 409, { error: "ya se había enviado" });
  }
  const list = config.deployProjects.filter((p) => Array.isArray(projects) && projects.includes(p));
  if (!list.length || list.length !== (projects || []).length) return send(res, 400, { error: "elige qué proyectos subir" });
  if (!ENVIRONMENTS.includes(environment)) return send(res, 400, { error: "elige a dónde subir" });
  const tag = environment === "develop" ? null : VERSIONS.includes(version) ? version : "z";
  const routes = loadRoutes();
  const target = realArea(area) && routes.areas[area] ? area : null;
  if (!target) return send(res, 400, { error: "elige la sesión que despliega" });
  if (routes.deployer !== target) changeRoutes((r) => (r.deployer = target));
  const created = mutate((d) => {
    if (d.deployments.some((x) => x.status === "approved")) return null;
    const at = now();
    const x = { id: "D" + stamp(at, 14), projects: list, environment, version: tag, area: target, status: "approved", approvedVia: "board", at };
    d.deployments.unshift(x);
    d.deployments = d.deployments.slice(0, 40);
    return x;
  });
  if (!created) return send(res, 409, { error: "ya hay un despliegue esperando envío" });
  openIfClosed(target);
  wakeOrchestrator();
  send(res, 200, created);
}

function handleTidy(res, send) {
  const r = mutate((d) => {
    const b = tidyBlockers(d);
    if (b.length) return { code: 409, error: "Todavía no: " + b.join(", ") + "." };
    const at = now();
    d.contextTidy = { id: "tidy-" + stamp(at, 14), at, status: "approved", approvedVia: "board" };
    return { code: 200 };
  });
  if (r.code !== 200) return send(res, r.code, { error: r.error });
  wakeOrchestrator();
  send(res, 200);
}

async function deliverMessage(id) {
  const m = load().messages.find((x) => x.id === id);
  if (!m || m.readAt) return;
  const session = () => {
    const s = state();
    return m.to === "reporter" ? s.reporterStatus : s.orchestrator;
  };
  let e = session();
  if (!e || !UUID.test(e.conversation || "")) return;
  if (!e.open) {
    openInVsCode(e.conversation);
    for (let i = 0; i < 24 && !(e = session()).open; i++) await wait(5000);
    if (!e.open) return;
    await wait(8000);
  }
  if (load().messages.find((x) => x.id === id).readAt) return;
  const ok = await wakeSession(e.session, messageNotice(id));
  mutate((d) => {
    const x = d.messages.find((y) => y.id === id);
    if (x) x.wokenUp = { at: now(), ok };
  });
}

function handleMessage(res, { to, text, voice }, send) {
  const clean = String(text || "").trim().slice(0, 4000);
  if (!MESSAGE_TARGETS[to]) return send(res, 400, { error: "destino desconocido" });
  if (!clean) return send(res, 400, { error: "escribe el mensaje" });
  const at = now();
  const id = "msg-" + stamp(at, 17);
  mutate((d) => {
    d.messages.unshift({ id, to, text: clean, at, readAt: null, reply: null, ...(voice ? { voice } : {}) });
    d.messages = d.messages.slice(0, 60);
  });
  const target = to === "reporter" ? state().reporterStatus : state().orchestrator;
  setTimeout(() => deliverMessage(id).catch(() => {}), target && target.watching ? 45000 : 1500);
  send(res, 200, { id });
}

function summaryToErrors(d, at) {
  const r = d.followUps.find((x) => x.at === at);
  if (!r) return "no existe ese resumen";
  if ((r.errors || []).some((e) => e.wholeSummary && e.state !== "discarded")) return "ese resumen ya se ha enviado";
  const mark = now();
  const time = new Date(r.at).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
  const text = `Resumen de seguimiento de ${nameOf(r.person || DEFAULT_PERSON)} de las ${time}, enviado entero por ${config.jira.me.name} porque ve un posible fallo:\n\n${r.text}`;
  r.errors = (r.errors || []).concat({ id: "err-" + stamp(mark, 17), text, wholeSummary: true, state: "approved", approvedVia: "board", at: mark, decidedAt: mark });
  return "";
}

function handleFollowUpError(res, { id, at, action }, send) {
  if (!["send", "discard", "summary"].includes(action)) return send(res, 400, { error: "acción desconocida" });
  const error = mutate((d) => {
    if (action === "summary") return summaryToErrors(d, at);
    for (const r of d.followUps) {
      const e = (r.errors || []).find((x) => x.id === id);
      if (!e) continue;
      if (e.state !== "proposed") return "ese posible error ya está " + e.state;
      Object.assign(e, action === "send" ? { state: "approved", approvedVia: "board", decidedAt: now() } : { state: "discarded", decidedAt: now() });
      return "";
    }
    return "no existe ese posible error";
  });
  if (error) return send(res, 409, { error });
  if (action !== "discard") {
    openIfClosed(ERRORS_AREA);
    wakeOrchestrator();
  }
  send(res, 200);
}

async function wakeFollowUpFor(id) {
  let e = state().followUpStatus;
  if (!e || !UUID.test(e.conversation || "")) return;
  if (!e.open) {
    openInVsCode(e.conversation);
    for (let i = 0; i < 24 && !(e = state().followUpStatus).open; i++) await wait(5000);
    if (!e.open) return;
    await wait(8000);
  }
  const ok = await wakeSession(e.session, FOLLOW_UP_NOTICE);
  mutate((d) => {
    if (d.followUpRequest && d.followUpRequest.id === id) d.followUpRequest.wokenUp = { at: now(), ok };
  });
}

function handleFollowUpRequest(res, { person } = {}, send) {
  const who = people(load()).some((x) => x.id === person) ? person : DEFAULT_PERSON;
  const p = mutate((d) => {
    if (!d.followUpRequest || d.followUpRequest.handled) {
      const at = now();
      d.followUpRequest = { id: at, at, handled: false, person: who };
    }
    return d.followUpRequest;
  });
  wakeFollowUpFor(p.id).catch(() => {});
  send(res, 200, p);
}

module.exports = { ENVIRONMENT_NAME, handleDeploy, handleTidy, handleMessage, handleFollowUpError, handleFollowUpRequest };

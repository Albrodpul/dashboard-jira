const path = require("path");
const config = require("../core/config");
const { HUMAN_APPROVALS, DATA_DIR, UUID, now, load, mutate } = require("../core/data");
const { appendLog } = require("../core/logfile");
const holds = require("./holds");

const ME = config.jira.me.name;
const CLI = config.cli;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 60 * 1000;
const OPEN_WAIT_MS = 2 * 60 * 1000;
const READY_MS = 15 * 1000;
const TICK_MS = 3000;
const IN_SESSION_OPEN = ["sent", "waiting", "partial"];
const VIA = { board: "en el tablero", chat: "por chat", rule: "con su regla de devueltas del tablero" };
const ENVIRONMENT_NAME = { develop: "develop", production: "producción", both: "develop y producción" };
const REVIEW_LINE = `Antes de dar una por hecha, pásala por el agente revisor y, si toca pantallas, pruébala: un texto o un caso acotado tú misma; lo demás, el agente probador, uno por sesión; siempre con un navegador abierto, sin scripts, y lo no visual por API o test (context/PLAYWRIGHT.md; context/JIRA.md, «Orden de trabajo», paso 4). Al acabar cada una avisa al tablero con «board.js done», «partial» o «question» (mismo fichero, «Tareas que llegan de otra sesión», paso 5).`;
const CAUSE_LINE = "Al cerrarla, apunta la causa con board.js cause (context/JIRA.md, «Tarea devuelta tras la revisión»).";

const REFERENCE = " (context/JIRA.md, «Tareas que llegan de otra sesión»)";
const NEUTRAL_REVIEW = `Al acabar cada una avisa al tablero con «${CLI} done», «partial» o «question».`;

function guide(t) {
  const projects = require("../core/projects");
  const p = config.project(projects.projectOf(t)) || config.mainProject;
  const m = p.messages || {};
  const legacy = p === config.mainProject && !p.messages;
  return {
    review: m.review || (legacy ? REVIEW_LINE : NEUTRAL_REVIEW),
    cause: m.cause !== undefined ? m.cause : legacy ? CAUSE_LINE : "",
    reference: m.reference !== undefined ? (m.reference ? ` (${m.reference})` : "") : legacy ? REFERENCE : "",
  };
}

const manual = require("./manual-tasks");
const log = (m) => appendLog(path.join(DATA_DIR, "mailman.log"), `${now()} ${m}\n`);
const mark = (id) => `[envío ${id}]`;
let counter = 0;
const newId = (at = now()) => `E${at.replace(/\D/g, "").slice(0, 17)}${String(counter++ % 100).padStart(2, "0")}`;

function taskNote(t) {
  return ((t.note ? `${t.noteBy ? t.noteBy + ": " : ""}${t.note}` : "") + (t.changes && t.changes.length ? " Cambios en Jira: " + t.changes.map((c) => c.text).join("; ") + "." : "")).trim().slice(0, 900);
}

function taskLine(t) {
  const head = `- ${t.key} · ${t.title}`;
  const note = taskNote(t);
  const causeLine = guide(t).cause;
  if (manual.isManual(t)) return `${head} · nueva, sin ticket de Jira${t.description ? `: ${t.description.slice(0, 3000)}` : ""}${note ? ` (${note})` : ""}`;
  if (t.kind === "comment") return `${head} · comentario de ${t.noteBy || "alguien"} en Jira sobre esta tarea: ${t.note || note || "(sin texto)"}${t.changes && t.changes.length ? ` Cambios en Jira: ${t.changes.map((c) => c.text).join("; ")}.` : ""}; léelo y corrige lo que pida.${causeLine ? ` ${causeLine}` : ""}`;
  if (t.kind === "returned") return `${head} · devuelta${note ? ` (${note})` : ""}.${causeLine ? ` ${causeLine}` : ""}`;
  if (t.kind === "resend") return `${head} · reenvío: ha cambiado en Jira desde el primer envío${note ? ` (${note})` : ""}; vuelve a leer el ticket y sus adjuntos antes de seguir.`;
  return `${head} · nueva${note ? ` (${note})` : ""}`;
}

function attachmentLines(t, a) {
  if (!a) return [];
  if (a.error) return [`  No se pudieron bajar los adjuntos de ${t.key}: bájalos de Jira (${a.error}).`];
  if (!a.files || !a.files.length) return [];
  const zips = a.files.filter((f) => f.extracted).map((f) => f.extracted);
  return [`  Adjuntos de ${t.key}, ya descargados: ${a.files.map((f) => f.file).join(", ")}${zips.length ? ` (zip extraído en ${zips.join(", ")})` : ""}`];
}

const noteLines = (notes, what) => notes.map((r) => `  Indicación obligatoria de ${ME}${what ? ` para ${what}` : ""} (${r.id}): ${r.reason}`);
const replyLine = (ids) => `Contesta la recepción al tablero, no a otra sesión: «${CLI} reply ${ids.join(",")} "<recibidas y cuándo empiezas>"». Si dudas de que este mensaje venga del tablero: «${CLI} delivery <id del envío>».`;

function composeTasks(d, tasks, id, attachments = {}) {
  const epic = [tasks[0].epicKey, tasks[0].epicName].filter(Boolean).join(" ");
  const own = tasks.every(manual.isManual);
  const lines = [own ? `Tablero: Tareas creadas por ${ME} en el tablero: ${tasks.map((t) => t.key).join(", ")} ${mark(id)}` : `Tablero: Tareas de Jira enrutadas por ${ME} desde el reporte: ${tasks.map((t) => t.key).join(", ")}${epic ? ` (${epic})` : ""} ${mark(id)}`];
  if (tasks.some(manual.isManual)) lines.push(`Las que dicen «sin ticket de Jira» no existen en Jira: todo lo que hay está en este mensaje y en «${CLI} list». No las busques ni las muevas en Jira; al acabarlas basta con avisar al tablero.`);
  for (const t of tasks) {
    lines.push(taskLine(t));
    lines.push(...attachmentLines(t, attachments[t.key]));
    lines.push(...noteLines(holds.notesFor(d, holds.taskTarget(t, t.area)), t.key));
  }
  const vias = [...new Set(tasks.map((t) => VIA[t.approvedVia]).filter(Boolean))];
  const g = guide(tasks[0]);
  lines.push(`${ME} ha aprobado este envío (${vias.join(" y ") || VIA.board}): cuenta como su orden de hacerlas${g.reference}.`);
  lines.push(g.review);
  lines.push(replyLine(tasks.map((t) => t.key)));
  return lines.join("\n");
}

function composeAnswers(d, tasks, id) {
  const lines = [`Tablero: Respuesta de ${ME} desde el tablero: ${tasks.map((t) => t.key).join(", ")} ${mark(id)}`];
  for (const t of tasks) {
    lines.push(`- ${t.key} · ${t.title}`);
    lines.push(`  Lo que preguntabas: ${(t.notice && t.notice.text) || "(sin texto)"}`);
    lines.push(`  Respuesta de ${ME}, literal: ${t.answer.text}`);
    lines.push(...noteLines(holds.notesFor(d, holds.taskTarget(t, t.area)), t.key));
    const held = holds.holdsFor(d, holds.taskTarget(t, t.area));
    if (held.length) lines.push(`  Ojo: ${t.key} sigue retenida por ${held[0].id} («${held[0].reason}»), ${holds.longUntil(held[0].until)}. No la retomes hasta entonces.`);
  }
  lines.push(`Lo ha escrito ${ME} en el tablero: vale como si te lo hubiera contestado en tu sesión${guide(tasks[0]).reference}.`);
  return lines.join("\n");
}

function composeDeployment(d, x, id) {
  const where = ENVIRONMENT_NAME[x.environment] || x.environment;
  const lines = [`Tablero: Despliegue ordenado por ${ME} desde el tablero (${x.id}): ${x.projects.join(", ")} a ${where} ${mark(id)}`];
  if (x.environment === "both") lines.push("Primero el deploy a develop y, hecho ese, el de producción, cada uno con su flujo de context/GIT.md.");
  lines.push("Orden: back primero si lo hay (context/GIT.md, «Deploy order»).");
  if (x.environment !== "develop" && x.version) lines.push(`Tag: incrementar ${{ z: "Z (parche)", y: "Y (menor)", x: "X (mayor)" }[x.version] || x.version.toUpperCase()}`);
  lines.push(...noteLines(holds.notesFor(d, { area: x.area }), null));
  lines.push(`${ME} lo ha ordenado con el botón Desplegar del tablero: cuenta como su orden explícita de commit, push, merge y tag para estos proyectos y este entorno, y para nada más (context/JIRA.md, «Despliegues que llegan del tablero»).`);
  lines.push(`Cuenta cómo va al tablero, no a otra sesión: «${CLI} reply ${x.id} "<una línea>"» al recibirlo y otra al terminar con lo que se subió (tags incluidos) o por qué no.`);
  return lines.join("\n");
}

function composeErrors(d, errors, area, id) {
  const lines = [`Tablero: Posibles errores enviados por ${ME} desde el tablero: ${errors.map((e) => e.id).join(", ")} ${mark(id)}`];
  for (const e of errors) lines.push(`- ${e.id}:`, e.text);
  lines.push(...noteLines(holds.notesFor(d, { area }), null));
  lines.push(`Al terminar, cuenta el resultado al tablero con «${CLI} error-result <id>[,<id>…] "<qué has encontrado o arreglado, en pocas líneas>"»: ${ME} lo lee en la pestaña Seguimiento.`);
  lines.push(`${ME} los ha enviado con el botón de la pestaña Seguimiento: cuenta como su orden de investigarlos y arreglar lo que sea un fallo de verdad, como con los de Sentry (context/SENTRY.md; context/JIRA.md, «Tareas que llegan de otra sesión»). Sin commit ni deploy.`);
  return lines.join("\n");
}

function composeSentry(d, issues, area, id) {
  const lines = [`Tablero: Errores de Sentry enviados por ${ME} desde el tablero: ${issues.map((x) => x.id).join(", ")} ${mark(id)}`];
  for (const x of issues) {
    lines.push(`- ${x.id} (${x.project}): ${x.title}${x.rounds > 1 ? " · reenvío: ya se mandó antes" : ""}`);
    if (x.culprit) lines.push(`  ${x.culprit}`);
    lines.push(`  ${x.count} veces, ${x.users} usuarios, último ${x.lastSeen}`);
    if (x.url) lines.push(`  ${x.url}`);
  }
  lines.push(...noteLines(holds.notesFor(d, { area }), null));
  lines.push(`Al terminar, cuenta el resultado al tablero con «${CLI} sentry-result <ID>[,<ID>…] "<qué has encontrado o arreglado, en pocas líneas>"»: ${ME} lo lee en la pestaña Sentry.`);
  lines.push(`${ME} los ha enviado con el botón de la pestaña Sentry: cuenta como su orden de investigarlos y arreglar lo que sea un fallo de verdad (context/SENTRY.md; context/JIRA.md, «Tareas que llegan de otra sesión»). Sin commit ni deploy.`);
  return lines.join("\n");
}

function composeStop(entries, id) {
  const keys = [...new Set(entries.map((e) => e.task.key))];
  const lines = [`Aviso del tablero: para ${keys.length === 1 ? "la tarea" : "las tareas"} ${keys.join(", ")} ${mark(id)}`];
  const seen = new Set();
  for (const { task, restriction: r } of entries) {
    if (seen.has(task.key)) continue;
    seen.add(task.key);
    lines.push(`- ${task.key} · ${task.title}: ${ME} la ha retenido (${r.id}, «${r.reason}»), ${holds.longUntil(r.until)}.`);
  }
  lines.push(`No sigas con ${keys.length === 1 ? "ella" : "ellas"}: deja lo que estés haciendo en un punto limpio, no hagas commit ni push de ese trabajo y no la retomes hasta que el tablero te la vuelva a mandar. Lo demás que tengas sigue igual.`);
  lines.push(`Cuéntalo al tablero en una línea: «${CLI} reply ${keys.join(",")} "<parada; en qué punto queda>"».`);
  return lines.join("\n");
}

function composeTidy(o, id) {
  return `Aviso del tablero: ${ME} ha pulsado Ordenar contexto (${o.id}) ${mark(id)}\nRelee ahora la sección «Ordenar contexto» de ${config.commandsDir}/orquesta.md y síguela: la ordenación la hace un subagente (Agent con model opus y effort medium), no tú.`;
}

const composeRole = (text, id) => `${text} ${mark(id)}`;

const approvedTask = (d, t) => !!t && t.status === "approved" && HUMAN_APPROVALS.includes(t.approvedVia);
const SOFT_RETRY_MS = 10 * 1000;
const due = (x, nowMs) => !x || (x.soft ? nowMs - Date.parse(x.at || 0) >= SOFT_RETRY_MS : (x.attempts || 0) < MAX_ATTEMPTS && nowMs - Date.parse(x.at || 0) >= RETRY_MS);

function followUpErrors(d) {
  return d.followUps.flatMap((r) => (r.errors || []).map((e) => ({ ...e })));
}

function collect(d, nowMs = Date.now()) {
  const jobs = [];
  const groups = new Map();
  for (const t of Object.values(d.tasks || {})) {
    if (!approvedTask(d, t) || !t.area || !due(t.delivery, nowMs) || holds.checkTask(d, t, t.area, nowMs)) continue;
    const k = `${t.area}|${t.epicKey || ""}`;
    if (!groups.has(k)) groups.set(k, { kind: "tasks", area: t.area, ids: [] });
    groups.get(k).ids.push(t.key);
  }
  jobs.push(...groups.values());
  const answers = new Map();
  for (const t of Object.values(d.tasks || {})) {
    if (!t.answer || t.answer.delivered || !t.area || !due(t.answer.delivery, nowMs)) continue;
    if (!answers.has(t.area)) answers.set(t.area, { kind: "answers", area: t.area, ids: [] });
    answers.get(t.area).ids.push(t.key);
  }
  jobs.push(...answers.values());
  for (const x of d.deployments || []) if (x.status === "approved" && x.approvedVia === "board" && due(x.delivery, nowMs) && !holds.checkArea(d, x.id, x.area, nowMs)) jobs.push({ kind: "deployment", area: x.area, ids: [x.id] });
  const errors = followUpErrors(d).filter((e) => e.state === "approved" && e.approvedVia === "board" && due(e.delivery, nowMs));
  if (errors.length && config.errorsArea && !holds.checkArea(d, "", config.errorsArea, nowMs)) jobs.push({ kind: "errors", area: config.errorsArea, ids: errors.map((e) => e.id) });
  const sentry = new Map();
  for (const x of Object.values(d.sentry || {})) {
    if (x.state !== "approved" || x.approvedVia !== "board" || !x.area || !due(x.delivery, nowMs) || holds.checkArea(d, x.id, x.area, nowMs)) continue;
    if (!sentry.has(x.area)) sentry.set(x.area, { kind: "sentry", area: x.area, ids: [] });
    sentry.get(x.area).ids.push(x.id);
  }
  jobs.push(...sentry.values());
  const stops = new Map();
  for (const e of holds.pendingStopNotices(d, nowMs)) {
    if (!due(e.task.stopDelivery, nowMs)) continue;
    if (!stops.has(e.task.area)) stops.set(e.task.area, { kind: "stop", area: e.task.area, ids: [] });
    const job = stops.get(e.task.area);
    job.ids.push(`${e.task.key}|${e.restriction.id}`);
  }
  jobs.push(...stops.values());
  const o = d.contextTidy;
  if (o && o.status === "approved" && o.approvedVia === "board" && !o.notifiedAt && due(o.delivery, nowMs)) jobs.push({ kind: "tidy", role: "orchestrator", ids: [o.id] });
  return jobs;
}

function itemsOf(d, job) {
  if (job.kind === "tasks") return job.ids.map((k) => d.tasks[k]).filter((t) => approvedTask(d, t) && t.area === job.area && !holds.checkTask(d, t, t.area));
  if (job.kind === "answers") return job.ids.map((k) => d.tasks[k]).filter((t) => t && t.answer && !t.answer.delivered);
  if (job.kind === "deployment") return (d.deployments || []).filter((x) => job.ids.includes(x.id) && x.status === "approved" && x.approvedVia === "board" && !holds.checkArea(d, x.id, x.area));
  if (job.kind === "errors") return holds.checkArea(d, "", job.area) ? [] : followUpErrors(d).filter((e) => job.ids.includes(e.id) && e.state === "approved" && e.approvedVia === "board");
  if (job.kind === "sentry") return Object.values(d.sentry || {}).filter((x) => job.ids.includes(x.id) && x.state === "approved" && x.approvedVia === "board" && !holds.checkArea(d, x.id, x.area));
  if (job.kind === "stop") {
    const wanted = new Set(job.ids);
    return holds.pendingStopNotices(d).filter((e) => wanted.has(`${e.task.key}|${e.restriction.id}`));
  }
  if (job.kind === "tidy") return [d.contextTidy].filter((o) => o && job.ids.includes(o.id) && o.status === "approved" && !o.notifiedAt);
  if (job.kind === "role") return [job.text];
  return [];
}

const idsOf = (job, items) => (job.kind === "stop" ? items.map((e) => `${e.task.key}|${e.restriction.id}`) : job.kind === "role" ? job.ids : items.map((x) => x.key || x.id));

function compose(d, job, items, id, attachments) {
  if (job.kind === "tasks") return composeTasks(d, items, id, attachments);
  if (job.kind === "answers") return composeAnswers(d, items, id);
  if (job.kind === "deployment") return composeDeployment(d, items[0], id);
  if (job.kind === "errors") return composeErrors(d, items, job.area, id);
  if (job.kind === "sentry") return composeSentry(d, items, job.area, id);
  if (job.kind === "stop") return composeStop(items, id);
  if (job.kind === "tidy") return composeTidy(items[0], id);
  return composeRole(items[0], id);
}

function eachRecord(d, job, ids, fn) {
  const wanted = new Set(ids);
  if (job.kind === "tasks" || job.kind === "answers") for (const k of ids) d.tasks[k] && fn(job.kind === "answers" ? d.tasks[k].answer : d.tasks[k], d.tasks[k]);
  if (job.kind === "deployment") for (const x of d.deployments || []) wanted.has(x.id) && fn(x);
  if (job.kind === "errors") for (const r of d.followUps || []) for (const e of r.errors || []) wanted.has(e.id) && fn(e);
  if (job.kind === "sentry") for (const x of Object.values(d.sentry || {})) wanted.has(x.id) && fn(x);
  if (job.kind === "stop") for (const id of ids) {
    const t = d.tasks[id.split("|")[0]];
    if (t) fn(t, id.split("|")[1]);
  }
  if (job.kind === "tidy" && d.contextTidy && wanted.has(d.contextTidy.id)) fn(d.contextTidy);
}

function markDelivered(d, job, ids, id, at) {
  const out = [];
  eachRecord(d, job, ids, (x, extra) => {
    if (job.kind === "tasks") {
      if (!["approved", "pending"].includes(x.status)) return;
      Object.assign(x, { status: "sent", sentAt: at, deliveredBy: { id, at } });
      if (!x.area) x.area = job.area;
      for (const k of ["changes", "delivery", "heldBack"]) delete x[k];
    } else if (job.kind === "answers") {
      if (!x || x.delivered) return;
      Object.assign(x, { delivered: true, deliveredAt: at, deliveredBy: id });
      delete x.delivery;
      extra.history = (extra.history || []).concat({ type: "answer", text: x.text, at: x.at }).slice(-10);
      extra.status = "sent";
    } else if (job.kind === "deployment") {
      if (x.status !== "approved") return;
      Object.assign(x, { status: "sent", sentAt: at, deliveredBy: id });
      delete x.delivery;
    } else if (job.kind === "errors" || job.kind === "sentry") {
      if (x.state !== "approved") return;
      Object.assign(x, { state: "sent", sentAt: at, deliveredBy: id });
      delete x.delivery;
    } else if (job.kind === "stop") {
      x.stopNotices = { ...(x.stopNotices || {}), [extra]: { at, id } };
      delete x.stopDelivery;
    } else if (job.kind === "tidy") {
      Object.assign(x, { notifiedAt: at, deliveredBy: id });
      delete x.delivery;
    }
    out.push(job.kind === "stop" ? `${x.key}|${extra}` : x.key || x.id || "");
  });
  return out;
}

function markFailed(d, job, ids, error, nowIso, soft) {
  let attempts = 0;
  const touched = new Set();
  eachRecord(d, job, ids, (x) => {
    if (!x || touched.has(x)) return;
    touched.add(x);
    const field = job.kind === "stop" ? "stopDelivery" : "delivery";
    const before = (x[field] && x[field].attempts) || 0;
    x[field] = soft ? { error, at: nowIso, attempts: before, soft: true } : { error, at: nowIso, attempts: before + 1 };
    attempts = Math.max(attempts, x[field].attempts);
  });
  return attempts;
}

function recordDelivery(d, entry) {
  d.deliveries = [entry, ...(d.deliveries || []).filter((x) => x.id !== entry.id)].slice(0, 120);
}

function defaultEnv() {
  const registry = require("../sessions/registry");
  const host = require("../sessions/host");
  const deliver = require("../sessions/deliver");
  return {
    primary: () => require("../cluster/cluster").primaryNow(),
    state: () => require("../server/state").state(),
    live: () => registry.liveSessions() || [],
    open: (conversation) => registry.openInVsCode(conversation),
    hosted: async (conversation) => {
      const list = await host.hostRequest("GET", "/sessions").catch(() => null);
      return Array.isArray(list) && list.some((x) => x.conversation === conversation && x.running);
    },
    nativePrompt: (conversation) => ((load().permissions || []).some((p) => p.native && p.status === "pending" && p.conversation === conversation)),
    attachments: (key) => require("../jira/client").downloadAttachments(key),
    typeInto: deliver.typeInto,
    sendMessage: deliver.sendMessageInto,
    seen: (conversation, token) => deliver.seenAnywhere(conversation, token),
    push: (text) => require("../server/push").sendPush("sessions", true, text).catch(() => {}),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

let env = null;
const E = () => env || (env = defaultEnv());

function targetOf(s, job) {
  if (job.role === "reporter") {
    const r = s.reporterStatus;
    return r ? { name: "Reporte", conversation: r.conversation, sessionName: r.session, open: r.open, ref: null, repeatedName: false } : null;
  }
  if (job.role === "orchestrator") {
    const o = s.orchestrator;
    return o ? { name: o.title || "Orquestadora", conversation: o.conversation, sessionName: o.session, open: o.open, ref: o.ref, repeatedName: false } : null;
  }
  const a = s.areas.find((x) => x.id === job.area);
  return a ? { name: a.name || a.id, conversation: a.conversation, sessionName: a.sessionName, open: a.open, ref: a.ref, repeatedName: a.repeatedName } : null;
}

class SoftWait extends Error {}
const READY_STATES = new Set(["idle", "busy", "shell"]);

async function reachDestination(job) {
  const e = E();
  let t = targetOf(e.state(), job);
  if (!t) throw new Error(job.role ? "no hay orquestadora registrada" : `la sesión de destino (${job.area}) no existe en el tablero`);
  const conversation = UUID.test(t.conversation || "") ? t.conversation : null;
  if (!t.open) {
    if (!conversation) throw new Error(`«${t.name}» está cerrada y no tiene conversación enlazada para abrirla`);
    e.open(conversation);
    for (let waited = 0; !t.open && waited < OPEN_WAIT_MS; waited += 5000) {
      await e.wait(5000);
      t = targetOf(e.state(), job) || t;
    }
    if (!t.open) throw new Error(`«${t.name}» no se ha abierto en 2 minutos`);
  }
  if (conversation) {
    const live = e.live().find((x) => x.conversation === conversation);
    const age = live ? Date.now() - Date.parse(live.started) : READY_MS;
    if (age < READY_MS) await e.wait(READY_MS - age);
    if (e.nativePrompt(conversation)) throw new SoftWait(`«${t.name}» tiene una pregunta de permiso abierta: se entrega en cuanto la contestes`);
    if (live && live.status && !READY_STATES.has(live.status)) throw new SoftWait(`«${t.name}» está en estado «${live.status}» (puede tener un diálogo abierto): se entrega en cuanto vuelva a estar libre o trabajando`);
  }
  const hosted = conversation ? await e.hosted(conversation) : false;
  if (!hosted) {
    if (!t.sessionName) throw new Error(`«${t.name}» no tiene nombre de sesión para mandarle el mensaje`);
    if (t.repeatedName && !t.ref) throw new Error(`hay varias sesiones abiertas con el nombre «${t.sessionName}» y no se sabe cuál es «${t.name}»`);
  }
  return { ...t, conversation, hosted, sendTo: t.repeatedName && t.ref ? `${t.sessionName} [${t.ref}]` : t.sessionName };
}

async function runJob(job) {
  const e = E();
  const items = itemsOf(load(), job);
  if (!items.length) return;
  const ids = idsOf(job, items);
  let dest;
  try {
    dest = await reachDestination(job);
  } catch (err) {
    return fail(job, ids, err, err instanceof SoftWait);
  }
  const attachments = {};
  if (job.kind === "tasks") {
    for (const t of items) {
      if (manual.isManual(t)) continue;
      try {
        attachments[t.key] = await e.attachments(t.key);
      } catch (err) {
        attachments[t.key] = { error: String(err.message || err) };
      }
    }
  }
  if (lateConfirm(job, ids)) return;
  const d = load();
  const fresh = itemsOf(d, job);
  const freshIds = idsOf(job, fresh);
  if (!fresh.length) return;
  const id = newId();
  const text = compose(d, job, fresh, id, attachments);
  mutate((x) => recordDelivery(x, { id, kind: job.kind, area: job.area || null, role: job.role || null, ids: freshIds, conversation: dest.conversation, via: dest.hosted ? "terminal" : "message", status: "typing", at: now(), pid: process.pid }));
  log(`${id} ${job.kind} -> ${dest.name}: ${freshIds.join(",")}`);
  let r;
  try {
    r = dest.hosted ? await e.typeInto(dest.conversation, text, mark(id)) : await e.sendMessage(dest.conversation, dest.sendTo, text, mark(id));
  } catch (err) {
    r = { ok: false, error: String(err.message || err) };
  }
  if (!r.ok) {
    mutate((x) => {
      const rec = (x.deliveries || []).find((y) => y.id === id);
      if (rec) Object.assign(rec, { status: "failed", error: r.error, endedAt: now() });
    });
    return fail(job, freshIds, new Error(r.error), false, dest.name);
  }
  const done = mutate((x) => {
    const at = now();
    const marked = markDelivered(x, job, freshIds, id, at);
    const rec = (x.deliveries || []).find((y) => y.id === id);
    if (rec) Object.assign(rec, { status: "confirmed", endedAt: at, marked });
    return marked;
  });
  log(`${id} confirmado${r.retried ? " (con un segundo Enter)" : ""}: ${done.join(",")}`);
}

function lateConfirm(job, ids) {
  const want = new Set(ids);
  const earlier = (load().deliveries || []).filter((x) => x.status === "failed" && x.conversation && (x.ids || []).some((i) => want.has(i)));
  for (const rec of earlier) {
    if (!E().seen(rec.conversation, mark(rec.id))) continue;
    mutate((x) => {
      const r = (x.deliveries || []).find((y) => y.id === rec.id);
      if (!r || r.status !== "failed") return;
      r.marked = markDelivered(x, { kind: r.kind, area: r.area, role: r.role }, r.ids, r.id, now());
      Object.assign(r, { status: "confirmed", endedAt: now(), late: true });
    });
    log(`${rec.id} confirmado tarde: no se vuelve a escribir`);
    return true;
  }
  return false;
}

function fail(job, ids, err, soft, name) {
  const error = String(err.message || err);
  const attempts = mutate((d) => markFailed(d, job, ids, error, now(), soft));
  log(`${job.kind} ${job.area || job.role} ${ids.join(",")}: ${soft ? "espera" : `fallo ${attempts}/${MAX_ATTEMPTS}`}: ${error}`);
  if (!soft && attempts >= MAX_ATTEMPTS) E().push(`No se pudo entregar ${ids.map((x) => x.split("|")[0]).join(", ")}${name ? ` a ${name}` : ""}: ${error}`);
}

function recover() {
  const d = load();
  const stale = (d.deliveries || []).filter((x) => x.status === "typing" && x.pid !== process.pid);
  for (const rec of stale) {
    const seen = rec.conversation ? E().seen(rec.conversation, mark(rec.id)) : false;
    mutate((x) => {
      const r = (x.deliveries || []).find((y) => y.id === rec.id);
      if (!r || r.status !== "typing") return;
      if (seen) {
        r.marked = markDelivered(x, { kind: r.kind, area: r.area, role: r.role }, r.ids, r.id, now());
        Object.assign(r, { status: "confirmed", endedAt: now(), recovered: true });
      } else Object.assign(r, { status: "failed", error: "el tablero se reinició antes de confirmar la entrega", endedAt: now() });
    });
    log(`${rec.id} pendiente de antes del reinicio: ${seen ? "sí llegó" : "no llegó; se reintenta"}`);
  }
}

const running = new Set();
const roleQueue = [];
let recovered = false;
let timer = null;

const destKey = (job) => job.role || job.area;

async function tick() {
  const e = E();
  if (!e.primary()) return;
  if (!recovered) {
    recovered = true;
    recover();
  }
  const jobs = collect(load());
  while (roleQueue.length) jobs.push(roleQueue.shift());
  for (const job of jobs) {
    const k = destKey(job);
    if (running.has(k)) {
      if (job.kind === "role") roleQueue.push(job);
      continue;
    }
    running.add(k);
    runJob(job)
      .catch((err) => log(`error inesperado en ${job.kind} ${k}: ${(err && err.stack) || err}`))
      .finally(() => running.delete(k));
  }
}

function kick() {
  clearTimeout(timer);
  timer = setTimeout(() => tick().catch(() => {}), 200);
}

function notifyRole(role, text) {
  roleQueue.push({ kind: "role", role, ids: [`role-${role}`], text });
  kick();
}

function retry({ kind, id }) {
  const field = kind === "stop" ? "stopDelivery" : "delivery";
  const ok = mutate((d) => {
    let hit = false;
    const clear = (x) => {
      if (x && x[field]) {
        delete x[field];
        hit = true;
      }
    };
    if (kind === "task" || kind === "stop") clear(d.tasks[id]);
    if (kind === "answer") clear(d.tasks[id] && d.tasks[id].answer);
    if (kind === "deployment") clear((d.deployments || []).find((x) => x.id === id));
    if (kind === "sentry") clear((d.sentry || {})[id]);
    if (kind === "error") for (const r of d.followUps || []) clear((r.errors || []).find((e) => e.id === id));
    return hit;
  });
  if (ok) kick();
  return ok;
}

function status(d = load()) {
  const failing = [];
  for (const t of Object.values(d.tasks || {})) {
    if (t.status === "approved" && t.delivery && !t.delivery.soft) failing.push({ kind: "task", id: t.key, error: t.delivery.error, attempts: t.delivery.attempts });
    if (t.answer && !t.answer.delivered && t.answer.delivery && !t.answer.delivery.soft) failing.push({ kind: "answer", id: t.key, error: t.answer.delivery.error, attempts: t.answer.delivery.attempts });
    if (t.stopDelivery && !t.stopDelivery.soft) failing.push({ kind: "stop", id: t.key, error: t.stopDelivery.error, attempts: t.stopDelivery.attempts });
  }
  for (const x of d.deployments || []) if (x.status === "approved" && x.delivery && !x.delivery.soft) failing.push({ kind: "deployment", id: x.id, error: x.delivery.error, attempts: x.delivery.attempts });
  for (const x of Object.values(d.sentry || {})) if (x.state === "approved" && x.delivery && !x.delivery.soft) failing.push({ kind: "sentry", id: x.id, error: x.delivery.error, attempts: x.delivery.attempts });
  for (const r of d.followUps || []) for (const e of r.errors || []) if (e.state === "approved" && e.delivery && !e.delivery.soft) failing.push({ kind: "error", id: e.id, error: e.delivery.error, attempts: e.delivery.attempts });
  return { delivering: [...running], failing, last: (d.deliveries || []).find((x) => x.status === "confirmed") || null };
}

function start() {
  setInterval(() => tick().catch(() => {}), TICK_MS);
  kick();
}

const _test = {
  setEnv: (x) => {
    env = x ? { ...defaultEnvStub(), ...x } : null;
    recovered = false;
    running.clear();
    roleQueue.length = 0;
  },
  runJob,
  collect,
  itemsOf,
  markDelivered,
  recover,
  idle: async () => {
    for (let i = 0; i < 200 && running.size; i++) await new Promise((r) => setTimeout(r, 5));
  },
};

function defaultEnvStub() {
  return { primary: () => true, push: () => {}, wait: () => Promise.resolve(), attachments: async () => ({ folder: null, files: [] }), nativePrompt: () => false, live: () => [], seen: () => false };
}

module.exports = { taskNote, taskLine, composeTasks, composeAnswers, composeDeployment, composeErrors, composeSentry, composeStop, composeTidy, collect, tick, kick, notifyRole, retry, status, start, MAX_ATTEMPTS, _test };

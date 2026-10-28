const http = require("http");
const cp = require("child_process");
const { BASE_URL, PORT, ENTRY, STATUSES, IN_SESSION, HUMAN_APPROVALS, UUID, isEmptyReport, now, load, mutate, markCounted, readStdin } = require("./data");
const { titleKey, assignRefs, loadRoutes, openInVsCode } = require("./sessions");
const { syncJiraEpics, downloadAttachments } = require("./jira");
const { sendPush, subscriptions } = require("./push");
const { TASK_STATUS, TASK_KIND, CAUSE } = require("./migrate");
const config = require("./config");
const { ERRORS_AREA, MESSAGE_TARGETS, state, tidyBlockers, lastContextPass, followUpErrors, wakeOrchestrator, ping } = require("./state");

const ALIASES = {
  informe: "report",
  reporte: "reporter",
  "aprobar-chat": "approve-chat",
  envios: "dispatches",
  adjuntos: "attachments",
  hecha: "done",
  "a-medias": "partial",
  pregunta: "question",
  comentario: "comment",
  entregada: "delivered",
  enviada: "sent",
  respuesta: "reply",
  cambios: "changes",
  orquestador: "orchestrator",
  despliegues: "deployments",
  "despliegue-update": "deployment-update",
  arranque: "startup",
  "aviso-prueba": "push-test",
  "error-enviado": "error-sent",
  seguimiento: "people",
  "persona-cuentas": "person-accounts",
  "ordenar-estado": "tidy-status",
  "ordenar-empieza": "tidy-start",
  "ordenar-fin": "tidy-end",
  mensaje: "message",
  contesta: "answer-message",
  progreso: "progress",
  contados: "counted",
  pendiente: "refresh-request",
  "epics-jira": "jira-epics",
  abrir: "open",
  "aprendizaje-leer": "learning-read",
  causa: "cause",
};
const NOTICE_OF = { done: "done", partial: "partial", question: "question", comment: "comment" };

const cmd = ALIASES[process.argv[2]] || process.argv[2];
const [a, b] = process.argv.slice(3);
const rest = (from) => process.argv.slice(from).join(" ").trim();
const keyList = (text) =>
  String(text || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const json = (x) => console.log(JSON.stringify(x, null, 2));
const option = (name) => {
  for (const n of [].concat(name)) {
    const i = process.argv.indexOf(n);
    if (i > 0) return process.argv[i + 1];
  }
  return null;
};
const withoutOptions = () => {
  const args = process.argv.slice(3);
  for (const n of ["--person", "--persona"]) {
    const i = args.indexOf(n);
    if (i >= 0) args.splice(i, 2);
  }
  return args;
};
const personOption = () => option(["--person", "--persona"]) || require("./follow-up").DEFAULT_PERSON;
const status = (s) => TASK_STATUS[s] || s;
const ME = config.jira.me.name;
const MY_FIRST_NAME = new RegExp(String(ME).split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

function fail(text) {
  console.error(text);
  process.exit(1);
}

function launchServer(message) {
  cp.spawn(process.execPath, [ENTRY, "serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  setTimeout(() => ping((ok) => console.log(ok ? `${message}: ${BASE_URL}` : "No se pudo arrancar el tablero")), 800);
}

function destinationOf(s) {
  return (id) => {
    const x = s.areas.find((y) => y.id === id);
    return x ? { session: x.name, sendTo: x.repeatedName && x.ref ? `${x.sessionName} [${x.ref}]` : x.sessionName, open: x.open, repeatedName: x.repeatedName, ref: x.ref } : null;
  };
}

const commands = {
  serve() {
    require("./server").serve();
  },

  ensure() {
    ping((up) => (up ? console.log(`Tablero ya en marcha: ${BASE_URL}`) : launchServer("Tablero arrancado")));
  },

  restart() {
    const stop = http.request(`${BASE_URL}/api/quit`, { method: "POST" }, (r) => {
      r.resume();
      if (r.statusCode !== 200) {
        const legacy = http.request(`${BASE_URL}/api/salir`, { method: "POST" }, (r2) => {
          r2.resume();
          if (r2.statusCode !== 200) return console.log(`El servidor en marcha no sabe reiniciarse: cierra a mano el proceso node del puerto ${PORT} (por su PID, nunca \`taskkill /IM node.exe\`) y ejecuta \`ensure\`.`);
          setTimeout(() => launchServer("Tablero reiniciado"), 400);
        });
        legacy.on("error", () => launchServer("Tablero reiniciado"));
        return legacy.end();
      }
      setTimeout(() => launchServer("Tablero reiniciado"), 400);
    });
    stop.on("error", () => launchServer("Tablero reiniciado"));
    stop.end();
  },

  add() {
    const items = [].concat(JSON.parse(a || readStdin()));
    const r = mutate((d) => {
      const out = [];
      let added = 0;
      let pending = 0;
      let auto = 0;
      for (const raw of items) {
        const { evento, ...input } = raw;
        const t = { ...input, kind: TASK_KIND[input.kind] || input.kind, event: input.event || evento };
        const previous = d.tasks[t.key];
        const used = previous && t.event && (previous.events || []).includes(t.event);
        const comesBack = previous && !used && ["returned", "comment"].includes(t.kind) && ["sent", "ignored", "done"].includes(previous.status);
        if (previous && !comesBack) {
          out.push(`${t.key}: ya existe, no se toca`);
          continue;
        }
        if (!previous && t.kind === "new" && d.deleted && d.deleted[t.key]) {
          out.push(`${t.key}: la borraste del tablero, no se vuelve a crear`);
          continue;
        }
        const { status: _s, approvedVia, decidedAt, sentAt, event, ...fields } = t;
        const task = { ...fields, status: "pending", events: ((previous && previous.events) || []).concat(event ? [event] : []).slice(-20) };
        d.tasks[t.key] = task;
        if (comesBack) {
          task.proposedArea = fields.proposedArea || previous.area || previous.proposedArea || "";
          task.rounds = (previous.rounds || 0) + 1;
          if (d.config && d.config.autoReturned && previous.area) {
            Object.assign(task, { status: "approved", area: previous.area, decidedAt: now(), approvedVia: "rule" });
            auto++;
            out.push(`${t.key}: ya estaba ${previous.status}; vuelve sola a su sesión (${previous.area}) por la regla de devueltas de ${ME}`);
          } else out.push(`${t.key}: ya estaba ${previous.status}; vuelve a Pendientes como ${t.kind}`);
        }
        if (task.status === "pending") pending++;
        added++;
      }
      out.push(`${added} tarjeta(s) añadida(s)`);
      return { out, pending, auto };
    });
    console.log(r.out.join("\n"));
    if (r.auto) wakeOrchestrator();
    if (r.pending) sendPush("tasks", false, r.pending === 1 ? "Hay una tarea nueva en Pendientes" : `Hay ${r.pending} tareas nuevas en Pendientes`).then((n) => n && console.log(`aviso enviado a ${n} dispositivo(s)`));
  },

  list() {
    const wanted = a ? status(a) : null;
    if (wanted && !STATUSES.includes(wanted)) fail(`estado desconocido: ${a}`);
    const visible = Object.values(load().tasks).filter((t) => !wanted || t.status === wanted);
    const unseen = visible.filter((t) => t.status === "approved" && !HUMAN_APPROVALS.includes(t.approvedVia));
    for (const t of unseen) console.error(`AVISO: ${t.key} figura como aprobada sin pasar por el tablero ni por una orden de ${ME} en el chat. No se envía.`);
    json(visible.filter((t) => !unseen.includes(t)));
  },

  update() {
    const patch = JSON.parse(b || readStdin());
    if (patch.status) patch.status = status(patch.status);
    const error = mutate((d) => {
      const t = d.tasks[a];
      if (!t) return `no existe ${a}`;
      if ("approvedVia" in patch || "decidedAt" in patch) return "approvedVia y decidedAt solo los pone el tablero";
      if (patch.status && patch.status !== "sent") return `el estado «${patch.status}» lo decide ${ME}: en el tablero, o por chat con approve-chat`;
      if (patch.status === "sent" && !(t.status === "approved" && HUMAN_APPROVALS.includes(t.approvedVia))) return `${a} no está aprobada por ${ME}: no se puede marcar como enviada`;
      if (patch.status === "sent" && !patch.sentAt) patch.sentAt = now();
      Object.assign(t, patch);
      return "";
    });
    if (error) fail(error);
    console.log(`${a} actualizada`);
  },

  "approve-chat"() {
    const area = b;
    const error = mutate((d) => {
      const t = d.tasks[a];
      if (!t) return `no existe ${a}`;
      if (t.status === "sent") return `${a} ya está enviada`;
      const areas = loadRoutes().areas;
      if (!area || !areas[area]) return `área desconocida: ${area || "(falta)"}. Las que hay: ${Object.keys(areas).join(", ")}`;
      Object.assign(t, { status: "approved", area, decidedAt: now(), approvedVia: "chat" });
      return "";
    });
    if (error) fail(error);
    console.log(`${a} aprobada por orden de ${ME} en el chat -> ${area}`);
  },

  watch() {
    require("./watcher").watch(a);
  },

  dispatches() {
    const s = state();
    const destination = destinationOf(s);
    const note = (t) => ((t.note ? `${t.noteBy ? t.noteBy + ": " : ""}${t.note}` : "") + (t.changes && t.changes.length ? " Cambios en Jira: " + t.changes.map((c) => c.text).join("; ") + "." : "")).trim().slice(0, 900);
    const tasks = s.tasks
      .filter((t) => t.status === "approved" && HUMAN_APPROVALS.includes(t.approvedVia))
      .map((t) => ({ key: t.key, title: t.title, kind: t.kind, epic: [t.epicKey, t.epicName].filter(Boolean).join(" "), approvedVia: t.approvedVia, assignee: t.assignee || "sin asignar", note: note(t), area: t.area, destination: destination(t.area) }));
    const deployments = s.deployments
      .filter((x) => x.status === "approved" && x.approvedVia === "board")
      .map((x) => ({ id: x.id, projects: x.projects, environment: x.environment, version: x.version, area: x.area, destination: destination(x.area) }));
    (async () => {
      for (const t of tasks) {
        try {
          t.attachments = await downloadAttachments(t.key);
        } catch (e) {
          t.attachments = { error: String(e.message || e) };
        }
      }
      const answers = s.tasks
        .filter((t) => t.answer && !t.answer.delivered)
        .map((t) => ({ key: t.key, title: t.title, asked: (t.notice && t.notice.text) || "", answer: t.answer.text, area: t.area, destination: destination(t.area) }));
      const errors = followUpErrors(load())
        .filter((e) => e.state === "approved" && e.approvedVia === "board")
        .map((e) => ({ id: e.id, text: e.text, seenAt: e.at, destination: destination(ERRORS_AREA) }));
      json({ tasks, deployments, answers, errors });
    })();
  },

  attachments() {
    downloadAttachments(a).then(json, (e) => fail(String(e.message || e)));
  },

  delivered() {
    const keys = keyList(process.argv.slice(3).join(","));
    const n = mutate((d) => {
      let k = 0;
      for (const c of keys) {
        const t = d.tasks[c];
        if (!t || !t.answer || t.answer.delivered) continue;
        t.answer.delivered = true;
        t.answer.deliveredAt = now();
        t.history = (t.history || []).concat({ type: "answer", text: t.answer.text, at: t.answer.at }).slice(-10);
        t.status = "sent";
        k++;
      }
      return k;
    });
    console.log(`${n} de ${keys.length} respuesta(s) marcadas como entregadas; la tarea vuelve a Enviadas`);
  },

  changes() {
    const events = JSON.parse(readStdin());
    let withdrawn = 0;
    const n = mutate((d) => {
      let marked = 0;
      for (const e of events) {
        const t = e && d.tasks[e.key];
        if (!t || !e.at || !e.text) continue;
        if (e.assignee) t.assignee = e.assignee;
        if (e.assignee && !MY_FIRST_NAME.test(e.assignee) && !/sin asignar|unassigned/i.test(e.assignee) && ["pending", "approved", "ignored"].includes(t.status) && !t.withdrawn) {
          t.withdrawn = { by: e.assignee, at: now() };
          t.status = "ignored";
          t.decidedAt = t.withdrawn.at;
          delete t.approvedVia;
          withdrawn++;
        }
        const since = IN_SESSION.includes(t.status) ? t.sentAt || t.at : t.at;
        const toStatus = /status: .* -> (.*)$/.exec(String(e.text));
        if (toStatus && config.statuses.closedRegex.test(toStatus[1].trim())) t.jiraClosedAt = e.at;
        if (!since || new Date(e.at).getTime() <= new Date(since).getTime()) continue;
        t.changes = t.changes || [];
        if (t.changes.some((c) => c.at === e.at && c.text === e.text)) continue;
        t.changes.push({ at: e.at, text: String(e.text).slice(0, 300), who: e.who || null });
        t.changes.sort((x, y) => String(x.at).localeCompare(String(y.at)));
        t.changes = t.changes.slice(-12);
        marked++;
      }
      return marked;
    });
    console.log(`${n} cambio(s) anotado(s) en tarjetas${withdrawn ? `; ${withdrawn} tarjeta(s) retirada(s) porque otra persona tiene el ticket` : ""}`);
  },

  orchestrator() {
    const s = state();
    const waiting = s.tasks.filter((t) => t.status === "approved" && HUMAN_APPROVALS.includes(t.approvedVia)).map((t) => ({ key: t.key, since: t.decidedAt }));
    for (const x of s.deployments.filter((y) => y.status === "approved")) waiting.push({ key: x.id, since: x.at });
    json({ orchestrator: s.orchestrator, waiting });
  },

  deployments() {
    const wanted = a ? { aprobada: "approved", enviada: "sent", cancelada: "cancelled" }[a] || a : null;
    json(load().deployments.filter((x) => !wanted || x.status === wanted).slice(0, 10));
  },

  "deployment-update"() {
    const patch = JSON.parse(b || readStdin());
    if (patch.status === "enviada") patch.status = "sent";
    const error = mutate((d) => {
      const x = d.deployments.find((y) => y.id === a);
      if (!x) return `no existe ${a}`;
      const extra = Object.keys(patch).filter((k) => !["status", "sentAt", "reply"].includes(k));
      if (extra.length) return `solo se pueden cambiar status, sentAt y reply (sobra: ${extra.join(", ")})`;
      if (patch.status && patch.status !== "sent") return `un despliegue solo lo ordena o lo cancela ${ME}, en el tablero`;
      if (patch.status === "sent" && !(x.status === "approved" && x.approvedVia === "board")) return `${a} no está esperando envío: no se puede marcar como enviado`;
      if (patch.status === "sent" && !patch.sentAt) patch.sentAt = now();
      Object.assign(x, patch);
      return "";
    });
    if (error) fail(error);
    console.log(`${a} actualizado`);
  },

  report() {
    const text = (a || readStdin()).trim();
    if (!text) fail("falta el texto del reporte");
    const empty = isEmptyReport(text);
    mutate((d) => {
      const at = now();
      const requested = d.refreshRequest && !d.refreshRequest.handled;
      const request = requested ? d.refreshRequest.id : null;
      d.lastReview = { at, text, empty, request };
      if (!empty) {
        d.reports.unshift({ at, text, request });
        d.reports = d.reports.filter((x) => !isEmptyReport(x.text)).slice(0, 20);
      }
      if (requested) d.refreshRequest.handled = true;
    });
    const counted = markCounted();
    console.log(`reporte guardado${empty ? " (sin novedades: la página sigue enseñando el último reporte con contenido)" : ""}${counted ? `; ${counted} evento(s) de Jira quedan como contados` : ""}`);
  },

  reporter() {
    json(state().reporterStatus);
  },

  "board-session"() {
    json(state().boardStatus);
  },

  startup() {
    require("./startup").launchStartup(a === "--child" || a === "--hijo");
  },

  "push-test"() {
    sendPush("test", true).then((n) => console.log(`aviso de prueba enviado a ${n} de ${subscriptions().length} dispositivo(s)`));
  },

  followup() {
    const person = personOption();
    const text = (withoutOptions()[0] || readStdin()).trim();
    if (!text) fail("falta el texto del resumen");
    const { DEFAULT_PERSON, nameOf } = require("./follow-up");
    mutate((d) => {
      d.followUps.unshift({ at: now(), text, person });
      d.followUps = d.followUps.slice(0, 120);
      const p = d.followUpRequest;
      if (p && !p.handled && (p.person || DEFAULT_PERSON) === person) Object.assign(p, { handled: true, handledAt: now() });
    });
    console.log(`resumen de seguimiento de ${nameOf(person)} guardado en el tablero`);
  },

  people() {
    json(require("./follow-up").people(load()));
  },

  "person-accounts"() {
    const accounts = process.argv
      .slice(4)
      .join(",")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!a || !accounts.length) fail("Uso: board.js person-accounts <persona> <correo>[,<correo>…]");
    if (!require("./follow-up").saveAccounts(a, accounts)) fail(`persona desconocida: ${a}`);
    console.log(`cuentas de ${a} guardadas: ${accounts.join(", ")}`);
  },

  "followup-error"() {
    const person = personOption();
    const { DEFAULT_PERSON } = require("./follow-up");
    const text = (withoutOptions().join(" ") || readStdin()).trim().slice(0, 3000);
    if (!text) fail("Uso: board.js followup-error [--person <id>] <posible error, con hora, cuenta, operación, respuesta y api_request_id>");
    const id = mutate((d) => {
      const r = d.followUps.find((x) => (x.person || DEFAULT_PERSON) === person);
      if (!r) return "";
      const at = now();
      const created = "err-" + at.replace(/[^0-9]/g, "").slice(0, 17);
      r.errors = (r.errors || []).concat({ id: created, text, state: "proposed", at });
      return created;
    });
    if (!id) fail("no hay ningún resumen de esa persona al que colgarlo: publica antes el resumen");
    console.log(`posible error ${id} añadido al último resumen; ${ME} decide si se envía a Errores sentry`);
    sendPush("followup", true, `Posible error en el seguimiento de ${require("./follow-up").nameOf(person)}`).then(
      () => {},
      () => {}
    );
  },

  "error-sent"() {
    const ids = keyList(process.argv.slice(3).join(","));
    const n = mutate((d) => {
      let k = 0;
      for (const r of d.followUps) {
        for (const e of r.errors || []) {
          if (!ids.includes(e.id) || e.state !== "approved" || e.approvedVia !== "board") continue;
          Object.assign(e, { state: "sent", sentAt: now() });
          k++;
        }
      }
      return k;
    });
    console.log(`${n} de ${ids.length} posible(s) error(es) marcados como enviados a Errores sentry`);
    if (n < ids.length) process.exit(1);
  },

  "error-result"() {
    const ids = keyList(a);
    const text = rest(4).slice(0, 1500);
    if (!ids.length || !text) fail("Uso: board.js error-result <id>[,<id>…] <qué se ha encontrado o hecho, en pocas líneas>");
    const n = mutate((d) => {
      let k = 0;
      for (const r of d.followUps) {
        for (const e of r.errors || []) {
          if (!ids.includes(e.id) || !["approved", "sent"].includes(e.state)) continue;
          e.result = { text, at: now() };
          if (e.state === "approved") Object.assign(e, { state: "sent", sentAt: now() });
          k++;
        }
      }
      return k;
    });
    console.log(`${n} de ${ids.length} posible(s) error(es) con su resultado guardado en el tablero`);
    if (n) sendPush("followup", true, "La sesión de errores ha contestado").then(() => {}, () => {});
    if (n < ids.length) process.exit(1);
  },

  "followup-status"() {
    json(state().followUpStatus);
  },

  "tidy-status"() {
    const d = load();
    json({ contextTidy: d.contextTidy || null, blockers: tidyBlockers(d), lastPass: lastContextPass() });
  },

  message() {
    let m = null;
    mutate((d) => {
      m = d.messages.find((x) => x.id === a) || null;
      if (m && !m.readAt) m.readAt = now();
    });
    if (!m) fail(`no existe el mensaje ${a}`);
    const time = new Date(m.at).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
    console.log(`Mensaje de ${ME} (${m.id}, ${time}) para ${MESSAGE_TARGETS[m.to]}:\n${m.text}`);
  },

  "answer-message"() {
    const text = rest(4).slice(0, 4000);
    if (!text) fail("Uso: board.js answer-message <id> <respuesta>");
    const ok = mutate((d) => {
      const m = d.messages.find((x) => x.id === a);
      if (!m) return false;
      m.readAt = m.readAt || now();
      m.replies = (m.replies || []).concat({ at: now(), text }).slice(-10);
      m.reply = text;
      return true;
    });
    if (!ok) fail(`no existe el mensaje ${a}`);
    console.log("respuesta guardada en el tablero");
    const target = (load().messages.find((x) => x.id === a) || {}).to;
    sendPush("reply", true, `Te ha contestado ${MESSAGE_TARGETS[target] || "una sesión"}`).then(
      () => {},
      () => {}
    );
  },

  progress() {
    const text = rest(4).slice(0, 300);
    if (!text) fail("Uso: board.js progress <id> <en qué estás, en una línea>");
    const ok = mutate((d) => {
      const m = d.messages.find((x) => x.id === a);
      if (!m) return false;
      m.readAt = m.readAt || now();
      m.progress = { at: now(), text };
      return true;
    });
    if (!ok) fail(`no existe el mensaje ${a}`);
    console.log("progreso guardado en el tablero");
  },

  counted() {
    console.log(`${markCounted()} evento(s) de Jira marcados como contados sin publicar reporte`);
  },

  "refresh-request"() {
    const p = load().refreshRequest;
    console.log(p && !p.handled ? JSON.stringify(p) : "ninguna");
  },

  sessions() {
    const list = [].concat(JSON.parse(a || readStdin()));
    mutate((d) => {
      d.sessions = { list, syncedAt: now() };
    });
    console.log(`${list.length} sesión(es) guardada(s)`);
    console.log(`${assignRefs(list)} referencia(s) casada(s) con su conversación`);
  },

  epics() {
    const list = [].concat(JSON.parse(a || readStdin()));
    mutate((d) => {
      const at = now();
      for (const e of list) if (e.key) d.seenEpics[e.key] = { name: e.name || e.key, seenAt: at };
    });
    console.log(`${list.length} bloque(s) anotado(s)`);
  },

  "jira-epics"() {
    syncJiraEpics().then(
      (n) => console.log(n + " epics leídos de Jira"),
      (e) => fail("Error: " + e.message)
    );
  },

  open() {
    const st = state();
    const asTarget = (x) => x && { name: x.title, conversation: x.conversation, open: x.open, sessionName: x.session };
    const role = ["orchestrator", "orquestador"].includes(a) ? asTarget(st.orchestrator) : ["followup", "seguimiento"].includes(a) ? asTarget(st.followUpStatus) : ["board", "tablero"].includes(a) ? asTarget(st.boardStatus) : null;
    const target = role || st.areas.find((x) => x.id === a || (x.name && titleKey(x.name) === titleKey(a)));
    if (!target) fail(`sesión desconocida: ${a}`);
    if (!UUID.test(target.conversation || "")) fail(`«${target.name}» no tiene una conversación enlazada: ábrela a mano en VS Code una vez.`);
    if (target.open) return console.log(`«${target.name}» ya está abierta (${target.sessionName}).`);
    openInVsCode(target.conversation);
    console.log(`Pedido a VS Code que abra «${target.name}». Comprueba con \`areas\` que pasa a open.`);
  },

  "learning-read"() {
    require("./learning")
      .readJira()
      .then(
        (n) => console.log(`${n} ticket(s) leídos de Jira para la pestaña Aprendizaje`),
        (e) => fail(String(e.message || e))
      );
  },

  cause() {
    const cause = CAUSE[b] || b;
    const note = rest(5).slice(0, 600);
    if (!a || !["written", "new"].includes(cause) || !note) fail("Uso: board.js cause <CLAVE> written|new <dónde estaba escrito, o qué se ha apuntado ahora>");
    const withCard = require("./learning").saveCause(a, cause, note);
    console.log(`causa de la devolución de ${a} apuntada como «${cause}»${withCard ? "" : " (sin tarjeta en el tablero)"}`);
  },

  areas() {
    json(state().areas);
  },

  "jira-setup"() {
    const { jiraGet } = require("./jira");
    const issue = a && /^[A-Z][A-Z0-9]+-\d+$/.test(a) ? a : null;
    const reviewer = rest(issue ? 4 : 3);
    (async () => {
      const me = await jiraGet("/myself");
      const out = { me: { id: me.accountId, name: me.displayName } };
      if (reviewer) out.reviewerCandidates = (await jiraGet(`/user/search?query=${encodeURIComponent(reviewer)}`)).filter((u) => u.accountType === "atlassian").map((u) => ({ id: u.accountId, name: u.displayName }));
      out.statuses = {};
      for (const p of config.jira.projects) {
        try {
          const types = await jiraGet(`/project/${encodeURIComponent(p)}/statuses`);
          out.statuses[p] = [...new Set(types.flatMap((t) => t.statuses.map((s) => s.name)))];
        } catch (e) {
          out.statuses[p] = `no se pudo leer (${e.message})`;
        }
      }
      if (issue) out.transitionsFrom = { issue, transitions: ((await jiraGet(`/issue/${issue}/transitions`)).transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to && t.to.name })) };
      json(out);
    })().catch((e) => fail(String(e.message || e)));
  },
};

function sessionNotice() {
  const args = process.argv.slice(3);
  const keys = keyList(args[0]);
  const text = args
    .slice(1)
    .join(" ")
    .trim()
    .slice(0, cmd === "comment" ? 5000 : 1200);
  if (!keys.length || !text) fail(`Uso: board.js done <CLAVE>[,<CLAVE>…] <qué se ha hecho y en qué proyectos> | partial <CLAVE>[,…] <motivo claro> | question <CLAVE>[,…] <pregunta para ${ME}> | comment <CLAVE> <comentario propuesto para Jira; ${config.jira.reviewer.mentions[0] || "@revisor"} lo menciona>`);
  const newStatus = ["question", "comment"].includes(cmd) ? "waiting" : cmd;
  const type = NOTICE_OF[cmd];
  const errors = mutate((d) => {
    const out = [];
    for (const k of keys) {
      const t = d.tasks[k];
      if (!t) out.push(`${k} no tiene tarjeta en el tablero: cuéntaselo a ${ME} en tu propia sesión`);
      else if (!IN_SESSION.includes(t.status) || t.manual) out.push(`${k} no está en ninguna sesión según el tablero (estado: ${t.status}${t.manual ? ", resuelta a mano" : ""})`);
      else {
        const at = now();
        t.status = newStatus;
        t.notice = { type, text, at };
        t.history = (t.history || []).concat({ type, text, at }).slice(-10);
        if (t.answer && t.answer.delivered) delete t.answer;
      }
    }
    return out;
  });
  for (const e of errors) console.error(e);
  console.log(`${keys.length - errors.length} de ${keys.length} anotada(s) como «${cmd}» en el tablero`);
  const end = () => {
    if (errors.length) process.exit(1);
  };
  const what = { partial: "se ha quedado a medias", question: "tiene una pregunta para ti", comment: "propone un comentario para Jira" }[cmd];
  if (cmd !== "done" && keys.length > errors.length) sendPush("sessions", true, `${keys.filter((k) => !errors.some((e) => e.startsWith(k))).join(", ")} ${what}`).then(end, end);
  else end();
}

function sentOrReply() {
  const args = process.argv.slice(3);
  const keys = cmd === "sent" ? args : keyList(args[0]);
  const text = cmd === "reply" ? args.slice(1).join(" ").trim().slice(0, 600) : "";
  if (!keys.length || (cmd === "reply" && !text)) fail("Uso: board.js sent <CLAVE|id>… | board.js reply <CLAVE|id>[,<CLAVE>…] <texto>");
  const errors = mutate((d) => {
    const out = [];
    for (const k of keys) {
      const t = d.tasks[k];
      const x = d.deployments.find((y) => y.id === k);
      const item = t || x;
      if (!item) out.push(`no existe ${k}`);
      else if (cmd === "reply") item.reply = text;
      else if (item.status !== "approved" || !(t ? HUMAN_APPROVALS.includes(t.approvedVia) : x.approvedVia === "board")) out.push(`${k} no está aprobada por ${ME} y esperando envío`);
      else {
        Object.assign(item, { status: "sent", sentAt: now() });
        delete item.changes;
      }
    }
    return out;
  });
  for (const e of errors) console.error(e);
  console.log(`${keys.length - errors.length} de ${keys.length} ${cmd === "sent" ? "marcada(s) como enviada(s)" : "con la respuesta guardada"}`);
  if (errors.length) process.exit(1);
}

function contextTidy() {
  const text = rest(4).slice(0, 4000);
  const error = mutate((d) => {
    const o = d.contextTidy;
    if (!o || o.id !== a) return `no hay ninguna ordenación ${a || ""}`;
    if (cmd === "tidy-start") {
      if (o.status !== "approved" || o.approvedVia !== "board") return `esa ordenación no está aprobada por ${ME} en el tablero`;
      Object.assign(o, { status: "in-progress", startedAt: now() });
    } else {
      if (o.status !== "in-progress") return "esa ordenación no está en curso";
      Object.assign(o, { status: "done", finishedAt: now(), summary: text || "Hecha." });
    }
    return "";
  });
  if (error) fail(error);
  console.log(cmd === "tidy-start" ? `${a} en curso` : `${a} terminada; resumen guardado en el tablero`);
}

for (const c of ["done", "partial", "question", "comment"]) commands[c] = sessionNotice;
for (const c of ["sent", "reply"]) commands[c] = sentOrReply;
for (const c of ["tidy-start", "tidy-end"]) commands[c] = contextTidy;

if (Object.prototype.hasOwnProperty.call(commands, cmd)) commands[cmd]();
else
  console.log(
    "Uso: node board.js serve | ensure | restart | add [json] | list [status] | update <key> [json] | approve-chat <key> <area> | report [text] | reporter | board-session | watch [reports|dispatches|board] | refresh-request | sessions [json] | epics [json] | jira-epics | open <session> | areas | dispatches | attachments <key> | done | partial | question | comment | delivered | sent | reply | changes | orchestrator | deployments | deployment-update | startup | push-test | followup | followup-error | error-sent | error-result | followup-status | people | person-accounts | tidy-status | tidy-start | tidy-end | message | answer-message | progress | counted | learning-read | cause | jira-setup [ISSUE-KEY] [reviewer name]"
  );

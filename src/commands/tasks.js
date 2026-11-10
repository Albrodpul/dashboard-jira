const { STATUSES, IN_SESSION, HUMAN_APPROVALS, UUID, DATA_DIR, now, load, mutate, readStdin } = require("../core/data");
const { titleKey, assignRefs, loadRoutes, openInVsCode } = require("../sessions/registry");
const { syncJiraEpics, downloadAttachments } = require("../jira/client");
const { sendPush } = require("../server/push");
const { TASK_KIND, CAUSE } = require("../core/migrate");
const config = require("../core/config");
const { state } = require("../server/state");
const holds = require("../features/holds");
const { cmd, a, b, rest, keyList, json, status, ME, MY_FIRST_NAME, fail } = require("./args");

function removedCard(d, t) {
  if (!["returned", "comment"].includes(t.kind) || !d.deleted || !d.deleted[t.key]) return null;
  let found = null;
  try {
    const lines = require("fs").readFileSync(require("path").join(DATA_DIR, "task-history.jsonl"), "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes(`"${t.key}"`)) continue;
      const r = JSON.parse(line);
      if (r.key === t.key && r.area) found = r;
    }
  } catch (e) {}
  return found && { area: found.area, status: found.status === "partial" ? "done" : found.status, removed: true };
}

const NOTICE_OF = { done: "done", partial: "partial", question: "question", comment: "comment" };

const commands = {
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
        const previous = d.tasks[t.key] || removedCard(d, t);
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
        const task = { ...fields, project: fields.project || (previous && previous.project) || require("../core/projects").projectOf(fields), status: "pending", events: ((previous && previous.events) || []).concat(event ? [event] : []).slice(-20) };
        d.tasks[t.key] = task;
        if (previous && previous.removed && d.deleted) delete d.deleted[t.key];
        if (comesBack) {
          task.proposedArea = fields.proposedArea || previous.area || previous.proposedArea || "";
          task.rounds = (previous.rounds || 0) + 1;
          const held = d.config && d.config.autoReturned && previous.area ? holds.checkTask(d, task, previous.area) : "";
          if (held) out.push(`${t.key}: ya estaba ${previous.status}; tu regla de devueltas la mandaría sola, pero ${held} Queda en Pendientes.`);
          else if (d.config && d.config.autoReturned && previous.area) {
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
    if (r.pending) sendPush("tasks", false, r.pending === 1 ? "Hay una tarea nueva en Pendientes" : `Hay ${r.pending} tareas nuevas en Pendientes`).then((n) => n && console.log(`aviso enviado a ${n} dispositivo(s)`));
  },

  "task-new"() {
    const argv = process.argv.slice(3);
    const at = argv.indexOf("--project");
    const project = at >= 0 ? argv[at + 1] : undefined;
    const words = at >= 0 ? argv.filter((x, i) => i !== at && i !== at + 1) : argv;
    const r = mutate((d) => require("../features/manual-tasks").createTask(d, { project, title: words[0], description: words.slice(1).join(" ") }));
    if (r.error) fail(r.error);
    console.log(`${r.key} creada en Pendientes`);
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
      if (patch.status === "sent" && holds.checkTask(d, t, t.area)) return holds.checkTask(d, t, t.area);
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
      const held = holds.checkTask(d, t, area);
      if (held) return held;
      Object.assign(t, { status: "approved", area, decidedAt: now(), approvedVia: "chat" });
      delete t.delivery;
      return "";
    });
    if (error) fail(error);
    console.log(`${a} aprobada por orden de ${ME} en el chat -> ${area}`);
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

  areas() {
    json(state().areas);
  },

  "learning-read"() {
    require("../jira/learning")
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
    const withCard = require("../jira/learning").saveCause(a, cause, note);
    console.log(`causa de la devolución de ${a} apuntada como «${cause}»${withCard ? "" : " (sin tarjeta en el tablero)"}`);
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
      else if (t ? holds.checkTask(d, t, t.area) : holds.checkArea(d, `El despliegue ${k}`, x.area)) out.push(t ? holds.checkTask(d, t, t.area) : holds.checkArea(d, `El despliegue ${k}`, x.area));
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

for (const c of ["done", "partial", "question", "comment"]) commands[c] = sessionNotice;
for (const c of ["sent", "reply"]) commands[c] = sentOrReply;

module.exports = commands;

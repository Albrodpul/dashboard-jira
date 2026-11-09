const { HUMAN_APPROVALS, isEmptyReport, now, load, mutate, markCounted, readStdin } = require("../core/data");
const { downloadAttachments } = require("../jira/client");
const { sendPush } = require("../server/push");
const config = require("../core/config");
const { ERRORS_AREA, MESSAGE_TARGETS, state, tidyBlockers, lastContextPass, followUpErrors } = require("../server/state");
const { sentryIssues } = require("../features/sentry");
const { cmd, a, b, rest, json, ME, fail } = require("./args");
const holds = require("../features/holds");
const mailman = require("../features/mailman");

function destinationOf(s) {
  return (id) => {
    const x = s.areas.find((y) => y.id === id);
    return x ? { session: x.name, sendTo: x.repeatedName && x.ref ? `${x.sessionName} [${x.ref}]` : x.sessionName, open: x.open, repeatedName: x.repeatedName, ref: x.ref } : null;
  };
}

const commands = {
  dispatches() {
    const s = state();
    const destination = destinationOf(s);
    const d = load();
    const approved = s.tasks.filter((t) => t.status === "approved" && HUMAN_APPROVALS.includes(t.approvedVia));
    const held = approved.filter((t) => holds.checkTask(d, t, t.area)).map((t) => ({ key: t.key, area: t.area, error: holds.checkTask(d, t, t.area) }));
    const tasks = approved
      .filter((t) => !holds.checkTask(d, t, t.area))
      .map((t) => ({ key: t.key, title: t.title, kind: t.kind, epic: [t.epicKey, t.epicName].filter(Boolean).join(" "), approvedVia: t.approvedVia, assignee: t.assignee || "sin asignar", note: mailman.taskNote(t), mandatory: holds.notesFor(d, holds.taskTarget(t, t.area)).map((r) => `${r.id}: ${r.reason}`), delivery: t.delivery || null, area: t.area, destination: destination(t.area) }));
    const deployments = s.deployments
      .filter((x) => x.status === "approved" && x.approvedVia === "board" && !holds.checkArea(d, x.id, x.area))
      .map((x) => ({ id: x.id, projects: x.projects, environment: x.environment, version: x.version, area: x.area, delivery: x.delivery || null, destination: destination(x.area) }));
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
        .filter((e) => e.state === "approved" && e.approvedVia === "board" && !holds.checkArea(d, e.id, ERRORS_AREA))
        .map((e) => ({ id: e.id, text: e.text, seenAt: e.at, destination: destination(ERRORS_AREA) }));
      const sentry = sentryIssues(load())
        .filter((x) => x.state === "approved" && x.approvedVia === "board" && !holds.checkArea(d, x.id, x.area))
        .map((x) => ({ id: x.id, title: x.title, culprit: x.culprit, project: x.project, url: x.url, events: x.count, users: x.users, lastSeen: x.lastSeen, again: x.rounds > 1, destination: destination(x.area) }));
      json({ deliveredBy: "board", note: `El tablero entrega todo esto solo, en cuanto ${ME} lo aprueba: esta lista es para consultar. No lo envíes tú.`, tasks, held, deployments, answers, errors, sentry });
    })();
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
      if (patch.status === "sent" && holds.checkArea(d, `El despliegue ${a}`, x.area)) return holds.checkArea(d, `El despliegue ${a}`, x.area);
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

  counted() {
    console.log(`${markCounted()} evento(s) de Jira marcados como contados sin publicar reporte`);
  },

  "refresh-request"() {
    const p = load().refreshRequest;
    console.log(p && !p.handled ? JSON.stringify(p) : "ninguna");
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

  "jira-setup"() {
    const { jiraGet } = require("../jira/client");
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

for (const c of ["tidy-start", "tidy-end"]) commands[c] = contextTidy;

module.exports = commands;

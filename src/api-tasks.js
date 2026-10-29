const { IN_SESSION, now, load, mutate } = require("./data");
const { loadRoutes, realArea, sessionsCli } = require("./sessions");
const { ME, jiraSearch, jiraRequest, summarizeIssue, adfFromText } = require("./jira");
const config = require("./config");
const { state, openIfClosed, wakeOrchestrator, isPaused, wakeReporter } = require("./state");

const RESUME_NOTICE = `Aviso del tablero: reanuda las revisiones. Compruébalo con «${config.cli} reporter» (paused: false) y sigue «Pausa» de .claude/commands/resumen-jira.md.`;
const REVIEW_NOTICE = `Aviso del tablero: ${config.jira.me.name} pide una revisión. Compruébalo con «${config.cli} refresh-request» y sigue «Pausa» de .claude/commands/resumen-jira.md.`;
const DAY = 24 * 3600 * 1000;

function routeEpic(t) {
  if (!t.epicKey || !t.area) return;
  const r = loadRoutes();
  const routed = Object.values(r.areas).some((a) => a.epics && a.epics[t.epicKey]);
  if (!routed && r.areas[t.area]) sessionsCli("route", t.epicKey, t.area, t.epicName || t.epicKey);
}

function handleTask(res, { key, patch }, send) {
  const byHand = patch.status === "sent" && patch.manual === true;
  if (patch.status && !byHand && !["pending", "approved", "ignored"].includes(patch.status)) return send(res, 400, { error: "estado no permitido" });
  const area = patch.area ? realArea(patch.area) || patch.area : patch.area;
  const result = mutate((d) => {
    const task = d.tasks[key];
    if (!task) return { code: 404, error: "tarea desconocida" };
    if (IN_SESSION.includes(task.status) && patch.status === "pending" && patch.resend === true) {
      const changes = (task.changes || []).map((c) => c.text);
      Object.assign(task, {
        status: "pending",
        kind: "resend",
        proposedArea: task.area || task.proposedArea || "",
        note: "Ya se envió una vez. Vuelve a enviarse para que la sesión relea el ticket y sus adjuntos.",
        noteBy: "Tablero",
        previousReply: task.reply || task.previousReply || null,
        rounds: (task.rounds || 0) + 1,
        decidedAt: null,
      });
      if (!task.at || (task.sentAt && task.sentAt > task.at && !changes.length)) task.at = task.sentAt || task.at;
      for (const k of ["sentAt", "reply", "manual", "approvedVia", "area", "notice", "answer"]) delete task[k];
      return { code: 200, task: { ...task } };
    }
    if (IN_SESSION.includes(task.status) && !(task.manual && patch.status === "pending")) return { code: 409, error: "ya enviada" };
    if (byHand && task.status === "approved") return { code: 409, error: "ya está aprobada: la envía la sesión que orquesta" };
    if (task.manual && patch.status === "pending") {
      delete task.manual;
      delete task.sentAt;
    }
    if (patch.status) task.status = patch.status;
    if (byHand) {
      Object.assign(task, { manual: true, sentAt: now(), decidedAt: now(), approvedVia: "manual" });
      return { code: 200, task: { ...task } };
    }
    if (patch.area !== undefined) task.area = area;
    if (patch.status === "approved") {
      task.decidedAt = now();
      task.approvedVia = "board";
    } else if (patch.status) {
      task.decidedAt = patch.status === "ignored" ? now() : null;
      delete task.approvedVia;
    }
    return { code: 200, task: { ...task } };
  });
  if (result.code !== 200) return send(res, result.code, { error: result.error });
  const t = result.task;
  if (patch.status === "approved" && t.area) {
    openIfClosed(t.area);
    wakeOrchestrator();
    routeEpic(t);
  }
  send(res, 200);
}

function handleBatch(res, { items }, send) {
  if (!Array.isArray(items) || !items.length) return send(res, 400, { error: "faltan las tareas" });
  const routes = loadRoutes();
  const pairs = items.map((i) => ({ key: String(i.key), area: realArea(i.area) }));
  if (pairs.some((p) => !p.area || !routes.areas[p.area])) return send(res, 400, { error: "todas las tareas necesitan una sesión" });
  const approved = mutate((d) => {
    const at = now();
    const out = [];
    for (const p of pairs) {
      const task = d.tasks[p.key];
      if (!task || task.status !== "pending") continue;
      Object.assign(task, { status: "approved", area: p.area, decidedAt: at, approvedVia: "board" });
      out.push({ ...task });
    }
    return out;
  });
  const areas = state().areas;
  for (const id of new Set(approved.map((t) => t.area))) openIfClosed(id, areas);
  const epics = new Set();
  for (const t of approved) {
    if (!t.epicKey || epics.has(t.epicKey)) continue;
    epics.add(t.epicKey);
    routeEpic(t);
  }
  if (approved.length) wakeOrchestrator();
  send(res, 200, { approved: approved.length });
}

function markDeleted(d, k) {
  const t = d.tasks[k];
  if (t && t.sentAt) {
    try {
      require("fs").appendFileSync(require("path").join(require("./data").DATA_DIR, "task-history.jsonl"), JSON.stringify({ key: t.key, title: t.title, epicName: t.epicName || null, kind: t.kind || null, status: t.status, sentAt: t.sentAt, area: t.area || null, removedAt: now() }) + "\n");
    } catch (e) {}
  }
  delete d.tasks[k];
  d.deleted = d.deleted || {};
  d.deleted[k] = now();
}

function handleDelete(res, { keys }, send) {
  const list = (Array.isArray(keys) ? keys : []).map(String).slice(0, 500);
  if (!list.length) return send(res, 400, { error: "faltan las tareas" });
  const deleted = mutate((d) => {
    let n = 0;
    for (const k of list) {
      const t = d.tasks[k];
      if (!t || !["sent", "ignored", "done", "partial"].includes(t.status)) continue;
      markDeleted(d, k);
      n++;
    }
    const limit = Date.now() - 30 * DAY;
    for (const [k, at] of Object.entries(d.deleted || {})) if (new Date(at).getTime() < limit) delete d.deleted[k];
    return n;
  });
  send(res, 200, { deleted });
}

function archiveDone() {
  const limit = Date.now() - DAY;
  mutate((d) => {
    for (const [k, t] of Object.entries(d.tasks)) {
      if (t.status === "done" && t.jiraClosedAt && new Date(t.jiraClosedAt).getTime() <= limit) markDeleted(d, k);
    }
  });
}

function handleAnswer(res, { key, text }, send) {
  const clean = String(text || "").trim().slice(0, 2000);
  if (!clean) return send(res, 400, { error: "escribe la respuesta" });
  const error = mutate((d) => {
    const t = d.tasks[key];
    if (!t) return "tarea desconocida";
    if (!["waiting", "partial"].includes(t.status)) return "esta tarea no espera respuesta";
    t.answer = { text: clean, at: now(), delivered: false };
    return "";
  });
  if (error) return send(res, 409, { error });
  wakeOrchestrator();
  send(res, 200);
}

function handleReviewed(res, { key }, send) {
  const t = load().tasks[key];
  if (!t || t.status !== "done") return send(res, 409, { error: "solo se marcan revisadas las tareas hechas" });
  (async () => {
    const { transitions } = await jiraRequest("GET", `/issue/${encodeURIComponent(key)}/transitions`);
    const tr = (transitions || []).find((x) => config.statuses.reviewRegex.test((x.to && x.to.name) || x.name || ""));
    if (!tr) throw new Error(`en Jira no hay paso a ${config.statuses.review} desde el estado actual`);
    await jiraRequest("POST", `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: tr.id } });
    mutate((d) => {
      if (d.tasks[key]) d.tasks[key].reviewedAt = now();
    });
  })()
    .then(() => send(res, 200))
    .catch((e) => send(res, 502, { error: String(e.message || e) }));
}

function handleComment(res, { key, text }, send) {
  const clean = String(text || "").trim().slice(0, 5000);
  if (!clean) return send(res, 400, { error: "el comentario está vacío" });
  const t = load().tasks[key];
  if (!t || t.status !== "waiting" || !t.notice || t.notice.type !== "comment") return send(res, 409, { error: "esta tarea no tiene un comentario propuesto" });
  const changed = clean !== String(t.notice.text || "").trim();
  jiraRequest("POST", `/issue/${encodeURIComponent(key)}/comment`, { body: adfFromText(clean) })
    .then(() => {
      mutate((d) => {
        const x = d.tasks[key];
        if (!x) return;
        const at = now();
        x.publishedComment = { at, text: clean };
        x.answer = { text: `${config.jira.me.name} ha publicado en Jira tu comentario${changed ? " con cambios" : " tal cual"}. Texto publicado: «${clean}». Sigue con la tarea cuando haya respuesta en Jira, o con lo que no dependa de ella.`, at, delivered: false };
      });
      wakeOrchestrator();
      send(res, 200);
    })
    .catch((e) => send(res, 502, { error: String(e.message || e) }));
}

function handleConfig(res, input, send) {
  mutate((d) => {
    d.config = d.config || {};
    if ("autoReturned" in input) d.config.autoReturned = !!input.autoReturned;
    if ("paused" in input) {
      d.config.paused = !!input.paused;
      d.config.pausedAt = input.paused ? now() : null;
    }
  });
  if (input.paused === false) {
    wakeReporter(RESUME_NOTICE).catch(() => {});
    require("./startup").wakeFollowUp().catch(() => {});
  }
  send(res, 200);
}

function handleRefresh(res, send) {
  const request = mutate((d) => {
    if (!d.refreshRequest || d.refreshRequest.handled) {
      const at = now();
      d.refreshRequest = { id: at, at, handled: false };
    }
    return d.refreshRequest;
  });
  if (isPaused(load())) wakeReporter(REVIEW_NOTICE).catch(() => {});
  send(res, 200, request);
}

function handleSearch(res, { q, onlyAvailable, skipReview }, send) {
  const text = String(q || "").replace(/["\\]/g, " ").trim().slice(0, 80);
  let jql = `${config.jira.projectsJql} AND issuetype != Epic AND statusCategory != Done`;
  if (/^[A-Za-z]+-\d+$/.test(text)) jql += ` AND key = "${text.toUpperCase()}"`;
  else if (text) jql += ` AND summary ~ "${text}*"`;
  if (onlyAvailable !== false) jql += ` AND (assignee is EMPTY OR assignee = "${ME}")`;
  if (skipReview !== false) jql += ` AND status != "${config.statuses.review}"`;
  jql += " ORDER BY created DESC";
  jiraSearch(jql, 60)
    .then((issues) => {
      const d = load();
      const routes = loadRoutes();
      send(res, 200, { items: issues.map((i) => summarizeIssue(i, d, routes)), capped: issues.length >= 60 });
    })
    .catch(() => send(res, 502, { error: "No se pudo consultar Jira" }));
}

function handleImport(res, { keys }, send) {
  const list = (Array.isArray(keys) ? keys : []).map(String).filter((k) => /^[A-Z]+-\d+$/.test(k)).slice(0, 60);
  if (!list.length) return send(res, 400, { error: "faltan las tareas" });
  jiraSearch(`key in (${list.join(",")})`, 60)
    .then((issues) => {
      const routes = loadRoutes();
      const skipped = [];
      const imported = mutate((d) => {
        let n = 0;
        const at = now();
        for (const i of issues) {
          const x = summarizeIssue(i, d, routes);
          if (x.onBoard) {
            skipped.push({ key: x.key, reason: "ya estaba en el tablero" });
            continue;
          }
          if (!x.available) {
            skipped.push({ key: x.key, reason: "la lleva " + x.assignee });
            continue;
          }
          d.tasks[x.key] = {
            key: x.key,
            title: x.title,
            kind: x.rejected && x.assignee ? "returned" : "new",
            epicKey: x.epicKey,
            epicName: x.epicName,
            assignee: x.assignee,
            note: "Traída de Jira a mano. Estado en Jira: " + x.status + (x.rejected ? `, con etiqueta ${config.statuses.rejectLabel}.` : "."),
            noteBy: "Tablero",
            at,
            proposedArea: x.area,
            status: "pending",
          };
          n++;
        }
        return n;
      });
      send(res, 200, { imported, skipped });
    })
    .catch(() => send(res, 502, { error: "No se pudo consultar Jira" }));
}

module.exports = { handleTask, handleBatch, handleDelete, archiveDone, handleAnswer, handleReviewed, handleComment, handleConfig, handleRefresh, handleSearch, handleImport };

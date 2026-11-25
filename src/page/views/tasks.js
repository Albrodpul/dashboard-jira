import { renderPermissions } from "../components/permissions.js";
import { nutria } from "../components/nutria.js";
import { state, choice, drafts, h, button, when, minutesSince, fmtDay, reviewer, reviewStatus, toast, request, requestOrFail, post, saveTask, whoSends, areaName, taskAreaSelect, areaSelect, render, refresh, switchView, empty, openTicket, limitsFor, holdOf, limitChips } from "../lib/base.js";
import { createSession } from "./sessions.js";
import { mixedProjects, projectName, projectChip, mainProject } from "../components/project-filter.js";
import { t as tr, tn } from "../lib/i18n.js";

const PENDING_CHIP = { returned: tr("Devuelta"), comment: tr("Comentario"), resend: tr("Ya enviada") };
const STATUS_CHIP = { approved: tr("Por enviar"), sent: tr("En curso"), ignored: tr("Ignorada"), waiting: tr("Te espera"), partial: tr("A medias"), done: tr("Hecha") };
const NOTICE_LABEL = { done: tr("Hecha"), partial: tr("A medias"), question: tr("Pregunta"), comment: tr("Comentario propuesto para Jira") };
const EMPTY_LISTS = {
  pending: [tr("Nada pendiente de decidir."), tr("Cuando alguien cree una tarea nueva sin asignar o para ti, te devuelva una o comente en una tuya, aparecerá aquí con su sesión propuesta.")],
  approved: [tr("Nada esperando envío."), tr("Lo que apruebes con Hacer lo escribe el tablero en su sesión en unos segundos, y la abre si está dormida.")],
  sent: [tr("Todavía no se ha enviado nada."), tr("Aquí queda cada tarea enviada, con la respuesta de la sesión que la recibe.")],
  waiting: [tr("Ninguna sesión te está esperando."), tr("Aquí salen las tareas en las que una sesión te pregunta algo o no ha podido terminar, con el motivo.")],
  done: [tr("Todavía no hay tareas hechas."), tr("Cuando una sesión termine una tarea la marca aquí, con lo que ha hecho.")],
  ignored: [tr("No hay tareas ignoradas."), tr("Las que descartes con Ignorar se guardan aquí por si cambias de idea.")],
};
const BACK_TO_PENDING = tr("La devuelve a Pendientes. No se envía nada hasta que pulses Hacer allí.");

const chosenSession = (t) => (choice[t.id] !== undefined ? choice[t.id] : t.proposedArea || "");
const hasChanges = (t) => !!(t.changes && t.changes.length);

function deleteTasks(keys) {
  return requestOrFail("/api/delete", { keys })
    .then((d) => toast(tn(d.deleted, "{n} tarjeta borrada.", "{n} tarjetas borradas.")))
    .catch(() => toast(tr("No se pudieron borrar.")))
    .then(() => refresh(true));
}

const deleteButton = (t) =>
  button(tr("Borrar"), {
    cls: "subtle",
    title: tr("Quita la tarjeta del tablero. En Jira no cambia nada."),
    onClick: (b) => {
      b.disabled = true;
      deleteTasks([t.id]);
    },
  });

function moveToPending(keys, b) {
  if (b) b.disabled = true;
  const queue = [...keys];
  const total = queue.length;
  const next = () => {
    if (!queue.length) {
      toast(tn(total, "{n} tarea está otra vez en Pendientes.", "{n} tareas están otra vez en Pendientes."));
      return refresh(true);
    }
    return request("/api/task", { key: queue.shift(), patch: { status: "pending", resend: true } }).then(next, next);
  };
  return next();
}

const backToPendingButton = (t, primary) =>
  button(tr("Pasar a Pendientes"), {
    cls: primary ? "primary" : "",
    title: BACK_TO_PENDING,
    onClick: (b) => {
      b.disabled = true;
      saveTask(t, { status: "pending", resend: true }, tr("{key} está otra vez en Pendientes.", { key: t.key }));
    },
  });

const undoButton = (t, label = tr("Deshacer")) => button(label, { onClick: () => saveTask(t, { status: "pending" }, tr("{key} vuelve a pendientes.", { key: t.key })) });

function changesList(t, title) {
  return h("div", { class: "changes" }, [h("b", { text: title }), ...t.changes.map((c) => h("div", {}, [h("span", { class: "hour", text: when(c.at) }), " " + c.text]))]);
}

function askNewSession(promptText, defaultName, epic, onCreated) {
  const n = window.prompt(promptText, defaultName);
  if (!n || !n.trim()) return render();
  toast(tr("Creando la sesión nueva en el tablero…"));
  createSession(n, epic, null).then((area) => {
    if (area) onCreated(area);
    render();
  });
}

const openExtras = new Set();
const skipped = {};

function sendOptions(t) {
  const id = `ctx-${t.id}`;
  const box = h("textarea", { class: "reply-box", id, rows: "3", placeholder: tr("Qué hacer, qué no tocar, qué adjunto mirar…"), "aria-label": tr("Indicaciones para la sesión en {key}", { key: t.key }) });
  box.value = drafts[id] || "";
  box.addEventListener("input", () => (drafts[id] = box.value));
  const kids = [box];
  const atts = t.attachments || [];
  if (atts.length) {
    const skip = (skipped[t.id] = skipped[t.id] || new Set());
    kids.push(h("div", { class: "meta", text: tr("Adjuntos que se le pasan (desmarca los que sobran):") }));
    for (const a of atts) {
      const cb = h("input", { type: "checkbox" });
      cb.checked = !skip.has(a.name);
      cb.addEventListener("change", () => (cb.checked ? skip.delete(a.name) : skip.add(a.name)));
      kids.push(h("label", { class: "send-option" }, [cb, h("span", { text: a.name })]));
    }
  }
  const extra = (drafts[id] || "").trim() || (skipped[t.id] && skipped[t.id].size);
  const d = h("details", { class: "send-options" }, [h("summary", { text: extra ? tr("Indicaciones para la sesión (añadidas)") : atts.length ? tr("Añadir indicaciones o quitar adjuntos") : tr("Añadir indicaciones para la sesión") }), h("div", { class: "send-options-body" }, kids)]);
  d.open = openExtras.has(t.id);
  d.addEventListener("toggle", () => (d.open ? openExtras.add(t.id) : openExtras.delete(t.id)));
  return d;
}

function approvePatch(t, area) {
  const patch = { status: "approved", area, extraContext: (drafts[`ctx-${t.id}`] || "").trim() };
  if (skipped[t.id] && skipped[t.id].size) patch.skipAttachments = [...skipped[t.id]];
  return patch;
}

function forgetOptions(t) {
  delete drafts[`ctx-${t.id}`];
  delete skipped[t.id];
  openExtras.delete(t.id);
}

function pendingActions(t) {
  const current = chosenSession(t);
  const sel = taskAreaSelect(`sel-${t.id}`, current, tr("Elige sesión…"), (v) => {
    if (v !== "__new__") {
      choice[t.id] = v;
      return render();
    }
    askNewSession(t.epicKey ? tr("Nombre de la sesión nueva para el epic {key} {name}", { key: t.epicKey, name: t.epicName || "" }) : tr("Nombre de la sesión nueva"), t.epicName || "", t.epicKey ? { key: t.epicKey, name: t.epicName || t.epicKey } : null, (area) => (choice[t.id] = area));
  }, t.project);
  sel.appendChild(h("option", { value: "__new__", text: tr("+ Sesión nueva…") }));
  sel.setAttribute("aria-label", tr("Sesión de destino de {key}", { key: t.key }));
  const held = holdOf(t, current);
  const actions = h("div", { class: "actions" }, [
    sel,
    button(tr("Hacer"), {
      cls: "primary",
      disabled: !current || !!held,
      title: held ? held.chip.title : undefined,
      onClick: () => {
        const patch = approvePatch(t, current);
        forgetOptions(t);
        saveTask(t, patch, tr("{key} aprobada: {who} la envía a {area} en unos segundos.", { key: t.key, who: whoSends(), area: areaName(current) }));
      },
    }),
    button(tr("Resuelta"), { disabled: !!held, title: held ? held.chip.title : tr("Ya la has hecho o mandado tú. Pasa a Enviadas sin avisar a ninguna sesión."), onClick: () => saveTask(t, { status: "sent", manual: true, area: current || undefined }, tr("{key} resuelta a mano: queda en Enviadas.", { key: t.key })) }),
    button(tr("Ignorar"), { onClick: () => saveTask(t, { status: "ignored" }, tr("{key} ignorada.", { key: t.key })) }),
  ]);
  return h("div", {}, [sendOptions(t), actions]);
}

function reviewedButton(t) {
  return button(tr("Revisada"), {
    cls: "primary",
    title: tr("La pasa a {status} en Jira. Pulsarlo es tu orden para ese cambio.", { status: reviewStatus() }),
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/reviewed", { key: t.id })
        .then(() => toast(tr("{key} pasa a {status} en Jira.", { key: t.key, status: reviewStatus() })))
        .catch((e) => {
          b.disabled = false;
          toast(tr("No se pudo pasar {key} a {status}: {error}", { key: t.key, status: reviewStatus(), error: e.message }));
        })
        .then(() => refresh(true));
    },
  });
}

let seenJob = null;

function reviewJobNotice() {
  const j = state.reviewJob;
  if (!j) return null;
  const n = j.done.length + j.failed.length;
  if (!j.finishedAt) {
    seenJob = j.id;
    return h("div", { class: "review-job" }, [h("strong", { text: tr("Pasando a {status}: {n} de {total}", { status: reviewStatus(), n, total: j.total }) }), h("div", { class: `ds-bar running`, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(j.total), "aria-valuenow": String(n) }, [h("i", { style: `width:${Math.round((n / j.total) * 100)}%` })])]);
  }
  if (seenJob === j.id) {
    seenJob = null;
    toast(j.failed.length ? tr("{n} pasadas a {status}; {failed} no: {list}", { n: j.done.length, status: reviewStatus(), failed: j.failed.length, list: j.failed.map((f) => `${f.key} (${f.error})`).join(", ") }) : tr("{n} pasadas a {status} en Jira.", { n: j.done.length, status: reviewStatus() }));
  }
  return null;
}

export function reviewAllButton(list) {
  const running = reviewJobNotice();
  if (running) return running;
  const todo = list.filter((t) => t.status === "done" && !t.reviewedAt);
  if (!todo.length) return null;
  return button(todo.length === 1 ? tr("Pasar a {status} (1)", { status: reviewStatus() }) : tr("Pasar las {n} a {status}", { n: todo.length, status: reviewStatus() }), {
    cls: "primary",
    title: tr("Las pasa todas a {status} en Jira. Pulsarlo es tu orden para ese cambio.", { status: reviewStatus() }),
    onClick: (b) => {
      if (!window.confirm(tn(todo.length, "¿Pasar la tarea a {status} en Jira?", "¿Pasar las {n} tareas a {status} en Jira?", { status: reviewStatus() }))) return;
      b.disabled = true;
      b.textContent = tr("Pasando…");
      requestOrFail("/api/reviewed-all", { keys: todo.map((t) => t.id) })
        .then((r) => {
          seenJob = r.id;
          toast(tr("Pasando {n} a {status}. Puedes seguir con otra cosa; aquí ves el avance.", { n: r.total, status: reviewStatus() }));
        })
        .catch((e) => toast(tr("No se pudo: {error}", { error: e.message })))
        .then(() => refresh(true));
    },
  });
}

function commentProposal(t, kids, acts) {
  const id = `com-${t.id}`;
  const box = h("textarea", { class: "reply-box comment-box", id, rows: "5", "aria-label": tr("Comentario para Jira en {key}", { key: t.key }) });
  box.value = drafts[id] !== undefined ? drafts[id] : t.notice.text;
  box.addEventListener("input", () => (drafts[id] = box.value));
  kids.push(h("div", { class: "meta", text: tr("Puedes cambiar el texto antes de publicarlo. «@{reviewer}» lo menciona.", { reviewer: reviewer() }) }), box);
  acts.push(
    button(tr("Publicar en Jira"), {
      cls: "primary",
      onClick: (b) => {
        const txt = box.value.trim();
        if (!txt) return toast(tr("El comentario está vacío."));
        b.disabled = true;
        requestOrFail("/api/comment", { key: t.id, text: txt })
          .then(() => {
            delete drafts[id];
            toast(tr("Comentario publicado en {key}. La sesión se entera.", { key: t.key }));
          })
          .catch((e) => {
            b.disabled = false;
            toast(tr("No se pudo publicar: {error}", { error: e.message }));
          })
          .then(() => refresh(true));
      },
    })
  );
}

function answerForSession(t, kids, acts, proposal) {
  if (t.answer && !t.answer.delivered) {
    kids.push(h("div", { class: "reply", text: tr("Tu respuesta de las {time}, de camino a la sesión: {text}", { time: when(t.answer.at), text: t.answer.text }) }));
    return;
  }
  const changes = t.status === "done";
  const placeholder = changes ? tr("Qué quieres que cambie: vuelve a la misma sesión con esto…") : proposal ? tr("O, en vez de publicarlo, dile otra cosa a la sesión…") : t.status === "waiting" ? tr("Tu respuesta para la sesión…") : tr("Lo que necesita para seguir (opcional)…");
  const box = h("textarea", { class: "reply-box", id: `resp-${t.id}`, rows: "3", placeholder, "aria-label": tr("Respuesta para la sesión sobre {key}", { key: t.key }) });
  box.value = drafts[t.id] || "";
  box.addEventListener("input", () => (drafts[t.id] = box.value));
  kids.push(box);
  acts.push(
    button(changes ? tr("Pedir cambios") : tr("Responder"), {
      cls: changes ? "" : "primary",
      title: changes ? tr("La devuelve a su sesión con lo que escribas, y vuelve a En curso.") : undefined,
      onClick: (b) => {
        const txt = (drafts[t.id] || "").trim();
        if (!txt) return toast(changes ? tr("Escribe qué quieres que cambie.") : tr("Escribe la respuesta."));
        b.disabled = true;
        requestOrFail("/api/answer", { key: t.id, text: txt })
          .then(() => {
            delete drafts[t.id];
            toast(changes ? tr("{key} vuelve a {area} con tus cambios.", { key: t.key, area: areaName(t.area) || tr("su sesión") }) : tr("Respuesta guardada: {who} se la pasa a la sesión.", { who: whoSends() }));
          })
          .catch((e) => {
            b.disabled = false;
            toast(tr("No se pudo guardar: {error}", { error: e.message }));
          })
          .then(() => refresh(true));
      },
    })
  );
}

function stopLines(t, kids) {
  for (const [id, s] of Object.entries(t.stopNotices || {})) kids.push(h("div", { class: "state-line", text: tr("Aviso de parar entregado a la sesión a las {time} (restricción {id}).", { time: when(s.at), id }) }));
  if (t.stopDelivery && !t.stopDelivery.soft) kids.push(deliveryProblem(t.stopDelivery, "stop", t.key, tr("No se pudo entregar el aviso de parar")));
}

function deliveryProblem(x, kind, id, label = tr("No se pudo entregar")) {
  const done = x.attempts >= 3;
  const head = x.attempts ? tr("{label} ({n} de 3 intentos)", { label, n: x.attempts }) : label;
  return h("div", { class: "delivery-error" }, [
    h("span", { text: `${head}: ${x.error}.${done ? "" : ` ${tr("Se reintenta solo.")}`}` }),
    button(tr("Reintentar"), { onClick: (b) => ((b.disabled = true), post("/api/delivery/retry", { kind, id }, tr("Reintentando la entrega."))) }),
  ]);
}

function sentExtras(t, kids) {
  if (t.extraContext) kids.push(h("div", { class: "note" }, [h("b", { text: `${tr("Tus indicaciones:")} ` }), t.extraContext]));
  if (t.skipAttachments && t.skipAttachments.length) kids.push(h("div", { class: "meta", text: tr("Adjuntos quitados: {list}", { list: t.skipAttachments.join(", ") }) }));
  if (t.answer && t.answer.kind === "changes") {
    const label = t.answer.delivered ? tr("Cambios pedidos a las {time}", { time: when(t.answer.at) }) : tr("Cambios pedidos a las {time}, de camino a la sesión", { time: when(t.answer.at) });
    kids.push(h("div", { class: "reply" }, [h("b", { text: `${label}: ` }), t.answer.text]));
  }
}

const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? tr("hace {n} s", { n: s }) : s < 3600 ? tr("hace {n} min", { n: Math.round(s / 60) }) : tr("hace {n} h", { n: Math.round(s / 3600) });
};
const span = (mins) => (mins < 1 ? tr("menos de 1 min") : mins < 90 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`);

function progressLine(t) {
  const pr = (state.progress || {})[t.key];
  const all = state.progressPhases || [];
  const phases = all.slice(1);
  if (!pr || !phases.length || t.status !== "sent" || t.manual) return null;
  const name = (all.find((p) => p.id === pr.phase) || {}).label || pr.phase;
  const steps = h("div", { class: "pg-steps", style: `grid-template-columns: repeat(${phases.length}, 1fr)`, role: "progressbar", "aria-label": name, "aria-valuemin": "0", "aria-valuemax": String(pr.of), "aria-valuenow": String(pr.step) }, phases.map((p, i) => h("i", { class: i + 1 < pr.step ? "on" : i + 1 === pr.step ? "now" : "", title: p.label })));
  const quiet = pr.action && Date.now() - Date.parse(pr.action.at) > 4 * 60000;
  const doing = pr.action ? (quiet ? tr("Sin moverse {ago} · lo último: {text}", { ago: ago(pr.action.at), text: pr.action.text }) : `${pr.action.text} · ${ago(pr.action.at)}`) : tr("Aún no ha empezado a trabajar en ella");
  const mins = pr.since ? Math.round((Date.now() - Date.parse(pr.since)) / 60000) : null;
  const time = [mins !== null ? tr("lleva {time}", { time: span(mins) }) : "", pr.typical ? tr("suelen tardar {low}–{high} min", { low: pr.typical.low, high: pr.typical.high }) : ""].filter(Boolean).join(" · ");
  return h("div", { class: "pg" }, [h("div", { class: "pg-head" }, [h("b", { text: name }), time ? h("span", { text: time }) : null]), steps, h("div", { class: `pg-doing${quiet || !pr.action ? " quiet" : ""}`, text: doing })]);
}

function inSession(t, kids) {
  kids.push(h("div", { class: "state-line", text: t.sentAt ? tr("En la sesión {area}, enviada a las {time}.", { area: areaName(t.area) || t.area, time: when(t.sentAt) }) : tr("En la sesión {area}.", { area: areaName(t.area) || t.area }) }));
  stopLines(t, kids);
  sentExtras(t, kids);
  if (t.notice) kids.push(h("div", { class: `notice ${t.status}` }, [h("b", { text: `${NOTICE_LABEL[t.notice.type] || tr("Aviso")} · ${when(t.notice.at)}` }), h("div", { text: t.notice.text })]));
  if (hasChanges(t)) kids.push(changesList(t, tr("Cambió en Jira después del envío")));
  const acts = [];
  if (t.status === "done") {
    if (t.reviewedAt) kids.push(h("div", {}, [h("span", { class: "chip sent", text: tr("En revisión desde las {time}", { time: when(t.reviewedAt) }) }), " "]));
    else acts.push(reviewedButton(t));
  }
  const proposal = t.status === "waiting" && t.notice && t.notice.type === "comment" && !(t.answer && !t.answer.delivered);
  if (proposal) commentProposal(t, kids, acts);
  if (t.status !== "done" || (t.area && t.approvedVia !== "manual")) answerForSession(t, kids, acts, proposal);
  acts.push(backToPendingButton(t));
  if (t.status !== "waiting") acts.push(deleteButton(t));
  kids.push(h("div", { class: "actions" }, acts));
}

function sentCard(t, kids) {
  if (t.manual) {
    kids.push(h("div", { class: "state-line", text: t.sentAt ? tr("Resuelta a mano a las {time}: no se envió a ninguna sesión desde el tablero.", { time: when(t.sentAt) }) : tr("Resuelta a mano: no se envió a ninguna sesión desde el tablero.") }));
    kids.push(h("div", { class: "actions" }, [undoButton(t), deleteButton(t)]));
    return;
  }
  kids.push(h("div", { class: "state-line", text: t.sentAt ? tr("Enviada a {area} a las {time}.", { area: areaName(t.area) || t.area, time: when(t.sentAt) }) : tr("Enviada a {area}.", { area: areaName(t.area) || t.area }) }));
  stopLines(t, kids);
  sentExtras(t, kids);
  const pg = progressLine(t);
  if (pg) kids.push(pg);
  const silentHours = t.sentAt ? Math.floor((Date.now() - new Date(t.sentAt).getTime()) / 3600000) : 0;
  if (silentHours >= 3) kids.push(h("div", {}, [h("span", { class: "chip silent", title: tr("La sesión no ha avisado al tablero de cómo va: ni hecha, ni a medias, ni con una pregunta. Puede haberse quedado parada."), text: tr("Sin noticias desde hace {n} h", { n: silentHours }) })]));
  if (t.reply) kids.push(h("div", { class: "reply", text: t.reply }));
  if (hasChanges(t)) kids.push(changesList(t, tr("Cambió en Jira después del envío")));
  kids.push(h("div", { class: "actions" }, [backToPendingButton(t, hasChanges(t)), deleteButton(t)]));
}

export function card(t, bare) {
  const pending = t.status === "pending";
  const kids = bare
    ? []
    : [
        h("div", { class: "top" }, [
          h("span", { class: "key", text: t.key }),
          projectChip(t.project),
          h("span", { class: `chip ${pending ? t.kind : t.status}`, text: pending ? PENDING_CHIP[t.kind] || tr("Nueva") : t.manual ? tr("A mano") : STATUS_CHIP[t.status] }),
          t.jiraClosedAt ? h("span", { class: "chip sent", text: tr("Listo en Jira") }) : null,
          ...limitChips(t, pending ? chosenSession(t) : t.area),
          h("span", { class: "time", text: when(t.at) }),
        ]),
        h("div", { class: "title", text: t.title }),
      ];
  if (bare && limitsFor(t, pending ? chosenSession(t) : t.area).length) kids.push(h("div", { class: "limit-chips" }, limitChips(t, pending ? chosenSession(t) : t.area)));
  if (t.heldBack && pending) kids.push(h("div", { class: "meta", text: tr("Estaba por enviar y volvió a Pendientes al crear la restricción {id}.", { id: t.heldBack.restriction }) }));
  if (bare && t.title.length > 60) kids.push(h("div", { class: "title", text: t.title }));
  if (t.note) kids.push(h("div", { class: "note" }, [h("b", { text: t.noteBy ? `${t.noteBy}: ` : "" }), t.note]));
  kids.push(h("div", { class: "meta", text: tr("Asignado: {who}", { who: t.assignee || tr("sin asignar") }) }));
  if (t.withdrawn && t.status === "ignored") kids.push(h("div", { class: "withdrawn", text: tr("Retirada sola a las {time}: el ticket lo tiene ahora {who}.", { time: when(t.withdrawn.at), who: t.withdrawn.by }) }));
  if (["pending", "approved", "ignored"].includes(t.status) && hasChanges(t)) kids.push(changesList(t, t.kind === "resend" ? tr("Cambios en Jira desde el primer envío") : tr("Cambios en Jira desde que llegó")));
  if (t.attachments) {
    kids.push(
      t.attachments.length
        ? h("div", { class: "attach" }, [h("span", { class: "chip attachment", text: tn(t.attachments.length, "{n} adjunto", "{n} adjuntos") }), h("span", { class: "attach-names", text: t.attachments.map((a) => a.name).join(", ") })])
        : h("div", { class: "meta", text: tr("Sin adjuntos") })
    );
  }

  if (pending) kids.push(pendingActions(t));
  else if (t.status === "approved") {
    const waited = t.decidedAt ? minutesSince(t.decidedAt) : 0;
    const via = ["chat", "rule", "yolo"].includes(t.approvedVia) ? t.approvedVia : "";
    const d = t.delivery;
    const at = t.decidedAt ? when(t.decidedAt) : "";
    const approved = {
      chat: at ? tr("Aprobada por chat a las {time}.", { time: at }) : tr("Aprobada por chat."),
      rule: at ? tr("Aprobada sola, por tu regla de devueltas, a las {time}.", { time: at }) : tr("Aprobada sola, por tu regla de devueltas."),
      yolo: at ? tr("Aprobada sola, por el modo YOLO, a las {time}.", { time: at }) : tr("Aprobada sola, por el modo YOLO."),
      "": at ? tr("Aprobada a las {time}.", { time: at }) : tr("Aprobada."),
    }[via];
    const writes = tr("{who} la escribe en {area} y la da por enviada cuando aparece en su conversación.", { who: whoSends(true), area: areaName(t.area) || t.area });
    const slow = waited >= 3 && !d ? tr("Lleva {n} min esperando: la sesión puede estar arrancando.", { n: waited }) : "";
    kids.push(h("div", { class: "state-line", text: [approved, writes, slow].filter(Boolean).join(" ") }));
    if (d && d.soft) kids.push(h("div", { class: "state-line", text: tr("Esperando: {error}.", { error: d.error }) }));
    else if (d) kids.push(deliveryProblem(d, "task", t.key));
    kids.push(h("div", { class: "actions" }, [undoButton(t)]));
  } else if (["waiting", "partial", "done"].includes(t.status)) inSession(t, kids);
  else if (t.status === "sent") sentCard(t, kids);
  else if (t.status === "ignored") kids.push(h("div", { class: "actions" }, [undoButton(t, tr("Recuperar")), deleteButton(t)]));
  return h(bare ? "div" : "article", { class: bare ? "task-detail" : `card ${pending ? t.kind : ""}` }, kids);
}

const openRows = new Set();
const closedRows = new Set();
const OPEN_BY_DEFAULT = ["pending", "waiting", "partial"];
const isOpen = (t) => openRows.has(t.id) || (!closedRows.has(t.id) && OPEN_BY_DEFAULT.includes(t.status));

function rowTag(t) {
  const held = holdOf(t, t.status === "pending" ? chosenSession(t) : t.area);
  if (held) return ["held", held.chip.text, held.chip.title];
  if (t.status === "approved" && t.delivery && !t.delivery.soft) return ["again", tr("Sin entregar"), t.delivery.error];
  if (t.status === "waiting") return ["again", tr("Te espera")];
  if (t.status === "partial") return ["again", tr("A medias")];
  if (hasChanges(t) && t.status !== "pending") return ["again", tr("Cambió en Jira")];
  if (t.status === "pending") return [t.kind === "new" || !PENDING_CHIP[t.kind] ? "sent" : "again", PENDING_CHIP[t.kind] || tr("Nueva")];
  if (t.jiraClosedAt) return ["answered", tr("Listo en Jira")];
  if (t.manual) return ["", tr("A mano")];
  if (t.status === "done") return t.reviewedAt ? ["answered", tr("En revisión")] : ["sent", tr("Por revisar")];
  if (t.status === "sent" && t.sentAt && Date.now() - new Date(t.sentAt).getTime() >= 3 * 3600000) return ["again", tr("Sin noticias")];
  return null;
}

function taskRow(t, groupArea, underProject) {
  const open = isOpen(t);
  const toggle = () => {
    if (open) {
      openRows.delete(t.id);
      closedRows.add(t.id);
    } else {
      closedRows.delete(t.id);
      openRows.add(t.id);
    }
    render();
  };
  const tag = rowTag(t);
  const own = t.area || t.proposedArea;
  const area = groupArea !== undefined && own === groupArea ? "" : areaName(own);
  const head = h("button", { type: "button", class: "issue-head", "aria-expanded": String(open), onclick: toggle }, [
    h("span", { class: "key task-key", text: t.key }),
    h("span", { class: "issue-msg task-title" }, [underProject ? null : projectChip(t.project), h("span", { text: t.title, title: t.title })]),
    tag ? h("span", { class: `issue-tag ${tag[0]}`, text: tag[1], title: tag[2] }) : h("span", { class: "issue-tag none" }),
    h("span", { class: "task-area", text: area || "" }),
    h("span", { class: "issue-when", text: when(t.sentAt || t.decidedAt || t.at) }),
  ]);
  return h("div", { class: `issue-row${open ? " open" : ""}` }, [head, open ? h("div", { class: "issue-body" }, [card(t, true)]) : null]);
}

export const taskList = (items, groupArea, underProject) => h("div", { class: "issue-list task-list" }, items.map((t) => taskRow(t, groupArea, underProject)));


function backToPendingGroup(g) {
  const own = g.items.filter((t) => !t.manual);
  const b = button(own.length === 1 ? tr("Pasar a Pendientes") : tr("Pasar las {n} a Pendientes", { n: own.length }), {
    title: tr("Devuelve a Pendientes todas las enviadas de este epic. No se envía nada hasta que pulses Hacer allí."),
    onClick: (x) => moveToPending(own.map((t) => t.id), x),
  });
  return h("span", { class: "group-actions" }, [areaLabel(g), b]);
}

const areaLabel = (g) => h("span", { class: `group-area${g.area ? "" : " none"}`, text: g.area ? areaName(g.area) || g.area : tr("Sin sesión asignada") });

function batchControls(g) {
  const values = g.items.map(chosenSession);
  const common = values.every((v) => v === values[0]) ? values[0] : "";
  const ready = values.every((v) => v && v !== "__new__");
  const emptyLabel = common ? tr("Elige sesión…") : values.some(Boolean) ? tr("Sesiones distintas…") : tr("Sesión para todas…");
  const sel = taskAreaSelect(`batch-${g.key || "no-epic"}`, common, emptyLabel, (v) => {
    if (v !== "__new__") {
      g.items.forEach((t) => (choice[t.id] = v));
      return render();
    }
    askNewSession(g.key ? tr("Nombre de la sesión nueva para el epic {key} {name}", { key: g.key, name: g.name }) : tr("Nombre de la sesión nueva"), g.key ? g.name : "", g.key ? { key: g.key, name: g.name } : null, (area) => g.items.forEach((t) => (choice[t.id] = area)));
  }, g.items.every((t) => t.project === g.items[0].project) ? g.items[0].project : undefined);
  sel.appendChild(h("option", { value: "__new__", text: tr("+ Sesión nueva…") }));
  sel.setAttribute("aria-label", tr("Sesión para todas las tareas de {name}", { name: g.name }));
  const free = g.items.filter((t) => !holdOf(t, chosenSession(t)));
  const heldCount = g.items.length - free.length;
  const btn = button(free.length === 1 ? tr("Hacer") : tr("Hacer las {n}", { n: free.length }), {
    cls: "primary",
    disabled: !ready || !free.length,
    title: heldCount ? tn(heldCount, "Una está retenida y no se envía.", "{n} están retenidas y no se envían.") : undefined,
    onClick: (b) => {
      b.disabled = true;
      const items = free.map((t) => {
        const { extraContext, skipAttachments } = approvePatch(t, chosenSession(t));
        forgetOptions(t);
        return { key: t.id, area: chosenSession(t), extraContext, skipAttachments };
      });
      post("/api/batch", { items }, tn(free.length, "Tarea aprobada.", "{n} tareas aprobadas: van juntas en un solo mensaje."));
    },
  });
  return h("span", { class: "group-actions" }, [sel, btn]);
}

function deleteBar(root, list) {
  const today = fmtDay.format(new Date());
  const old = list.filter((t) => {
    const f = t.sentAt || t.decidedAt || t.at;
    return !f || fmtDay.format(new Date(f)) !== today;
  });
  const closed = list.filter((t) => t.jiraClosedAt);
  const ids = (xs) => xs.map((t) => t.id);
  const withChanges = list.filter((t) => !t.manual && hasChanges(t));
  const only = tr("Solo las quita del tablero; en Jira no cambia nada.");
  return [
    withChanges.length && state.tab === "sent"
      ? button(tr("Pasar a Pendientes las {n} con cambios en Jira", { n: withChanges.length }), {
          cls: "primary",
          title: tr("Devuelve a Pendientes las que han cambiado en Jira después de enviarlas, para volver a enviarlas juntas."),
          onClick: (b) => moveToPending(ids(withChanges), b),
        })
      : null,
    h("div", { class: "issues-read task-delete" }, [
      h("span", { class: "meta", text: tr("Quitar del tablero:"), title: only }),
      closed.length ? button(tr("Listo en Jira ({n})", { n: closed.length }), { cls: "subtle", title: `${tr("Las que ya están Listo en Jira.")} ${only}`, onClick: (b) => ((b.disabled = true), deleteTasks(ids(closed))) }) : null,
      button(tr("De días anteriores ({n})", { n: old.length }), { cls: "subtle", title: only, disabled: !old.length, onClick: (b) => ((b.disabled = true), deleteTasks(ids(old))) }),
      button(tr("Todas ({n})", { n: list.length }), {
        cls: "subtle",
        title: only,
        onClick: (b) => {
          const ask = { sent: "¿Borrar las {n} en curso, incluidas las de hoy?", ignored: "¿Borrar las {n} ignoradas, incluidas las de hoy?", done: "¿Borrar las {n} hechas, incluidas las de hoy?", waiting: "¿Borrar las {n} a medias, incluidas las de hoy?" }[state.tab];
          if (!window.confirm(tr(ask, { n: list.length }))) return;
          b.disabled = true;
          deleteTasks(ids(list));
        },
      }),
    ]),
  ];
}

export function renderTasks(root) {
  const list = state.tasks.filter((t) => t.status === state.tab || (state.tab === "waiting" && t.status === "partial"));
  const permissionsShown = state.tab === "waiting" ? renderPermissions(root) : 0;
  if (!list.length) return permissionsShown ? null : root.appendChild(empty(...EMPTY_LISTS[state.tab]));
  const deletable = list.filter((t) => t.status !== "waiting");
  const bar = [h("div", { class: "proj-count" }, [h("strong", { text: String(list.length) }), h("span", { text: ` ${list.length === 1 ? tr("tarea") : tr("tareas")}` })])];
  if (state.tab === "done") bar.push(reviewAllButton(list));
  if (["sent", "ignored", "done", "waiting"].includes(state.tab) && deletable.length) bar.push(...deleteBar(root, deletable));
  root.appendChild(h("div", { class: "issues-bar task-bar" }, bar.filter(Boolean)));
  const byEpic = new Map();
  const projectOf = (t) => t.project || mainProject();
  for (const t of list) {
    const k = `${projectOf(t)}|${t.epicKey || "no-epic"}`;
    if (!byEpic.has(k)) byEpic.set(k, { project: projectOf(t), key: t.epicKey, name: t.epicName || tr("Sin epic"), area: t.area || t.proposedArea, items: [] });
    byEpic.get(k).items.push(t);
  }
  const groups = [...byEpic.values()];
  const projects = [...new Set(groups.map((g) => g.project))];
  const titled = mixedProjects();
  for (const project of projects) {
    if (titled) root.appendChild(h("h3", { class: "project-title" }, [projectName(project), h("span", { class: "n", text: String(groups.filter((g) => g.project === project).reduce((n, g) => n + g.items.length, 0)) })]));
    for (const g of groups.filter((x) => x.project === project)) renderEpicGroup(root, g);
  }
}

function renderEpicGroup(root, g) {
  g.items.sort((a, b) => hasChanges(b) - hasChanges(a) || String(b.at || "").localeCompare(String(a.at || "")));
  const batch = state.tab === "pending" && g.items.length > 1;
  const sendBack = (["sent", "done"].includes(state.tab) || (state.tab === "waiting" && g.items.every((t) => t.status === "partial"))) && g.items.some((t) => !t.manual);
  const head = h("div", { class: "group-head" }, [g.key ? h("span", { class: "group-key", text: g.key }) : null, h("span", { class: "group-name", text: g.name }), batch ? batchControls(g) : sendBack ? backToPendingGroup(g) : areaLabel(g)]);
  root.appendChild(h("section", { class: "list-section" }, [head, taskList(g.items, g.area, true)]));
}

export function renderToday(root, errors) {
  let any = renderPermissions(root, true) > 0;
  for (const [statuses, title] of [[["waiting", "partial"], tr("Te esperan")], [["pending"], tr("Pendientes")]]) {
    const list = state.tasks.filter((t) => statuses.includes(t.status));
    if (!list.length) continue;
    any = true;
    root.appendChild(h("section", { class: "today-group" }, [h("h3", { text: `${title} (${list.length})` }), taskList(list)]));
  }
  if (errors) {
    any = true;
    root.appendChild(h("section", { class: "today-group" }, [h("h3", { text: tr("Posibles errores de seguimiento por decidir ({n})", { n: errors }) }), h("div", { class: "actions" }, [button(tr("Verlos en Seguimiento"), { onClick: () => switchView("follow-up") })])]));
  }
  if (!any) root.appendChild(h("p", { class: "today-empty", text: tr("Nada que decidir ahora: las nutrias se apañan solas.") }));
}

const BOARD_COLUMNS = [
  ["pending", tr("Pendientes"), ["pending"]],
  ["approved", tr("Por enviar"), ["approved"]],
  ["waiting", tr("Te esperan"), ["waiting", "partial"]],
  ["sent", tr("En curso"), ["sent"]],
  ["done", tr("Hechas"), ["done"]],
];
const openDrawer = (t) => openTicket(t.id);

function boardRow(t) {
  const tag = t.kind === "returned" ? tr("Devuelta") : t.kind === "comment" ? tr("Comentario") : t.kind === "resend" ? tr("Ya enviada") : "";
  const held = holdOf(t, chosenSession(t));
  return h("button", { type: "button", class: `board-row${state.ticket === t.id ? " open" : ""}`, title: t.title, onclick: () => openDrawer(t) }, [h("span", { class: "key", text: t.key }), h("span", { class: "board-row-title", text: t.title }), held ? h("span", { class: "board-tag held", title: held.chip.title, text: tr("Retenida") }) : null, tag ? h("span", { class: `board-tag ${t.kind}`, text: tag }) : null]);
}

function boardCard(t) {
  const held = holdOf(t, t.area);
  const flag = held ? tr("Retenida") : t.status === "approved" && t.delivery && !t.delivery.soft ? tr("Sin entregar") : t.status === "partial" ? tr("A medias") : t.status === "waiting" ? tr("Te espera") : t.manual ? tr("A mano") : hasChanges(t) ? tr("Cambió en Jira") : t.status === "done" && t.reviewedAt ? tr("En revisión") : "";
  return h("button", { type: "button", class: `board-card${state.ticket === t.id ? " open" : ""}`, onclick: () => openDrawer(t) }, [
    projectChip(t.project),
    h("span", { class: "board-card-title", text: t.title }),
    h("span", { class: "board-card-foot" }, [h("span", { class: "key", text: t.key }), h("span", { class: "board-card-area", text: areaName(t.area || t.proposedArea) || "" }), flag ? h("span", { class: `board-tag${held ? " held" : ""}`, title: held ? held.chip.title : t.delivery && t.delivery.error, text: flag }) : null, h("span", { class: "time", text: when(t.sentAt || t.decidedAt || t.at) })]),
  ]);
}

function pendingColumn(list) {
  const byEpic = new Map();
  for (const t of list) {
    const k = `${t.project || mainProject()}|${t.epicKey || "no-epic"}`;
    if (!byEpic.has(k)) byEpic.set(k, { project: t.project, key: t.epicKey, name: t.epicName || tr("Sin epic"), area: t.area || t.proposedArea, items: [] });
    byEpic.get(k).items.push(t);
  }
  return [...byEpic.values()].map((g) =>
    h("div", { class: "board-epic" }, [
      h("div", { class: "board-epic-head" }, [projectChip(g.project), g.key ? h("span", { class: "group-key", text: g.key }) : null, h("span", { class: "board-epic-name", text: g.name }), batchControls(g)]),
      ...g.items.map(boardRow),
    ])
  );
}

function epicGroups(list) {
  const byEpic = new Map();
  for (const t of list) {
    const k = `${t.project || mainProject()}|${t.epicKey || "no-epic"}`;
    if (!byEpic.has(k)) byEpic.set(k, { project: t.project, key: t.epicKey, name: t.epicName || tr("Sin epic"), items: [] });
    byEpic.get(k).items.push(t);
  }
  return [...byEpic.values()].sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || b.items.length - a.items.length || a.name.localeCompare(b.name));
}

function sentColumn(list) {
  return epicGroups(list).map((g) =>
    h("div", { class: "board-epic sent-epic" }, [
      h("div", { class: "board-epic-head", title: mixedProjects() ? projectName(g.project || mainProject()) : undefined }, [g.key ? h("span", { class: "group-key", text: g.key }) : null, h("span", { class: "board-epic-name", text: g.name }), h("span", { class: "n", text: String(g.items.length) })]),
      ...g.items.map(boardCard),
    ])
  );
}

let boardQuery = "";
const fold = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const matches = (t, words) => {
  const hay = fold([t.key, t.title, t.epicKey, t.epicName, areaName(t.area || t.proposedArea), t.assignee, projectName(t.project)].join(" "));
  return words.every((w) => hay.includes(w));
};

export function boardSearch() {
  const input = h("input", { type: "search", class: "board-search", id: "board-search", placeholder: tr("Filtrar tareas: clave, título, epic o sesión"), "aria-label": tr("Filtrar las tareas del tablero"), autocomplete: "off" });
  input.value = boardQuery;
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      boardQuery = input.value;
      render();
      const again = document.getElementById("board-search");
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
      boardQuery = "";
      render();
    }
  });
  return input;
}

export function renderBoard(root) {
  renderPermissions(root, false, true);
  const words = fold(boardQuery).split(/\s+/).filter(Boolean);
  const shown = words.length ? state.tasks.filter((t) => matches(t, words)) : state.tasks;
  if (words.length && !shown.length) return root.appendChild(empty(tr("Ninguna tarea coincide."), tr("Prueba con otra clave, palabra del título, epic o sesión.")));
  const columns = BOARD_COLUMNS.map(([id, title, statuses]) => {
    const list = shown.filter((t) => statuses.includes(t.status)).sort((a, b) => String(b.sentAt || b.at || "").localeCompare(String(a.sentAt || a.at || "")));
    const head = h("div", { class: "board-head" }, [h("span", { text: title }), h("span", { class: "n", text: String(list.length) })]);
    const body = !list.length ? [h("div", { class: "board-empty" }, [nutria(id === "done" ? "idle" : "free", "mid", id === "done" ? "box" : null), h("span", { text: tr("Ninguna") })])] : id === "pending" ? pendingColumn(list) : id === "sent" ? sentColumn(list) : list.map(boardCard);
    if (id === "done") {
      const all = reviewAllButton(list);
      const inReview = list.filter((t) => t.reviewedAt);
      const clear = inReview.length
        ? button(tn(inReview.length, "Borrar la que ya está en revisión", "Borrar las {n} que ya están en revisión"), {
            cls: "subtle",
            title: tr("Quita del tablero las tareas hechas que ya pasaste a {status}. En Jira no cambia nada.", { status: reviewStatus() }),
            onClick: (b) => {
              if (!window.confirm(tn(inReview.length, "¿Borrar del tablero la tarea en {status}? En Jira no cambia nada.", "¿Borrar del tablero las {n} tareas en {status}? En Jira no cambia nada.", { status: reviewStatus() }))) return;
              b.disabled = true;
              deleteTasks(inReview.map((t) => t.id));
            },
          })
        : null;
      if (all || clear) body.unshift(h("div", { class: "board-col-action" }, [all, clear]));
    }
    return h("section", { class: `board-col tasks-col${id === "pending" ? " wide" : ""}` }, [head, ...body]);
  });
  const board = h("div", { class: "task-board" }, columns);
  root.appendChild(board);
  fitBoard(board);
}

function fitBoard(board) {
  const fit = () => board.isConnected && board.style.setProperty("--board-top", `${Math.round(board.getBoundingClientRect().top + window.scrollY)}px`);
  requestAnimationFrame(fit);
  if (!fitBoard.bound) {
    fitBoard.bound = true;
    window.addEventListener("resize", () => document.querySelectorAll(".task-board").forEach((b) => b.style.setProperty("--board-top", `${Math.round(b.getBoundingClientRect().top + window.scrollY)}px`)));
  }
}

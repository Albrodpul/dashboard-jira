import { renderPermissions } from "../components/permissions.js";
import { state, choice, drafts, h, button, when, minutesSince, fmtDay, reviewer, reviewStatus, toast, request, requestOrFail, post, saveTask, whoSends, areaName, taskAreaSelect, areaSelect, render, refresh, switchView, empty, openTicket, limitsFor, holdOf, limitChips } from "../lib/base.js";
import { createSession } from "./sessions.js";

const PENDING_CHIP = { returned: "Devuelta", comment: "Comentario", resend: "Ya enviada" };
const STATUS_CHIP = { approved: "Por enviar", sent: "En curso", ignored: "Ignorada", waiting: "Te espera", partial: "A medias", done: "Hecha" };
const NOTICE_LABEL = { done: "Hecha", partial: "A medias", question: "Pregunta", comment: "Comentario propuesto para Jira" };
const EMPTY_LISTS = {
  pending: ["Nada pendiente de decidir.", "Cuando alguien cree una tarea nueva sin asignar o para ti, te devuelva una o comente en una tuya, aparecerá aquí con su sesión propuesta."],
  approved: ["Nada esperando envío.", "Lo que apruebes con Hacer lo escribe el tablero en su sesión en unos segundos, y la abre si está dormida."],
  sent: ["Todavía no se ha enviado nada.", "Aquí queda cada tarea enviada, con la respuesta de la sesión que la recibe."],
  waiting: ["Ninguna sesión te está esperando.", "Aquí salen las tareas en las que una sesión te pregunta algo o no ha podido terminar, con el motivo."],
  done: ["Todavía no hay tareas hechas.", "Cuando una sesión termine una tarea la marca aquí, con lo que ha hecho."],
  ignored: ["No hay tareas ignoradas.", "Las que descartes con Ignorar se guardan aquí por si cambias de idea."],
};
const BACK_TO_PENDING = "La devuelve a Pendientes. No se envía nada hasta que pulses Hacer allí.";

const chosenSession = (t) => (choice[t.id] !== undefined ? choice[t.id] : t.proposedArea || "");
const hasChanges = (t) => !!(t.changes && t.changes.length);

function deleteTasks(keys) {
  return requestOrFail("/api/delete", { keys })
    .then((d) => toast(d.deleted === 1 ? "1 tarjeta borrada." : `${d.deleted} tarjetas borradas.`))
    .catch(() => toast("No se pudieron borrar."))
    .then(() => refresh(true));
}

const deleteButton = (t) =>
  button("Borrar", {
    cls: "subtle",
    title: "Quita la tarjeta del tablero. En Jira no cambia nada.",
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
      toast(total === 1 ? "1 tarea está otra vez en Pendientes." : `${total} tareas están otra vez en Pendientes.`);
      return refresh(true);
    }
    return request("/api/task", { key: queue.shift(), patch: { status: "pending", resend: true } }).then(next, next);
  };
  return next();
}

const backToPendingButton = (t, primary) =>
  button("Pasar a Pendientes", {
    cls: primary ? "primary" : "",
    title: BACK_TO_PENDING,
    onClick: (b) => {
      b.disabled = true;
      saveTask(t, { status: "pending", resend: true }, `${t.key} está otra vez en Pendientes.`);
    },
  });

const undoButton = (t, label = "Deshacer") => button(label, { onClick: () => saveTask(t, { status: "pending" }, `${t.key} vuelve a pendientes.`) });

function changesList(t, title) {
  return h("div", { class: "changes" }, [h("b", { text: title }), ...t.changes.map((c) => h("div", {}, [h("span", { class: "hour", text: when(c.at) }), " " + c.text]))]);
}

function askNewSession(promptText, defaultName, epic, onCreated) {
  const n = window.prompt(promptText, defaultName);
  if (!n || !n.trim()) return render();
  toast("Creando la sesión nueva en el tablero…");
  createSession(n, epic, null).then((area) => {
    if (area) onCreated(area);
    render();
  });
}

function pendingActions(t) {
  const current = chosenSession(t);
  const sel = taskAreaSelect(`sel-${t.id}`, current, "Elige sesión…", (v) => {
    if (v !== "__new__") {
      choice[t.id] = v;
      return render();
    }
    askNewSession(`Nombre de la sesión nueva${t.epicKey ? ` para el epic ${t.epicKey} ${t.epicName || ""}` : ""}`, t.epicName || "", t.epicKey ? { key: t.epicKey, name: t.epicName || t.epicKey } : null, (area) => (choice[t.id] = area));
  });
  sel.appendChild(h("option", { value: "__new__", text: "+ Sesión nueva…" }));
  sel.setAttribute("aria-label", `Sesión de destino de ${t.key}`);
  const held = holdOf(t, current);
  return h("div", { class: "actions" }, [
    sel,
    button("Hacer", { cls: "primary", disabled: !current || !!held, title: held ? held.chip.title : undefined, onClick: () => saveTask(t, { status: "approved", area: current }, `${t.key} aprobada: ${whoSends()} la envía a ${areaName(current)} en unos segundos.`) }),
    button("Resuelta", { disabled: !!held, title: held ? held.chip.title : "Ya la has hecho o mandado tú. Pasa a Enviadas sin avisar a ninguna sesión.", onClick: () => saveTask(t, { status: "sent", manual: true, area: current || undefined }, `${t.key} resuelta a mano: queda en Enviadas.`) }),
    button("Ignorar", { onClick: () => saveTask(t, { status: "ignored" }, `${t.key} ignorada.`) }),
  ]);
}

function reviewedButton(t) {
  return button("Revisada", {
    cls: "primary",
    title: `La pasa a ${reviewStatus()} en Jira. Pulsarlo es tu orden para ese cambio.`,
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/reviewed", { key: t.id })
        .then(() => toast(`${t.key} pasa a ${reviewStatus()} en Jira.`))
        .catch((e) => {
          b.disabled = false;
          toast(`No se pudo pasar ${t.key} a ${reviewStatus()}: ${e.message}`);
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
    return h("div", { class: "review-job" }, [h("strong", { text: `Pasando a ${reviewStatus()}: ${n} de ${j.total}` }), h("div", { class: `ds-bar running`, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(j.total), "aria-valuenow": String(n) }, [h("i", { style: `width:${Math.round((n / j.total) * 100)}%` })])]);
  }
  if (seenJob === j.id) {
    seenJob = null;
    toast(j.failed.length ? `${j.done.length} pasadas a ${reviewStatus()}; ${j.failed.length} no: ${j.failed.map((f) => `${f.key} (${f.error})`).join(", ")}` : `${j.done.length} pasadas a ${reviewStatus()} en Jira.`);
  }
  return null;
}

export function reviewAllButton(list) {
  const running = reviewJobNotice();
  if (running) return running;
  const todo = list.filter((t) => t.status === "done" && !t.reviewedAt);
  if (!todo.length) return null;
  return button(todo.length === 1 ? `Pasar a ${reviewStatus()} (1)` : `Pasar las ${todo.length} a ${reviewStatus()}`, {
    cls: "primary",
    title: `Las pasa todas a ${reviewStatus()} en Jira. Pulsarlo es tu orden para ese cambio.`,
    onClick: (b) => {
      if (!window.confirm(`¿Pasar ${todo.length === 1 ? "la tarea" : `las ${todo.length} tareas`} a ${reviewStatus()} en Jira?`)) return;
      b.disabled = true;
      b.textContent = "Pasando…";
      requestOrFail("/api/reviewed-all", { keys: todo.map((t) => t.id) })
        .then((r) => {
          seenJob = r.id;
          toast(`Pasando ${r.total} a ${reviewStatus()}. Puedes seguir con otra cosa; aquí ves el avance.`);
        })
        .catch((e) => toast(`No se pudo: ${e.message}`))
        .then(() => refresh(true));
    },
  });
}

function commentProposal(t, kids, acts) {
  const id = `com-${t.id}`;
  const box = h("textarea", { class: "reply-box comment-box", id, rows: "5", "aria-label": `Comentario para Jira en ${t.key}` });
  box.value = drafts[id] !== undefined ? drafts[id] : t.notice.text;
  box.addEventListener("input", () => (drafts[id] = box.value));
  kids.push(h("div", { class: "meta", text: `Puedes cambiar el texto antes de publicarlo. «@${reviewer()}» lo menciona.` }), box);
  acts.push(
    button("Publicar en Jira", {
      cls: "primary",
      onClick: (b) => {
        const txt = box.value.trim();
        if (!txt) return toast("El comentario está vacío.");
        b.disabled = true;
        requestOrFail("/api/comment", { key: t.id, text: txt })
          .then(() => {
            delete drafts[id];
            toast(`Comentario publicado en ${t.key}. La sesión se entera.`);
          })
          .catch((e) => {
            b.disabled = false;
            toast(`No se pudo publicar: ${e.message}`);
          })
          .then(() => refresh(true));
      },
    })
  );
}

function answerForSession(t, kids, acts, proposal) {
  if (t.answer && !t.answer.delivered) {
    kids.push(h("div", { class: "reply", text: `Tu respuesta de las ${when(t.answer.at)}, de camino a la sesión: ${t.answer.text}` }));
    return;
  }
  const placeholder = proposal ? "O, en vez de publicarlo, dile otra cosa a la sesión…" : t.status === "waiting" ? "Tu respuesta para la sesión…" : "Lo que necesita para seguir (opcional)…";
  const box = h("textarea", { class: "reply-box", id: `resp-${t.id}`, rows: "3", placeholder, "aria-label": `Respuesta para la sesión sobre ${t.key}` });
  box.value = drafts[t.id] || "";
  box.addEventListener("input", () => (drafts[t.id] = box.value));
  kids.push(box);
  acts.push(
    button("Responder", {
      cls: "primary",
      onClick: (b) => {
        const txt = (drafts[t.id] || "").trim();
        if (!txt) return toast("Escribe la respuesta.");
        b.disabled = true;
        requestOrFail("/api/answer", { key: t.id, text: txt })
          .then(() => {
            delete drafts[t.id];
            toast(`Respuesta guardada: ${whoSends()} se la pasa a la sesión.`);
          })
          .catch(() => toast("No se pudo guardar la respuesta."))
          .then(() => refresh(true));
      },
    })
  );
}

function stopLines(t, kids) {
  for (const [id, s] of Object.entries(t.stopNotices || {})) kids.push(h("div", { class: "state-line", text: `Aviso de parar entregado a la sesión a las ${when(s.at)} (restricción ${id}).` }));
  if (t.stopDelivery && !t.stopDelivery.soft) kids.push(deliveryProblem(t.stopDelivery, "stop", t.key, "No se pudo entregar el aviso de parar"));
}

function deliveryProblem(x, kind, id, label = "No se pudo entregar") {
  const done = x.attempts >= 3;
  return h("div", { class: "delivery-error" }, [
    h("span", { text: `${label}${x.attempts ? ` (${x.attempts} de 3 intentos)` : ""}: ${x.error}.${done ? "" : " Se reintenta solo."}` }),
    button("Reintentar", { onClick: (b) => ((b.disabled = true), post("/api/delivery/retry", { kind, id }, "Reintentando la entrega.")) }),
  ]);
}

function inSession(t, kids) {
  kids.push(h("div", { class: "state-line", text: `En la sesión ${areaName(t.area) || t.area}${t.sentAt ? `, enviada a las ${when(t.sentAt)}` : ""}.` }));
  stopLines(t, kids);
  if (t.notice) kids.push(h("div", { class: `notice ${t.status}` }, [h("b", { text: `${NOTICE_LABEL[t.notice.type] || "Aviso"} · ${when(t.notice.at)}` }), h("div", { text: t.notice.text })]));
  if (hasChanges(t)) kids.push(changesList(t, "Cambió en Jira después del envío"));
  const acts = [];
  if (t.status === "done") {
    if (t.reviewedAt) kids.push(h("div", {}, [h("span", { class: "chip sent", text: `En revisión desde las ${when(t.reviewedAt)}` }), " "]));
    else acts.push(reviewedButton(t));
  }
  const proposal = t.status === "waiting" && t.notice && t.notice.type === "comment" && !(t.answer && !t.answer.delivered);
  if (proposal) commentProposal(t, kids, acts);
  if (t.status !== "done") answerForSession(t, kids, acts, proposal);
  acts.push(backToPendingButton(t));
  if (t.status !== "waiting") acts.push(deleteButton(t));
  kids.push(h("div", { class: "actions" }, acts));
}

function sentCard(t, kids) {
  if (t.manual) {
    kids.push(h("div", { class: "state-line", text: `Resuelta a mano${t.sentAt ? ` a las ${when(t.sentAt)}` : ""}: no se envió a ninguna sesión desde el tablero.` }));
    kids.push(h("div", { class: "actions" }, [undoButton(t), deleteButton(t)]));
    return;
  }
  kids.push(h("div", { class: "state-line", text: `Enviada a ${areaName(t.area) || t.area}${t.sentAt ? ` a las ${when(t.sentAt)}` : ""}.` }));
  stopLines(t, kids);
  const silentHours = t.sentAt ? Math.floor((Date.now() - new Date(t.sentAt).getTime()) / 3600000) : 0;
  if (silentHours >= 3) kids.push(h("div", {}, [h("span", { class: "chip silent", title: "La sesión no ha avisado al tablero de cómo va: ni hecha, ni a medias, ni con una pregunta. Puede haberse quedado parada.", text: `Sin noticias desde hace ${silentHours} h` })]));
  if (t.reply) kids.push(h("div", { class: "reply", text: t.reply }));
  if (hasChanges(t)) kids.push(changesList(t, "Cambió en Jira después del envío"));
  kids.push(h("div", { class: "actions" }, [backToPendingButton(t, hasChanges(t)), deleteButton(t)]));
}

export function card(t, bare) {
  const pending = t.status === "pending";
  const kids = bare
    ? []
    : [
        h("div", { class: "top" }, [
          h("span", { class: "key", text: t.key }),
          h("span", { class: `chip ${pending ? t.kind : t.status}`, text: pending ? PENDING_CHIP[t.kind] || "Nueva" : t.manual ? "A mano" : STATUS_CHIP[t.status] }),
          t.jiraClosedAt ? h("span", { class: "chip sent", text: "Listo en Jira" }) : null,
          ...limitChips(t, pending ? chosenSession(t) : t.area),
          h("span", { class: "time", text: when(t.at) }),
        ]),
        h("div", { class: "title", text: t.title }),
      ];
  if (bare && limitsFor(t, pending ? chosenSession(t) : t.area).length) kids.push(h("div", { class: "limit-chips" }, limitChips(t, pending ? chosenSession(t) : t.area)));
  if (t.heldBack && pending) kids.push(h("div", { class: "meta", text: `Estaba por enviar y volvió a Pendientes al crear la restricción ${t.heldBack.restriction}.` }));
  if (bare && t.title.length > 60) kids.push(h("div", { class: "title", text: t.title }));
  if (t.note) kids.push(h("div", { class: "note" }, [h("b", { text: t.noteBy ? `${t.noteBy}: ` : "" }), t.note]));
  kids.push(h("div", { class: "meta", text: `Asignado: ${t.assignee || "sin asignar"}` }));
  if (t.withdrawn && t.status === "ignored") kids.push(h("div", { class: "withdrawn", text: `Retirada sola a las ${when(t.withdrawn.at)}: el ticket lo tiene ahora ${t.withdrawn.by}.` }));
  if (["pending", "approved", "ignored"].includes(t.status) && hasChanges(t)) kids.push(changesList(t, t.kind === "resend" ? "Cambios en Jira desde el primer envío" : "Cambios en Jira desde que llegó"));
  if (t.attachments) {
    kids.push(
      t.attachments.length
        ? h("div", { class: "attach" }, [h("span", { class: "chip attachment", text: t.attachments.length === 1 ? "1 adjunto" : `${t.attachments.length} adjuntos` }), h("span", { class: "attach-names", text: t.attachments.map((a) => a.name).join(", ") })])
        : h("div", { class: "meta", text: "Sin adjuntos" })
    );
  }

  if (pending) kids.push(pendingActions(t));
  else if (t.status === "approved") {
    const waited = t.decidedAt ? minutesSince(t.decidedAt) : 0;
    const via = t.approvedVia === "chat" ? " por chat" : t.approvedVia === "rule" ? " sola, por tu regla de devueltas," : "";
    const d = t.delivery;
    const slow = waited >= 3 && !d ? ` Lleva ${waited} min esperando: la sesión puede estar arrancando.` : "";
    kids.push(h("div", { class: "state-line", text: `Aprobada${via}${t.decidedAt ? ` a las ${when(t.decidedAt)}` : ""}. ${whoSends(true)} la escribe en ${areaName(t.area) || t.area} y la da por enviada cuando aparece en su conversación.${slow}` }));
    if (d && d.soft) kids.push(h("div", { class: "state-line", text: `Esperando: ${d.error}.` }));
    else if (d) kids.push(deliveryProblem(d, "task", t.key));
    kids.push(h("div", { class: "actions" }, [undoButton(t)]));
  } else if (["waiting", "partial", "done"].includes(t.status)) inSession(t, kids);
  else if (t.status === "sent") sentCard(t, kids);
  else if (t.status === "ignored") kids.push(h("div", { class: "actions" }, [undoButton(t, "Recuperar"), deleteButton(t)]));
  return h(bare ? "div" : "article", { class: bare ? "task-detail" : `card ${pending ? t.kind : ""}` }, kids);
}

const openRows = new Set();
const closedRows = new Set();
const OPEN_BY_DEFAULT = ["pending", "waiting", "partial"];
const isOpen = (t) => openRows.has(t.id) || (!closedRows.has(t.id) && OPEN_BY_DEFAULT.includes(t.status));

function rowTag(t) {
  const held = holdOf(t, t.status === "pending" ? chosenSession(t) : t.area);
  if (held) return ["held", held.chip.text, held.chip.title];
  if (t.status === "approved" && t.delivery && !t.delivery.soft) return ["again", "Sin entregar", t.delivery.error];
  if (t.status === "waiting") return ["again", "Te espera"];
  if (t.status === "partial") return ["again", "A medias"];
  if (hasChanges(t) && t.status !== "pending") return ["again", "Cambió en Jira"];
  if (t.status === "pending") return [t.kind === "new" || !PENDING_CHIP[t.kind] ? "sent" : "again", PENDING_CHIP[t.kind] || "Nueva"];
  if (t.jiraClosedAt) return ["answered", "Listo en Jira"];
  if (t.manual) return ["", "A mano"];
  if (t.status === "done") return t.reviewedAt ? ["answered", "En revisión"] : ["sent", "Por revisar"];
  if (t.status === "sent" && t.sentAt && Date.now() - new Date(t.sentAt).getTime() >= 3 * 3600000) return ["again", "Sin noticias"];
  return null;
}

function taskRow(t, groupArea) {
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
    h("span", { class: "issue-msg task-title", text: t.title, title: t.title }),
    tag ? h("span", { class: `issue-tag ${tag[0]}`, text: tag[1], title: tag[2] }) : h("span", { class: "issue-tag none" }),
    h("span", { class: "task-area", text: area || "" }),
    h("span", { class: "issue-when", text: when(t.sentAt || t.decidedAt || t.at) }),
  ]);
  return h("div", { class: `issue-row${open ? " open" : ""}` }, [head, open ? h("div", { class: "issue-body" }, [card(t, true)]) : null]);
}

export const taskList = (items, groupArea) => h("div", { class: "issue-list task-list" }, items.map((t) => taskRow(t, groupArea)));


function backToPendingGroup(g) {
  const own = g.items.filter((t) => !t.manual);
  const b = button(own.length === 1 ? "Pasar a Pendientes" : `Pasar las ${own.length} a Pendientes`, {
    title: "Devuelve a Pendientes todas las enviadas de este epic. No se envía nada hasta que pulses Hacer allí.",
    onClick: (x) => moveToPending(own.map((t) => t.id), x),
  });
  return h("span", { class: "group-actions" }, [areaLabel(g), b]);
}

const areaLabel = (g) => h("span", { class: `group-area${g.area ? "" : " none"}`, text: g.area ? areaName(g.area) || g.area : "Sin sesión asignada" });

function batchControls(g) {
  const values = g.items.map(chosenSession);
  const common = values.every((v) => v === values[0]) ? values[0] : "";
  const ready = values.every((v) => v && v !== "__new__");
  const emptyLabel = common ? "Elige sesión…" : values.some(Boolean) ? "Sesiones distintas…" : "Sesión para todas…";
  const sel = taskAreaSelect(`batch-${g.key || "no-epic"}`, common, emptyLabel, (v) => {
    if (v !== "__new__") {
      g.items.forEach((t) => (choice[t.id] = v));
      return render();
    }
    askNewSession(`Nombre de la sesión nueva${g.key ? ` para el epic ${g.key} ${g.name}` : ""}`, g.key ? g.name : "", g.key ? { key: g.key, name: g.name } : null, (area) => g.items.forEach((t) => (choice[t.id] = area)));
  });
  sel.appendChild(h("option", { value: "__new__", text: "+ Sesión nueva…" }));
  sel.setAttribute("aria-label", `Sesión para todas las tareas de ${g.name}`);
  const free = g.items.filter((t) => !holdOf(t, chosenSession(t)));
  const heldCount = g.items.length - free.length;
  const btn = button(free.length === 1 ? "Hacer" : `Hacer las ${free.length}`, {
    cls: "primary",
    disabled: !ready || !free.length,
    title: heldCount ? `${heldCount === 1 ? "Una está retenida y no se envía" : `${heldCount} están retenidas y no se envían`}.` : undefined,
    onClick: (b) => {
      b.disabled = true;
      post("/api/batch", { items: free.map((t) => ({ key: t.id, area: chosenSession(t) })) }, free.length === 1 ? "Tarea aprobada." : `${free.length} tareas aprobadas: van juntas en un solo mensaje.`);
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
  const name = { sent: "en curso", ignored: "ignoradas", done: "hechas", waiting: "a medias" }[state.tab];
  const closed = list.filter((t) => t.jiraClosedAt);
  const ids = (xs) => xs.map((t) => t.id);
  const withChanges = list.filter((t) => !t.manual && hasChanges(t));
  const only = "Solo las quita del tablero; en Jira no cambia nada.";
  return [
    withChanges.length && state.tab === "sent"
      ? button(`Pasar a Pendientes las ${withChanges.length} con cambios en Jira`, {
          cls: "primary",
          title: "Devuelve a Pendientes las que han cambiado en Jira después de enviarlas, para volver a enviarlas juntas.",
          onClick: (b) => moveToPending(ids(withChanges), b),
        })
      : null,
    h("div", { class: "issues-read task-delete" }, [
      h("span", { class: "meta", text: "Quitar del tablero:", title: only }),
      closed.length ? button(`Listo en Jira (${closed.length})`, { cls: "subtle", title: `Las que ya están Listo en Jira. ${only}`, onClick: (b) => ((b.disabled = true), deleteTasks(ids(closed))) }) : null,
      button(`De días anteriores (${old.length})`, { cls: "subtle", title: only, disabled: !old.length, onClick: (b) => ((b.disabled = true), deleteTasks(ids(old))) }),
      button(`Todas (${list.length})`, {
        cls: "subtle",
        title: only,
        onClick: (b) => {
          if (!window.confirm(`¿Borrar las ${list.length} ${name}, incluidas las de hoy?`)) return;
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
  const bar = [h("div", { class: "proj-count" }, [h("strong", { text: String(list.length) }), h("span", { text: list.length === 1 ? " tarea" : " tareas" })])];
  if (state.tab === "done") bar.push(reviewAllButton(list));
  if (["sent", "ignored", "done", "waiting"].includes(state.tab) && deletable.length) bar.push(...deleteBar(root, deletable));
  root.appendChild(h("div", { class: "issues-bar task-bar" }, bar.filter(Boolean)));
  const byEpic = new Map();
  for (const t of list) {
    const k = t.epicKey || "no-epic";
    if (!byEpic.has(k)) byEpic.set(k, { key: t.epicKey, name: t.epicName || "Sin epic", area: t.area || t.proposedArea, items: [] });
    byEpic.get(k).items.push(t);
  }
  for (const g of byEpic.values()) {
    g.items.sort((a, b) => hasChanges(b) - hasChanges(a) || String(b.at || "").localeCompare(String(a.at || "")));
    const batch = state.tab === "pending" && g.items.length > 1;
    const sendBack = (["sent", "done"].includes(state.tab) || (state.tab === "waiting" && g.items.every((t) => t.status === "partial"))) && g.items.some((t) => !t.manual);
    const head = h("div", { class: "group-head" }, [g.key ? h("span", { class: "group-key", text: g.key }) : null, h("span", { class: "group-name", text: g.name }), batch ? batchControls(g) : sendBack ? backToPendingGroup(g) : areaLabel(g)]);
    root.appendChild(h("section", { class: "list-section" }, [head, taskList(g.items, g.area)]));
  }
}

export function renderToday(root, errors) {
  let any = renderPermissions(root, true) > 0;
  for (const [statuses, title] of [[["waiting", "partial"], "Te esperan"], [["pending"], "Pendientes"]]) {
    const list = state.tasks.filter((t) => statuses.includes(t.status));
    if (!list.length) continue;
    any = true;
    root.appendChild(h("section", { class: "today-group" }, [h("h3", { text: `${title} (${list.length})` }), taskList(list)]));
  }
  if (errors) {
    any = true;
    root.appendChild(h("section", { class: "today-group" }, [h("h3", { text: `Posibles errores de seguimiento por decidir (${errors})` }), h("div", { class: "actions" }, [button("Verlos en Seguimiento", { onClick: () => switchView("follow-up") })])]));
  }
  if (!any) root.appendChild(h("p", { class: "today-empty", text: "Nada que decidir ahora." }));
}

const BOARD_COLUMNS = [
  ["pending", "Pendientes", ["pending"]],
  ["approved", "Por enviar", ["approved"]],
  ["waiting", "Te esperan", ["waiting", "partial"]],
  ["sent", "En curso", ["sent"]],
  ["done", "Hechas", ["done"]],
];
const openDrawer = (t) => openTicket(t.id);

function boardRow(t) {
  const tag = t.kind === "returned" ? "Devuelta" : t.kind === "comment" ? "Comentario" : t.kind === "resend" ? "Ya enviada" : "";
  const held = holdOf(t, chosenSession(t));
  return h("button", { type: "button", class: `board-row${state.ticket === t.id ? " open" : ""}`, title: t.title, onclick: () => openDrawer(t) }, [h("span", { class: "key", text: t.key }), h("span", { class: "board-row-title", text: t.title }), held ? h("span", { class: "board-tag held", title: held.chip.title, text: "Retenida" }) : null, tag ? h("span", { class: `board-tag ${t.kind}`, text: tag }) : null]);
}

function boardCard(t) {
  const held = holdOf(t, t.area);
  const flag = held ? "Retenida" : t.status === "approved" && t.delivery && !t.delivery.soft ? "Sin entregar" : t.status === "partial" ? "A medias" : t.status === "waiting" ? "Te espera" : t.manual ? "A mano" : hasChanges(t) ? "Cambió en Jira" : "";
  return h("button", { type: "button", class: `board-card${state.ticket === t.id ? " open" : ""}`, onclick: () => openDrawer(t) }, [
    h("span", { class: "board-card-title", text: t.title }),
    h("span", { class: "board-card-foot" }, [h("span", { class: "key", text: t.key }), h("span", { class: "board-card-area", text: areaName(t.area || t.proposedArea) || "" }), flag ? h("span", { class: `board-tag${held ? " held" : ""}`, title: held ? held.chip.title : t.delivery && t.delivery.error, text: flag }) : null, h("span", { class: "time", text: when(t.sentAt || t.decidedAt || t.at) })]),
  ]);
}

function pendingColumn(list) {
  const byEpic = new Map();
  for (const t of list) {
    const k = t.epicKey || "no-epic";
    if (!byEpic.has(k)) byEpic.set(k, { key: t.epicKey, name: t.epicName || "Sin epic", area: t.area || t.proposedArea, items: [] });
    byEpic.get(k).items.push(t);
  }
  return [...byEpic.values()].map((g) =>
    h("div", { class: "board-epic" }, [
      h("div", { class: "board-epic-head" }, [g.key ? h("span", { class: "group-key", text: g.key }) : null, h("span", { class: "board-epic-name", text: g.name }), batchControls(g)]),
      ...g.items.map(boardRow),
    ])
  );
}

export function renderBoard(root) {
  renderPermissions(root, false, true);
  const columns = BOARD_COLUMNS.map(([id, title, statuses]) => {
    const list = state.tasks.filter((t) => statuses.includes(t.status)).sort((a, b) => String(b.sentAt || b.at || "").localeCompare(String(a.sentAt || a.at || "")));
    const head = h("div", { class: "board-head" }, [h("span", { text: title }), h("span", { class: "n", text: String(list.length) })]);
    const body = !list.length ? [h("div", { class: "board-empty", text: "Ninguna" })] : id === "pending" ? pendingColumn(list) : list.map(boardCard);
    if (id === "done") {
      const all = reviewAllButton(list);
      if (all) body.unshift(h("div", { class: "board-col-action" }, [all]));
    }
    return h("section", { class: `board-col tasks-col${id === "pending" ? " wide" : ""}` }, [head, ...body]);
  });
  root.appendChild(h("div", { class: "task-board" }, columns));
}

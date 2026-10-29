import { renderPermissions } from "./permissions.js";
import { state, choice, drafts, h, button, when, minutesSince, fmtDay, reviewer, reviewStatus, toast, request, requestOrFail, post, saveTask, whoSends, areaName, taskAreaSelect, render, refresh, switchView, empty } from "./base.js";
import { createSession } from "./sessions.js";

const PENDING_CHIP = { returned: "Devuelta", comment: "Comentario", resend: "Ya enviada" };
const STATUS_CHIP = { approved: "Por enviar", sent: "En curso", ignored: "Ignorada", waiting: "Te espera", partial: "A medias", done: "Hecha" };
const NOTICE_LABEL = { done: "Hecha", partial: "A medias", question: "Pregunta", comment: "Comentario propuesto para Jira" };
const EMPTY_LISTS = {
  pending: ["Nada pendiente de decidir.", "Cuando alguien cree una tarea nueva sin asignar o para ti, te devuelva una o comente en una tuya, aparecerá aquí con su sesión propuesta."],
  approved: ["Nada esperando envío.", "Lo que apruebes con Hacer lo envía la sesión que orquesta en unos segundos, si está abierta."],
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
  return h("div", { class: "actions" }, [
    sel,
    button("Hacer", { cls: "primary", disabled: !current, onClick: () => saveTask(t, { status: "approved", area: current }, `${t.key} aprobada: ${whoSends()} la envía a ${areaName(current)} en unos segundos.`) }),
    button("Resuelta", { title: "Ya la has hecho o mandado tú. Pasa a Enviadas sin avisar a ninguna sesión.", onClick: () => saveTask(t, { status: "sent", manual: true, area: current || undefined }, `${t.key} resuelta a mano: queda en Enviadas.`) }),
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

function inSession(t, kids) {
  kids.push(h("div", { class: "state-line", text: `En la sesión ${areaName(t.area) || t.area}${t.sentAt ? `, enviada a las ${when(t.sentAt)}` : ""}.` }));
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
  const silentHours = t.sentAt ? Math.floor((Date.now() - new Date(t.sentAt).getTime()) / 3600000) : 0;
  if (silentHours >= 3) kids.push(h("div", {}, [h("span", { class: "chip silent", title: "La sesión no ha avisado al tablero de cómo va: ni hecha, ni a medias, ni con una pregunta. Puede haberse quedado parada.", text: `Sin noticias desde hace ${silentHours} h` })]));
  if (t.reply) kids.push(h("div", { class: "reply", text: t.reply }));
  if (hasChanges(t)) kids.push(changesList(t, "Cambió en Jira después del envío"));
  kids.push(h("div", { class: "actions" }, [backToPendingButton(t, hasChanges(t)), deleteButton(t)]));
}

export function card(t) {
  const pending = t.status === "pending";
  const kids = [
    h("div", { class: "top" }, [
      h("span", { class: "key", text: t.key }),
      h("span", { class: `chip ${pending ? t.kind : t.status}`, text: pending ? PENDING_CHIP[t.kind] || "Nueva" : t.manual ? "A mano" : STATUS_CHIP[t.status] }),
      t.jiraClosedAt ? h("span", { class: "chip sent", text: "Listo en Jira" }) : null,
      h("span", { class: "time", text: when(t.at) }),
    ]),
    h("div", { class: "title", text: t.title }),
  ];
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
    const slow = waited >= 3 ? ` Lleva ${waited} min esperando: ${whoSends()} puede estar ocupada o cerrada.` : "";
    kids.push(h("div", { class: "state-line", text: `Aprobada${via}${t.decidedAt ? ` a las ${when(t.decidedAt)}` : ""}. ${whoSends(true)} la envía a ${areaName(t.area) || t.area} en cuanto la recoge.${slow}` }));
    kids.push(h("div", { class: "actions" }, [undoButton(t)]));
  } else if (["waiting", "partial", "done"].includes(t.status)) inSession(t, kids);
  else if (t.status === "sent") sentCard(t, kids);
  else if (t.status === "ignored") kids.push(h("div", { class: "actions" }, [undoButton(t, "Recuperar"), deleteButton(t)]));
  return h("article", { class: `card ${pending ? t.kind : ""}` }, kids);
}


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
  const btn = button(g.items.length === 1 ? "Hacer" : `Hacer las ${g.items.length}`, {
    cls: "primary",
    disabled: !ready,
    onClick: (b) => {
      b.disabled = true;
      post("/api/batch", { items: g.items.map((t) => ({ key: t.id, area: chosenSession(t) })) }, `${g.items.length} tareas aprobadas: van juntas en un solo mensaje.`);
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
  root.appendChild(
    h("div", { class: "toolbar" }, [
      closed.length ? button(`Borrar las ${closed.length} que ya están Listo en Jira`, { onClick: (b) => ((b.disabled = true), deleteTasks(ids(closed))) }) : null,
      button(`Borrar las de días anteriores (${old.length})`, { disabled: !old.length, onClick: (b) => ((b.disabled = true), deleteTasks(ids(old))) }),
      button(`Borrar todas (${list.length})`, {
        onClick: (b) => {
          if (!window.confirm(`¿Borrar las ${list.length} ${name}, incluidas las de hoy?`)) return;
          b.disabled = true;
          deleteTasks(ids(list));
        },
      }),
      h("span", { class: "meta", text: "Solo las quita del tablero; en Jira no cambia nada." }),
      withChanges.length && state.tab === "sent"
        ? button(`Pasar a Pendientes las ${withChanges.length} con cambios en Jira`, {
            cls: "primary",
            title: "Devuelve a Pendientes las que han cambiado en Jira después de enviarlas, para volver a enviarlas juntas.",
            onClick: (b) => moveToPending(ids(withChanges), b),
          })
        : null,
    ])
  );
}

export function renderTasks(root) {
  const list = state.tasks.filter((t) => t.status === state.tab || (state.tab === "waiting" && t.status === "partial"));
  const permissionsShown = state.tab === "waiting" ? renderPermissions(root) : 0;
  if (!list.length) return permissionsShown ? null : root.appendChild(empty(...EMPTY_LISTS[state.tab]));
  const deletable = list.filter((t) => t.status !== "waiting");
  if (["sent", "ignored", "done", "waiting"].includes(state.tab) && deletable.length) deleteBar(root, deletable);
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
    root.appendChild(h("section", {}, [head, h("div", { class: "cards" }, g.items.map(card))]));
  }
}

export function renderToday(root, errors) {
  let any = renderPermissions(root, true) > 0;
  for (const [statuses, title] of [[["waiting", "partial"], "Te esperan"], [["pending"], "Pendientes"]]) {
    const list = state.tasks.filter((t) => statuses.includes(t.status));
    if (!list.length) continue;
    any = true;
    root.appendChild(h("section", { class: "today-group" }, [h("h3", { text: `${title} (${list.length})` }), ...list.map(card)]));
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
  ["sent", "En curso", ["sent"]],
  ["waiting", "Te esperan", ["waiting", "partial"]],
  ["done", "Hechas", ["done"]],
];
let openTask = null;

function openDrawer(t) {
  openTask = t.id;
  render();
}

function closeDrawer() {
  openTask = null;
  render();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openTask) closeDrawer();
});

function boardRow(t) {
  const tag = t.kind === "returned" ? "Devuelta" : t.kind === "comment" ? "Comentario" : t.kind === "resend" ? "Ya enviada" : "";
  return h("button", { type: "button", class: `board-row${openTask === t.id ? " open" : ""}`, title: t.title, onclick: () => openDrawer(t) }, [h("span", { class: "key", text: t.key }), h("span", { class: "board-row-title", text: t.title }), tag ? h("span", { class: `board-tag ${t.kind}`, text: tag }) : null]);
}

function boardCard(t) {
  const flag = t.status === "partial" ? "A medias" : t.status === "waiting" ? "Te espera" : t.manual ? "A mano" : hasChanges(t) ? "Cambió en Jira" : "";
  return h("button", { type: "button", class: `board-card${openTask === t.id ? " open" : ""}`, onclick: () => openDrawer(t) }, [
    h("span", { class: "board-card-title", text: t.title }),
    h("span", { class: "board-card-foot" }, [h("span", { class: "key", text: t.key }), h("span", { class: "board-card-area", text: areaName(t.area || t.proposedArea) || "" }), flag ? h("span", { class: "board-tag", text: flag }) : null, h("span", { class: "time", text: when(t.sentAt || t.decidedAt || t.at) })]),
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
    return h("section", { class: `board-col tasks-col${id === "pending" ? " wide" : ""}` }, [head, ...body]);
  });
  root.appendChild(h("div", { class: "task-board" }, columns));
  const t = openTask && state.tasks.find((x) => x.id === openTask);
  if (!t) return (openTask = null);
  root.appendChild(
    h("aside", { class: "drawer", "aria-label": `Tarea ${t.key}` }, [
      h("div", { class: "drawer-head" }, [h("span", { class: "meta", text: [t.epicKey, t.epicName].filter(Boolean).join(" ") }), button("Cerrar", { cls: "subtle", onClick: closeDrawer })]),
      card(t),
    ])
  );
}

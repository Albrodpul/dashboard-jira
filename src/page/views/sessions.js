import { state, h, button, when, toast, requestOrFail, post, areaName, taskAreaSelect, refresh, render, empty, ticketUrl } from "../lib/base.js";
import { sessionNutria } from "../components/nutria.js";
import { currentProject, hasModule, mixedProjects, mainProject, projectTitle, inProjectOrder, workspacesWith, projectName } from "../components/project-filter.js";
import { openTalk } from "./talk.js";
import { t, tn, LOCALE } from "../lib/i18n.js";

export function createSession(name, epic, btn) {
  const clean = String(name || "").trim();
  if (!clean) {
    toast(t("Escribe un nombre para la sesión."));
    return Promise.resolve(null);
  }
  const label = btn ? btn.textContent : "";
  let created = null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("Creando…");
  }
  return requestOrFail("/api/new-session", { title: clean, epicKey: epic ? epic.key : undefined, epicName: epic ? epic.name : undefined, project: currentProject() || undefined })
    .then((d) => {
      created = d.area;
      toast(d.open ? t("Sesión «{name}» creada y en marcha.", { name: clean }) : t("Sesión «{name}» creada, pero todavía no ha arrancado. Ábrela desde su fila.", { name: clean }));
    })
    .catch(() => toast(t("No se pudo crear la sesión.")))
    .then(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
      return refresh(true);
    })
    .then(() => created);
}

export const hostedOf = (conversation) => (state.hosted || []).find((x) => x.conversation === conversation) || null;

let epicQuery = "";
const freeEpics = () => state.epics.filter((e) => !e.area).sort((a, b) => a.key.localeCompare(b.key, "es", { numeric: true }));
const liveOf = (conversation) => ((state.allSessions || state.sessions || {}).list || []).find((s) => s.conversation === conversation) || null;

const EFFORT = { low: t("bajo"), medium: t("medio"), high: t("alto"), xhigh: t("muy alto"), max: t("máximo") };

function profileText(role) {
  const p = (state.sessionProfiles || {})[role];
  if (!p) return "";
  const model = String(p.model || "").replace(/^claude-/, "").split("-")[0];
  return t("{model} · esfuerzo {effort}", { model: `${model.charAt(0).toUpperCase()}${model.slice(1)}`, effort: EFFORT[p.effort] || p.effort });
}

function hostAction(action, conversation, name, b, okText) {
  if (b) b.disabled = true;
  return requestOrFail("/api/host/action", { action, conversation, name })
    .then(() => {
      toast(okText);
      return refresh(true);
    })
    .catch((e) => {
      if (b) b.disabled = false;
      toast(t("No se pudo: {error}", { error: e.message }));
    });
}

function nameInput(a) {
  const input = h("input", { class: "srow-name", type: "text", maxlength: "60", value: a.name, "aria-label": t("Nombre de {name}", { name: a.name }) });
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (!v) {
      toast(t("El nombre no puede quedar vacío."));
      return refresh(true);
    }
    post("/api/session", { name: a.sessionName || a.name, ref: a.ref || "", title: v, conversation: a.conversation, areaId: a.id }, t("Nombre guardado."));
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
  return input;
}

function epicChips(a) {
  const keys = Object.keys(a.epics || {}).sort();
  const chips = keys.map((k) => {
    const x = h("button", { class: "epic-x", type: "button", title: t("Quitar {key} de esta sesión", { key: k }), "aria-label": t("Quitar {key} de {name}", { key: k, name: a.name }), text: "×" });
    x.addEventListener("click", () => {
      x.disabled = true;
      post("/api/epic", { key: k, name: a.epics[k], area: "" }, t("{key} ya no tiene sesión.", { key: k }));
    });
    return h("span", { class: "epic-chip", title: a.epics[k] }, [h("b", { text: k }), h("span", { class: "epic-name", text: a.epics[k] }), x]);
  });
  const free = freeEpics();
  if (free.length) {
    const add = h("select", { class: "srow-add", "aria-label": t("Añadir un epic a {name}", { name: a.name }) }, [h("option", { value: "", text: "+" })]);
    free.forEach((e) => add.appendChild(h("option", { value: e.key, text: `${e.key} ${e.name}` })));
    add.addEventListener("change", () => {
      const e = free.find((y) => y.key === add.value);
      if (e) post("/api/epic", { key: e.key, name: e.name, area: a.id }, t("{key} va a la sesión «{name}».", { key: e.key, name: a.name }));
    });
    chips.push(add);
  }
  if (!keys.length) chips.unshift(h("span", { class: "meta", text: t("Sin epics") }));
  return h("div", { class: "srow-epics" }, chips);
}

function moreMenu(items) {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  const d = h("details", { class: "srow-more" }, [h("summary", { class: "btn subtle", title: t("Más acciones"), "aria-label": t("Más acciones"), text: "⋯" }), h("div", { class: "srow-more-menu" }, list)]);
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    const close = (e) => {
      if (d.contains(e.target)) return;
      d.open = false;
      document.removeEventListener("click", close, true);
    };
    document.addEventListener("click", close, true);
  });
  return d;
}

function actions(a, fixed) {
  const main = [];
  const more = [];
  const conv = a.conversation;
  const hosted = conv && hostedOf(conv);
  const live = conv && liveOf(conv);
  const name = a.sessionName || a.name;
  if (conv && !hosted && !live && !fixed) main.push(button(t("Al tablero"), { title: t("La lleva al tablero para poder hablarle y mandarle tareas desde aquí"), onClick: (b) => hostAction("move", conv, name, b, t("«{name}» ya vive en el tablero.", { name: a.name })) }));
  if (hosted) main.push(button(t("Chat"), { onClick: () => openTalk(conv) }));
  if (hosted && !live) more.push(button(t("Abrir"), { cls: "subtle", onClick: (b) => hostAction("open", conv, name, b, t("Abriendo «{name}»…", { name: a.name })) }));
  if (conv && !fixed && a.id)
    more.push(
      button(a.keepOpen ? t("Quitar fijada") : t("Fijar"), {
        cls: "subtle",
        title: a.keepOpen ? t("Vuelve a dormirse sola cuando esté parada") : t("Que no se duerma sola aunque esté parada (por ejemplo, si tiene una revisión programada)"),
        onClick: (b) => {
          b.disabled = true;
          post("/api/session", { name, areaId: a.id, keepOpen: !a.keepOpen }, a.keepOpen ? t("«{name}» vuelve a dormirse sola.", { name: a.name }) : t("«{name}» fijada: no se duerme sola.", { name: a.name }));
        },
      })
    );
  if (hosted && live && !fixed && !a.keepOpen) more.push(button(t("Dormir"), { cls: "subtle", title: t("La cierra; se despierta sola cuando le llegue algo"), onClick: (b) => hostAction("sleep", conv, name, b, t("«{name}» dormida.", { name: a.name })) }));
  if (!fixed && !Object.keys(a.epics || {}).length)
    more.push(
      button(t("Quitar del tablero"), {
        cls: "subtle",
        title: t("La quita del tablero; su conversación no se borra"),
        onClick: (b) => {
          if (!window.confirm(t("¿Quitar «{name}» del tablero? Su conversación no se borra.", { name: a.name }))) return;
          b.disabled = true;
          post("/api/session", { name, areaId: a.id, remove: true }, t("«{name}» quitada del tablero.", { name: a.name }));
        },
      })
    );
  return h("div", { class: "srow-actions" }, [...main, moreMenu(more)]);
}

const pendingConvs = () => new Set(((state.permissions && state.permissions.pending) || []).map((p) => p.conversation));

function phaseOf(a) {
  if (!a.conversation) return "sleeping";
  const live = liveOf(a.conversation);
  if (pendingConvs().has(a.conversation) || (live && live.status === "waiting")) return "waiting";
  if (!live) return "sleeping";
  return live.status === "busy" ? "busy" : "open";
}

const PHASES = [
  ["waiting", t("Te esperan"), t("Tienen una pregunta o un permiso pendiente.")],
  ["busy", t("Trabajando"), ""],
  ["open", t("Abiertas"), t("En marcha y paradas.")],
  ["sleeping", t("Dormidas"), t("Se despiertan solas cuando les llega algo.")],
];

function currentTask(a) {
  const mine = (state.allTasks || state.tasks || []).filter((x) => x.area === a.id && ["sent", "waiting", "partial"].includes(x.status));
  mine.sort((x, y) => String(y.sentAt || "").localeCompare(String(x.sentAt || "")));
  return mine[0] || null;
}

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }) : "");

function rowFacts(a) {
  const parts = [];
  if (mixedProjects()) parts.push(projectName(a.project || mainProject()));
  const task = currentTask(a);
  if (task) parts.push(`${task.key} ${task.title || ""}`.trim());
  const live = a.conversation && liveOf(a.conversation);
  if (live && live.statusSince) parts.push(live.status === "busy" ? t("trabajando desde las {time}", { time: hhmm(live.statusSince) }) : t("parada desde las {time}", { time: hhmm(live.statusSince) }));
  if (live && live.subagents) parts.push(tn(live.subagents, "{n} agente", "{n} agentes"));
  const rem = (state.reminders || []).filter((r) => r.area === a.id).map((r) => r.time);
  if (rem.length) parts.push(t("aviso diario a las {times}", { times: rem.join(", ") }));
  if (a.keepOpen) parts.push(t("fijada"));
  return parts.length ? h("span", { class: "meta srow-facts", text: parts.join(" · ") }) : null;
}

const openEpics = new Set();

function epicToggle(a) {
  const keys = Object.keys(a.epics || {});
  if (!(hasModule("jira") && workspacesWith("jira").includes(a.project || mainProject()))) return null;
  const isOpen = openEpics.has(a.id);
  const label = keys.length ? tn(keys.length, "{n} epic", "{n} epics") : t("Sin epics");
  return h("button", { type: "button", class: "srow-epic-toggle", "aria-expanded": String(isOpen), onclick: () => (isOpen ? openEpics.delete(a.id) : openEpics.add(a.id), render()) }, [label, h("span", { class: "ps-chev", "aria-hidden": "true", text: isOpen ? "▴" : "▾" })]);
}

function searchText(a) {
  return [a.name, a.sessionName, projectName(a.project || mainProject()), ...Object.entries(a.epics || {}).flat()].join(" ").toLowerCase();
}

function row(a) {
  const ph = phaseOf(a);
  const dot = { waiting: "wait", busy: "busy", open: "on", sleeping: "off" }[ph];
  const kids = [
    h("span", { class: "srow-avatar", title: PHASES.find((x) => x[0] === ph)[1] }, [sessionNutria(a.name, dot)]),
    h("div", { class: "srow-main" }, [nameInput(a), rowFacts(a)]),
    epicToggle(a) || h("span", {}),
    actions(a, false),
  ];
  if (openEpics.has(a.id)) kids.push(epicChips(a));
  return h("div", { class: `srow ${ph}`, "data-search": searchText(a) }, kids);
}

function fixedCard(name, role, conversation, profile) {
  const live = conversation && liveOf(conversation);
  const ph = !conversation ? "sleeping" : pendingConvs().has(conversation) ? "waiting" : !live ? "sleeping" : live.status === "busy" ? "busy" : "open";
  const text = { waiting: t("te espera"), busy: t("trabajando"), open: t("abierta"), sleeping: conversation ? t("dormida") : t("sin registrar") }[ph];
  const dot = { waiting: "wait", busy: "busy", open: "on", sleeping: "off" }[ph];
  const a = { name: t(name), sessionName: name, conversation, epics: {} };
  return h("div", { class: `fcard ${ph}`, title: [role, profileText(profile)].filter(Boolean).join(" · ") }, [
    h("div", { class: "fcard-head" }, [sessionNutria(name, dot), h("strong", { text: t(name) })]),
    h("span", { class: "meta", text: text }),
    actions(a, true),
  ]);
}

const STOP = new Set(["super", "backoffice", "landing", "para", "con", "sin", "entre", "desde"]);
const wordsOf = (s) => new Set(String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)));

function suggestFor(e, areas) {
  const mine = wordsOf(e.name);
  let best = null;
  let tie = false;
  for (const a of areas) {
    const epicWords = wordsOf(Object.values(a.epics || {}).join(" "));
    const nameWords = wordsOf(a.name);
    let score = 0;
    for (const w of mine) if (epicWords.has(w) || nameWords.has(w)) score += 1;
    if (score > (best ? best.score : 0)) (best = { area: a, score }), (tie = false);
    else if (best && score === best.score) tie = true;
  }
  return best && !tie ? best.area : null;
}

function epicRow(e, suggestion) {
  const sel = taskAreaSelect(`ep2-${e.key}`, e.area || "", t("Sin sesión"), (v) => post("/api/epic", { key: e.key, name: e.name, area: v }, v ? t("{key} va a la sesión «{name}».", { key: e.key, name: areaName(v) }) : t("{key} ya no tiene sesión.", { key: e.key })));
  const extra = e.area
    ? null
    : suggestion
      ? button(`→ ${suggestion.name}`, { title: t("Propuesta: la sesión «{name}»", { name: suggestion.name }), onClick: (b) => ((b.disabled = true), post("/api/epic", { key: e.key, name: e.name, area: suggestion.id }, t("{key} va a la sesión «{name}».", { key: e.key, name: suggestion.name }))) })
      : button(t("Sesión nueva"), { cls: "subtle", onClick: (b) => { const n = window.prompt(t("Nombre de la sesión nueva para {key} {name}", { key: e.key, name: e.name }), e.name); if (n) createSession(n, e, b); } });
  return h("div", { class: "erow" }, [h("a", { class: "key jira-link", href: ticketUrl(e.key), target: "_blank", rel: "noopener noreferrer", text: e.key }), h("span", { class: "erow-name", text: e.name }), sel, extra]);
}

function head(title, n, note) {
  return h("div", { class: "group-head" }, [h("span", { class: "group-name", text: title }), n === null ? null : h("span", { class: "group-key", text: String(n) }), note ? h("span", { class: "meta", text: note }) : null]);
}

function epicSearch(root) {
  const box = h("div", { class: "erows" });
  const paint = () => {
    box.textContent = "";
    const q = epicQuery.trim().toLowerCase();
    if (!q) return;
    const byKey = {};
    for (const e of state.allEpics || []) byKey[e.key] = e;
    for (const e of state.epics) byKey[e.key] = e;
    const list = Object.values(byKey).filter((e) => `${e.key} ${e.name}`.toLowerCase().includes(q)).slice(0, 20);
    if (!list.length) return box.appendChild(h("p", { class: "meta", text: t("Ningún epic coincide.") }));
    list.forEach((e) => box.appendChild(epicRow(e)));
  };
  const input = h("input", { type: "search", class: "find-input", placeholder: t("Buscar un epic de Jira para darle sesión ({n} abiertos)", { n: (state.allEpics || []).length }), value: epicQuery, "aria-label": t("Buscar epic") });
  input.addEventListener("input", () => {
    epicQuery = input.value;
    paint();
  });
  root.appendChild(input);
  root.appendChild(box);
  paint();
}

let formOpen = false;
let editingReminder = null;
const areaLabel = (a) => (mixedProjects() ? `${a.name} · ${projectName(a.project || mainProject())}` : a.name);
const shortDate = (d) => d.split("-").reverse().slice(0, 2).join("/");

function reminderRow(r) {
  const a = state.areas.find((x) => x.id === r.area);
  const when2 = t(r.weekdays ? "Cada día de lunes a viernes a las {time}, del {from} al {until}" : "Cada día a las {time}, del {from} al {until}", { time: r.time, from: shortDate(r.from), until: shortDate(r.until) });
  const last = r.delivery && r.delivery.error ? t("No se pudo entregar: {error}", { error: r.delivery.error }) : r.lastSentAt ? t("Último enviado: {when}", { when: when(r.lastSentAt) }) : t("Todavía no se ha enviado");
  const remove = button(t("Quitar"), {
    cls: "subtle",
    onClick: (b) => {
      if (!window.confirm(t("¿Quitar este aviso programado?"))) return;
      b.disabled = true;
      post("/api/reminder", { remove: r.id }, t("Aviso quitado."));
    },
  });
  if (editingReminder === r.id) return reminderForm(r);
  const edit = button(t("Editar"), { onClick: () => ((editingReminder = r.id), render()) });
  return h("div", { class: "rem-row" }, [
    h("div", { class: "rem-main" }, [h("strong", { text: a ? areaLabel(a) : r.area }), h("span", { class: "meta", text: `${when2} · ${last}` }), h("details", { class: "rem-text" }, [h("summary", { text: t("Texto") }), h("p", { text: r.text })])]),
    h("div", { class: "actions" }, [edit, remove]),
  ]);
}

function reminderForm(r) {
  const areas = state.areas.filter((a) => a.conversation && !a.unnamed);
  if (!areas.length) return null;
  const sel = h("select", { "aria-label": t("Sesión") }, areas.map((a) => h("option", { value: a.id, text: areaLabel(a) })));
  const time = h("input", { type: "time", value: r ? r.time : "08:30", "aria-label": t("Hora") });
  const from = h("input", { type: "date", "aria-label": t("Primer día") });
  const until = h("input", { type: "date", "aria-label": t("Último día") });
  const weekdays = h("input", { type: "checkbox" });
  const text = h("textarea", { rows: r ? "8" : "3", placeholder: t("Qué tiene que hacer la sesión cada día"), "aria-label": t("Texto del aviso") });
  if (r) {
    sel.value = r.area;
    from.value = r.from;
    until.value = r.until;
    weekdays.checked = !!r.weekdays;
    text.value = r.text;
  } else until.value = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  const save = button(r ? t("Guardar") : t("Programar"), {
    cls: "primary",
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/reminder", { ...(r ? { id: r.id, from: from.value } : {}), area: sel.value, time: time.value, until: until.value, weekdays: weekdays.checked, text: text.value })
        .then(() => {
          toast(r ? t("Aviso guardado.") : t("Aviso programado."));
          editingReminder = null;
        })
        .catch((e) => toast(t("No se pudo: {error}", { error: e.message })))
        .finally(() => ((b.disabled = false), refresh(true)));
    },
  });
  const fields = h("div", { class: "rem-fields" }, [
    h("label", {}, [h("span", { text: t("Sesión") }), sel]),
    h("label", {}, [h("span", { text: t("Hora") }), time]),
    r ? h("label", {}, [h("span", { text: t("Desde el") }), from]) : null,
    h("label", {}, [h("span", { text: t("Hasta el") }), until]),
    h("label", { class: "rem-check" }, [weekdays, h("span", { text: t("Solo de lunes a viernes") })]),
  ]);
  if (r) return h("div", { class: "rem-form rem-editing" }, [fields, text, h("div", { class: "actions" }, [save, button(t("Cancelar"), { cls: "subtle", onClick: () => ((editingReminder = null), render()) })])]);
  const box = h("details", { class: "rem-form" }, [h("summary", { text: t("Programar un aviso") }), fields, text, h("div", { class: "actions" }, [save])]);
  box.open = formOpen;
  box.addEventListener("toggle", () => (formOpen = box.open));
  return box;
}

export function remindersSection(root) {
  const visible = new Set(state.areas.map((a) => a.id));
  const list = (state.reminders || []).filter((r) => visible.has(r.area));
  const sec = h("section", { class: "s2-section" }, [head(t("Avisos programados"), list.length, t("El tablero se los manda a la sesión cada día a su hora, aunque se haya dormido o reiniciado."))]);
  if (list.length) sec.appendChild(h("div", { class: "srows" }, list.map(reminderRow)));
  const form = reminderForm();
  if (form) sec.appendChild(form);
  root.appendChild(sec);
}

let sessionQuery = "";
let freeOpen = false;
let sleepingOpen = false;

function newSessionButton() {
  return button(t("Nueva sesión"), { cls: "primary", onClick: (b) => { const n = window.prompt(t("Nombre de la sesión nueva")); if (n && n.trim()) createSession(n.trim(), null, b); } });
}

function applySearch(root) {
  const q = sessionQuery.trim().toLowerCase();
  root.querySelectorAll(".srow[data-search]").forEach((r) => (r.hidden = !!q && !r.dataset.search.includes(q)));
  root.querySelectorAll(".phase").forEach((sec) => {
    const rows = [...sec.querySelectorAll(".srow[data-search]")];
    sec.hidden = !!q && rows.every((r) => r.hidden);
    if (q && sec.tagName === "DETAILS" && !sec.hidden) sec.open = true;
  });
}

function epicsBlock(root, areas) {
  const free = freeEpics();
  const fixedIds = new Set([state.deployerArea, state.sentry && state.sentry.errorsArea].filter(Boolean));
  const candidates = state.areas.filter((a) => !a.unnamed && a.conversation && !fixedIds.has(a.id) && Object.keys(a.epics || {}).length);
  const proposals = free.map((e) => ({ e, s: suggestFor(e, candidates) }));
  const ready = proposals.filter((x) => x.s);
  const box = h("details", { class: `s2-free${free.length ? " warn" : ""}` });
  box.open = freeOpen;
  box.addEventListener("toggle", () => (freeOpen = box.open));
  const summary = free.length ? tn(free.length, "{n} epic sin sesión", "{n} epics sin sesión") : t("Epics");
  box.appendChild(h("summary", {}, [h("strong", { text: summary }), h("span", { class: "meta", text: free.length ? ` · ${t("sus tareas llegan a Pendientes sin sesión propuesta")} · ${ready.length ? t("{n} con propuesta", { n: ready.length }) : t("repartir")}` : ` · ${t("buscar uno para darle sesión")}` })]));
  if (ready.length > 1) {
    box.appendChild(
      h("div", { class: "s2-free-bar" }, [
        h("span", { class: "meta", text: t("El tablero propone sesión para {n} por su nombre.", { n: ready.length }) }),
        button(t("Aceptar las {n} propuestas", { n: ready.length }), {
          cls: "primary",
          onClick: async (b) => {
            b.disabled = true;
            let ok = 0;
            for (const { e, s } of ready) await requestOrFail("/api/epic", { key: e.key, name: e.name, area: s.id }).then(() => ok++, () => {});
            toast(tn(ok, "{n} epic repartido.", "{n} epics repartidos."));
            refresh(true);
          },
        }),
      ])
    );
  }
  if (free.length) box.appendChild(h("div", { class: "erows" }, proposals.map(({ e, s }) => epicRow(e, s))));
  const search = h("div", { class: "s2-free-search" });
  epicSearch(search);
  box.appendChild(search);
  root.appendChild(box);
}

export function renderSessions(root) {
  const find = h("input", { type: "search", class: "find-input", placeholder: t("Buscar una sesión o un epic"), value: sessionQuery, "aria-label": t("Buscar una sesión") });
  find.addEventListener("input", () => ((sessionQuery = find.value), applySearch(root)));
  root.appendChild(h("div", { class: "s2-toolbar" }, [find, newSessionButton()]));

  const fixed = [];
  const area = (id) => state.areas.find((a) => a.id === id);
  const mainId = ((state.jiraSetup && state.jiraSetup.workspaces) || [])[0];
  const onlyOther = currentProject() && mainId && currentProject() !== mainId.id;
  if (!onlyOther) {
    if (state.reporterRoute) fixed.push(fixedCard("Reporte de Jira", t("Lee Jira y publica el reporte"), state.reporterRoute.conversation, "reporter"));
    if (state.orchestrator) fixed.push(fixedCard("Orquestadora", t("Habla contigo de tareas, aprobaciones y restricciones"), state.orchestrator.conversation, "orchestrator"));
    if (state.followUpStatus) fixed.push(fixedCard("Seguimiento", t("Lo que hace cada uno en beta y producción"), state.followUpStatus.conversation, "followUp"));
    if (area(state.deployerArea)) fixed.push(fixedCard("Despliegue", t("Despliegues de la pestaña Desplegar"), area(state.deployerArea).conversation, "deploy"));
    const err = state.sentry && area(state.sentry.errorsArea);
    if (err) fixed.push(fixedCard("Errores sentry", t("Errores de Sentry y del seguimiento"), err.conversation, "errors"));
  }
  if (state.boardStatus) fixed.push(fixedCard("Tablero", t("Mejoras del propio tablero, común a todos los proyectos"), state.boardStatus.conversation, "board"));
  if (fixed.length) root.appendChild(h("section", { class: "s2-section" }, [head(t("Fijas"), null, t("Las que hacen funcionar el tablero.")), h("div", { class: "fcards" }, fixed)]));

  const fixedIds = new Set([state.deployerArea, state.sentry && state.sentry.errorsArea].filter(Boolean));
  const followUp = state.followUpStatus && state.followUpStatus.conversation;
  const areas = state.areas.filter((a) => !a.unnamed && !fixedIds.has(a.id) && a.conversation !== followUp);
  const jira = hasModule("jira");
  if (jira) epicsBlock(root, areas);

  if (!areas.length) root.appendChild(empty(t("Sin sesiones."), t("Crea una con «Nueva sesión».")));
  for (const [id, title, note] of PHASES) {
    const order = inProjectOrder(areas.map((a) => a.project || mainProject()));
    const at = (a) => order.indexOf(a.project || mainProject());
    const mine = areas.filter((a) => phaseOf(a) === id).sort((a, b) => at(a) - at(b) || a.name.localeCompare(b.name, "es"));
    if (!mine.length) continue;
    const headEl = head(title, mine.length, id === "busy" ? "" : note);
    const rows = h("div", { class: "srows" }, mine.map(row));
    if (id === "sleeping") {
      const d = h("details", { class: "s2-section phase" }, [h("summary", {}, [headEl]), rows]);
      d.open = sleepingOpen;
      d.addEventListener("toggle", () => (sleepingOpen = d.open));
      root.appendChild(d);
    } else root.appendChild(h("section", { class: `s2-section phase ${id}` }, [headEl, rows]));
  }
  root.appendChild(h("p", { class: "meta", text: `${jira ? t("Las sesiones reciben las tareas de sus epics") : t("Las sesiones reciben las tareas que les mandes desde el tablero")} · ${profileText("area")} · ${t("los avisos programados están en Ajustes → Proyectos.")}` }));
  applySearch(root);
}

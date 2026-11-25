import { state, h, post, switchView, setRender, setRefresh, empty, reviewer, button, SETTINGS, openSettings } from "./lib/base.js";
import { paintSettings, settingsButton, lastSection, GEAR } from "./components/settings.js";
import { syncPush } from "./views/notifications.js";
import { renderTasks, renderToday, renderBoard, boardSearch } from "./views/tasks.js";
import { nutria, paint as paintOtter } from "./components/nutria.js";
import { renderSessions } from "./views/sessions.js";
import { renderDeploy } from "./views/deploy.js";
import { renderTalk } from "./views/talk.js";
import { renderContext } from "./views/context.js";
import { renderFollowUp } from "./views/follow-up.js";
import { renderReport, updateStamp, mountHeader, quotaBlock, tokenBanner, overtimeBanner, yoloBanner } from "./components/report.js";
import { renderHome, homeAlerts, stuckBanners, watchdogBanners } from "./views/home.js";
import { renderDaily } from "./views/daily.js";
import { batteryBadge } from "./components/battery.js";
import { renderLearning } from "./views/learning.js";
import { renderSentry } from "./views/sentry.js";
import { renderFind, searchBox } from "./views/find.js";
import { applyTheme } from "./views/appearance.js";
import { paintTicket } from "./components/ticket.js";
import { newTaskButton, newTaskForm } from "./components/new-task.js";
import { t, tn, translateStatic } from "./lib/i18n.js";
import { projectSwitch, projectSheetButton, bindProjectKeys, applyProjectFilter, tabVisible, hasModule, mixedProjects, mainProject, projectTitle } from "./components/project-filter.js";

const TASK_TABS = [
  { id: "pending", label: t("Pendientes") },
  { id: "approved", label: t("Por enviar") },
  { id: "waiting", label: t("Te esperan") },
  { id: "sent", label: t("En curso") },
  { id: "done", label: t("Hechas") },
  { id: "ignored", label: t("Ignoradas") },
];
const GROUPS = [
  [
    t("Mi día"),
    [
      { id: "home", label: t("Inicio"), hint: t("Qué pasa ahora") },
      { id: "tasks", label: t("Tareas"), hint: t("Lo de Jira y lo que te espera") },
      { id: "daily", label: t("Daily"), hint: t("El resumen de ayer y el de hoy") },
      { id: "follow-up", label: t("Seguimiento"), hint: t("Lo que hacen los compañeros") },
    ],
  ],
  [
    t("Sesiones"),
    [
      { id: "talk", label: t("Chats"), hint: t("Escribir a una sesión") },
      { id: "sessions", label: t("Sesiones"), hint: t("Quién lleva cada epic") },
      { id: "context", label: t("Contexto"), hint: t("Lo que aprenden las sesiones y ordenarlo") },
    ],
  ],
  [
    t("Arreglar y entregar"),
    [
      { id: "sentry", label: t("Errores"), hint: t("Errores de Sentry a una sesión") },
      { id: "deploy", label: t("Desplegar"), hint: t("Subir a develop o producción") },
    ],
  ],
];
const VIEWS = {
  home: [t("Inicio"), t("Lo que te necesita y cómo van las sesiones.")],
  daily: [t("Daily"), t("El resumen del último día laborable y el de hoy, agrupado por área: qué se hizo, dónde y cómo. Se redacta solo a la hora de la daily y se puede rehacer con su botón.")],
  pending: [t("Pendientes"), t("Tareas nuevas o devueltas que puedes pasar a la sesión de su epic. Nada se envía hasta que pulsas Hacer.")],
  approved: [t("Por enviar"), t("Aprobadas con Hacer, mientras el tablero las escribe en su sesión. Si no puede, lo dice aquí.")],
  sent: [t("En curso"), t("Lo que ya está en su sesión, con lo que ha contestado.")],
  waiting: [t("Te esperan"), t("Una sesión se ha parado en estas tareas: te pregunta algo o no ha podido terminarlas y dice por qué. Contéstale aquí o devuélvelas a Pendientes.")],
  done: [t("Hechas"), t("La sesión dice que ha terminado: pendientes de que tú las revises. En Jira siguen «En curso».")],
  ignored: [t("Ignoradas"), t("Descartadas con Ignorar. Se pueden recuperar.")],
  deploy: [t("Desplegar"), t("Sube proyectos a develop, a producción o a los dos. La orden sale de aquí hacia la sesión que despliega; nada se sube hasta que pulsas Desplegar.")],
  sessions: [t("Sesiones"), t("Qué sesión lleva cada epic y en qué está cada una. Las dormidas se despiertan solas cuando les llega algo.")],
  find: [t("Buscar"), t("Lo que coincide en las tareas del tablero, en las sesiones y en Jira. Lo de Jira se puede traer a Pendientes.")],
  today: [t("Hoy"), t("Lo que necesita algo de ti ahora mismo y, debajo, el último reporte.")],
  more: [t("Más"), t("Errores, despliegues, lo que hacen los demás y ajustes.")],
  talk: [t("Chats"), t("Las sesiones del tablero en directo: las fijas y cualquier otra que esté abierta. Escríbeles o córtalas, o abre una nueva para hablar.")],
  sentry: [t("Errores"), t("Errores sin resolver de los proyectos de Sentry. Elige la sesión y pulsa Enviar: el tablero se lo pasa con el enlace y te cuenta aquí lo que ha encontrado.")],
  context: [t("Contexto"), t("Lo que van guardando las sesiones en context/: si hace que vuelvan menos tareas de revisión y, cuando todo está limpio, la orquestadora para repasarlo y ordenarlo.")],
  "follow-up": [t("Seguimiento"), t("Lo que hace cada uno según sus peticiones a la API, separado por persona: beta se resume sola cada hora y producción cada dos; cualquiera de los dos, también cuando lo pidas.")],
};
const mainOnly = (draw) => (root) => {
  if (mixedProjects()) root.appendChild(projectTitle(mainProject()));
  return draw(root);
};

const PAGE_OTTERS = {
  tasks: ["pending", null, t("Ordenando la bandeja")],
  daily: ["idle", "newspaper", t("Leyendo lo que hizo cada uno")],
  deploy: ["idle", "rocket", t("Lista para despegar")],
  sessions: ["idle", "book", t("Pasando lista")],
  find: ["idle", "magnifier", t("Buscando…")],
  talk: ["idle", null, t("Escribe y se lo paso")],
  sentry: ["idle", "magnifier", t("Buscando pistas en los errores")],
  context: ["idle", "book", t("Repasando lo aprendido")],
  "follow-up": ["idle", "binoculars", t("Vigilando beta y producción")],
  more: ["idle", null, t("¿Qué más necesitas?")],
};

function pageOtter(key) {
  const head = document.querySelector(".main-head");
  if (!head) return;
  head.querySelector(".page-otter")?.remove();
  const o = PAGE_OTTERS[key];
  if (!o) return;
  const [mood, prop, say] = o;
  head.appendChild(h("div", { class: "page-otter", title: say }, [h("span", { class: "page-otter-say", text: say }), paintOtter(nutria(mood, "page", prop), key)]));
}
const NON_TASK_VIEWS = {
  home: renderHome,
  daily: renderDaily,
  sessions: renderSessions,
  find: renderFind,
  deploy: mainOnly(renderDeploy),
  sentry: mainOnly(renderSentry),
  "follow-up": mainOnly(renderFollowUp),
  context: (root) => {
    const part = (title, paint) => {
      const box = h("section", { class: "page-part" }, [h("h3", { class: "page-part-title", text: title })]);
      root.appendChild(box);
      paint(box);
    };
    if (hasModule("context")) part(t("Ordenar contexto"), renderContext);
    if (hasModule("jira")) part(t("Aprendizaje"), mainOnly(renderLearning));
  },
  talk: renderTalk,
};
const ICONS = {
  today: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  talk: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
};
const NAV_ICONS = {
  home: ICONS.today,
  daily: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18M8 14h5"/>',
  tasks: ICONS.tasks,
  talk: ICONS.talk,
  sentry: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  deploy: '<path d="M12 19V5M5 12l7-7 7 7"/><path d="M5 21h14"/>',
  "follow-up": '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  sessions: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
  context: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/>',
};
const navIcon = (id) => {
  const s = h("span", { class: "tab-icon", "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[id] || ""}</svg>`;
  return s;
};
const BOTTOM_BAR = [
  ["today", t("Hoy"), "today"],
  ["tasks", t("Tareas"), "pending"],
  ["talk", t("Chats"), "talk"],
  ["more", t("Más"), "more"],
];
const MOBILE = window.matchMedia("(max-width: 760px)");
const isTaskTab = (tab) => TASK_TABS.some((x) => x.id === tab);
const tabOf = (status) => (status === "partial" ? "waiting" : status === "jira" ? "find" : status === "epics" || status === "sessions-new" ? "sessions" : status === "learning" ? "context" : status);

try {
  const saved = localStorage.getItem("board-tab");
  state.tab = SETTINGS.includes(saved) ? "home" : tabOf(saved || "home");
} catch (e) {}

function paintTabs(counts, waitingDeploys) {
  const tabs = document.getElementById("tabs");
  tabs.textContent = "";
  if (!document.getElementById("nav-search")) {
    const box = searchBox();
    box.id = "nav-search";
    document.getElementById("top-search").appendChild(box);
  }
  const HIGHLIGHT = ["pending", "deploy", "waiting"];
  for (const [group, list] of GROUPS) {
    const shown = list.filter((x) => tabVisible(x.id));
    if (!shown.length) continue;
    tabs.appendChild(h("div", { class: "tab-group", text: group }));
    for (const tab of shown) {
      if (tab.id === "tasks") {
        tabs.appendChild(tasksTab(counts));
        continue;
      }
      const n = isTaskTab(tab.id) ? counts[tab.id] : tab.id === "deploy" ? waitingDeploys || undefined : undefined;
      const cls = `tab${n && HIGHLIGHT.includes(tab.id) ? " has" : ""}${n && tab.id === "waiting" ? " urgent" : ""}`;
      tabs.appendChild(h("button", { class: cls, role: "tab", "aria-selected": String(state.tab === tab.id), type: "button", title: `${tab.label}: ${tab.hint}`, onclick: () => switchView(tab.id) }, [navIcon(tab.id), tabText(tab), n === undefined ? null : h("span", { class: "n", text: String(n) })]));
    }
  }
  const foot = document.getElementById("nav-foot");
  if (foot) {
    foot.textContent = "";
    const c = state.cluster;
    const badge = batteryBadge(c && c.macPower && c.macPower.battery, null);
    if (badge) foot.appendChild(badge);
    foot.appendChild(quotaBlock());
    const load = machineLoad();
    if (load) foot.appendChild(load);
  }
}

const CPU_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>';
const RAM_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="9" rx="1.5"/><path d="M6 10.5v2M10 10.5v2M14 10.5v2M18 10.5v2M5 16v3M9 16v3M15 16v3M19 16v3"/></svg>';
function machineLoad() {
  const m = state.machine;
  if (!m || typeof m.cpu !== "number") return null;
  const level = (n) => (n >= 85 ? " high" : n >= 65 ? " medium" : "");
  const who = m.label || t("el ordenador que manda");
  const item = (icon, n, title) => {
    const el = h("span", { class: `ml-item${level(n)}`, title }, [h("span", { class: "ml-icon" }), h("b", { text: `${n}%` })]);
    el.firstChild.innerHTML = icon;
    return el;
  };
  return h("div", { class: "machine-load" }, [item(CPU_ICON, m.cpu, t("{machine}: CPU al {n} %", { machine: who, n: m.cpu })), item(RAM_ICON, m.mem, t("{machine}: RAM al {n} %", { machine: who, n: m.mem }))]);
}

const tabText = (tab) => h("span", { class: "tab-text" }, [h("span", { class: "tab-long", text: tab.label }), h("span", { class: "tab-short", text: tab.short || tab.label })]);

function lastTaskTab() {
  try {
    const saved = localStorage.getItem("last-task-tab");
    return isTaskTab(saved) ? saved : "pending";
  } catch (e) {
    return "pending";
  }
}

function tasksTab(counts) {
  const badges = [];
  if (counts.pending) badges.push(h("span", { class: "n", title: t("Pendientes"), text: String(counts.pending) }));
  if (counts.waiting) badges.push(h("span", { class: "n alert", title: t("Te esperan"), text: String(counts.waiting) }));
  const cls = `tab${counts.pending ? " has" : ""}`;
  return h("button", { class: cls, role: "tab", "aria-selected": String(isTaskTab(state.tab)), type: "button", title: t("Tareas: lo de Jira y lo que te espera"), onclick: () => switchView(lastTaskTab()) }, [navIcon("tasks"), tabText({ label: t("Tareas"), hint: t("Lo de Jira y lo que te espera") }), h("span", { class: "tab-badges" }, badges)]);
}

function paintBottomBar(section, attention) {
  const bottom = document.getElementById("bottom");
  bottom.textContent = "";
  for (const [id, label, target] of BOTTOM_BAR) {
    const b = h("button", { type: "button", "aria-current": section === id ? "page" : "false" });
    b.innerHTML = `<span class="bn-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg></span>`;
    b.appendChild(document.createTextNode(label));
    if (attention[id]) {
      const n = attention[id];
      const what = id === "today" ? tn(n, "{n} cosa espera tu decisión: tareas por decidir o posibles errores del seguimiento", "{n} cosas esperan tu decisión: tareas por decidir o posibles errores del seguimiento") : t("{n} sin terminar", { n });
      b.appendChild(h("span", { class: "badge", text: String(n), title: what, "aria-label": what }));
    }
    b.addEventListener("click", () => switchView(target, true));
    bottom.appendChild(b);
  }
}

function statusChips(root, counts, board) {
  const chips = h("div", { class: "status-chips", role: "group", "aria-label": t("Listas de tareas") });
  const open = (id) => () => switchView(id);
  for (const tab of TASK_TABS.filter((x) => !board || x.id === "ignored")) chips.appendChild(h("button", { type: "button", class: `${counts[tab.id] ? "" : "zero"}${tab.id === "waiting" && counts.waiting ? " alert" : ""}`, "aria-pressed": String(!board && state.tab === tab.id), text: tab.label + (counts[tab.id] ? ` ${counts[tab.id]}` : ""), onclick: open(tab.id) }));
  root.appendChild(chips);
  const sel = chips.querySelector('[aria-pressed="true"]');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest", inline: "center" });
}

function renderMore(root, waitingDeploys, errors) {
  const options = GROUPS.flatMap(([, list]) => list).filter((x) => !["home", "tasks", "talk"].includes(x.id) && tabVisible(x.id));
  const onProject = (onlyMenu) => {
    if (onlyMenu === true) return render();
    applyProjectFilter();
    if (!tabVisible(state.tab)) return switchView("home");
    render();
  };
  const choices = projectSheetButton(onProject);
  if (choices) root.appendChild(h("section", { class: "more-block" }, [h("h3", { class: "more-title", text: t("Proyecto") }), choices]));
  root.appendChild(searchBox());
  const badge = (tab) => (tab.id === "deploy" && waitingDeploys ? waitingDeploys : tab.id === "follow-up" && errors ? errors : 0);
  root.appendChild(
    h("section", { class: "more-block" }, [
      h("h3", { class: "more-title", text: t("Secciones") }),
      h("div", { class: "more-grid" }, options.map((tab) => {
        const n = badge(tab);
        return h("button", { type: "button", class: "more-tile", title: VIEWS[tab.id][1], onclick: () => switchView(tab.id, true) }, [navIcon(tab.id), h("span", { class: "more-tile-name", text: tab.label }), n ? h("span", { class: "more-tile-n", text: String(n) }) : null]);
      })),
    ])
  );
  const rows = [];
  if (hasModule("jira")) {
    const on = !!(state.config && state.config.yolo);
    const sw = h("input", { type: "checkbox", role: "switch", class: "sg-switch", "aria-label": t("Modo YOLO") });
    sw.checked = on;
    sw.addEventListener("change", (e) => {
      e.preventDefault();
      sw.checked = on;
      toggleYolo();
    });
    const icon = h("span", { class: "more-row-icon" });
    icon.innerHTML = YOLO_ICON;
    rows.push(h("label", { class: "more-row" }, [icon, h("span", { class: "more-row-text" }, [h("strong", { text: t("Modo YOLO") }), h("span", { text: on ? t("Activo: las tareas van solas a su sesión") : t("Apagado: las tareas esperan a que pulses Hacer") })]), sw]));
  }
  const gear = h("span", { class: "more-row-icon" });
  gear.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GEAR}</svg>`;
  rows.push(h("button", { type: "button", class: "more-row", onclick: () => openSettings(lastSection()) }, [gear, h("span", { class: "more-row-text" }, [h("strong", { text: t("Ajustes") }), h("span", { text: t("Proyectos, ordenadores, avisos, permisos y apariencia.") })]), h("span", { class: "more-row-chev", text: "›" })]));
  root.appendChild(h("section", { class: "more-block more-rows" }, rows));
}

function toggleYolo() {
  const on = !(state.config && state.config.yolo);
  const pending = (state.tasks || []).filter((x) => x.status === "pending").length;
  if (on && pending && !window.confirm(tn(pending, "Hay {n} tarea en Pendientes: se enviará ya. ¿Activar el modo YOLO?", "Hay {n} tareas en Pendientes: se enviarán ya. ¿Activar el modo YOLO?"))) return;
  post("/api/config", { yolo: on }, on ? t("Modo YOLO activo: cada tarea pendiente va sola a su sesión (si no tiene, el tablero la crea) y cada posible error del seguimiento, a la sesión de errores.") : t("Modo YOLO apagado: las tareas nuevas esperan a que pulses Hacer."));
}

function paintProjectPicker() {
  const onChange = (onlyMenu) => {
    if (onlyMenu === true) return paintProjectPicker();
    applyProjectFilter();
    if (!tabVisible(state.tab)) return switchView("home");
    render();
  };
  bindProjectKeys(onChange);
  const top = document.getElementById("top-project");
  if (top) top.textContent = "";
  const spots = [
    [document.getElementById("nav-project"), "side"],
  ];
  for (const [el, variant] of spots) {
    if (!el) continue;
    el.textContent = "";
    const pick = projectSwitch(onChange, variant);
    if (pick) el.appendChild(pick);
  }
}

let renderedTab = null;

function scrollKey(el) {
  const parts = [];
  for (let x = el; x && x !== document.body; x = x.parentElement) {
    if (x.id) {
      parts.unshift(`#${x.id}`);
      break;
    }
    const cls = (x.classList && x.classList[0]) || "";
    const same = x.parentElement ? [...x.parentElement.children].filter((y) => y.tagName === x.tagName && ((y.classList && y.classList[0]) || "") === cls) : [];
    parts.unshift(`${x.tagName}.${cls}:${same.indexOf(x)}`);
  }
  return parts.join(">");
}

function innerScrolls() {
  const out = new Map();
  for (const el of document.querySelectorAll("main *, .drawer, .drawer *, #settings-body *")) if (el.scrollTop > 0 || el.scrollLeft > 0) out.set(scrollKey(el), [el.scrollTop, el.scrollLeft]);
  return out;
}

function restoreScrolls(saved) {
  if (!saved.size) return;
  for (const el of document.querySelectorAll("main *, .drawer, .drawer *, #settings-body *")) {
    const at = saved.get(scrollKey(el));
    if (!at) continue;
    if (el.scrollTop !== at[0]) el.scrollTop = at[0];
    if (el.scrollLeft !== at[1]) el.scrollLeft = at[1];
  }
}

function render() {
  document.documentElement.classList.toggle("yolo", !!(state.config && state.config.yolo));
  const keepY = renderedTab === state.tab ? window.scrollY : null;
  const inner = keepY !== null ? innerScrolls() : new Map();
  const groups = document.getElementById("groups");
  if (keepY !== null && groups) groups.style.minHeight = groups.offsetHeight + "px";
  try {
    paint();
    paintSettings();
    paintTicket();
  } finally {
    renderedTab = state.tab;
    if (groups) groups.style.minHeight = "";
    if (keepY !== null && window.scrollY !== keepY) window.scrollTo(0, Math.min(keepY, document.documentElement.scrollHeight));
    restoreScrolls(inner);
  }
}

function paint() {
  state.renderSeq = (state.renderSeq || 0) + 1;
  const counts = Object.fromEntries(TASK_TABS.map((x) => [x.id, 0]));
  for (const task of state.tasks) if (counts[tabOf(task.status)] !== undefined) counts[tabOf(task.status)]++;
  counts.waiting += ((state.permissions && state.permissions.pending) || []).length;
  const waitingDeploys = (state.deployments || []).filter((x) => x.status === "approved").length;
  const errors = (state.followUps || []).flatMap((r) => r.errors || []).filter((e) => e.state === "proposed").length;
  const mobile = MOBILE.matches;
  if (!mobile && ["report", "today", "more"].includes(state.tab)) state.tab = "home";
  if (mobile && ["report", "home"].includes(state.tab)) state.tab = "today";
  state.tab = tabOf(state.tab);
  const section = state.tab === "today" ? "today" : isTaskTab(state.tab) ? "tasks" : state.tab === "talk" ? "talk" : "more";

  paintBottomBar(section, { today: counts.pending + counts.waiting + errors, more: waitingDeploys });
  paintTabs(counts, waitingDeploys);
  const right = document.getElementById("top-right");
  right.textContent = "";
  const c = state.cluster;
  if (c && c.peer && (viaHeaders[1] || c.role !== "primary")) {
    const stale = viaHeaders[1];
    right.appendChild(h("span", { class: "commander warn", text: stale ? t("{machine}: el otro no responde", { machine: stale }) : t("Sin ordenador al mando") }));
  }
  if (!mobile) {
    right.appendChild(activityButton());
    if (hasModule("jira")) right.appendChild(yoloButton());
    right.appendChild(settingsButton("btn top-settings"));
  }
  const brand = document.querySelector(".nav > .brand");
  if (brand) {
    const old = brand.querySelector(".mobile-battery");
    if (old) old.remove();
    const small = batteryBadge(c && c.macPower && c.macPower.battery, null);
    brand.appendChild(h("span", { class: "mobile-battery" }, [small, quotaBlock()]));
  }
  paintProjectPicker();
  document.querySelector(".app").setAttribute("data-jira", hasModule("jira") ? "on" : "off");
  document.querySelector(".app").setAttribute("data-view", state.tab);
  document.querySelector(".app").setAttribute("data-section", section);
  const board = !mobile && isTaskTab(state.tab) && state.tab !== "ignored";
  const [title, sub] = board ? [t("Tareas"), t("Todas las tareas por estado. Pulsa una para ver su tarjeta entera.")] : VIEWS[state.tab] || VIEWS.pending;
  document.getElementById("view-title").textContent = title;
  document.getElementById("view-sub").textContent = sub;
  pageOtter(board || isTaskTab(state.tab) ? "tasks" : state.tab);

  const root = document.getElementById("groups");
  root.textContent = "";
  if (["home", "today"].includes(state.tab)) {
    const alerts = homeAlerts([...stuckBanners(), ...watchdogBanners(), overtimeBanner(), yoloBanner(), tokenBanner(() => switchView("claude", true))]);
    if (alerts) root.appendChild(alerts);
  }
  if (section === "tasks") {
    try {
      localStorage.setItem("last-task-tab", state.tab);
    } catch (e) {}
    if (mobile || board) statusChips(root, counts, board);
  }
  if (state.tab === "today") {
    renderHome(root);
    return renderToday(root, errors);
  }
  if (state.tab === "more") return renderMore(root, waitingDeploys, errors);
  const switchable = !mobile && isTaskTab(state.tab);
  if (switchable || state.tab === "pending") {
    const bar = h("div", { class: "task-toolbar" });
    if (switchable && !board) bar.appendChild(button(t("← Volver al tablero"), { onClick: () => switchView("pending") }));
    const chips = !mobile && root.querySelector(".status-chips");
    if (chips) bar.appendChild(chips);
    if (board) bar.appendChild(boardSearch());
    bar.appendChild(newTaskButton());
    root.appendChild(bar);
    const form = newTaskForm();
    if (form) root.appendChild(form);
  }
  if (!state.ok) return root.appendChild(empty(t("El tablero no responde."), t("Arráncalo con: {command}", { command: "node board.js ensure" }), "closed"));
  if (board) return renderBoard(root);
  (NON_TASK_VIEWS[state.tab] || renderTasks)(root);
}

const FIELDS = ["cluster", "daily", "dailies", "tidies", "sessionProfiles", "sessions", "aliases", "reporterRoute", "reporterStatus", "boardStatus", "orchestrator", "epics", "allEpics", "reports", "lastReview", "config", "followUps", "sentry", "permissions", "hosted", "contextSync", "contextTidy", "messages", "tidyBlockers", "lastContextPass", "followUpStatus", "refreshRequest", "deployments", "deployerArea", "quota", "people", "jiraSetup", "voice", "speech", "deployStatus", "reviewJob", "convProfiles", "claudeTokenExpires", "workHours", "workSchedule", "restrictions", "mailman", "stuckDialogs", "testWaits", "machine", "reminders", "watchdog", "progress", "progressPhases", "github"];
const withoutReadTime = (d) => JSON.stringify(d, (k, v) => (k === "syncedAt" ? undefined : v));
const editing = () => {
  const a = document.activeElement;
  return !!a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName) && !!a.closest("#groups, #settings-body");
};
const liveFocus = () => {
  const a = document.activeElement;
  return a && a.tagName === "TEXTAREA" && a.closest(".term-inline") ? a : null;
};
let last = "";
let deferred = null;

let viaHeaders = [null, null];

function showVia(via, stale) {
  if (via !== undefined) viaHeaders = [via, stale];
  [via, stale] = viaHeaders;
  const c = state.cluster;
  let el = document.getElementById("via");
  if (!via && !stale) return el && el.remove();
  if (!el) {
    el = document.createElement("p");
    el.id = "via";
    document.body.prepend(el);
  }
  const primary = (c && c.label) || t("el ordenador que manda");
  el.className = stale ? "via stale" : "via";
  if (stale) el.textContent = t("Estás en el {machine} y el otro ordenador no responde: ves los últimos datos copiados. Si sigue así, en un minuto manda el {machine}.", { machine: stale });
  else el.textContent = t("Estás en el {machine}: lo que ves es el tablero del {primary}, que es el que manda.", { machine: via, primary });
}

function apply(d) {
  for (const k of FIELDS) state[k] = d[k];
  state.allAreas = [...d.areas].sort((a, b) => a.name.localeCompare(b.name, "es"));
  state.allTasks = d.tasks.map((v) => ({ ...v, id: v.key }));
  state.allSessions = d.sessions || { list: [], syncedAt: null };
  applyProjectFilter();
  state.config = d.config || {};
  renderReport();
  updateStamp();
  render();
  showVia();
}

let lastHash = "";
let inFlight = null;
let failures = 0;
function reload(force) {
  if (inFlight && !force) return inFlight;
  const headers = force || !lastHash ? {} : { "x-state-hash": lastHash };
  inFlight = fetch("/api/state", { cache: "no-store", headers })
    .then((r) => {
      showVia(r.headers.get("x-tower-via"), r.headers.get("x-tower-stale"));
      if (!r.ok && r.status !== 204) throw new Error(String(r.status));
      failures = 0;
      if (r.status === 204) return null;
      lastHash = r.headers.get("x-state-hash") || "";
      return r.json();
    })
    .then((d) => {
      if (!d) {
        state.ok = true;
        return updateStamp();
      }
      state.ok = true;
      const raw = withoutReadTime(d);
      if (raw === last && !force) {
        state.sessions = d.sessions || state.sessions;
        return updateStamp();
      }
      const talkBox = liveFocus();
      if (!force && editing() && !talkBox) {
        deferred = d;
        Object.assign(state, { reports: d.reports || [], lastReview: d.lastReview || null, refreshRequest: d.refreshRequest || null, sessions: d.sessions || state.sessions });
        renderReport();
        return updateStamp();
      }
      last = raw;
      deferred = null;
      const selection = talkBox ? [talkBox.selectionStart, talkBox.selectionEnd] : null;
      apply(d);
      if (talkBox && talkBox.isConnected && document.activeElement !== talkBox) {
        talkBox.focus({ preventScroll: true });
        if (selection[0] != null) talkBox.setSelectionRange(...selection);
      }
    })
    .catch(() => {
      failures++;
      if (state.ok && failures < 4) return;
      state.ok = false;
      last = "";
      lastHash = "";
      render();
    })
    .finally(() => (inFlight = null));
  return inFlight;
}

applyTheme();
translateStatic();

setRender(() => {
  const started = performance.now();
  render();
  const ms = performance.now() - started;
  if (ms > 300) reportPageError("slow-render", `${Math.round(ms)} ms`, state.tab);
});
setRefresh(reload);
mountHeader();
syncPush();
document.addEventListener("focusout", () =>
  setTimeout(() => {
    if (!deferred || editing()) return;
    const d = deferred;
    deferred = null;
    last = withoutReadTime(d);
    apply(d);
  }, 80)
);
document.addEventListener("visibilitychange", () => !document.hidden && reload(false));
MOBILE.addEventListener("change", render);
let reportHidden = false;
try {
  reportHidden = localStorage.getItem("report-hidden") === "1";
} catch (e) {}
document.body.classList.toggle("report-hidden", reportHidden);
function setReportHidden(hidden) {
  reportHidden = hidden;
  document.body.classList.toggle("report-hidden", hidden);
  try {
    localStorage.setItem("report-hidden", hidden ? "1" : "");
  } catch (e) {}
  window.dispatchEvent(new Event("layoutchange"));
  render();
}
const ACTIVITY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>';
const YOLO_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
function iconButton(cls, icon, label, attrs) {
  const b = h("button", { class: cls, type: "button", ...attrs }, [h("span", { class: "top-btn-icon" }), h("span", { class: "top-btn-text", text: label })]);
  b.firstChild.innerHTML = icon;
  return b;
}
function activityButton() {
  return iconButton(`btn top-btn activity-toggle${reportHidden ? "" : " on"}`, ACTIVITY_ICON, t("Última actividad"), {
    "aria-controls": "report",
    "aria-pressed": String(!reportHidden),
    title: reportHidden ? t("Enseñar la última actividad de Jira y GitHub") : t("Ocultar la última actividad"),
    onclick: () => setReportHidden(!reportHidden),
  });
}
function yoloButton() {
  const on = !!(state.config && state.config.yolo);
  return iconButton(`btn top-btn yolo-toggle${on ? " on" : ""}`, YOLO_ICON, t("YOLO"), {
    "aria-pressed": String(on),
    title: on ? t("Modo YOLO activo: pulsa para apagarlo") : t("Todo automático: las tareas pendientes van solas a su sesión (si no tienen, el tablero crea una con el nombre del epic) y los posibles errores del seguimiento, a la sesión de errores. Las restricciones siguen mandando."),
    onclick: toggleYolo,
  });
}
render();
const askedTab = new URLSearchParams(location.search).get("tab");
if (askedTab) {
  history.replaceState(null, "", "/");
  if (SETTINGS.includes(askedTab)) openSettings(askedTab);
  else state.tab = askedTab;
}
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => e.data && e.data.tab && switchView(e.data.tab, true));
const pageErrors = [];
function reportPageError(kind, message, where) {
  pageErrors.push({ at: new Date().toISOString(), kind, message: String(message || "").slice(0, 300), where: String(where || "").slice(0, 200), tab: state.tab, hidden: document.hidden });
  if (pageErrors.length > 30) pageErrors.shift();
  fetch("/api/page-errors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ua: navigator.userAgent, errors: pageErrors }) }).catch(() => {});
}
window.addEventListener("error", (e) => reportPageError("error", e.message, `${e.filename}:${e.lineno}`));
try {
  new PerformanceObserver((list) => list.getEntries().forEach((e) => e.duration > 500 && reportPageError("long-task", `${Math.round(e.duration)} ms`, e.name))).observe({ type: "longtask", buffered: true });
} catch (e) {}
window.addEventListener("unhandledrejection", (e) => reportPageError("promise", e.reason && (e.reason.stack || e.reason.message || e.reason)));
reload(true);
let ticks = 0;
setInterval(() => {
  ticks++;
  if (document.hidden && ticks % 5) return;
  reload(false);
}, 3000);

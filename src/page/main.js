import { state, h, post, switchView, setRender, setRefresh, empty, reviewer } from "./lib/base.js";
import { renderTasks, renderToday, renderBoard } from "./views/tasks.js";
import { renderSessions } from "./views/sessions.js";
import { renderDeploy } from "./views/deploy.js";
import { renderTalk } from "./views/talk.js";
import { renderContext } from "./views/context.js";
import { renderFollowUp } from "./views/follow-up.js";
import { renderReport, updateStamp, mountHeader, quotaBlock, tokenBanner, overtimeBanner } from "./components/report.js";
import { renderHome, sessionStrip, shortcuts, homeAlerts, stuckBanners } from "./views/home.js";
import { renderDaily } from "./views/daily.js";
import { batteryBadge } from "./components/battery.js";
import { renderLearning } from "./views/learning.js";
import { renderSentry } from "./views/sentry.js";
import { renderProjects } from "./views/projects.js";
import { renderWorkspaces } from "./views/workspaces.js";
import { renderFind, searchBox } from "./views/find.js";
import { renderMachines } from "./views/machines.js";
import { paintTicket } from "./components/ticket.js";
import { newTaskButton, newTaskForm } from "./components/new-task.js";
import { projectPicker, applyProjectFilter, tabVisible, hasModule, mixedProjects, mainProject, projectTitle } from "./components/project-filter.js";

const TASK_TABS = [
  { id: "pending", label: "Pendientes" },
  { id: "approved", label: "Por enviar" },
  { id: "waiting", label: "Te esperan" },
  { id: "sent", label: "En curso" },
  { id: "done", label: "Hechas" },
  { id: "ignored", label: "Ignoradas" },
];
const GROUPS = [
  [
    "Mi día",
    [
      { id: "home", label: "Inicio", hint: "Qué pasa ahora" },
      { id: "tasks", label: "Tareas", hint: "Lo de Jira y lo que te espera" },
      { id: "talk", label: "Hablar", hint: "Escribir a una sesión" },
      { id: "daily", label: "Daily", hint: "El resumen de ayer y lo de hoy" },
    ],
  ],
  [
    "Arreglar y entregar",
    [
      { id: "sentry", label: "Errores", hint: "Errores de Sentry a una sesión" },
      { id: "deploy", label: "Desplegar", hint: "Subir a develop o producción" },
    ],
  ],
  [
    "Entorno",
    [
      { id: "projects", label: "Servidores", hint: "Servidores de desarrollo en local" },
      { id: "machines", label: "Ordenadores", hint: "PC y Mac: quién manda" },
    ],
  ],
  [
    "Qué hacen los demás",
    [
      { id: "follow-up", label: "Seguimiento", hint: "Lo que hacen los compañeros" },
      { id: "learning", label: "Aprendizaje", hint: "Si vuelven menos tareas" },
    ],
  ],
  [
    "Ajustes",
    [
      { id: "workspaces", label: "Proyectos", hint: "Alta y ajustes de cada proyecto" },
      { id: "sessions", label: "Sesiones", hint: "Quién lleva cada epic" },
      { id: "context", label: "Ordenar contexto", hint: "Repasar context/" },
    ],
  ],
];
const VIEWS = {
  learning: ["Aprendizaje", "Si el contexto que van guardando las sesiones hace que vuelvan menos tareas de revisión."],
  home: ["Inicio", "Lo que te necesita y cómo van las sesiones."],
  daily: ["Daily", "El resumen del último día laborable para copiar en Slack y lo que llevas hoy. Lo de hoy se va rellenando solo; redactarlo lo hace Claude cuando lo pides."],
  pending: ["Pendientes", "Tareas nuevas o devueltas que puedes pasar a la sesión de su epic. Nada se envía hasta que pulsas Hacer."],
  approved: ["Por enviar", "Aprobadas con Hacer, mientras el tablero las escribe en su sesión. Si no puede, lo dice aquí."],
  sent: ["En curso", "Lo que ya está en su sesión, con lo que ha contestado."],
  waiting: ["Te esperan", "Una sesión se ha parado en estas tareas: te pregunta algo o no ha podido terminarlas y dice por qué. Contéstale aquí o devuélvelas a Pendientes."],
  done: ["Hechas", "La sesión dice que ha terminado: pendientes de que tú las revises. En Jira siguen «En curso»."],
  ignored: ["Ignoradas", "Descartadas con Ignorar. Se pueden recuperar."],
  deploy: ["Desplegar", "Sube proyectos a develop, a producción o a los dos. La orden sale de aquí hacia la sesión que despliega; nada se sube hasta que pulsas Desplegar."],
  sessions: ["Sesiones", "Qué sesión lleva cada epic y en qué está cada una. Las dormidas se despiertan solas cuando les llega algo."],
  machines: ["Ordenadores", "Quién manda, el horario del Mac y el token de Claude."],
  find: ["Buscar", "Lo que coincide en las tareas del tablero, en las sesiones y en Jira. Lo de Jira se puede traer a Pendientes."],
  today: ["Hoy", "Lo que necesita algo de ti ahora mismo y, debajo, el último reporte."],
  more: ["Más", "Errores, despliegues, tu ordenador, lo que hacen los demás y ajustes."],
  talk: ["Hablar", "Las sesiones del tablero en directo: las fijas y cualquier otra que esté abierta. Escríbeles o córtalas, o abre una nueva para hablar."],
  workspaces: ["Proyectos", "Cada proyecto que lleva el tablero: su carpeta en este ordenador, sus módulos y sus credenciales."],
  projects: ["Servidores", "Los servidores locales que usan las sesiones: base de datos, API y webs de cada proyecto."],
  sentry: ["Errores", "Errores sin resolver de los proyectos de Sentry. Elige la sesión y pulsa Enviar: el tablero se lo pasa con el enlace y te cuenta aquí lo que ha encontrado."],
  context: ["Ordenar contexto", "La orquestadora repasa y ordena context/ y el índice de AGENTS.md. Solo se puede lanzar con todo limpio: sin tareas pendientes, por enviar ni en sesión."],
  "follow-up": ["Seguimiento", "Lo que hace cada uno según sus peticiones a la API, separado por persona: beta se resume sola cada hora y producción cada dos; cualquiera de los dos, también cuando lo pidas."],
};
const mainOnly = (paint) => (root) => {
  if (mixedProjects()) root.appendChild(projectTitle(mainProject()));
  return paint(root);
};
const NON_TASK_VIEWS = {
  learning: mainOnly(renderLearning),
  home: renderHome,
  daily: renderDaily,
  sessions: renderSessions,
  find: renderFind,
  machines: renderMachines,
  deploy: mainOnly(renderDeploy),
  sentry: mainOnly(renderSentry),
  projects: renderProjects,
  workspaces: renderWorkspaces,
  "follow-up": mainOnly(renderFollowUp),
  context: renderContext,
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
  projects: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2-3 2M13 15h4"/>',
  machines: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  workspaces: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  "follow-up": '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  learning: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/>',
  sessions: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
  context: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};
const navIcon = (id) => {
  const s = h("span", { class: "tab-icon", "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[id] || ""}</svg>`;
  return s;
};
const BOTTOM_BAR = [
  ["today", "Hoy", "today"],
  ["tasks", "Tareas", "pending"],
  ["talk", "Hablar", "talk"],
  ["more", "Más", "more"],
];
const MOBILE = window.matchMedia("(max-width: 760px)");
const isTaskTab = (tab) => TASK_TABS.some((t) => t.id === tab);
const tabOf = (status) => (status === "partial" ? "waiting" : status === "jira" ? "find" : status === "epics" || status === "sessions-new" ? "sessions" : status);

try {
  const saved = localStorage.getItem("board-tab");
  state.tab = tabOf(saved || "home");
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
    const shown = list.filter((t) => tabVisible(t.id));
    if (!shown.length) continue;
    tabs.appendChild(h("div", { class: "tab-group", text: group }));
    for (const t of shown) {
      if (t.id === "tasks") {
        tabs.appendChild(tasksTab(counts));
        continue;
      }
      const n = isTaskTab(t.id) ? counts[t.id] : t.id === "deploy" ? waitingDeploys || undefined : undefined;
      const cls = `tab${n && HIGHLIGHT.includes(t.id) ? " has" : ""}${n && t.id === "waiting" ? " urgent" : ""}`;
      tabs.appendChild(h("button", { class: cls, role: "tab", "aria-selected": String(state.tab === t.id), type: "button", title: `${t.label}: ${t.hint}`, onclick: () => switchView(t.id) }, [navIcon(t.id), tabText(t), n === undefined ? null : h("span", { class: "n", text: String(n) })]));
    }
  }
}

const tabText = (t) => h("span", { class: "tab-text", text: t.label });

function lastTaskTab() {
  try {
    const t = localStorage.getItem("last-task-tab");
    return isTaskTab(t) ? t : "pending";
  } catch (e) {
    return "pending";
  }
}

function tasksTab(counts) {
  const badges = [];
  if (counts.pending) badges.push(h("span", { class: "n", title: "Pendientes", text: String(counts.pending) }));
  if (counts.waiting) badges.push(h("span", { class: "n alert", title: "Te esperan", text: String(counts.waiting) }));
  const cls = `tab${counts.pending ? " has" : ""}`;
  return h("button", { class: cls, role: "tab", "aria-selected": String(isTaskTab(state.tab)), type: "button", title: "Tareas: lo de Jira y lo que te espera", onclick: () => switchView(lastTaskTab()) }, [navIcon("tasks"), tabText({ label: "Tareas", hint: "Lo de Jira y lo que te espera" }), h("span", { class: "tab-badges" }, badges)]);
}

function paintBottomBar(section, attention) {
  const bottom = document.getElementById("bottom");
  bottom.textContent = "";
  for (const [id, label, target] of BOTTOM_BAR) {
    const b = h("button", { type: "button", "aria-current": section === id ? "page" : "false" });
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;
    b.appendChild(document.createTextNode(label));
    if (attention[id]) {
      const n = attention[id];
      const what = id === "today" ? `${n} ${n === 1 ? "cosa espera" : "cosas esperan"} tu decisión: tareas por decidir o posibles errores del seguimiento` : `${n} sin terminar`;
      b.appendChild(h("span", { class: "badge", text: String(n), title: what, "aria-label": what }));
    }
    b.addEventListener("click", () => switchView(target, true));
    bottom.appendChild(b);
  }
}

function statusChips(root, counts, board) {
  const chips = h("div", { class: "status-chips", role: "group", "aria-label": "Listas de tareas" });
  const open = (id) => () => {
    if (board) {
      try {
        localStorage.setItem("task-view", "list");
      } catch (e) {}
    }
    switchView(id);
  };
  for (const t of TASK_TABS.filter((x) => !board || x.id === "ignored")) chips.appendChild(h("button", { type: "button", class: `${counts[t.id] ? "" : "zero"}${t.id === "waiting" && counts.waiting ? " alert" : ""}`, "aria-pressed": String(!board && state.tab === t.id), text: t.label + (counts[t.id] ? ` ${counts[t.id]}` : ""), onclick: open(t.id) }));
  root.appendChild(chips);
  const sel = chips.querySelector('[aria-pressed="true"]');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest", inline: "center" });
}

function renderMore(root, waitingDeploys, errors) {
  const options = GROUPS.flatMap(([, list]) => list).filter((t) => !["home", "tasks", "talk"].includes(t.id) && tabVisible(t.id));
  const menu = h(
    "div",
    { class: "more-menu" },
    options.map((t) => {
      const extra = t.id === "deploy" && waitingDeploys ? ` · ${waitingDeploys} esperando` : t.id === "follow-up" && errors ? ` · ${errors} posibles errores` : "";
      return h("button", { type: "button", onclick: () => switchView(t.id, true) }, [h("strong", { text: t.label + extra }), h("span", { text: VIEWS[t.id][1] })]);
    })
  );
  root.appendChild(searchBox());
  root.appendChild(menu);
  root.appendChild(quotaBlock());
}

function taskView() {
  try {
    return localStorage.getItem("task-view") || "board";
  } catch (e) {
    return "board";
  }
}

function viewSwitch(current) {
  const pick = (v) => () => {
    try {
      localStorage.setItem("task-view", v);
    } catch (e) {}
    if (v === "board" && state.tab === "ignored") return switchView("pending");
    render();
  };
  return h("div", { class: "view-switch", role: "group", "aria-label": "Vista de tareas" }, [
    h("button", { type: "button", "aria-pressed": String(current === "list"), text: "Lista", onclick: pick("list") }),
    h("button", { type: "button", "aria-pressed": String(current === "board"), text: "Tablero", onclick: pick("board") }),
  ]);
}

function returnedRule(root) {
  const rule = h("input", { type: "checkbox", id: "auto-returned" });
  rule.checked = !!(state.config && state.config.autoReturned);
  rule.addEventListener("change", () => post("/api/config", { autoReturned: rule.checked }, rule.checked ? "Las tareas devueltas o comentadas irán solas a la sesión que las hizo." : "Las tareas devueltas o comentadas esperarán aquí a que pulses Hacer."));
  root.appendChild(h("label", { class: "rule", for: "auto-returned" }, [rule, ` Enviar solas a su sesión las tareas devueltas o comentadas por ${reviewer()}`]));
}

function paintProjectPicker() {
  const onChange = () => {
    applyProjectFilter();
    if (!tabVisible(state.tab)) return switchView("home");
    render();
  };
  const top = document.getElementById("top-project");
  if (top && !top.contains(document.activeElement)) {
    top.textContent = "";
    const pick = projectPicker(onChange);
    if (pick) top.appendChild(pick);
  }
  const brand = document.querySelector(".nav > .brand");
  if (brand && !brand.contains(document.activeElement)) {
    const old = brand.querySelector(".mobile-project");
    if (old) old.remove();
    const pick = projectPicker(onChange);
    if (pick) {
      pick.classList.add("mobile-project");
      brand.appendChild(pick);
    }
  }
}

let renderedTab = null;

function render() {
  const keepY = renderedTab === state.tab ? window.scrollY : null;
  const groups = document.getElementById("groups");
  if (keepY !== null && groups) groups.style.minHeight = groups.offsetHeight + "px";
  try {
    paint();
    paintTicket();
  } finally {
    renderedTab = state.tab;
    if (groups) groups.style.minHeight = "";
    if (keepY !== null && window.scrollY !== keepY) window.scrollTo(0, Math.min(keepY, document.documentElement.scrollHeight));
  }
}

function paint() {
  state.renderSeq = (state.renderSeq || 0) + 1;
  const counts = Object.fromEntries(TASK_TABS.map((t) => [t.id, 0]));
  for (const t of state.tasks) if (counts[tabOf(t.status)] !== undefined) counts[tabOf(t.status)]++;
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
  if (c && c.peer) {
    const stale = viaHeaders[1];
    const text = stale ? `${stale}: el otro no responde` : c.role === "primary" ? `Manda el ${c.label || "ordenador"}` : "Sin ordenador al mando";
    right.appendChild(h("span", { class: `commander${stale || c.role !== "primary" ? " warn" : ""}`, title: c.role === "primary" ? `Manda desde ${new Date(c.since).toLocaleString("es-ES")}` : "", text }));
  }
  const badge = batteryBadge(c && c.macPower && c.macPower.battery);
  if (badge) right.appendChild(badge);
  const brand = document.querySelector(".nav > .brand");
  if (brand) {
    const old = brand.querySelector(".mobile-battery");
    if (old) old.remove();
    const small = batteryBadge(c && c.macPower && c.macPower.battery);
    brand.appendChild(h("span", { class: "mobile-battery" }, [small, quotaBlock()]));
  }
  right.appendChild(quotaBlock());
  paintProjectPicker();
  document.querySelector(".app").setAttribute("data-jira", hasModule("jira") ? "on" : "off");
  document.querySelector(".app").setAttribute("data-view", state.tab);
  document.querySelector(".app").setAttribute("data-section", section);
  const board = !mobile && isTaskTab(state.tab) && state.tab !== "ignored" && taskView() === "board";
  const [title, sub] = board ? ["Tareas", "Todas las tareas por estado. Pulsa una para ver su tarjeta entera."] : VIEWS[state.tab] || VIEWS.pending;
  document.getElementById("view-title").textContent = title;
  document.getElementById("view-sub").textContent = sub;

  const root = document.getElementById("groups");
  root.textContent = "";
  if (["home", "today"].includes(state.tab)) {
    const alerts = homeAlerts([...stuckBanners(), overtimeBanner(), tokenBanner(() => switchView("machines", true))]);
    if (alerts) root.appendChild(alerts);
  }
  if (section === "tasks") {
    try {
      localStorage.setItem("last-task-tab", state.tab);
    } catch (e) {}
    statusChips(root, counts, board);
  }
  if (state.tab === "today") {
    shortcuts(root);
    const strip = sessionStrip();
    if (strip) root.appendChild(strip);
    return renderToday(root, errors);
  }
  if (state.tab === "more") return renderMore(root, waitingDeploys, errors);
  const switchable = !mobile && isTaskTab(state.tab);
  if (switchable || state.tab === "pending") {
    const bar = h("div", { class: "task-toolbar" });
    if (switchable) bar.appendChild(viewSwitch(board ? "board" : "list"));
    const chips = !mobile && root.querySelector(".status-chips");
    if (chips) bar.appendChild(chips);
    bar.appendChild(newTaskButton());
    if ((state.tab === "pending" || switchable) && hasModule("jira")) returnedRule(bar);
    root.appendChild(bar);
    const form = newTaskForm();
    if (form) root.appendChild(form);
  }
  if (!state.ok) return root.appendChild(empty("El tablero no responde.", "Arráncalo con: node board.js ensure"));
  if (board) return renderBoard(root);
  (NON_TASK_VIEWS[state.tab] || renderTasks)(root);
}

const FIELDS = ["cluster", "daily", "dailies", "tidies", "sessionProfiles", "sessions", "aliases", "reporterRoute", "reporterStatus", "boardStatus", "orchestrator", "epics", "allEpics", "reports", "lastReview", "config", "followUps", "sentry", "permissions", "hosted", "contextSync", "contextTidy", "messages", "tidyBlockers", "lastContextPass", "followUpStatus", "refreshRequest", "deployments", "deployerArea", "quota", "people", "jiraSetup", "voice", "speech", "deployStatus", "reviewJob", "convProfiles", "claudeTokenExpires", "workHours", "workSchedule", "restrictions", "mailman", "stuckDialogs"];
const withoutReadTime = (d) => JSON.stringify(d, (k, v) => (k === "syncedAt" ? undefined : v));
const editing = () => {
  const a = document.activeElement;
  return !!a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName) && !!a.closest("#groups");
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
  const primary = (c && c.label) || "el ordenador que manda";
  el.className = stale ? "via stale" : "via";
  if (stale) el.textContent = `Estás en el ${stale} y el otro ordenador no responde: ves los últimos datos copiados. Si sigue así, en un minuto manda el ${stale}.`;
  else el.textContent = `Estás en el ${via}: lo que ves es el tablero del ${primary}, que es el que manda.`;
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
function reload(force) {
  if (inFlight && !force) return inFlight;
  const headers = force || !lastHash ? {} : { "x-state-hash": lastHash };
  inFlight = fetch("/api/state", { cache: "no-store", headers })
    .then((r) => {
      showVia(r.headers.get("x-tower-via"), r.headers.get("x-tower-stale"));
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
      state.ok = false;
      last = "";
      lastHash = "";
      render();
    })
    .finally(() => (inFlight = null));
  return inFlight;
}

setRender(() => {
  const started = performance.now();
  render();
  const ms = performance.now() - started;
  if (ms > 300) reportPageError("slow-render", `${Math.round(ms)} ms`, state.tab);
});
setRefresh(reload);
mountHeader();
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
const navToggle = document.getElementById("nav-toggle");
const setNavHidden = (hidden, save) => {
  document.body.classList.toggle("nav-hidden", hidden);
  navToggle.setAttribute("aria-expanded", String(!hidden));
  navToggle.title = hidden ? "Desplegar el menú lateral" : "Plegar el menú lateral a solo iconos";
  navToggle.setAttribute("aria-label", navToggle.title);
  if (!save) return;
  try {
    localStorage.setItem("nav-hidden", hidden ? "1" : "");
  } catch (e) {}
  window.dispatchEvent(new Event("layoutchange"));
};
let navHidden = false;
try {
  navHidden = localStorage.getItem("nav-hidden") === "1";
} catch (e) {}
setNavHidden(navHidden, false);
navToggle.addEventListener("click", () => setNavHidden(!document.body.classList.contains("nav-hidden"), true));
const reportToggle = document.getElementById("report-toggle");
const setReportCollapsed = (collapsed, save) => {
  document.body.classList.toggle("report-collapsed", collapsed);
  reportToggle.setAttribute("aria-expanded", String(!collapsed));
  reportToggle.title = collapsed ? "Desplegar el reporte de Jira" : "Plegar el reporte de Jira";
  reportToggle.setAttribute("aria-label", reportToggle.title);
  if (!save) return;
  try {
    localStorage.setItem("report-collapsed", collapsed ? "1" : "");
  } catch (e) {}
  window.dispatchEvent(new Event("layoutchange"));
};
let reportCollapsed = false;
try {
  reportCollapsed = localStorage.getItem("report-collapsed") === "1";
} catch (e) {}
setReportCollapsed(reportCollapsed, false);
reportToggle.addEventListener("click", () => setReportCollapsed(!document.body.classList.contains("report-collapsed"), true));
document.querySelector(".report-head strong").addEventListener("click", () => document.body.classList.contains("report-collapsed") && setReportCollapsed(false, true));
render();
const askedTab = new URLSearchParams(location.search).get("tab");
if (askedTab) {
  state.tab = askedTab;
  history.replaceState(null, "", "/");
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

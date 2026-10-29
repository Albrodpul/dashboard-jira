import { state, h, post, switchView, setRender, setRefresh, empty, reviewer } from "./base.js";
import { renderTasks, renderToday, renderBoard } from "./tasks.js";
import { renderSessions, renderEpics } from "./sessions.js";
import { renderDeploy, renderTalk, renderContext, renderFollowUp } from "./operations.js";
import { renderReport, updateStamp, mountHeader, quotaBlock } from "./report.js";
import { renderHome, sessionStrip, shortcuts, dailyCard } from "./home.js";
import { renderLearning } from "./learning.js";
import { renderSentry } from "./sentry.js";
import { renderProjects } from "./projects.js";
import { renderFind, searchBox } from "./find.js";
import { renderMachines } from "./machines.js";

const TASK_TABS = [
  { id: "pending", label: "Pendientes" },
  { id: "approved", label: "Por enviar" },
  { id: "sent", label: "En curso" },
  { id: "waiting", label: "Te esperan" },
  { id: "done", label: "Hechas" },
  { id: "ignored", label: "Ignoradas" },
];
const GROUPS = [
  [
    "General",
    [
      { id: "home", label: "Inicio" },
      { id: "tasks", label: "Tareas" },
      { id: "talk", label: "Hablar" },
    ],
  ],
  [
    "Operar",
    [
      { id: "projects", label: "Proyectos" },
      { id: "deploy", label: "Desplegar" },
      { id: "sentry", label: "Sentry" },
      { id: "context", label: "Ordenar contexto" },
    ],
  ],
  [
    "Equipo",
    [
      { id: "follow-up", label: "Seguimiento" },
      { id: "learning", label: "Aprendizaje" },
    ],
  ],
  [
    "Configurar",
    [
      { id: "sessions", label: "Sesiones" },
      { id: "epics", label: "Epics" },
      { id: "machines", label: "Equipos" },
    ],
  ],
];
const VIEWS = {
  learning: ["Aprendizaje", "Si el contexto que van guardando las sesiones hace que vuelvan menos tareas de revisión."],
  home: ["Inicio", "Qué sesiones están trabajando, cuáles se han parado con algo pendiente y cuáles están libres."],
  pending: ["Pendientes", "Tareas nuevas o devueltas que puedes pasar a la sesión de su epic. Nada se envía hasta que pulsas Hacer."],
  approved: ["Por enviar", "Aprobadas con Hacer, esperando a que la sesión que orquesta las envíe."],
  sent: ["En curso", "Lo que ya está en su sesión, con lo que ha contestado."],
  waiting: ["Te esperan", "Una sesión se ha parado en estas tareas: te pregunta algo o no ha podido terminarlas y dice por qué. Contéstale aquí o devuélvelas a Pendientes."],
  done: ["Hechas", "La sesión dice que ha terminado: pendientes de que tú las revises. En Jira siguen «En curso»."],
  ignored: ["Ignoradas", "Descartadas con Ignorar. Se pueden recuperar."],
  deploy: ["Desplegar", "Sube proyectos a develop, a producción o a los dos. La orden sale de aquí hacia la sesión que despliega; nada se sube hasta que pulsas Desplegar."],
  sessions: ["Sesiones", "Las sesiones que pueden recibir tareas, con el nombre que les pones tú."],
  epics: ["Epics", "Qué sesión lleva cada epic."],
  machines: ["Equipos", "Los ordenadores de tu Tailscale, cuál manda y desde cuándo. Puedes pasar el mando a mano."],
  find: ["Buscar", "Lo que coincide en las tareas del tablero, en las sesiones y en Jira. Lo de Jira se puede traer a Pendientes."],
  today: ["Hoy", "Lo que necesita algo de ti ahora mismo y, debajo, el último reporte."],
  more: ["Más", "Buscar, operar, equipo y configuración."],
  talk: ["Hablar", "Las sesiones del tablero en directo: las fijas y cualquier otra que esté abierta. Escríbeles o córtalas, o abre una nueva para hablar."],
  projects: ["Proyectos", "Los servidores locales que usan las sesiones: MySQL, super-app, Donatella, backoffice y landing."],
  sentry: ["Sentry", "Errores sin resolver de landing, backoffice y super-app. Elige la sesión y pulsa Enviar: la orquestadora se lo pasa con el enlace y te cuenta aquí lo que ha encontrado."],
  context: ["Ordenar contexto", "La orquestadora repasa y ordena context/ y el índice de AGENTS.md. Solo se puede lanzar con todo limpio: nada pendiente, por enviar, en sesión ni desplegándose."],
  "follow-up": ["Seguimiento", "Lo que ha hecho cada compañero según sus peticiones a la API: el revisor principal tiene resumen automático cada hora; los demás, cuando lo pidas."],
};
const NON_TASK_VIEWS = {
  learning: renderLearning,
  home: renderHome,
  sessions: renderSessions,
  epics: renderEpics,
  find: renderFind,
  machines: renderMachines,
  deploy: renderDeploy,
  sentry: renderSentry,
  projects: renderProjects,
  "follow-up": renderFollowUp,
  context: renderContext,
  talk: renderTalk,
};
const ICONS = {
  today: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  talk: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
};
const BOTTOM_BAR = [
  ["today", "Hoy", "today"],
  ["tasks", "Tareas", "pending"],
  ["talk", "Hablar", "talk"],
  ["more", "Más", "more"],
];
const MOBILE = window.matchMedia("(max-width: 760px)");
const isTaskTab = (tab) => TASK_TABS.some((t) => t.id === tab);
const tabOf = (status) => (status === "partial" ? "waiting" : status === "jira" ? "find" : status);

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
    tabs.appendChild(h("div", { class: "tab-group", text: group }));
    for (const t of list) {
      if (t.id === "tasks") {
        tabs.appendChild(tasksTab(counts));
        continue;
      }
      const n = isTaskTab(t.id) ? counts[t.id] : t.id === "deploy" ? waitingDeploys || undefined : undefined;
      const cls = `tab${n && HIGHLIGHT.includes(t.id) ? " has" : ""}${n && t.id === "waiting" ? " urgent" : ""}`;
      tabs.appendChild(h("button", { class: cls, role: "tab", "aria-selected": String(state.tab === t.id), type: "button", onclick: () => switchView(t.id) }, [t.label, n === undefined ? null : h("span", { class: "n", text: String(n) })]));
    }
  }
}

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
  return h("button", { class: cls, role: "tab", "aria-selected": String(isTaskTab(state.tab)), type: "button", onclick: () => switchView(lastTaskTab()) }, ["Tareas", h("span", { class: "tab-badges" }, badges)]);
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
  for (const t of TASK_TABS) chips.appendChild(h("button", { type: "button", class: `${counts[t.id] ? "" : "zero"}${t.id === "waiting" && counts.waiting ? " alert" : ""}`, "aria-pressed": String(!board && state.tab === t.id), text: t.label + (counts[t.id] ? ` ${counts[t.id]}` : ""), onclick: open(t.id) }));
  root.appendChild(chips);
  const sel = chips.querySelector('[aria-pressed="true"]');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest", inline: "center" });
}

function renderMore(root, waitingDeploys, errors) {
  const options = [...GROUPS.filter(([g]) => !["General", "Tareas"].includes(g)).flatMap(([, list]) => list)];
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

function render() {
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
    const text = stale ? `${stale}: el otro no responde` : c.role === "primary" ? `Manda el ${c.label || "ordenador"}${c.manual ? " (a mano)" : ""}` : "Sin ordenador al mando";
    right.appendChild(h("span", { class: `commander${stale || c.role !== "primary" ? " warn" : ""}${c.preferred ? "" : " backup"}`, title: c.role === "primary" ? `Manda desde ${new Date(c.since).toLocaleString("es-ES")}` : "", text }));
  }
  right.appendChild(quotaBlock());
  document.querySelector(".app").setAttribute("data-view", state.tab);
  const board = !mobile && isTaskTab(state.tab) && state.tab !== "ignored" && taskView() === "board";
  const [title, sub] = board ? ["Tareas", "Todas las tareas por estado. Pulsa una para ver su tarjeta entera."] : VIEWS[state.tab] || VIEWS.pending;
  document.getElementById("view-title").textContent = title;
  document.getElementById("view-sub").textContent = sub;

  const root = document.getElementById("groups");
  root.textContent = "";
  if (section === "tasks") {
    try {
      localStorage.setItem("last-task-tab", state.tab);
    } catch (e) {}
    statusChips(root, counts, board);
  }
  if (state.tab === "today") {
    const strip = sessionStrip();
    if (strip) root.appendChild(strip);
    shortcuts(root);
    dailyCard(root);
    return renderToday(root, errors);
  }
  if (state.tab === "more") return renderMore(root, waitingDeploys, errors);
  if (!mobile && isTaskTab(state.tab) && state.tab !== "ignored") root.appendChild(viewSwitch(board ? "board" : "list"));
  if (state.tab === "pending" || board) returnedRule(root);
  if (!state.ok) return root.appendChild(empty("El tablero no responde.", "Arráncalo con: node board.js ensure"));
  if (board) return renderBoard(root);
  (NON_TASK_VIEWS[state.tab] || renderTasks)(root);
}

const FIELDS = ["cluster", "daily", "sessions", "aliases", "reporterRoute", "reporterStatus", "boardStatus", "orchestrator", "epics", "allEpics", "reports", "lastReview", "config", "followUps", "sentry", "permissions", "hosted", "contextSync", "contextTidy", "messages", "tidyBlockers", "lastContextPass", "followUpStatus", "refreshRequest", "deployments", "deployerArea", "quota", "people", "jiraSetup", "voice", "speech", "deployStatus"];
const withoutReadTime = (d) => JSON.stringify(d, (k, v) => (k === "syncedAt" ? undefined : v));
const editing = () => {
  const a = document.activeElement;
  return !!a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName) && !!a.closest("#groups");
};
let last = "";
let deferred = null;

let viaHeaders = [null, null];

function showVia(via, stale) {
  if (via !== undefined) viaHeaders = [via, stale];
  [via, stale] = viaHeaders;
  const c = state.cluster;
  const takenOver = !via && !stale && c && c.role === "primary" && c.peer && !c.preferred;
  let el = document.getElementById("via");
  if (!via && !stale && !takenOver) return el && el.remove();
  if (!el) {
    el = document.createElement("p");
    el.id = "via";
    document.body.prepend(el);
  }
  const primary = (c && c.label) || "el ordenador que manda";
  el.className = stale || takenOver ? "via stale" : "via";
  if (takenOver) el.textContent = `Estás viendo el tablero del ${c.label || "otro ordenador"}: el otro ordenador está fuera de servicio y manda este.`;
  else if (stale) el.textContent = `Estás en el ${stale} y el otro ordenador no responde: ves los últimos datos copiados. Si sigue así, en un minuto manda el ${stale}.`;
  else el.textContent = `Estás en el ${via}: lo que ves es el tablero del ${primary}, que es el que manda.`;
}

function apply(d) {
  for (const k of FIELDS) state[k] = d[k];
  state.areas = [...d.areas].sort((a, b) => a.name.localeCompare(b.name, "es"));
  state.tasks = d.tasks.map((v) => ({ ...v, id: v.key }));
  state.sessions = d.sessions || { list: [], syncedAt: null };
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
      const talkBox = document.activeElement && document.activeElement.id === "talk-text" ? document.activeElement : null;
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
      const box = selection && document.getElementById("talk-text");
      if (box) {
        box.focus({ preventScroll: true });
        box.setSelectionRange(...selection);
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

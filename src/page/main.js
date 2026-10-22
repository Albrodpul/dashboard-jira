import { state, h, post, switchView, setRender, setRefresh, empty, reviewer } from "./base.js";
import { renderTasks, renderToday } from "./tasks.js";
import { renderSessions, renderEpics } from "./sessions.js";
import { renderSearch, renderDeploy, renderTalk, renderContext, renderFollowUp } from "./operations.js";
import { renderReport, updateStamp, mountHeader, quotaBlock } from "./report.js";
import { renderHome, sessionStrip } from "./home.js";
import { renderLearning } from "./learning.js";

const TASK_TABS = [
  { id: "pending", label: "Pendientes" },
  { id: "approved", label: "Por enviar" },
  { id: "sent", label: "Enviadas" },
  { id: "waiting", label: "Te esperan" },
  { id: "partial", label: "A medias" },
  { id: "done", label: "Hechas" },
  { id: "ignored", label: "Ignoradas" },
];
const GROUPS = [
  ["Resumen", [{ id: "home", label: "Inicio" }]],
  ["Tareas", TASK_TABS],
  [
    "Operar",
    [
      { id: "deploy", label: "Desplegar" },
      { id: "context", label: "Ordenar contexto" },
      { id: "talk", label: "Hablar" },
    ],
  ],
  [
    "Seguimiento",
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
      { id: "jira", label: "Buscar en Jira" },
    ],
  ],
];
const VIEWS = {
  learning: ["Aprendizaje", "Si el contexto que van guardando las sesiones hace que vuelvan menos tareas de revisión."],
  home: ["Inicio", "Qué sesiones están trabajando, cuáles se han parado con algo pendiente y cuáles están libres."],
  pending: ["Pendientes", "Tareas nuevas o devueltas que puedes pasar a la sesión de su epic. Nada se envía hasta que pulsas Hacer."],
  approved: ["Por enviar", "Aprobadas con Hacer, esperando a que la sesión que orquesta las envíe."],
  sent: ["Enviadas", "Lo que ya está en su sesión, con lo que ha contestado."],
  waiting: ["Te esperan", "Una sesión se ha parado en estas tareas porque necesita que le contestes. Responde aquí y se lo hago llegar."],
  partial: ["A medias", "Tareas que la sesión no ha podido terminar, con el motivo. Puedes contestarle aquí o devolverlas a Pendientes."],
  done: ["Hechas", "La sesión dice que ha terminado: pendientes de que tú las revises. En Jira siguen «En curso»."],
  ignored: ["Ignoradas", "Descartadas con Ignorar. Se pueden recuperar."],
  deploy: ["Desplegar", "Sube proyectos a develop, a producción o a los dos. La orden sale de aquí hacia la sesión que despliega; nada se sube hasta que pulsas Desplegar."],
  sessions: ["Sesiones", "Las conversaciones de VS Code que pueden recibir tareas, con el nombre que les pones tú."],
  epics: ["Epics", "Qué sesión lleva cada epic."],
  jira: ["Buscar en Jira", "Trae a Pendientes tareas que no han salido en ninguna revisión."],
  today: ["Hoy", "Lo que necesita algo de ti ahora mismo y, debajo, el último reporte."],
  more: ["Más", "Operar, seguimiento y configuración."],
  talk: ["Hablar", "Escribe a la sesión de reporte o a la orquestadora como si estuvieras en su pestaña de VS Code. Si no lo leen en 45 segundos, el tablero la abre y la despierta."],
  context: ["Ordenar contexto", "La orquestadora repasa y ordena context/ y el índice de AGENTS.md. Solo se puede lanzar con todo limpio: nada pendiente, por enviar, en sesión ni desplegándose."],
  "follow-up": ["Seguimiento", "Lo que ha hecho cada compañero según sus peticiones a la API: el revisor principal tiene resumen automático cada hora; los demás, cuando lo pidas."],
};
const NON_TASK_VIEWS = {
  learning: renderLearning,
  home: renderHome,
  sessions: renderSessions,
  epics: renderEpics,
  jira: renderSearch,
  deploy: renderDeploy,
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

try {
  const saved = localStorage.getItem("board-tab");
  state.tab = saved || "home";
} catch (e) {}

function paintTabs(counts, waitingDeploys) {
  const tabs = document.getElementById("tabs");
  tabs.textContent = "";
  const HIGHLIGHT = ["pending", "deploy", "waiting", "partial"];
  for (const [group, list] of GROUPS) {
    tabs.appendChild(h("div", { class: "tab-group", text: group }));
    for (const t of list) {
      const n = isTaskTab(t.id) ? counts[t.id] : t.id === "deploy" ? waitingDeploys || undefined : undefined;
      const cls = `tab${n && HIGHLIGHT.includes(t.id) ? " has" : ""}${n && t.id === "waiting" ? " urgent" : ""}`;
      tabs.appendChild(h("button", { class: cls, role: "tab", "aria-selected": String(state.tab === t.id), type: "button", onclick: () => switchView(t.id) }, [t.label, n === undefined ? null : h("span", { class: "n", text: String(n) })]));
    }
  }
}

function paintBottomBar(section, attention) {
  const bottom = document.getElementById("bottom");
  bottom.textContent = "";
  for (const [id, label, target] of BOTTOM_BAR) {
    const b = h("button", { type: "button", "aria-current": section === id ? "page" : "false" });
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;
    b.appendChild(document.createTextNode(label));
    if (attention[id]) b.appendChild(h("span", { class: "badge", text: String(attention[id]) }));
    b.addEventListener("click", () => switchView(target, true));
    bottom.appendChild(b);
  }
}

function statusChips(root, counts) {
  const chips = h("div", { class: "status-chips", role: "group", "aria-label": "Listas de tareas" });
  for (const t of TASK_TABS) chips.appendChild(h("button", { type: "button", class: counts[t.id] ? "" : "zero", "aria-pressed": String(state.tab === t.id), text: t.label + (counts[t.id] ? ` ${counts[t.id]}` : ""), onclick: () => switchView(t.id) }));
  root.appendChild(chips);
  const sel = chips.querySelector('[aria-pressed="true"]');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest", inline: "center" });
}

function renderMore(root, waitingDeploys, errors) {
  const options = GROUPS.filter(([g]) => !["Resumen", "Tareas"].includes(g)).flatMap(([, list]) => list).filter((t) => t.id !== "talk");
  const menu = h(
    "div",
    { class: "more-menu" },
    options.map((t) => {
      const extra = t.id === "deploy" && waitingDeploys ? ` · ${waitingDeploys} esperando` : t.id === "follow-up" && errors ? ` · ${errors} posibles errores` : "";
      return h("button", { type: "button", onclick: () => switchView(t.id, true) }, [h("strong", { text: t.label + extra }), h("span", { text: VIEWS[t.id][1] })]);
    })
  );
  root.appendChild(menu);
  root.appendChild(quotaBlock());
}

function returnedRule(root) {
  const rule = h("input", { type: "checkbox", id: "auto-returned" });
  rule.checked = !!(state.config && state.config.autoReturned);
  rule.addEventListener("change", () => post("/api/config", { autoReturned: rule.checked }, rule.checked ? "Las tareas devueltas o comentadas irán solas a la sesión que las hizo." : "Las tareas devueltas o comentadas esperarán aquí a que pulses Hacer."));
  root.appendChild(h("label", { class: "rule", for: "auto-returned" }, [rule, ` Enviar solas a su sesión las tareas devueltas o comentadas por ${reviewer()}`]));
}

function render() {
  const counts = Object.fromEntries(TASK_TABS.map((t) => [t.id, 0]));
  for (const t of state.tasks) if (counts[t.status] !== undefined) counts[t.status]++;
  const waitingDeploys = (state.deployments || []).filter((x) => x.status === "approved").length;
  const errors = (state.followUps || []).flatMap((r) => r.errors || []).filter((e) => e.state === "proposed").length;
  const mobile = MOBILE.matches;
  if (!mobile && ["report", "today", "more"].includes(state.tab)) state.tab = "home";
  if (mobile && ["report", "home"].includes(state.tab)) state.tab = "today";
  const section = state.tab === "today" ? "today" : isTaskTab(state.tab) ? "tasks" : state.tab === "talk" ? "talk" : "more";

  paintBottomBar(section, { today: counts.pending + counts.waiting + counts.partial + errors, more: waitingDeploys });
  paintTabs(counts, waitingDeploys);
  document.getElementById("tabs").appendChild(quotaBlock());
  document.querySelector(".app").setAttribute("data-view", state.tab);
  const [title, sub] = VIEWS[state.tab] || VIEWS.pending;
  document.getElementById("view-title").textContent = title;
  document.getElementById("view-sub").textContent = sub;

  const root = document.getElementById("groups");
  root.textContent = "";
  if (mobile && section === "tasks") statusChips(root, counts);
  if (state.tab === "today") {
    const strip = sessionStrip();
    if (strip) root.appendChild(strip);
    return renderToday(root, errors);
  }
  if (state.tab === "more") return renderMore(root, waitingDeploys, errors);
  if (state.tab === "pending") returnedRule(root);
  if (!state.ok) return root.appendChild(empty("El tablero no responde.", "Arráncalo con: node board.js ensure"));
  (NON_TASK_VIEWS[state.tab] || renderTasks)(root);
}

const FIELDS = ["sessions", "aliases", "reporterRoute", "reporterStatus", "orchestrator", "epics", "allEpics", "reports", "lastReview", "config", "followUps", "contextTidy", "messages", "tidyBlockers", "lastContextPass", "followUpStatus", "refreshRequest", "deployments", "deployerArea", "quota", "people", "jiraSetup", "voice", "speech"];
const withoutReadTime = (d) => JSON.stringify(d, (k, v) => (k === "syncedAt" ? undefined : v));
const editing = () => {
  const a = document.activeElement;
  return a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName);
};
let last = "";
let deferred = null;

function apply(d) {
  for (const k of FIELDS) state[k] = d[k];
  state.areas = [...d.areas].sort((a, b) => a.name.localeCompare(b.name, "es"));
  state.tasks = d.tasks.map((v) => ({ ...v, id: v.key }));
  state.sessions = d.sessions || { list: [], syncedAt: null };
  state.config = d.config || {};
  renderReport();
  updateStamp();
  render();
}

function reload(force) {
  return fetch("/api/state", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
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
      render();
    });
}

setRender(render);
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
reload(true);
setInterval(() => reload(false), 3000);

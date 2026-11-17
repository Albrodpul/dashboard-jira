import { state, h } from "../lib/base.js";

const KEY = "project-filter";
const workspaces = () => (state.jiraSetup && state.jiraSetup.workspaces) || [];

export function currentProject() {
  if (workspaces().length < 2) return "";
  let v = "";
  try {
    v = localStorage.getItem(KEY) || "";
  } catch (e) {}
  return workspaces().some((p) => p.id === v) ? v : "";
}

export const mixedProjects = () => workspaces().length > 1 && !currentProject();

export const projectName = (id) => (workspaces().find((p) => p.id === id) || {}).name || id || "";

export const mainProject = () => (workspaces()[0] || {}).id || "";

export const projectTitle = (id, n) => h("h3", { class: "project-title" }, [projectName(id || mainProject()), n == null ? null : h("span", { class: "n", text: String(n) })]);

export const inProjectOrder = (ids) => {
  const order = workspaces().map((p) => p.id);
  const at = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  return [...new Set(ids)].sort((a, b) => at(a) - at(b));
};

export const workspacesWith = (module) => workspaces().filter((p) => !p.modules || p.modules[module] !== false).map((p) => p.id);

export const projectChip = (id) => (mixedProjects() ? h("span", { class: "chip project-chip", text: projectName(id || mainProject()) }) : null);

const TAB_MODULE = { daily: "daily", sentry: "sentry", deploy: "deploy", projects: "devServers", "follow-up": "followUp", learning: "jira", context: "context" };

export function hasModule(name) {
  const p = workspaces().find((x) => x.id === currentProject());
  return !p || !p.modules || p.modules[name] !== false;
}

export const tabVisible = (id) => !TAB_MODULE[id] || hasModule(TAB_MODULE[id]);

export const filterTasks = (list) => {
  const p = currentProject();
  return p ? list.filter((t) => t.project === p) : list;
};

export function applyProjectFilter() {
  const p = currentProject();
  const keep = (x) => !p || !x.project || x.project === p;
  const shared = state.boardStatus && state.boardStatus.conversation;
  state.tasks = filterTasks(state.allTasks || state.tasks);
  state.areas = (state.allAreas || state.areas).filter(keep);
  const sessions = state.allSessions || state.sessions;
  state.sessions = { ...sessions, list: (sessions.list || []).filter((s) => keep(s) || (shared && s.conversation === shared)) };
}

function choose(id, onChange) {
  try {
    localStorage.setItem(KEY, id);
  } catch (e) {}
  switchOpen = false;
  onChange();
}

let switchOpen = false;

function paintMenu(onChange) {
  let portal = document.getElementById("ps-portal");
  if (!portal) {
    portal = h("div", { id: "ps-portal" });
    document.body.appendChild(portal);
  }
  portal.textContent = "";
  if (!switchOpen) return;
  const list = workspaces();
  const cur = currentProject();
  const options = [{ id: "", name: "Todos los proyectos" }, ...list].map((p, i) =>
    h("button", { type: "button", role: "option", class: "ps-option", "aria-selected": String(p.id === cur), onclick: () => choose(p.id, onChange) }, [
      h("span", { class: "ps-initial", "aria-hidden": "true", text: p.id ? initial(p.name) : "∗" }),
      h("span", { class: "ps-text" }, [h("span", { class: "ps-option-name", text: p.name }), statLine(p.id)]),
      i < 10 ? h("kbd", { text: String(i) }) : null,
    ])
  );
  portal.appendChild(h("div", { class: "ps-backdrop", onclick: () => ((switchOpen = false), onChange(true)) }));
  portal.appendChild(h("div", { class: "ps-menu", role: "listbox", "aria-label": "Proyecto" }, [h("div", { class: "ps-menu-title", text: "Proyecto" }), ...options]));
}

export function projectStats(id) {
  const sessions = ((state.allSessions || state.sessions || {}).list || []).filter((s) => !id || s.project === id);
  const waitingConv = new Set(((state.permissions && state.permissions.pending) || []).map((p) => p.conversation));
  const tasks = (state.allTasks || state.tasks || []).filter((t) => !id || t.project === id);
  return {
    busy: sessions.filter((s) => s.status === "busy").length,
    waiting: sessions.filter((s) => s.status === "waiting" || waitingConv.has(s.conversation)).length,
    pending: tasks.filter((t) => t.status === "pending").length,
  };
}

function statLine(id) {
  const s = projectStats(id);
  const parts = [];
  if (s.waiting) parts.push(h("span", { class: "ps-wait", text: `${s.waiting} te ${s.waiting === 1 ? "espera" : "esperan"}` }));
  if (s.busy) parts.push(h("span", { text: `${s.busy} trabajando` }));
  if (s.pending) parts.push(h("span", { text: `${s.pending} ${s.pending === 1 ? "tarea pendiente" : "tareas pendientes"}` }));
  return h("span", { class: "ps-stats" }, parts.length ? parts : [h("span", { text: "Sin nada en marcha" })]);
}

const initial = (name) => (String(name || "").trim()[0] || "·").toUpperCase();

export function projectSwitch(onChange, variant) {
  const list = workspaces();
  if (list.length < 2) return null;
  const cur = currentProject();
  const name = cur ? projectName(cur) : "Todos";
  const wrap = h("div", { class: `proj-switch ${variant}${cur ? " filtered" : ""}${switchOpen ? " open" : ""}` });
  const toggle = h("button", { type: "button", class: "ps-button", "aria-haspopup": "listbox", "aria-expanded": String(switchOpen), title: `${cur ? name : "Todos los proyectos"} · cambiar de proyecto (teclas 0-${Math.min(list.length, 9)})`, onclick: () => ((switchOpen = !switchOpen), onChange(true)) }, [
    h("span", { class: "ps-initial", "aria-hidden": "true", text: cur ? initial(name) : "∗" }),
    h("span", { class: "ps-name", text: name }),
    h("span", { class: "ps-chev", "aria-hidden": "true" }),
  ]);
  toggle.querySelector(".ps-chev").innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  wrap.appendChild(toggle);
  if (cur) wrap.appendChild(h("button", { type: "button", class: "ps-clear", title: "Ver todos los proyectos", "aria-label": "Ver todos los proyectos", text: "×", onclick: () => choose("", onChange) }));
  paintMenu(onChange);
  return wrap;
}

let keysBound = false;
export function bindProjectKeys(onChange) {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && switchOpen) {
      switchOpen = false;
      return onChange(true);
    }
    if (e.metaKey || e.ctrlKey || e.altKey || !/^[0-9]$/.test(e.key)) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.closest && t.closest(".xterm")))) return;
    const list = workspaces();
    if (list.length < 2) return;
    const n = Number(e.key);
    if (n > list.length) return;
    e.preventDefault();
    choose(n === 0 ? "" : list[n - 1].id, onChange);
  });
}

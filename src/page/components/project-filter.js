import { state, h } from "../lib/base.js";
import { t, tn } from "../lib/i18n.js";

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

const TAB_MODULE = { daily: "daily", sentry: "sentry", deploy: "deploy", projects: "devServers", "follow-up": "followUp" };

export function hasModule(name) {
  const p = workspaces().find((x) => x.id === currentProject());
  return !p || !p.modules || p.modules[name] !== false;
}

export const tabVisible = (id) => (id === "context" ? hasModule("context") || hasModule("jira") : !TAB_MODULE[id] || hasModule(TAB_MODULE[id]));

export const filterTasks = (list) => {
  const p = currentProject();
  return p ? list.filter((x) => x.project === p) : list;
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
  if (switchOpen && portal.querySelector(".ps-menu")) return;
  portal.textContent = "";
  if (!switchOpen) return;
  const list = workspaces();
  const cur = currentProject();
  const options = [{ id: "", name: t("Todos los proyectos") }, ...list].map((p, i) =>
    h("button", { type: "button", role: "option", class: "ps-option", "aria-selected": String(p.id === cur), onclick: () => choose(p.id, onChange) }, [
      h("span", { class: "ps-initial", "aria-hidden": "true", text: p.id ? initial(p.name) : "∗" }),
      h("span", { class: "ps-text" }, [h("span", { class: "ps-option-name", text: p.name }), statLine(p.id)]),
      p.id === (cur || "") ? h("span", { class: "ps-check", "aria-label": t("Proyecto actual"), text: "✓" }) : null,
      i < 10 ? h("kbd", { text: String(i) }) : null,
    ])
  );
  const close = () => ((switchOpen = false), onChange(true));
  const items = h("div", { class: "ps-items" }, options);
  const search = list.length > 6 ? h("input", { type: "search", class: "ps-search", placeholder: t("Buscar proyecto"), "aria-label": t("Buscar proyecto") }) : null;
  if (search) search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const el of items.children) el.hidden = !!q && !el.textContent.toLowerCase().includes(q);
  });
  portal.appendChild(h("div", { class: "ps-backdrop", onclick: close }));
  const sheet = h("div", { class: "ps-menu", role: "listbox", "aria-label": t("Proyecto") }, [h("span", { class: "ps-grab", "aria-hidden": "true" }), h("div", { class: "ps-menu-head" }, [h("strong", { class: "ps-title-desk", text: cur ? projectName(cur) : t("Todos los proyectos") }), h("strong", { class: "ps-title-sheet", text: t("Cambiar de proyecto") }), h("span", { class: "ps-keys", text: t("Cambia de proyecto con las teclas 0-{max}", { max: Math.min(list.length, 9) }) })]), search, items]);
  portal.appendChild(sheet);
  let startY = null;
  sheet.addEventListener("touchstart", (e) => {
    startY = items.scrollTop > 0 && e.target.closest(".ps-items") ? null : e.touches[0].clientY;
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = dy ? `translateY(${dy}px)` : "";
  }, { passive: true });
  sheet.addEventListener("touchend", (e) => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy > 90) return close();
    sheet.style.transform = "";
  });
}

export function projectStats(id) {
  const sessions = ((state.allSessions || state.sessions || {}).list || []).filter((s) => !id || s.project === id);
  const waitingConv = new Set(((state.permissions && state.permissions.pending) || []).map((p) => p.conversation));
  const tasks = (state.allTasks || state.tasks || []).filter((x) => !id || x.project === id);
  return {
    busy: sessions.filter((s) => s.status === "busy").length,
    waiting: sessions.filter((s) => s.status === "waiting" || waitingConv.has(s.conversation)).length,
    pending: tasks.filter((x) => x.status === "pending").length,
  };
}

function statLine(id) {
  const s = projectStats(id);
  const parts = [];
  if (s.waiting) parts.push(h("span", { class: "ps-wait", text: tn(s.waiting, "{n} te espera", "{n} te esperan") }));
  if (s.busy) parts.push(h("span", { text: t("{n} trabajando", { n: s.busy }) }));
  if (s.pending) parts.push(h("span", { text: tn(s.pending, "{n} tarea pendiente", "{n} tareas pendientes") }));
  return h("span", { class: "ps-stats" }, parts.length ? parts : [h("span", { text: t("Sin nada en marcha") })]);
}

const initial = (name) => (String(name || "").trim()[0] || "·").toUpperCase();

export function projectSwitch(onChange, variant) {
  const list = workspaces();
  if (list.length < 2) return null;
  const cur = currentProject();
  const name = cur ? projectName(cur) : t("Todos");
  const wrap = h("div", { class: `proj-switch ${variant}${cur ? " filtered" : ""}${switchOpen ? " open" : ""}` });
  const toggle = h("button", { type: "button", class: "ps-button", "aria-haspopup": "listbox", "aria-expanded": String(switchOpen), title: t("{project} · cambiar de proyecto (teclas 0-{max})", { project: cur ? name : t("Todos los proyectos"), max: Math.min(list.length, 9) }), onclick: () => ((switchOpen = !switchOpen), onChange(true)) }, [
    h("span", { class: "ps-initial", "aria-hidden": "true", text: cur ? initial(name) : "∗" }),
    h("span", { class: "ps-name", text: name }),
    h("span", { class: "ps-chev", "aria-hidden": "true" }),
  ]);
  toggle.querySelector(".ps-chev").innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  wrap.appendChild(toggle);
  if (cur) wrap.appendChild(h("button", { type: "button", class: "ps-clear", title: t("Ver todos los proyectos"), "aria-label": t("Ver todos los proyectos"), text: "×", onclick: () => choose("", onChange) }));
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
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el.closest && el.closest(".xterm")))) return;
    const list = workspaces();
    if (list.length < 2) return;
    const n = Number(e.key);
    if (n > list.length) return;
    e.preventDefault();
    choose(n === 0 ? "" : list[n - 1].id, onChange);
  });
}

export function projectSheetButton(onChange) {
  const list = workspaces();
  if (list.length < 2) return null;
  const cur = currentProject();
  const name = cur ? projectName(cur) : t("Todos los proyectos");
  const chev = h("span", { class: "ps-chev", "aria-hidden": "true" });
  chev.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return h("button", { type: "button", class: `ps-sheet-button${cur ? " filtered" : ""}`, "aria-haspopup": "listbox", onclick: () => ((switchOpen = true), paintMenu(onChange)) }, [
    h("span", { class: "ps-initial", "aria-hidden": "true", text: cur ? initial(name) : "∗" }),
    h("span", { class: "ps-text" }, [h("span", { class: "ps-option-name", text: name }), statLine(cur || "")]),
    chev,
  ]);
}

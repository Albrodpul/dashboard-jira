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

const TAB_MODULE = { sentry: "sentry", deploy: "deploy", projects: "devServers", "follow-up": "followUp", learning: "jira", context: "context" };

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
  state.tasks = filterTasks(state.allTasks || state.tasks);
  state.areas = (state.allAreas || state.areas).filter(keep);
  const sessions = state.allSessions || state.sessions;
  state.sessions = { ...sessions, list: (sessions.list || []).filter(keep) };
}

export function projectPicker(onChange) {
  const list = workspaces();
  if (list.length < 2) return null;
  const sel = h("select", { class: "project-filter", "aria-label": "Proyecto" }, [h("option", { value: "", text: "Todos los proyectos" }), ...list.map((p) => h("option", { value: p.id, text: p.name }))]);
  sel.value = currentProject();
  sel.addEventListener("change", () => {
    try {
      localStorage.setItem(KEY, sel.value);
    } catch (e) {}
    onChange();
  });
  return sel;
}

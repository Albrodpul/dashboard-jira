import { state, h, button, toast, requestOrFail, refresh, render } from "../lib/base.js";
import { currentProject } from "./project-filter.js";

const draft = { open: false, project: "", title: "", description: "" };

const workspaces = () => (state.jiraSetup && state.jiraSetup.workspaces) || [];

export function newTaskButton() {
  return button(draft.open ? "Cerrar" : "Nueva tarea", {
    cls: "subtle new-task-toggle",
    onClick: () => {
      draft.open = !draft.open;
      render();
    },
  });
}

export function newTaskForm() {
  if (!draft.open) return null;
  const list = workspaces();
  const fixed = currentProject();
  if (fixed) draft.project = fixed;
  else if (!draft.project && list.length) draft.project = list[0].id;
  const title = h("input", { type: "text", class: "new-task-title", placeholder: "Qué hay que hacer", value: draft.title, "aria-label": "Título de la tarea" });
  title.addEventListener("input", () => (draft.title = title.value));
  const description = h("textarea", { class: "reply-box", placeholder: "Detalles para la sesión (opcional)", "aria-label": "Detalles" });
  description.value = draft.description;
  description.addEventListener("input", () => (draft.description = description.value));
  let pick = null;
  if (list.length > 1 && !fixed) {
    pick = h("select", { class: "new-task-project", "aria-label": "Proyecto" }, list.map((p) => h("option", { value: p.id, text: p.name })));
    pick.value = draft.project;
    pick.addEventListener("change", () => (draft.project = pick.value));
  }
  const create = button("Crear en Pendientes", {
    cls: "primary",
    onClick: async (b) => {
      b.disabled = true;
      try {
        const r = await requestOrFail("/api/task/new", { project: draft.project, title: draft.title, description: draft.description });
        Object.assign(draft, { open: false, title: "", description: "" });
        toast(`${r.key} creada en Pendientes`);
        refresh(true);
      } catch (e) {
        toast(`No se pudo crear: ${e.message}`);
        b.disabled = false;
      }
    },
  });
  setTimeout(() => {
    if (!document.activeElement || document.activeElement === document.body) title.focus();
  }, 0);
  const where = fixed ? (list.find((p) => p.id === fixed) || {}).name : "";
  return h("div", { class: "card new-task" }, [h("strong", { text: where ? `Nueva tarea en ${where}, sin Jira` : "Nueva tarea, sin Jira" }), pick, title, description, h("div", { class: "actions" }, [create])]);
}

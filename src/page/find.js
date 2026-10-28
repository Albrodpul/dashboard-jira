import { state, h, button, switchView, empty, areaName } from "./base.js";
import { jiraResults, openTalk } from "./operations.js";

export const find = { q: "", draft: "" };
const STATUS = { pending: "Pendiente", approved: "Por enviar", sent: "En curso", waiting: "Te espera", partial: "A medias", done: "Hecha", ignored: "Ignorada" };
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export function searchBox() {
  const input = h("input", { type: "search", class: "find-input", placeholder: "Buscar: clave, tarea o sesión", value: find.draft, "aria-label": "Buscar en el tablero y en Jira" });
  input.addEventListener("input", () => (find.draft = input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    find.q = input.value.trim();
    switchView("find", true);
  });
  return h("div", { class: "find-box" }, [input]);
}

function section(root, title, rows) {
  root.appendChild(h("div", { class: "group-head" }, [h("span", { class: "group-name", text: title })]));
  root.appendChild(h("div", { class: "rows" }, rows));
}

export function renderFind(root) {
  root.appendChild(searchBox());
  if (!find.q) return root.appendChild(empty("Escribe una clave o un texto y pulsa Intro.", "Busca en las tareas del tablero, en las sesiones y en Jira."));
  const n = norm(find.q);
  const tasks = state.tasks.filter((t) => norm(t.key).includes(n) || norm(t.title).includes(n));
  if (tasks.length)
    section(
      root,
      `En el tablero (${tasks.length})`,
      tasks.map((t) =>
        h("div", { class: "row" }, [
          h("div", { class: "row-id" }, [h("span", { class: "key", text: t.key }), h("span", { class: "chip", text: STATUS[t.status] || t.status })]),
          h("div", { class: "row-side" }, [h("span", { text: t.title }), h("span", { class: "meta", text: t.area ? `Sesión: ${areaName(t.area)}` : "Sin sesión" })]),
          button("Ver", { onClick: () => switchView(t.status === "partial" ? "waiting" : t.status, true) }),
        ])
      )
    );
  const areas = state.areas.filter((a) => a.conversation && (norm(a.name).includes(n) || norm(a.sessionName).includes(n) || Object.keys(a.epics || {}).some((k) => norm(k).includes(n))));
  if (areas.length)
    section(
      root,
      `Sesiones (${areas.length})`,
      areas.map((a) =>
        h("div", { class: "row" }, [
          h("div", { class: "row-id" }, [h("strong", { text: a.name })]),
          h("div", { class: "row-side" }, [h("span", { class: "meta", text: Object.keys(a.epics || {}).join(", ") || "Sin epics" })]),
          button("Hablar", { onClick: () => openTalk(a.conversation) }),
        ])
      )
    );
  root.appendChild(h("div", { class: "group-head" }, [h("span", { class: "group-name", text: "En Jira, sin terminar" })]));
  jiraResults(root, find.q);
}

import { state, h, button, switchView, empty, areaName, toast, requestOrFail, render, refresh, ticketLink } from "../lib/base.js";
import { openTalk } from "./talk.js";

const search = { q: "", onlyAvailable: true, skipReview: true, results: null, busy: false, capped: false };

function runSearch() {
  search.busy = true;
  render();
  requestOrFail("/api/search", { q: search.q, onlyAvailable: search.onlyAvailable, skipReview: search.skipReview })
    .then((d) => {
      search.results = d.items;
      search.capped = d.capped;
    })
    .catch(() => toast("No se pudo consultar Jira."))
    .then(() => {
      search.busy = false;
      render();
    });
}

function importTasks(keys) {
  requestOrFail("/api/import", { keys })
    .then((d) => {
      toast(`${d.imported}${d.imported === 1 ? " tarea traída" : " tareas traídas"} a Pendientes${d.skipped.length ? `; ${d.skipped.length} sin traer.` : "."}`);
      return refresh(true);
    })
    .catch(() => toast("No se pudieron traer las tareas."))
    .then(runSearch);
}

export function jiraResults(root, q) {
  if (search.globalQ !== q) {
    Object.assign(search, { globalQ: q, q, onlyAvailable: false, skipReview: false, results: null });
    runSearch();
  }
  if (search.busy) return root.appendChild(empty("Buscando en Jira…", ""));
  resultRows(root);
}

function resultRows(root) {
  if (!search.results) return;
  if (!search.results.length) return root.appendChild(empty("Ninguna tarea coincide.", "Prueba con otro texto o quita algún filtro."));
  const eligible = search.results.filter((x) => x.available && !x.onBoard);
  const all = eligible.length > 1 ? h("span", { class: "group-actions" }, [button(`Traer las ${eligible.length}`, { onClick: (b) => ((b.disabled = true), importTasks(eligible.map((x) => x.key))) })]) : null;
  const head = h("div", { class: "issues-bar find-jira-bar" }, [h("span", { class: "meta", text: `${search.results.length}${search.results.length === 1 ? " tarea" : " tareas"}${search.capped ? " (hay más: afina la búsqueda)" : ""}` }), all]);
  const rows = search.results.map((x) => {
    const bring = button(x.onBoard ? "Ya en el tablero" : x.available ? "Traer al tablero" : `La lleva ${x.assignee}`, { disabled: !(x.available && !x.onBoard), onClick: (b) => ((b.disabled = true), importTasks([x.key])) });
    const meta = `Asignado: ${x.assignee || "sin asignar"} · Epic: ${x.epicKey ? `${x.epicKey} ${x.epicName || ""}` : "sin epic"} · Sesión: ${x.area ? areaName(x.area) : "sin sesión"}`;
    return h("div", { class: "row" }, [
      h("div", { class: "row-id" }, [ticketLink(x.key, "key jira-link"),h("span", { class: `chip ${x.rejected ? "returned" : "ignored"}`, text: x.status + (x.rejected ? " · rechazo" : "") })]),
      h("div", { class: "row-side" }, [h("span", { text: x.title }), h("span", { class: "meta", text: meta })]),
      bring,
    ]);
  });
  root.appendChild(h("section", { class: "list-section" }, [head, h("div", { class: "rows" }, rows)]));
}

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
  root.appendChild(h("section", { class: "list-section" }, [h("div", { class: "group-head" }, [h("span", { class: "group-name", text: title })]), h("div", { class: "rows" }, rows)]));
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
  const jira = h("section", { class: "list-section find-jira" }, [h("div", { class: "group-head" }, [h("span", { class: "group-name", text: "En Jira, sin terminar" })])]);
  root.appendChild(jira);
  jiraResults(jira, find.q);
}

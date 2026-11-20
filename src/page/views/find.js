import { state, h, button, switchView, empty, areaName, toast, requestOrFail, render, refresh, ticketLink } from "../lib/base.js";
import { openTalk } from "./talk.js";
import { t as tr, tn } from "../lib/i18n.js";

const search = { q: "", onlyAvailable: true, skipReview: true, results: null, busy: false, capped: false };

function runSearch() {
  search.busy = true;
  render();
  requestOrFail("/api/search", { q: search.q, onlyAvailable: search.onlyAvailable, skipReview: search.skipReview })
    .then((d) => {
      search.results = d.items;
      search.capped = d.capped;
    })
    .catch(() => toast(tr("No se pudo consultar Jira.")))
    .then(() => {
      search.busy = false;
      render();
    });
}

function importTasks(keys) {
  requestOrFail("/api/import", { keys })
    .then((d) => {
      toast(d.skipped.length ? tn(d.imported, "{n} tarea traída a Pendientes; {skipped} sin traer.", "{n} tareas traídas a Pendientes; {skipped} sin traer.", { skipped: d.skipped.length }) : tn(d.imported, "{n} tarea traída a Pendientes.", "{n} tareas traídas a Pendientes."));
      return refresh(true);
    })
    .catch(() => toast(tr("No se pudieron traer las tareas.")))
    .then(runSearch);
}

export function jiraResults(root, q) {
  if (search.globalQ !== q) {
    Object.assign(search, { globalQ: q, q, onlyAvailable: false, skipReview: false, results: null });
    runSearch();
  }
  if (search.busy) return root.appendChild(empty(tr("Buscando en Jira…"), ""));
  resultRows(root);
}

function resultRows(root) {
  if (!search.results) return;
  if (!search.results.length) return root.appendChild(empty(tr("Ninguna tarea coincide."), tr("Prueba con otro texto o quita algún filtro.")));
  const eligible = search.results.filter((x) => x.available && !x.onBoard);
  const all = eligible.length > 1 ? h("span", { class: "group-actions" }, [button(tr("Traer las {n}", { n: eligible.length }), { onClick: (b) => ((b.disabled = true), importTasks(eligible.map((x) => x.key))) })]) : null;
  const head = h("div", { class: "issues-bar find-jira-bar" }, [h("span", { class: "meta", text: search.capped ? tn(search.results.length, "{n} tarea (hay más: afina la búsqueda)", "{n} tareas (hay más: afina la búsqueda)") : tn(search.results.length, "{n} tarea", "{n} tareas") }), all]);
  const rows = search.results.map((x) => {
    const bring = button(x.onBoard ? tr("Ya en el tablero") : x.available ? tr("Traer al tablero") : tr("La lleva {who}", { who: x.assignee }), { disabled: !(x.available && !x.onBoard), onClick: (b) => ((b.disabled = true), importTasks([x.key])) });
    const meta = tr("Asignado: {who} · Epic: {epic} · Sesión: {area}", { who: x.assignee || tr("sin asignar"), epic: x.epicKey ? `${x.epicKey} ${x.epicName || ""}` : tr("sin epic"), area: x.area ? areaName(x.area) : tr("sin sesión") });
    return h("div", { class: "row" }, [
      h("div", { class: "row-id" }, [ticketLink(x.key, "key jira-link"),h("span", { class: `chip ${x.rejected ? "returned" : "ignored"}`, text: x.status + (x.rejected ? ` · ${tr("rechazo")}` : "") })]),
      h("div", { class: "row-side" }, [h("span", { text: x.title }), h("span", { class: "meta", text: meta })]),
      bring,
    ]);
  });
  root.appendChild(h("section", { class: "list-section" }, [head, h("div", { class: "rows" }, rows)]));
}

export const find = { q: "", draft: "" };
const STATUS = { pending: tr("Pendiente"), approved: tr("Por enviar"), sent: tr("En curso"), waiting: tr("Te espera"), partial: tr("A medias"), done: tr("Hecha"), ignored: tr("Ignorada") };
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export function searchBox() {
  const input = h("input", { type: "search", class: "find-input", placeholder: tr("Buscar: clave, tarea o sesión"), value: find.draft, "aria-label": tr("Buscar en el tablero y en Jira") });
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
  if (!find.q) return root.appendChild(empty(tr("Escribe una clave o un texto y pulsa Intro."), tr("Busca en las tareas del tablero, en las sesiones y en Jira.")));
  const n = norm(find.q);
  const tasks = state.tasks.filter((t) => norm(t.key).includes(n) || norm(t.title).includes(n));
  if (tasks.length)
    section(
      root,
      tr("En el tablero ({n})", { n: tasks.length }),
      tasks.map((t) =>
        h("div", { class: "row" }, [
          h("div", { class: "row-id" }, [h("span", { class: "key", text: t.key }), h("span", { class: "chip", text: STATUS[t.status] || t.status })]),
          h("div", { class: "row-side" }, [h("span", { text: t.title }), h("span", { class: "meta", text: t.area ? tr("Sesión: {area}", { area: areaName(t.area) }) : tr("Sin sesión") })]),
          button(tr("Ver"), { onClick: () => switchView(t.status === "partial" ? "waiting" : t.status, true) }),
        ])
      )
    );
  const areas = state.areas.filter((a) => a.conversation && (norm(a.name).includes(n) || norm(a.sessionName).includes(n) || Object.keys(a.epics || {}).some((k) => norm(k).includes(n))));
  if (areas.length)
    section(
      root,
      tr("Sesiones ({n})", { n: areas.length }),
      areas.map((a) =>
        h("div", { class: "row" }, [
          h("div", { class: "row-id" }, [h("strong", { text: a.name })]),
          h("div", { class: "row-side" }, [h("span", { class: "meta", text: Object.keys(a.epics || {}).join(", ") || tr("Sin epics") })]),
          button(tr("Chat"), { onClick: () => openTalk(a.conversation) }),
        ])
      )
    );
  const jira = h("section", { class: "list-section find-jira" }, [h("div", { class: "group-head" }, [h("span", { class: "group-name", text: tr("En Jira, sin terminar") })])]);
  root.appendChild(jira);
  jiraResults(jira, find.q);
}

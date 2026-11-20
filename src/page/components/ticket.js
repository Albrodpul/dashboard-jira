import { state, h, button, when, toast, requestOrFail, refresh, render, areaName, ticketUrl, setTicketOpener } from "../lib/base.js";
import { t } from "../lib/i18n.js";
import { card } from "../views/tasks.js";

const cache = new Map();
let returnFocus = null;

function load(key, force) {
  const c = cache.get(key);
  if (c && !force && (c.busy || Date.now() - c.at < 60000)) return;
  cache.set(key, { ...(c || {}), busy: true, at: Date.now() });
  requestOrFail("/api/ticket", { key })
    .then((data) => cache.set(key, { data, at: Date.now() }))
    .catch(() => cache.set(key, { error: true, at: Date.now() }))
    .then(() => state.ticket === key && paintTicket());
}

export function showTicket(key) {
  if (!returnFocus) returnFocus = document.activeElement;
  state.ticket = key;
  if (!state.tasks.some((x) => x.id === key)) load(key);
  render();
  const close = document.querySelector("#ticket-drawer .drawer-close");
  if (close) close.focus({ preventScroll: true });
}

export function closeTicket() {
  state.ticket = null;
  render();
  if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

function bring(key, b) {
  b.disabled = true;
  requestOrFail("/api/import", { keys: [key] })
    .then((d) => {
      toast(d.imported ? t("{key} traída a Pendientes.", { key }) : t("{key} sin traer: {reason}.", { key, reason: (d.skipped[0] && d.skipped[0].reason) || t("no se pudo") }));
      return refresh(true);
    })
    .catch(() => {
      toast(t("No se pudo traer la tarea."));
      b.disabled = false;
    });
}

const fact = (label, value) => (value ? h("div", { class: "ticket-fact" }, [h("dt", { text: label }), h("dd", { text: value })]) : null);

function jiraOnly(key) {
  const c = cache.get(key) || {};
  if (c.error) return [h("p", { class: "meta", text: t("No se pudo leer el ticket en Jira.") }), h("div", { class: "actions" }, [button(t("Reintentar"), { onClick: () => load(key, true) })])];
  if (!c.data) return [h("p", { class: "meta", text: t("Leyendo el ticket en Jira…") })];
  const x = c.data;
  const epic = x.type === "Epic";
  const kids = [
    h("div", { class: "top" }, [h("span", { class: "key", text: x.key }), h("span", { class: `chip ${x.rejected ? "returned" : "ignored"}`, text: x.status + (x.rejected ? ` · ${t("rechazo")}` : "") }), x.type ? h("span", { class: "meta", text: x.type }) : null]),
    h("div", { class: "title", text: x.title }),
    h("dl", { class: "ticket-facts" }, [
      fact(t("Asignado"), x.assignee || t("sin asignar")),
      epic ? null : fact(t("Epic"), x.epicKey ? `${x.epicKey} ${x.epicName || ""}`.trim() : t("sin epic")),
      epic ? null : fact(t("Sesión"), x.area ? areaName(x.area) : t("sin sesión")),
      fact(t("Prioridad"), x.priority),
      fact(t("Creada por"), x.reporter),
      fact(t("Creada"), when(x.created)),
      fact(t("Actualizada"), when(x.updated)),
    ]),
  ];
  if (x.description) kids.push(h("div", { class: "ticket-desc", text: x.description }));
  else kids.push(h("p", { class: "meta", text: t("Sin descripción.") }));
  if (epic) return [h("article", { class: "card" }, kids)];
  kids.push(h("p", { class: "meta", text: t("No está en el tablero.") }));
  if (x.available && !x.onBoard) kids.push(h("div", { class: "actions" }, [button(t("Traer al tablero"), { cls: "primary", onClick: (b) => bring(key, b) })]));
  return [h("article", { class: "card" }, kids)];
}

export function paintTicket() {
  let box = document.getElementById("ticket-drawer");
  if (!state.ticket) {
    if (box) box.remove();
    document.body.classList.remove("ticket-open");
    return;
  }
  const task = state.tasks.find((x) => x.id === state.ticket);
  const keep = box ? box.scrollTop : 0;
  const fresh = !box;
  if (!box) {
    box = h("aside", { class: "drawer", id: "ticket-drawer", role: "dialog", "aria-modal": "false" });
    document.body.appendChild(box);
  }
  const active = document.activeElement && box.contains(document.activeElement) && ["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement.tagName);
  if (active) return;
  box.setAttribute("aria-label", t("Tarea {key}", { key: state.ticket }));
  box.textContent = "";
  const epic = task ? [task.epicKey, task.epicName].filter(Boolean).join(" ") : "";
  box.appendChild(
    h("div", { class: "drawer-head" }, [
      h("span", { class: "meta drawer-epic", text: epic || t("Detalle de la tarea") }),
      ticketUrl(state.ticket) ? h("a", { class: "btn link drawer-jira", href: ticketUrl(state.ticket), target: "_blank", rel: "noopener noreferrer", text: t("Abrir en Jira ↗") }) : h("span", { class: "meta drawer-jira", text: t("Sin Jira") }),
      button(t("Cerrar"), { cls: "subtle drawer-close", onClick: closeTicket }),
    ])
  );
  for (const k of task ? [card(task)] : jiraOnly(state.ticket)) box.appendChild(k);
  if (task && task.source === "manual" && task.description) box.appendChild(h("div", { class: "ticket-desc", text: task.description }));
  document.body.classList.add("ticket-open");
  if (!fresh) box.scrollTop = keep;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.ticket) closeTicket();
});

setTicketOpener(showTicket);

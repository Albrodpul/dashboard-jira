import { state, h, button, when, post, renderMd } from "../lib/base.js";

export function renderContext(root) {
  const o = state.contextTidy;
  const blockers = state.tidyBlockers || [];
  const running = o && (o.status === "approved" || o.status === "in-progress");
  let last = "Todavía no hay ninguna pasada.";
  if (state.lastContextPass) {
    const days = Math.floor((Date.now() - new Date(state.lastContextPass + "T12:00:00").getTime()) / 86400000);
    last = `Última pasada: ${state.lastContextPass} (hace ${days}${days === 1 ? " día" : " días"}).`;
  }
  const tidy = running ? null : button("Ordenar contexto", { cls: "primary", disabled: blockers.length > 0, onClick: (b) => ((b.disabled = true), post("/api/tidy", {}, "Ordenación pedida: la orquestadora la empieza en unos segundos.")) });
  root.appendChild(h("div", { class: "issues-bar" }, [h("span", { class: "meta", text: last }), tidy]));
  if (running) {
    root.appendChild(h("div", { class: "notice context-state" }, [h("b", { text: o.status === "approved" ? "Pedida" : "En curso" }), h("span", { text: o.status === "approved" ? `Pedida a las ${when(o.at)}: la orquestadora la empieza en cuanto la recoge.` : `En curso desde las ${when(o.startedAt)}. No envíes tareas hasta que termine.` })]));
    return;
  }
  if (blockers.length) root.appendChild(h("div", { class: "notice context-state" }, [h("b", { text: "Todavía no" }), h("span", { text: `Falta: ${blockers.join(", ")}. Cuando todo esté hecho o limpio, se activa.` })]));
  if (o && o.status === "done") root.appendChild(h("section", { class: "card context-result" }, [h("div", { class: "meta", text: `Última ordenación, terminada a las ${when(o.finishedAt)}` }), renderMd(o.summary || "")]));
}

import { state, h, button, when, post, renderMd } from "../lib/base.js";

export function renderContext(root) {
  const o = state.contextTidy;
  const blockers = state.tidyBlockers || [];
  if (state.lastContextPass) {
    const days = Math.floor((Date.now() - new Date(state.lastContextPass + "T12:00:00").getTime()) / 86400000);
    root.appendChild(h("div", { class: "meta", text: `Última pasada: ${state.lastContextPass} (hace ${days}${days === 1 ? " día" : " días"}).` }));
  }
  if (o && (o.status === "approved" || o.status === "in-progress")) {
    root.appendChild(h("div", { class: "state-line", text: o.status === "approved" ? `Pedida a las ${when(o.at)}: la orquestadora la empieza en cuanto la recoge.` : `En curso desde las ${when(o.startedAt)}. No envíes tareas hasta que termine.` }));
    return;
  }
  if (blockers.length) root.appendChild(h("div", { class: "state-line", text: `No se puede todavía: ${blockers.join(", ")}. Cuando todo esté hecho o limpio, se activa.` }));
  const tidy = button("Ordenar contexto", { cls: "primary", disabled: blockers.length > 0, onClick: (b) => ((b.disabled = true), post("/api/tidy", {}, "Ordenación pedida: la orquestadora la empieza en unos segundos.")) });
  root.appendChild(h("div", { class: "actions" }, [tidy]));
  if (o && o.status === "done") {
    root.appendChild(h("div", { class: "jira-head", text: `Última ordenación, terminada a las ${when(o.finishedAt)}` }));
    root.appendChild(renderMd(o.summary || ""));
  }
}

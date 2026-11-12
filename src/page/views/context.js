import { state, h, button, when, post, renderMd } from "../lib/base.js";
import { currentProject, mixedProjects, mainProject, projectTitle, workspacesWith } from "../components/project-filter.js";

export function renderContext(root) {
  if (!mixedProjects()) return renderOne(root, currentProject());
  for (const id of workspacesWith("context")) {
    if (id !== mainProject() && !(state.tidies && state.tidies[id])) continue;
    root.appendChild(projectTitle(id));
    renderOne(root, id);
  }
}

function renderOne(root, pid) {
  const own = pid && pid !== mainProject() && state.tidies && state.tidies[pid];
  const o = own ? own.contextTidy : state.contextTidy;
  const blockers = (own ? own.blockers : state.tidyBlockers) || [];
  const lastPass = own ? own.lastPass : state.lastContextPass;
  const who = own ? "una sesión del proyecto" : "la orquestadora";
  const running = o && (o.status === "approved" || o.status === "in-progress");
  let last = "Todavía no hay ninguna pasada.";
  if (lastPass) {
    const days = Math.floor((Date.now() - new Date(lastPass + "T12:00:00").getTime()) / 86400000);
    last = `Última pasada: ${lastPass} (hace ${days}${days === 1 ? " día" : " días"}).`;
  }
  const tidy = running ? null : button("Ordenar contexto", { cls: "primary", disabled: blockers.length > 0, onClick: (b) => ((b.disabled = true), post("/api/tidy", own ? { project: pid } : {}, `Ordenación pedida: ${who} la empieza en unos segundos.`)) });
  root.appendChild(h("div", { class: "issues-bar" }, [h("span", { class: "meta", text: last }), tidy]));
  if (running) {
    root.appendChild(h("div", { class: "notice context-state" }, [h("b", { text: o.status === "approved" ? "Pedida" : "En curso" }), h("span", { text: o.status === "approved" ? `Pedida a las ${when(o.at)}: ${who} la empieza en cuanto la recoge.` : `En curso desde las ${when(o.startedAt)}. No envíes tareas hasta que termine.` })]));
    return;
  }
  if (blockers.length) root.appendChild(h("div", { class: "notice context-state" }, [h("b", { text: "Todavía no" }), h("span", { text: `Falta: ${blockers.join(", ")}. Cuando todo esté hecho o limpio, se activa.` })]));
  if (o && o.status === "done") root.appendChild(h("section", { class: "card context-result" }, [h("div", { class: "meta", text: `Última ordenación, terminada a las ${when(o.finishedAt)}` }), renderMd(o.summary || "")]));
}

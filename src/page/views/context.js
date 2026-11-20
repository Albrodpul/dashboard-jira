import { state, h, button, when, post, renderMd } from "../lib/base.js";
import { currentProject, mixedProjects, mainProject, projectTitle, workspacesWith } from "../components/project-filter.js";
import { t, tn } from "../lib/i18n.js";

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
  const who = own ? t("una sesión del proyecto") : t("la orquestadora");
  const running = o && (o.status === "approved" || o.status === "in-progress");
  let last = t("Todavía no hay ninguna pasada.");
  if (lastPass) {
    const days = Math.floor((Date.now() - new Date(lastPass + "T12:00:00").getTime()) / 86400000);
    last = tn(days, "Última pasada: {date} (hace {n} día).", "Última pasada: {date} (hace {n} días).", { date: lastPass });
  }
  const tidy = running ? null : button(t("Ordenar contexto"), { cls: "primary", disabled: blockers.length > 0, onClick: (b) => ((b.disabled = true), post("/api/tidy", own ? { project: pid } : {}, t("Ordenación pedida: {who} la empieza en unos segundos.", { who }))) });
  root.appendChild(h("div", { class: "issues-bar" }, [h("span", { class: "meta", text: last }), tidy]));
  if (running) {
    root.appendChild(h("div", { class: "notice context-state" }, [h("b", { text: o.status === "approved" ? t("Pedida") : t("En curso") }), h("span", { text: o.status === "approved" ? t("Pedida a las {time}: {who} la empieza en cuanto la recoge.", { time: when(o.at), who }) : t("En curso desde las {time}. No envíes tareas hasta que termine.", { time: when(o.startedAt) }) })]));
    return;
  }
  if (blockers.length) root.appendChild(h("div", { class: "notice context-state" }, [h("b", { text: t("Todavía no") }), h("span", { text: t("Falta: {list}. Cuando todo esté hecho o limpio, se activa.", { list: blockers.join(", ") }) })]));
  if (o && o.status === "done") root.appendChild(h("section", { class: "card context-result" }, [h("div", { class: "meta", text: t("Última ordenación, terminada a las {time}", { time: when(o.finishedAt) }) }), renderMd(o.summary || "")]));
}

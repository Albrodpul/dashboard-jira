import { state, h, button, when, toast, requestOrFail, render, refresh, empty, areaSelect, areaName } from "../lib/base.js";
import { currentProject } from "../components/project-filter.js";
import { t, tn } from "../lib/i18n.js";

const labelOf = (p) => (data && data.labels && data.labels[p]) || {};
const projectName = (p) => labelOf(p).name || p;
const STALE_MS = 60 * 1000;

let data = null;
let loading = false;
let loadedAt = 0;
let filter = "all";
const chosen = {};

function load(force) {
  if (loading) return;
  loading = true;
  fetch(`/api/sentry${force ? "?force=1" : ""}`, { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      data = d;
      loadedAt = Date.now();
    })
    .catch(() => {
      data = { available: true, issues: [], errors: [t("No se pudo leer Sentry desde el tablero.")] };
      loadedAt = Date.now();
    })
    .finally(() => {
      loading = false;
      if (state.tab === "sentry") render();
    });
}

setInterval(() => {
  if (state.tab === "sentry" && !document.hidden && Date.now() - loadedAt > STALE_MS) load(false);
}, 5000);

const sendOf = (id) => ((state.sentry && state.sentry.sends) || []).find((x) => x.id === id) || null;

function sendState(s) {
  if (!s) return null;
  const area = areaName(s.area) || s.area;
  if (s.state === "approved" && s.delivery && !s.delivery.soft) return h("div", { class: "delivery-error", text: t("No se pudo entregar a «{area}» ({n} de 3 intentos): {error}.", { area, n: s.delivery.attempts, error: s.delivery.error }) });
  if (s.state === "approved") return h("div", { class: "state-line", text: t("Enviando a «{area}»: el tablero se lo pasa en unos segundos.", { area }) });
  const kids = [h("b", { text: t("Enviado a «{area}» a las {time}", { area, time: when(s.sentAt || s.at) }) })];
  if (s.result) kids.push(h("span", { text: s.result.text }));
  else kids.push(h("span", { text: t("Sin respuesta todavía.") }));
  return h("div", { class: `notice${s.result ? " done" : ""}` }, kids);
}

function sendIssue(issue, area, b) {
  if (!area) return toast(t("Elige a qué sesión mandarlo."));
  b.disabled = true;
  requestOrFail("/api/sentry/send", { issues: [issue], area })
    .then(() => {
      toast(t("{id} enviado: el tablero se lo pasa a «{area}».", { id: issue.id, area: areaName(area) }));
      return refresh(true);
    })
    .catch((e) => {
      b.disabled = false;
      toast(t("No se pudo enviar: {error}", { error: e.message }));
    });
}

const STATUS_LABEL = { resolved: t("resuelto"), ignored: t("ignorado") };

function closeIssue(issue, status, b) {
  if (!window.confirm(`${t("¿Marcar {id} como {status} en Sentry?", { id: issue.id, status: STATUS_LABEL[status] })}

${status === "resolved" ? t("Si vuelve a pasar, Sentry lo reabre solo.") : t("Sentry deja de avisar de él.")}`)) return;
  b.disabled = true;
  requestOrFail("/api/sentry/status", { issueId: issue.issueId, id: issue.id, status, owner: issue.owner })
    .then(() => {
      data.issues = data.issues.filter((x) => x.id !== issue.id);
      toast(t("{id} marcado como {status} en Sentry.", { id: issue.id, status: STATUS_LABEL[status] }));
      render();
    })
    .catch((e) => {
      b.disabled = false;
      toast(t("No se pudo cambiar en Sentry: {error}", { error: e.message }));
    });
}

const open = new Set();
const defaultArea = (issue) => (state.sentry && ((state.sentry.errorsAreas || {})[issue.owner] || state.sentry.errorsArea)) || "";
const manyOwners = () => Object.keys((data && data.owners) || {}).length > 1;

function splitTitle(title) {
  const text = String(title || "");
  const i = text.indexOf(": ");
  if (i < 0 || i > 120) return { kind: "", message: text };
  const kind = text.slice(0, i).split(/[\\.]/).pop();
  return { kind, message: text.slice(i + 2) };
}


function sendTag(s, seenAgain) {
  if (seenAgain) return h("span", { class: "issue-tag again", text: t("Ha vuelto a pasar") });
  if (!s) return h("span", { class: "issue-tag none" });
  if (s.state === "approved") return h("span", { class: "issue-tag sending", text: t("Enviando…") });
  return h("span", { class: `issue-tag ${s.result ? "answered" : "sent"}`, text: t(s.result ? "Respondido · {area}" : "En {area}", { area: areaName(s.area) || s.area }) });
}

function issueRow(issue) {
  const s = sendOf(issue.id);
  const pendingSend = s && s.state === "approved";
  const seenAgain = s && s.state === "sent" && new Date(issue.lastSeen) > new Date(s.sentAt || s.at);
  const { kind, message } = splitTitle(issue.title);
  const isOpen = open.has(issue.id);
  const toggle = () => {
    if (open.has(issue.id)) open.delete(issue.id);
    else open.add(issue.id);
    render();
  };
  const head = h("button", { type: "button", class: "issue-head", "aria-expanded": String(isOpen), onclick: toggle }, [
    h("span", { class: `issue-project ${labelOf(issue.project).tone || ""}`, title: projectName(issue.project), text: labelOf(issue.project).short || projectName(issue.project) }),
    h("span", { class: "issue-text" }, [manyOwners() && !currentProject() && issue.owner ? h("span", { class: "meta", text: `${data.owners[issue.owner] || issue.owner} · ` }) : null, kind ? h("b", { text: kind }) : null, h("span", { class: "issue-msg", text: message, title: issue.title })]),
    sendTag(s, seenAgain),
    h("span", { class: "issue-count", title: tn(issue.users, "{n} usuario", "{n} usuarios"), text: `${issue.count}×` }),
    h("span", { class: "issue-when", text: when(issue.lastSeen) }),
  ]);
  const kids = [head];
  if (isOpen) {
    const body = [h("div", { class: "issue-full", text: issue.title })];
    if (issue.culprit) body.push(h("div", { class: "issue-culprit", text: issue.culprit }));
    body.push(h("div", { class: "meta", text: `${issue.id} · ${tn(issue.count, "{n} vez", "{n} veces")} · ${tn(issue.users, "{n} usuario", "{n} usuarios")} · ${t("primera vez {time}", { time: when(issue.firstSeen) })}` }));
    const status = sendState(s);
    if (status) body.push(status);
    const actions = [];
    if (!pendingSend) {
      const current = chosen[issue.id] || (s && s.area) || defaultArea(issue);
      const sel = areaSelect(`sentry-${issue.id}`, current, t("Elige sesión…"), (v) => (chosen[issue.id] = v));
      sel.setAttribute("aria-label", t("Sesión a la que mandar {id}", { id: issue.id }));
      actions.push(sel, button(s ? t("Volver a enviar") : t("Enviar"), { cls: "primary", onClick: (b) => sendIssue(issue, chosen[issue.id] || current, b) }));
    }
    actions.push(h("a", { class: "btn link", href: issue.url, target: "_blank", rel: "noopener", text: t("Ver en Sentry") }));
    if (issue.issueId)
      actions.push(
        h("span", { class: "issue-close" }, [
          button(t("Resuelto"), { cls: "subtle", title: t("Lo marca como resuelto en Sentry: sale de la lista y, si vuelve a pasar, Sentry lo reabre"), onClick: (b) => closeIssue(issue, "resolved", b) }),
          button(t("Ignorar"), { cls: "subtle", title: t("Lo ignora en Sentry: sale de la lista y deja de avisar"), onClick: (b) => closeIssue(issue, "ignored", b) }),
        ])
      );
    body.push(h("div", { class: "actions issue-actions" }, actions));
    kids.push(h("div", { class: "issue-body" }, body));
  }
  return h("div", { class: `issue-row${isOpen ? " open" : ""}${labelOf(issue.project).production ? " prod" : ""}` }, kids);
}

function filters(root, issues) {
  const projects = (data.projects || []).filter((p) => issues.some((i) => i.project === p));
  if (projects.length < 2) return;
  const chips = h("div", { class: "people-chips", role: "group", "aria-label": t("Filtrar por proyecto") });
  for (const [id, label] of [["all", t("Todos")], ...projects.map((p) => [p, projectName(p)])]) {
    const n = id === "all" ? issues.length : issues.filter((i) => i.project === id).length;
    chips.appendChild(
      h("button", {
        type: "button",
        "aria-pressed": String(filter === id),
        text: `${label} ${n}`,
        onclick: () => {
          filter = id;
          render();
        },
      })
    );
  }
  root.appendChild(chips);
}

export function renderSentry(root) {
  if (state.sentry && !state.sentry.enabled) return root.appendChild(empty(t("Sentry no está configurado."), t("Actívalo en Ajustes → Proyectos → Editar (organización y proyectos) y pon su token en las credenciales del proyecto. El principal lo lleva en board.config.json y su token en .env o en .mcp.json.")));
  if (!data || Date.now() - loadedAt > STALE_MS) load(false);
  if (!data) return root.appendChild(empty(t("Leyendo Sentry…"), t("Errores sin resolver de los últimos 14 días.")));
  for (const e of data.errors || []) root.appendChild(h("div", { class: "setup-note warn", text: e }));
  const scope = currentProject();
  const issues = (data.issues || []).filter((i) => !scope || !i.owner || i.owner === scope);
  const bar = h("div", { class: "issues-bar" });
  filters(bar, issues);
  bar.appendChild(h("div", { class: "issues-read" }, [h("span", { class: "meta", text: loading ? t("Actualizando…") : t("Leído a las {time}", { time: when(data.at) }) }), button(t("Actualizar"), { cls: "subtle", disabled: loading, onClick: () => load(true) })]));
  root.appendChild(bar);
  if (!issues.length) return root.appendChild(empty(t("Nada sin resolver."), t("No hay errores abiertos en Sentry en estos proyectos.")));
  if (filter !== "all" && !issues.some((i) => i.project === filter)) filter = "all";
  const shown = issues.filter((i) => filter === "all" || i.project === filter);
  root.appendChild(h("div", { class: "issue-list" }, shown.map(issueRow)));
}

import { state, h, button, when, toast, requestOrFail, render, refresh, empty, areaSelect, areaName } from "../lib/base.js";

const PROJECT_NAMES = { web: "Web", admin: "Admin", "backend-beta": "API beta", "backend-production": "API producción" };
const projectName = (p) => PROJECT_NAMES[p] || p;
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
      data = { available: true, issues: [], errors: ["No se pudo leer Sentry desde el tablero."] };
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
  if (s.state === "approved") return h("div", { class: "state-line", text: `Enviando a «${areaName(s.area) || s.area}»: la orquestadora se lo pasa en unos segundos.` });
  const kids = [h("b", { text: `Enviado a «${areaName(s.area) || s.area}» a las ${when(s.sentAt || s.at)}` })];
  if (s.result) kids.push(h("span", { text: s.result.text }));
  else kids.push(h("span", { text: "Sin respuesta todavía." }));
  return h("div", { class: `notice${s.result ? " done" : ""}` }, kids);
}

function sendIssue(issue, area, b) {
  if (!area) return toast("Elige a qué sesión mandarlo.");
  b.disabled = true;
  requestOrFail("/api/sentry/send", { issues: [issue], area })
    .then(() => {
      toast(`${issue.id} enviado: la orquestadora se lo pasa a «${areaName(area)}».`);
      return refresh(true);
    })
    .catch((e) => {
      b.disabled = false;
      toast(`No se pudo enviar: ${e.message}`);
    });
}

const STATUS_LABEL = { resolved: "resuelto", ignored: "ignorado" };

function closeIssue(issue, status, b) {
  if (!window.confirm(`¿Marcar ${issue.id} como ${STATUS_LABEL[status]} en Sentry?

${status === "resolved" ? "Si vuelve a pasar, Sentry lo reabre solo." : "Sentry deja de avisar de él."}`)) return;
  b.disabled = true;
  requestOrFail("/api/sentry/status", { issueId: issue.issueId, id: issue.id, status })
    .then(() => {
      data.issues = data.issues.filter((x) => x.id !== issue.id);
      toast(`${issue.id} marcado como ${STATUS_LABEL[status]} en Sentry.`);
      render();
    })
    .catch((e) => {
      b.disabled = false;
      toast(`No se pudo cambiar en Sentry: ${e.message}`);
    });
}

const open = new Set();
const PROJECT_TONE = { web: "web", admin: "panel", "backend-beta": "beta", "backend-production": "prod" };

function splitTitle(title) {
  const t = String(title || "");
  const i = t.indexOf(": ");
  if (i < 0 || i > 120) return { kind: "", message: t };
  const kind = t.slice(0, i).split(/[\\.]/).pop();
  return { kind, message: t.slice(i + 2) };
}

const SHORT = { web: "Web", admin: "Admin", "backend-beta": "API beta", "backend-production": "API prod" };

function sendTag(s, seenAgain) {
  if (seenAgain) return h("span", { class: "issue-tag again", text: "Ha vuelto a pasar" });
  if (!s) return h("span", { class: "issue-tag none" });
  if (s.state === "approved") return h("span", { class: "issue-tag sending", text: "Enviando…" });
  return h("span", { class: `issue-tag ${s.result ? "answered" : "sent"}`, text: s.result ? `Respondido · ${areaName(s.area) || s.area}` : `En ${areaName(s.area) || s.area}` });
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
    h("span", { class: `issue-project ${PROJECT_TONE[issue.project] || ""}`, title: projectName(issue.project), text: SHORT[issue.project] || projectName(issue.project) }),
    h("span", { class: "issue-text" }, [kind ? h("b", { text: kind }) : null, h("span", { class: "issue-msg", text: message, title: issue.title })]),
    sendTag(s, seenAgain),
    h("span", { class: "issue-count", title: `${issue.users} ${issue.users === 1 ? "usuario" : "usuarios"}`, text: `${issue.count}×` }),
    h("span", { class: "issue-when", text: when(issue.lastSeen) }),
  ]);
  const kids = [head];
  if (isOpen) {
    const body = [h("div", { class: "issue-full", text: issue.title })];
    if (issue.culprit) body.push(h("div", { class: "issue-culprit", text: issue.culprit }));
    body.push(h("div", { class: "meta", text: `${issue.id} · ${issue.count} ${issue.count === 1 ? "vez" : "veces"} · ${issue.users} ${issue.users === 1 ? "usuario" : "usuarios"} · primera vez ${when(issue.firstSeen)}` }));
    const status = sendState(s);
    if (status) body.push(status);
    const actions = [];
    if (!pendingSend) {
      const current = chosen[issue.id] || (s && s.area) || (state.sentry && state.sentry.errorsArea) || "";
      const sel = areaSelect(`sentry-${issue.id}`, current, "Elige sesión…", (v) => (chosen[issue.id] = v));
      sel.setAttribute("aria-label", `Sesión a la que mandar ${issue.id}`);
      actions.push(sel, button(s ? "Volver a enviar" : "Enviar", { cls: "primary", onClick: (b) => sendIssue(issue, chosen[issue.id] || current, b) }));
    }
    actions.push(h("a", { class: "btn link", href: issue.url, target: "_blank", rel: "noopener", text: "Ver en Sentry" }));
    if (issue.issueId)
      actions.push(
        h("span", { class: "issue-close" }, [
          button("Resuelto", { cls: "subtle", title: "Lo marca como resuelto en Sentry: sale de la lista y, si vuelve a pasar, Sentry lo reabre", onClick: (b) => closeIssue(issue, "resolved", b) }),
          button("Ignorar", { cls: "subtle", title: "Lo ignora en Sentry: sale de la lista y deja de avisar", onClick: (b) => closeIssue(issue, "ignored", b) }),
        ])
      );
    body.push(h("div", { class: "actions issue-actions" }, actions));
    kids.push(h("div", { class: "issue-body" }, body));
  }
  return h("div", { class: `issue-row${isOpen ? " open" : ""}${issue.project === "backend-production" ? " prod" : ""}` }, kids);
}

function filters(root, issues) {
  const projects = (data.projects || []).filter((p) => issues.some((i) => i.project === p));
  if (projects.length < 2) return;
  const chips = h("div", { class: "people-chips", role: "group", "aria-label": "Filtrar por proyecto" });
  for (const [id, label] of [["all", "Todos"], ...projects.map((p) => [p, projectName(p)])]) {
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
  if (state.sentry && !state.sentry.enabled) return root.appendChild(empty("Sentry no está configurado.", "Falta «sentry» (org y proyectos) en board.config.json, o el token: SENTRY_TOKEN en .env o el servidor de Sentry en .mcp.json."));
  if (!data || Date.now() - loadedAt > STALE_MS) load(false);
  if (!data) return root.appendChild(empty("Leyendo Sentry…", "Errores sin resolver de los últimos 14 días."));
  for (const e of data.errors || []) root.appendChild(h("div", { class: "setup-note warn", text: e }));
  const issues = data.issues || [];
  const bar = h("div", { class: "issues-bar" });
  filters(bar, issues);
  bar.appendChild(h("div", { class: "issues-read" }, [h("span", { class: "meta", text: loading ? "Actualizando…" : `Leído a las ${when(data.at)}` }), button("Actualizar", { cls: "subtle", disabled: loading, onClick: () => load(true) })]));
  root.appendChild(bar);
  if (!issues.length) return root.appendChild(empty("Nada sin resolver.", "No hay errores abiertos en Sentry en estos proyectos."));
  if (filter !== "all" && !issues.some((i) => i.project === filter)) filter = "all";
  const shown = issues.filter((i) => filter === "all" || i.project === filter);
  root.appendChild(h("div", { class: "issue-list" }, shown.map(issueRow)));
}

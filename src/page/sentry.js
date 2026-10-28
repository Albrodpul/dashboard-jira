import { state, h, button, when, toast, requestOrFail, render, refresh, empty, areaSelect, areaName } from "./base.js";

const PROJECT_NAMES = { landing: "Landing", backoffice: "Backoffice", "backend-beta": "Super-app beta", "backend-production": "Super-app producción" };
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

function issueCard(issue) {
  const s = sendOf(issue.id);
  const pendingSend = s && s.state === "approved";
  const seenAgain = s && s.state === "sent" && new Date(issue.lastSeen) > new Date(s.sentAt || s.at);
  const kids = [
    h("div", { class: "top" }, [
      h("span", { class: "key", text: issue.id }),
      h("span", { class: `chip ${issue.project === "backend-production" ? "waiting" : "approved"}`, text: projectName(issue.project) }),
      seenAgain ? h("span", { class: "chip returned", text: "Ha vuelto a pasar" }) : null,
      h("span", { class: "time", text: when(issue.lastSeen) }),
    ]),
    h("div", { class: "title sentry-title", text: issue.title, title: issue.title }),
  ];
  if (issue.culprit) kids.push(h("div", { class: "meta sentry-culprit", text: issue.culprit }));
  kids.push(h("div", { class: "meta", text: `${issue.count} ${issue.count === 1 ? "vez" : "veces"} · ${issue.users} ${issue.users === 1 ? "usuario" : "usuarios"} · visto por primera vez ${when(issue.firstSeen)}` }));
  const status = sendState(s);
  if (status) kids.push(status);
  if (!pendingSend) {
    const current = chosen[issue.id] || (s && s.area) || (state.sentry && state.sentry.errorsArea) || "";
    const sel = areaSelect(`sentry-${issue.id}`, current, "Elige sesión…", (v) => (chosen[issue.id] = v));
    sel.setAttribute("aria-label", `Sesión a la que mandar ${issue.id}`);
    kids.push(
      h("div", { class: "actions" }, [
        sel,
        button(s ? "Volver a enviar" : "Enviar", { cls: "primary", onClick: (b) => sendIssue(issue, chosen[issue.id] || current, b) }),
        h("a", { class: "btn link", href: issue.url, target: "_blank", rel: "noopener", text: "Ver en Sentry" }),
      ])
    );
  }
  return h("article", { class: "card" }, kids);
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
  const head = [h("span", { class: "meta", text: loading ? "Actualizando…" : `Leído a las ${when(data.at)}` }), button("Actualizar", { cls: "subtle", disabled: loading, onClick: () => load(true) })];
  root.appendChild(h("div", { class: "toolbar" }, head));
  for (const e of data.errors || []) root.appendChild(h("div", { class: "setup-note warn", text: e }));
  const issues = data.issues || [];
  if (!issues.length) return root.appendChild(empty("Nada sin resolver.", "No hay errores abiertos en Sentry en estos proyectos."));
  filters(root, issues);
  if (filter !== "all" && !issues.some((i) => i.project === filter)) filter = "all";
  const shown = issues.filter((i) => filter === "all" || i.project === filter);
  root.appendChild(h("div", { class: "cards" }, shown.map(issueCard)));
}

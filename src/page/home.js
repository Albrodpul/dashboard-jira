import { state, h, when, minutesSince, switchView, empty, reviewer, fixedAreaIds, button, post, toast } from "./base.js";


const GROUPS = [
  ["working", "Trabajando", "Tienen un turno en marcha."],
  ["blocked", "Bloqueadas", "Paradas con algo pendiente: te esperan, a medias o sin avisar de una tarea enviada."],
  ["free", "Libres", "Abiertas y sin nada entre manos."],
];
const BOARD = ["free", "working", "blocked"];
const DOTS = { working: "busy", blocked: "bad", free: "on" };
const SILENT_MIN = 5;

function liveOf(conversation, sessionName) {
  const list = state.sessions.list || [];
  return list.find((s) => (conversation ? s.conversation === conversation : s.name === sessionName)) || null;
}

function blockReason(live, tasks) {
  const waiting = tasks.find((t) => t.status === "waiting");
  if (waiting) return { text: "Te espera", task: waiting, view: "waiting" };
  const partial = tasks.find((t) => t.status === "partial");
  if (partial) return { text: "A medias", task: partial, view: "waiting" };
  const silent = tasks.find((t) => t.status === "sent" && !t.manual && (!t.sentAt || minutesSince(t.sentAt) >= SILENT_MIN));
  if (silent) return { text: "Parada sin avisar de", task: silent, view: "sent" };
  if (live.status && !["busy", "idle"].includes(live.status)) return { text: `Estado «${live.status}»` };
  return null;
}

function fixedArea(id) {
  const a = id && state.areas.find((x) => x.id === id);
  return a && a.conversation ? { conversation: a.conversation, session: a.sessionName || a.name } : null;
}

export function sessionSituation() {
  const out = { working: [], blocked: [], free: [], system: [] };
  const fixed = fixedAreaIds();
  const systemConversations = new Set([state.reporterRoute, state.orchestrator, state.followUpStatus, state.boardStatus, ...state.areas.filter((a) => fixed.has(a.id))].filter(Boolean).map((r) => r.conversation));
  for (const a of state.areas) {
    if (!a.open || systemConversations.has(a.conversation)) continue;
    const live = liveOf(a.conversation, a.sessionName);
    if (!live) continue;
    const tasks = state.tasks.filter((t) => t.area === a.id && ["sent", "waiting", "partial"].includes(t.status));
    const row = { id: a.id, name: a.unnamed ? a.vsCodeTitle || `${a.sessionName} (sin nombre)` : a.name, sessionName: a.sessionName, conversation: a.conversation, since: live.statusSince, subagents: live.subagents || 0, tasks };
    const asking = ((state.permissions && state.permissions.pending) || []).find((p) => p.conversation === a.conversation);
    if (asking) out.blocked.push({ ...row, reason: { text: `Espera tu permiso: ${asking.label}`, view: "waiting" } });
    else if (live.status === "busy") out.working.push(row);
    else {
      const reason = blockReason(live, tasks);
      if (reason) out.blocked.push({ ...row, reason });
      else out.free.push(row);
    }
  }
  const roles = [
    ["Reporte de Jira", state.reporterRoute],
    ["Orquestadora", state.orchestrator],
    [`Seguimiento de ${reviewer()}`, state.followUpStatus],
    ["Tablero", state.boardStatus],
    ["Despliegue", fixedArea(state.deployerArea)],
    ["Errores sentry", fixedArea(state.sentry && state.sentry.errorsArea)],
  ];
  for (const [name, r] of roles) {
    if (!r || !r.conversation) continue;
    const live = liveOf(r.conversation, r.session);
    out.system.push({ name, open: !!live, working: !!live && live.status === "busy", conversation: r.conversation, session: live ? live.name : r.session || name });
  }
  return out;
}

const vsCodeLink = (s) => {
  if (!s.conversation) return null;
  if ((state.hosted || []).some((x) => x.conversation === s.conversation && !x.waitingForVsCode)) return h("button", { class: "btn link", type: "button", text: "Ver en directo", onclick: () => import("./terminal.js").then((m) => m.openTerminal(s.conversation, s.sessionName || s.name)) });
  return h("a", { class: "btn link", href: `vscode://anthropic.claude-code/open?session=${encodeURIComponent(s.conversation)}`, text: "Ir a su pestaña" });
};

function sessionCard(s, group) {
  const kids = [h("div", { class: "top" }, [h("span", { class: `dot ${DOTS[group]}` }), h("strong", { class: "session-title", text: s.name }), h("span", { class: "time", text: s.since ? `desde ${when(s.since)}` : "" })])];
  if (s.reason) {
    const t = s.reason.task;
    kids.push(h("div", { class: "reason" }, [h("b", { text: s.reason.text + (t ? " " : "") }), t ? h("button", { class: "task-link", type: "button", text: t.key, title: t.title, onclick: () => switchView(s.reason.view) }) : null]));
  }
  if (s.subagents) kids.push(h("div", { class: "meta", text: s.subagents === 1 ? "Con un subagente en marcha" : `Con ${s.subagents} subagentes en marcha` }));
  const others = s.tasks.filter((t) => !s.reason || t !== s.reason.task);
  if (others.length) kids.push(h("div", { class: "meta", text: `Con ${others.map((t) => t.key).join(", ")}` }));
  kids.push(h("div", { class: "home-footer" }, [h("span", { class: "meta", text: s.sessionName || "" }), vsCodeLink(s)]));
  return h("article", { class: `card home-session ${group}` }, kids);
}

export function shortcuts(root) {
  const count = (statuses) => state.tasks.filter((t) => statuses.includes(t.status)).length;
  const data = [
    ["pending", "Pendientes", ["pending"]],
    ["waiting", "Te esperan", ["waiting", "partial"]],
    ["sent", "En curso", ["sent"]],
    ["done", "Hechas por revisar", ["done"]],
  ].map(([id, label, statuses]) => [id, label, count(statuses) + (id === "waiting" ? ((state.permissions && state.permissions.pending) || []).length : 0)]);
  root.appendChild(h("div", { class: "shortcuts" }, data.map(([id, label, n]) => h("button", { type: "button", class: `shortcut${n ? " filled" : ""}${id === "waiting" && n ? " urgent" : ""}`, onclick: () => switchView(id) }, [h("strong", { text: String(n) }), h("span", { text: label })]))));
}

let dailyAsked = null;

function dailyLines(text) {
  const raw = String(text).split("\n");
  const title = (raw.find((l) => l.trim()) || "").trim();
  const items = [];
  let group = null;
  let sub = null;
  const section = (t) => /:$/.test(t) && t.split(/\s+/).length <= 3;
  for (const line of raw.slice(raw.findIndex((l) => l.trim()) + 1)) {
    if (!line.trim()) {
      if (sub) sub = null;
      else group = null;
      continue;
    }
    const t = line.trim().replace(/^[-•*◦]\s+/, "");
    const node = { text: t, children: [] };
    if (group && section(t)) {
      sub = node;
      group.children.push(node);
    } else if (/:$/.test(t)) {
      items.push(node);
      group = node;
      sub = null;
    } else if (sub) sub.children.push(node);
    else if (group) group.children.push(node);
    else items.push(node);
  }
  return { title, items };
}

const toHtml = (list, esc) => `<ul>${list.map((i) => `<li>${esc(i.text)}${i.children.length ? toHtml(i.children, esc) : ""}</li>`).join("")}</ul>`;
const toPlain = (list, depth) => list.flatMap((i) => [`${"    ".repeat(depth)}${depth ? "◦" : "•"} ${i.text}`, ...toPlain(i.children, depth + 1)]);
const toNodes = (list) => h("ul", {}, list.map((i) => h("li", {}, [i.text, i.children.length ? toNodes(i.children) : null])));

function dailyBody(text) {
  const { title, items } = dailyLines(text);
  return h("div", { class: "daily-text" }, [title ? h("p", { text: title }) : null, toNodes(items)]);
}

function copyDaily(text) {
  const { title, items } = dailyLines(text);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `${title ? `<p>${esc(title)}</p>` : ""}${toHtml(items, esc)}`;
  const plain = [title, ...toPlain(items, 0)].filter(Boolean).join("\n");
  const done = () => toast("Copiado.");
  if (window.ClipboardItem && navigator.clipboard.write)
    return navigator.clipboard
      .write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) })])
      .then(done, () => navigator.clipboard.writeText(plain).then(done));
  return navigator.clipboard.writeText(plain).then(done);
}

export function dailyCard(root) {
  const d = state.daily;
  const busy = dailyAsked && (!d || d.at < dailyAsked);
  const day = d && d.day ? d.day.split("-").reverse().slice(0, 2).join("/") : "";
  const ask = (today) => {
    dailyAsked = new Date().toISOString();
    post("/api/daily", { today }, today ? "Preparando el resumen de hoy…" : "Rehaciendo el resumen…");
  };
  const actions = [];
  if (d && d.text) actions.push(button("Copiar", { onClick: () => copyDaily(d.text) }));
  actions.push(button(busy ? "Preparando…" : "Rehacer", { cls: "subtle", disabled: !!busy, onClick: () => ask(false) }));
  actions.push(button("El de hoy", { cls: "subtle", disabled: !!busy, title: "Lo que llevas hecho hoy, por si apagas antes y quieres tenerlo ya", onClick: () => ask(true) }));
  const body = !d ? "Se prepara solo cada mañana con lo del último día laborable." : d.empty ? "Ese día no hay movimiento en Jira, commits ni despliegues tuyos." : d.text;
  const det = h("details", { class: "card daily-card" }, [
    h("summary", {}, [h("strong", { text: "Para la daily" }), h("span", { class: "meta", text: day ? ` · ${day}` : "" })]),
    d && d.text ? dailyBody(d.text) : h("p", { class: "daily-text", text: body }),
    h("div", { class: "actions" }, actions),
  ]);
  try {
    det.open = localStorage.getItem("daily-open") !== "0";
  } catch (e) {
    det.open = true;
  }
  det.addEventListener("toggle", () => {
    try {
      localStorage.setItem("daily-open", det.open ? "1" : "0");
    } catch (e) {}
  });
  root.appendChild(det);
}

export function renderHome(root) {
  const cs = state.contextSync;
  if (cs && cs.state === "conflict") root.appendChild(h("p", { class: "setup-note warn", text: "El contexto compartido tiene un choque entre los dos ordenadores y no se sincroniza. Hay que resolverlo a mano en palc (git status)." }));
  else if (cs && cs.state === "error") root.appendChild(h("p", { class: "setup-note warn", text: `El contexto compartido no se sincroniza: ${String(cs.error || "").split(/\r?\n/)[0]}` }));
  shortcuts(root);
  dailyCard(root);
  const s = sessionSituation();
  if (!s.working.length && !s.blocked.length && !s.free.length) root.appendChild(empty("No hay sesiones de área abiertas.", "Las que abras aparecen aquí solas."));
  else {
    const columns = BOARD.map((id) => {
      const [, title, note] = GROUPS.find((g) => g[0] === id);
      const head = h("div", { class: "board-head", title: note }, [h("span", { class: `dot ${DOTS[id]}` }), h("span", { text: title }), h("span", { class: "n", text: String(s[id].length) })]);
      const cards = s[id].length ? s[id].map((x) => sessionCard(x, id)) : [h("div", { class: "board-empty", text: "Ninguna" })];
      return h("section", { class: "board-col" }, [head, ...cards]);
    });
    root.appendChild(h("div", { class: "board" }, columns));
  }
  if (s.system.length) {
    root.appendChild(h("p", { class: "meta home-system", text: "Del tablero: " + s.system.map((x) => `${x.name} ${x.working ? "trabajando" : x.open ? "abierta" : "cerrada"}`).join(" · ") }));
  }
}

export function sessionStrip() {
  const s = sessionSituation();
  const total = s.working.length + s.blocked.length + s.free.length;
  if (!total) return null;
  const parts = [
    ["working", "busy", "trabajando"],
    ["blocked", "bad", s.blocked.length === 1 ? "bloqueada" : "bloqueadas"],
    ["free", "on", s.free.length === 1 ? "libre" : "libres"],
  ].filter(([id]) => s[id].length);
  const summary = h("summary", { class: "strip-summary" }, [h("span", { class: "strip-title", text: "Sesiones abiertas:" }), ...parts.flatMap(([id, dot, label], i) => [i ? " · " : null, h("span", { class: `dot ${dot}` }), ` ${s[id].length} ${label}`]).filter(Boolean)]);
  const list = h(
    "div",
    { class: "strip-list" },
    GROUPS.flatMap(([id]) =>
      s[id].map((x) =>
        h("div", { class: "strip-row" }, [
          h("span", { class: `dot ${DOTS[id]}` }),
          h("span", { class: "strip-name", text: x.name }),
          h("span", { class: "meta", text: x.reason ? `${x.reason.text}${x.reason.task ? " " + x.reason.task.key : ""}` : x.tasks.length ? x.tasks.map((t) => t.key).join(", ") : "" }),
        ])
      )
    )
  );
  const det = h("details", { class: "session-strip" }, [summary, list]);
  try {
    det.open = sessionStorage.getItem("strip-open") === "1";
  } catch (e) {}
  det.addEventListener("toggle", () => {
    try {
      sessionStorage.setItem("strip-open", det.open ? "1" : "0");
    } catch (e) {}
  });
  return det;
}

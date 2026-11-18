import { state, h, when, minutesSince, switchView, empty, fixedAreaIds, button, post, toast } from "../lib/base.js";
import { currentProject, mixedProjects, projectName } from "../components/project-filter.js";


const GROUPS = [
  ["working", "Trabajando", "Tienen un turno en marcha."],
  ["blocked", "Bloqueadas", "Paradas con algo pendiente: te esperan, a medias o sin avisar de una tarea enviada."],
  ["free", "Libres", "Abiertas y sin nada entre manos."],
];
const BOARD = ["working", "blocked", "free"];
const DOTS = { working: "busy", blocked: "bad", free: "on" };
const SILENT_MIN = 5;

function liveOf(conversation, sessionName, everywhere) {
  const list = (everywhere && state.allSessions ? state.allSessions.list : state.sessions.list) || [];
  return list.find((s) => (conversation ? s.conversation === conversation : s.name === sessionName)) || null;
}

function blockReason(live, tasks) {
  const waiting = tasks.find((t) => t.status === "waiting");
  if (waiting) return { text: "Te espera", task: waiting, view: "waiting" };
  const partial = tasks.find((t) => t.status === "partial");
  if (partial) return { text: "A medias", task: partial, view: "waiting" };
  const silent = tasks.find((t) => t.status === "sent" && !t.manual && (!t.sentAt || minutesSince(t.sentAt) >= SILENT_MIN));
  if (silent) return { text: "Parada sin avisar de", task: silent, view: "sent" };
  if (live.status === "waiting") return { text: "Espera tu respuesta en su sesión" };
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
    const row = { id: a.id, name: a.unnamed ? a.vsCodeTitle || `${a.sessionName} (sin nombre)` : a.name, sessionName: a.sessionName, conversation: a.conversation, project: a.project || live.project, since: live.statusSince, subagents: live.subagents || 0, tasks };
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
    ["Seguimiento", state.followUpStatus],
    ["Tablero", state.boardStatus],
    ["Despliegue", fixedArea(state.deployerArea)],
    ["Errores sentry", fixedArea(state.sentry && state.sentry.errorsArea)],
  ];
  const picked = currentProject();
  const mainId = ((state.jiraSetup && state.jiraSetup.workspaces) || [])[0];
  const otherProject = picked && mainId && picked !== mainId.id;
  for (const [name, r] of roles) {
    if (!r || !r.conversation || (otherProject && name !== "Tablero")) continue;
    const live = liveOf(r.conversation, r.session, true);
    out.system.push({ name, open: !!live, working: !!live && live.status === "busy", conversation: r.conversation, session: live ? live.name : r.session || name });
  }
  return out;
}

const vsCodeLink = (s) => {
  if (!s.conversation) return null;
  if ((state.hosted || []).some((x) => x.conversation === s.conversation && !x.waitingForVsCode)) return h("button", { class: "btn link", type: "button", text: "Ver en directo", onclick: () => import("../components/terminal.js").then((m) => m.openTerminal(s.conversation, s.name || s.sessionName)) });
  return h("a", { class: "btn link", href: `vscode://anthropic.claude-code/open?session=${encodeURIComponent(s.conversation)}`, text: "Ir a su pestaña" });
};



export function stuckBanners() {
  return (state.stuckDialogs || []).map((x) =>
    h("div", { class: "token-banner high stuck-banner" }, [
      h("div", {}, [
        h("strong", { text: `«${x.name}» está parada en una pregunta al arrancar` }),
        h("span", { text: "El tablero no sabe contestarla sola. Ábrela, elige la opción y sigue." }),
        x.text ? h("pre", { class: "stuck-text", text: x.text }) : null,
      ]),
      h("button", { class: "btn primary", type: "button", text: "Ver en directo", onclick: () => import("../components/terminal.js").then((m) => m.openTerminal(x.conversation, x.name)) }),
    ])
  );
}

export function watchdogBanners() {
  return (state.watchdog || []).map((x) =>
    h("div", { class: "token-banner high" }, [
      h("div", {}, [h("strong", { text: x.title }), h("span", { text: `${x.detail} Visto a las ${when(x.at)}.` })]),
      h("div", { class: "banner-actions" }, [
        x.conversation && x.kind !== "typing" ? h("button", { class: "btn", type: "button", text: "Ver en directo", onclick: () => import("../components/terminal.js").then((m) => m.openTerminal(x.conversation, x.name)) }) : null,
        x.key ? h("button", { class: "btn", type: "button", text: "Quitar", onclick: () => post("/api/watchdog/dismiss", { key: x.key }) }) : null,
      ]),
    ])
  );
}

export function homeAlerts(items) {
  const cs = state.contextSync;
  const rows = [];
  if (cs && cs.state === "conflict") rows.push(h("div", { class: "token-banner high" }, [h("div", {}, [h("strong", { text: "El contexto compartido no se sincroniza" }), h("span", { text: "Hay un choque entre los dos ordenadores: hay que resolverlo a mano en la carpeta del contexto (git status)." })])]));
  else if (cs && cs.state === "error") rows.push(h("div", { class: "token-banner high" }, [h("div", {}, [h("strong", { text: "El contexto compartido no se sincroniza" }), h("span", { text: String(cs.error || "").split(/\r?\n/)[0] })])]));
  rows.push(...items.filter(Boolean));
  return rows.length ? h("div", { class: "alerts" }, rows) : null;
}

export function shortcuts(root) {
  const count = (statuses) => state.tasks.filter((t) => statuses.includes(t.status)).length;
  const data = [
    ["pending", "Pendientes", ["pending"]],
    ["waiting", "Te esperan", ["waiting", "partial"]],
    ["sent", "En curso", ["sent"]],
    ["done", "Hechas", ["done"]],
  ].map(([id, label, statuses]) => [id, label, count(statuses) + (id === "waiting" ? ((state.permissions && state.permissions.pending) || []).length : 0)]);
  root.appendChild(h("div", { class: "shortcuts" }, data.map(([id, label, n]) => h("button", { type: "button", class: `shortcut${n ? " filled" : ""}${id === "waiting" && n ? " urgent" : ""}`, onclick: () => switchView(id) }, [h("strong", { text: String(n) }), h("span", { text: label })]))));
}

function sessionCard(s, group) {
  const kids = [h("div", { class: "top" }, [h("span", { class: `dot ${DOTS[group]}` }), h("strong", { class: "session-title", text: s.name }), h("span", { class: "time", text: s.since ? `desde ${when(s.since)}` : "" })])];
  if (s.reason) {
    const t = s.reason.task;
    kids.push(h("div", { class: "reason" }, [h("b", { text: s.reason.text + (t ? " " : "") }), t ? h("button", { class: "task-link", type: "button", text: t.key, title: t.title, onclick: () => switchView(s.reason.view) }) : null]));
  }
  if (s.subagents) kids.push(h("div", { class: "meta", text: s.subagents === 1 ? "Con un subagente en marcha" : `Con ${s.subagents} subagentes en marcha` }));
  const others = s.tasks.filter((t) => !s.reason || t !== s.reason.task);
  if (others.length) kids.push(h("div", { class: "meta", text: `Con ${others.map((t) => t.key).join(", ")}` }));
  const where = mixedProjects() && s.project ? h("span", { class: "chip session-project", text: projectName(s.project) }) : null;
  kids.push(h("div", { class: "home-footer" }, [h("span", { class: "home-footer-who" }, [where]), vsCodeLink(s)]));
  return h("article", { class: `card home-session ${group}` }, kids);
}

const MOOD = { working: "Trabajando", blocked: "Bloqueada", free: "Libre", closed: "Cerrada" };

export function claudito(mood, size = "") {
  const eyes = mood === "free" || mood === "closed" ? '<rect class="eye" x="4" y="6" width="2" height="1"/><rect class="eye" x="10" y="6" width="2" height="1"/>' : '<rect class="eye" x="5" y="5" width="1" height="2"/><rect class="eye" x="10" y="5" width="1" height="2"/>';
  const arms = mood === "blocked" ? '<rect class="arm" x="0" y="5" width="2" height="2"/><rect class="arm raised" x="14" y="0" width="2" height="5"/>' : '<rect class="arm left" x="0" y="5" width="2" height="2"/><rect class="arm right" x="14" y="5" width="2" height="2"/>';
  const laptop = mood === "working" ? '<rect class="laptop" x="3" y="9" width="10" height="3"/><rect class="screen" x="4" y="10" width="8" height="1"/>' : "";
  const el = h("span", { class: `claudito ${mood} ${size}`.trim(), "aria-hidden": "true" });
  el.innerHTML = `<svg viewBox="0 0 16 14" shape-rendering="crispEdges"><rect class="body" x="2" y="3" width="12" height="7"/>${arms}<rect class="leg" x="3" y="10" width="1" height="2"/><rect class="leg" x="5" y="10" width="1" height="2"/><rect class="leg" x="10" y="10" width="1" height="2"/><rect class="leg" x="12" y="10" width="1" height="2"/>${eyes}${laptop}</svg>${mood === "blocked" ? '<b class="bubble">?</b>' : mood === "free" ? '<i class="zz">z<span>z</span></i>' : ""}`;
  return el;
}

let picked = null;

function deskLine(s, group) {
  if (group === "blocked" && s.reason) return h("span", { class: "desk-why", text: s.reason.text + (s.reason.task ? ` ${s.reason.task.key}` : "") });
  const n = s.tasks.length;
  const bits = [n ? (n === 1 ? "1 tarea" : `${n} tareas`) : group === "free" ? "Sin nada entre manos" : "Sin tareas del tablero", s.subagents ? (s.subagents === 1 ? "1 subagente" : `${s.subagents} subagentes`) : null].filter(Boolean);
  return h("span", { class: "meta", text: bits.join(" · ") });
}

export function renderHome(root) {
  shortcuts(root);
  const s = sessionSituation();
  const all = BOARD.flatMap((id) => s[id].map((x) => ({ x, id })));
  if (picked && !all.some((d) => d.x.conversation === picked)) picked = null;
  const detail = h("div", { class: "office-detail" });
  const showDetail = () => {
    detail.replaceChildren();
    const d = all.find((y) => y.x.conversation === picked);
    if (d) detail.appendChild(sessionCard(d.x, d.id));
    for (const el of floor.querySelectorAll(".desk")) el.classList.toggle("picked", el.dataset.conv === picked);
  };
  const desks = all.map(({ x, id }) =>
    h("button", { class: `desk ${id}`, type: "button", "data-conv": x.conversation, title: `${x.name}: ${MOOD[id]}${x.since ? ` desde ${when(x.since)}` : ""}`, onclick: () => ((picked = picked === x.conversation ? null : x.conversation), showDetail()) }, [
      claudito(id),
      h("strong", { class: "desk-name", text: x.name }),
      deskLine(x, id),
      mixedProjects() && x.project ? h("span", { class: "chip session-project", text: projectName(x.project) }) : null,
    ])
  );
  const label = { working: () => "trabajando", blocked: (n) => (n === 1 ? "bloqueada" : "bloqueadas"), free: (n) => (n === 1 ? "libre" : "libres") };
  const counts = BOARD.filter((id) => s[id].length).map((id) => `${s[id].length} ${label[id](s[id].length)}`);
  const head = h("div", { class: "office-head" }, [h("strong", { text: "Sesiones" }), h("span", { class: "meta", text: counts.length ? counts.join(" · ") : "Ninguna abierta" })]);
  const floor = h("div", { class: "office-floor" }, desks.length ? desks : [h("div", { class: "office-empty" }, [claudito("closed"), h("span", { class: "meta", text: "No hay sesiones abiertas" })])]);
  root.appendChild(h("section", { class: "office" }, [head, floor, detail]));
  showDetail();
  if (s.system.length)
    root.appendChild(
      h("div", { class: "office-crew" }, [
        h("span", { class: "meta", text: "Del tablero" }),
        ...s.system.map((x) => {
          const mood = x.working ? "working" : x.open ? "free" : "closed";
          return h("span", { class: "crew", title: `${x.name}: ${x.working ? "trabajando" : x.open ? "abierta" : "cerrada"}` }, [claudito(mood, "small"), h("span", { text: x.name })]);
        }),
      ])
    );
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
  const summary = h("summary", { class: "strip-summary" }, [h("span", { class: "strip-title", text: "Sesiones abiertas:" }), ...parts.flatMap(([id, dot, label], i) => [i ? " · " : null, h("span", { class: "strip-part" }, [h("span", { class: `dot ${dot}` }), ` ${s[id].length} ${label}`])]).filter(Boolean)]);
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
    const saved = sessionStorage.getItem("strip-open");
    det.open = saved ? saved === "1" : s.blocked.length > 0;
  } catch (e) {}
  det.addEventListener("toggle", () => {
    try {
      sessionStorage.setItem("strip-open", det.open ? "1" : "0");
    } catch (e) {}
  });
  return det;
}

import { state, h, when, minutesSince, switchView, empty, fixedAreaIds, button, post, toast } from "../lib/base.js";
import { currentProject, mixedProjects, projectName } from "../components/project-filter.js";
import { nutria, paint, CLAYS } from "../components/nutria.js";


const GROUPS = [
  ["working", "Trabajando", "Tienen un turno en marcha."],
  ["blocked", "Bloqueadas", "Paradas con algo pendiente: te esperan, a medias o sin avisar de una tarea enviada."],
  ["free", "Libres", "Abiertas y sin nada entre manos."],
];
const BOARD = ["working", "blocked", "free"];
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

function openLive(conversation, name) {
  if (!conversation) return;
  if ((state.hosted || []).some((x) => x.conversation === conversation && !x.waitingForVsCode)) return import("../components/terminal.js").then((m) => m.openTerminal(conversation, name));
  window.location.href = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(conversation)}`;
}



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


const ALERT_MOOD = (el) => (el.classList.contains("overtime-banner") ? (el.classList.contains("on") ? "working" : "free") : "alert");

export function homeAlerts(items) {
  const cs = state.contextSync;
  const rows = [];
  if (cs && cs.state === "conflict") rows.push(h("div", { class: "token-banner high" }, [h("div", {}, [h("strong", { text: "El contexto compartido no se sincroniza" }), h("span", { text: "Hay un choque entre los dos ordenadores: hay que resolverlo a mano en la carpeta del contexto (git status)." })])]));
  else if (cs && cs.state === "error") rows.push(h("div", { class: "token-banner high" }, [h("div", {}, [h("strong", { text: "El contexto compartido no se sincroniza" }), h("span", { text: String(cs.error || "").split(/\r?\n/)[0] })])]));
  rows.push(...items.filter(Boolean));
  if (!rows.length) return null;
  rows.forEach((el, i) => {
    el.classList.add("note", `tilt-${i % 3}`);
    el.prepend(nutria(ALERT_MOOD(el), "note-who"));
  });
  return room("cork", "Tablón de avisos", rows.length === 1 ? "1 aviso" : `${rows.length} avisos`, [h("div", { class: "cork-board" }, rows)], { decor: [pin()] });
}

const MOOD_TEXT = { working: "trabajando", blocked: "bloqueada", free: "libre" };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function madridNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { h: Number(p.hour) % 24, m: Number(p.minute) };
}

function windowDecor() {
  const { h: hour } = madridNow();
  const night = hour < 8 || hour >= 20;
  return h("span", { class: `win${night ? " night" : ""}`, title: night ? "De noche" : "De día" }, [h("span", { class: night ? "moon" : "sun" })]);
}

function clockDecor() {
  const { h: hour, m } = madridNow();
  const face = h("span", { class: "clock", title: `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}` }, [h("i", { class: "hand hour" }), h("i", { class: "hand min" })]);
  face.firstChild.style.transform = `rotate(${(hour % 12) * 30 + m / 2}deg)`;
  face.lastChild.style.transform = `rotate(${m * 6}deg)`;
  return face;
}

const plant = () => h("span", { class: "plant" }, [h("i"), h("i"), h("i")]);
const pin = () => h("span", { class: "pinned-paper" });
const poster = (text) => h("span", { class: "poster", text });

function room(kind, name, count, body, { decor = [], onclick, title } = {}) {
  const wall = h("header", { class: "room-wall" }, [h("span", { class: "room-sign" }, [h("strong", { text: name }), count ? h("span", { text: count }) : null]), h("span", { class: "room-decor" }, decor)]);
  const floor = h("div", { class: "room-floor" }, body);
  const el = h(onclick ? "button" : "section", { class: `room r-${kind}${onclick ? " go" : ""}`, ...(onclick ? { type: "button", onclick, title } : {}) }, [wall, floor]);
  return el;
}

function deskLine(s, group) {
  if (group === "blocked" && s.reason) return h("span", { class: "plate-why", text: s.reason.text + (s.reason.task ? ` ${s.reason.task.key}` : "") });
  const bits = [s.tasks.length ? plural(s.tasks.length, "tarea", "tareas") : null, s.subagents ? plural(s.subagents, "ayudante", "ayudantes") : null].filter(Boolean);
  return bits.length ? h("span", { class: "plate-meta", text: bits.join(" · ") }) : null;
}

const sofaFront = () => h("span", { class: "sofa" }, [h("i", { class: "arm-rest left" }), h("i", { class: "arm-rest right" })]);
function art(cls, markup) {
  const el = document.createElement("span");
  el.className = cls;
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = markup;
  return el;
}
const cobweb = (cls = "") => art(`cobweb ${cls}`.trim(), '<svg viewBox="0 0 30 30"><g fill="none" stroke="currentColor" stroke-width=".9" stroke-linecap="round"><path d="M0 0L29 29M0 0L29 11M0 0L11 29M0 0L29 1M0 0L1 29"/><path d="M9 0Q8 4 7 7Q4 8 0 9M17 0Q16 8 14 14Q8 16 0 17M26 0Q24 12 21 21Q12 24 0 26"/></g><circle cx="15" cy="15" r="1.8" fill="currentColor"/></svg>');
const deskItems = () => h("span", { class: "desk-items" }, [h("i", { class: "laptop-shut" }), h("i", { class: "postit" }), h("i", { class: "cup" }, [h("b"), h("b")])]);
const emptyStation = (i) => h("span", { class: `ws-empty tilt-${i}` }, [h("i", { class: "mon-off" }), h("i", { class: "ws-desk" }), h("span", { class: "chair" })]);
const emptyLounge = () => h("span", { class: "still-row" }, [h("span", { class: "couch-empty seat-scene" }, [h("i", { class: "rug" }), h("i", { class: "sofa-back" }), sofaFront(), h("i", { class: "cushion" })]), h("span", { class: "side-table" }, [h("i", { class: "magazine" })])]);
const lonelyBox = () => h("span", { class: "lonely-box" }, [h("i")]);
const pick = (key, n) => [...String(key || "")].reduce((v, ch) => (v * 33 + ch.charCodeAt(0)) >>> 0, 11) % n;

function actor(x, id, fig, extra = "") {
  const helpers = x.subagents ? h("span", { class: "helpers" }, Array.from({ length: Math.min(x.subagents, 3) }, () => paint(nutria(id === "working" ? "working" : "relax", "tiny"), x.name))) : null;
  return h("button", { class: `seat ${id} ${extra}`.trim(), type: "button", "data-conv": x.conversation, title: `${x.name}: ${MOOD_TEXT[id]}${x.since ? ` desde ${when(x.since)}` : ""}. Pulsa para verla en directo.`, onclick: () => openLive(x.conversation, x.sessionName || x.name) }, [
    h("span", { class: "seat-scene" }, [...fig, helpers]),
    h("span", { class: "plate" }, [h("strong", { text: x.name }), deskLine(x, id), mixedProjects() && x.project ? h("span", { class: "plate-project", text: projectName(x.project) }) : null]),
  ]);
}

const otter = (x, mood, prop, cls = "") => {
  const el = paint(nutria(mood, "", prop), x.name);
  if (cls) el.classList.add(...cls.split(" "));
  return el;
};

const WORK = [
  (x) => [otter(x, "working"), h("span", { class: "desk-top" })],
  (x) => [h("span", { class: "monitor" }, [h("i"), h("i"), h("i")]), otter(x, "typing", null, "working-arms"), h("span", { class: "desk-top keyboard" })],
  (x) => [h("span", { class: "whiteboard" }, [h("i"), h("i"), h("i")]), otter(x, "drawing")],
];

function workScene(x, id) {
  if (id === "blocked") return actor(x, id, [otter(x, "blocked"), h("span", { class: "desk-top" })]);
  const v = pick(x.name, WORK.length);
  return actor(x, id, WORK[v](x), `work-v${v}`);
}

const REST = [
  (x) => [h("i", { class: "sofa-back" }), otter(x, "free"), sofaFront()],
  (x) => [h("span", { class: "hammock" }, [h("i", { class: "post left" }), h("i", { class: "post right" })]), h("span", { class: "swing" }, [otter(x, "free"), h("i", { class: "cloth" })])],
  (x) => [h("span", { class: "beanbag" }), otter(x, "idle", "book")],
  (x) => [h("span", { class: "pool" }), otter(x, "relax", null, "floating"), h("span", { class: "pool-front" }), h("span", { class: "float-ring" })],
  (x) => [otter(x, "idle", "controller"), h("span", { class: "tv" }, [h("i")])],
];

const PAIRS = [
  (a, b) => ({ cls: "coffee", left: [otter(a, "idle", "mug"), h("b", { class: "say one", text: "…" })], middle: h("span", { class: "coffee-table" }), right: [otter(b, "idle", "mug", "mirror"), h("b", { class: "say two", text: "jaja" })] }),
  (a, b) => ({ cls: "pingpong", left: [otter(a, "idle", "paddle")], middle: h("span", { class: "pp-table" }, [h("i", { class: "net" }), h("i", { class: "ball" })]), right: [otter(b, "idle", "paddle", "mirror")] }),
  (a, b) => ({ cls: "chess", left: [otter(a, "idle"), h("b", { class: "say one", text: "?" })], middle: h("span", { class: "chess-table" }), right: [otter(b, "idle", null, "mirror")] }),
];

function restScenes(list) {
  const sorted = [...list].sort((p, q) => p.x.name.localeCompare(q.x.name));
  const out = [];
  let last = -1;
  for (let i = 0; i < sorted.length; i += 2) {
    const a = sorted[i].x;
    const b = sorted[i + 1] && sorted[i + 1].x;
    if (!b) {
      const v = pick(a.name, REST.length);
      out.push(h("div", { class: `scene rest-v${v}` }, [actor(a, "free", REST[v](a))]));
      continue;
    }
    let k = pick(a.name + b.name, PAIRS.length);
    if (k === last) k = (k + 1) % PAIRS.length;
    last = k;
    const p = PAIRS[k](a, b);
    out.push(h("div", { class: `scene pair ${p.cls}` }, [actor(a, "free", p.left), p.middle, actor(b, "free", p.right)]));
  }
  return out;
}

function inboxPile(n) {
  const sheets = Math.min(n, 9);
  if (!n) return h("span", { class: "tray empty" }, [h("i", { class: "clip" }), h("span", { class: "tray-box" }), cobweb("on-tray")]);
  return h("span", { class: "tray" }, [...Array.from({ length: sheets }, (_, i) => h("i", { class: "sheet", style: `bottom:${6 + i * 4}px;transform:rotate(${((i * 37) % 9) - 4}deg)` })), h("span", { class: "tray-box" })]);
}

function shelf(n) {
  const spines = Math.min(n, 28);
  const rows = [[], []];
  for (let i = 0; i < spines; i++) rows[i < 14 ? 0 : 1].push(h("i", { class: "folder", style: `height:${26 + ((i * 7) % 12)}px;background:${CLAYS[(i * 3) % CLAYS.length]}` }));
  return h("span", { class: `shelf${spines ? "" : " empty"}` }, [...rows.map((r) => h("span", { class: "shelf-row" }, r)), spines ? null : cobweb("on-shelf")]);
}

function queue(items) {
  const shown = items.slice(0, 5);
  return h("span", { class: "queue" }, [
    ...shown.map((x) => h("span", { class: "queuer", title: x.title }, [h("span", { class: "sign", text: x.label }), paint(nutria(x.mood || "waiting", "mid"), x.label)])),
    items.length > shown.length ? h("span", { class: "queue-more", text: `+${items.length - shown.length}` }) : null,
  ]);
}

export function renderHome(root) {
  const s = sessionSituation();
  const count = (st) => state.tasks.filter((t) => st.includes(t.status));
  const waiting = count(["waiting", "partial"]);
  const perms = (state.permissions && state.permissions.pending) || [];
  const pending = count(["pending"]);
  const sent = count(["sent"]).length;
  const done = count(["done"]).length;
  const atDesk = [...s.working.map((x) => ({ x, id: "working" })), ...s.blocked.map((x) => ({ x, id: "blocked" }))];
  const resting = s.free.map((x) => ({ x, id: "free" }));

  const plan = h("div", { class: `office-plan${resting.length >= 2 ? " wide-rest" : ""}${state.workHours === false && !(state.config && state.config.overtime) ? " lights-off" : ""}` });

  const yours = [...perms.map((p) => ({ label: "Permiso", title: p.label, mood: "blocked" })), ...waiting.map((t) => ({ label: t.key, title: `${t.status === "partial" ? "A medias" : "Te espera"}: ${t.title}`, mood: t.status === "partial" ? "blocked" : "waiting" }))];
  const yourN = yours.length;
  plan.append(
    room("desk", "Tu mesa", yourN ? `${plural(yourN, "cosa te espera", "cosas te esperan")}` : "Nadie te espera", [yourN ? queue(yours) : h("span", { class: "calm" }, [h("span", { class: "chair pushed" })]), h("span", { class: "big-desk" }, yourN ? [] : [deskItems()])], { decor: [windowDecor(), plant()], onclick: () => switchView("waiting"), title: "Ver lo que te espera" }),
    room("inbox", "Bandeja de entrada", pending.length ? plural(pending.length, "pendiente", "pendientes") : "Vacía", [h("span", { class: "inbox-scene" }, [pending.length ? paint(nutria("pending", "mid"), "bandeja") : null, inboxPile(pending.length)]), h("strong", { class: "big-n", text: String(pending.length) })], { decor: [poster("IN")], onclick: () => switchView("pending"), title: "Ver las pendientes" }),
    room("work", "Sala de trabajo", `${atDesk.length ? plural(atDesk.length, "sesión", "sesiones") : "Vacía"} · ${plural(sent, "tarea en curso", "tareas en curso")}`, atDesk.length ? atDesk.map(({ x, id }) => workScene(x, id)) : [h("span", { class: "still-row" }, [0, 1, 2].map(emptyStation))], { decor: [clockDecor(), plant()] }),
    room("sofa", "Sala de descanso", resting.length ? plural(resting.length, "libre", "libres") : "Vacía", resting.length ? restScenes(resting) : [emptyLounge()], { decor: [h("span", { class: "lamp" })] }),
    room("archive", "Archivo", done ? plural(done, "hecha", "hechas") : "Nada archivado", [h("span", { class: "archive-scene" }, [shelf(done), done ? paint(nutria("done", "mid"), "archivo") : lonelyBox()]), h("strong", { class: "big-n", text: String(done) })], { decor: [poster("✓")], onclick: () => switchView("done"), title: "Ver las hechas" }),
  );
  if (s.system.length) {
    plan.append(
      room("control", "Sala de control", plural(s.system.filter((x) => x.open).length, "abierta", "abiertas"), s.system.map((x) => {
        const mood = x.working ? "working" : x.open ? "free" : "closed";
        return h("button", { class: `console ${mood}`, type: "button", title: `${x.name}: ${x.working ? "trabajando" : x.open ? "abierta" : "cerrada"}. Pulsa para verla en directo.`, onclick: () => openLive(x.conversation, x.session) }, [h("span", { class: "screen-wall" }), paint(nutria(mood, "mid"), x.name), h("span", { class: "plate small" }, [h("strong", { text: x.name })])]);
      }), { decor: [h("span", { class: "radar" })] })
    );
  }
  root.appendChild(h("div", { class: "office" }, [plan]));
}

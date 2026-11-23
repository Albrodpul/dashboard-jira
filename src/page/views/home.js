import { decide } from "../components/permissions.js";
import { state, h, when, minutesSince, switchView, empty, fixedAreaIds, button, post, toast } from "../lib/base.js";
import { currentProject, mixedProjects, projectName } from "../components/project-filter.js";
import { nutria, paint, CLAYS } from "../components/nutria.js";
import { t as tr } from "../lib/i18n.js";


const GROUPS = [
  ["working", tr("Trabajando"), tr("Tienen un turno en marcha.")],
  ["blocked", tr("Bloqueadas"), tr("Paradas con algo pendiente: te esperan, a medias o sin avisar de una tarea enviada.")],
  ["free", tr("Libres"), tr("Abiertas y sin nada entre manos.")],
];
const BOARD = ["working", "blocked", "free"];
const SILENT_MIN = 5;
const DOTS = { working: "busy", blocked: "bad", free: "on" };
const LAYOUT_KEY = "tower-home";
export const HOME_LAYOUTS = [
  { id: "office", label: "Oficina de nutrias" },
  { id: "columns", label: "Columnas y tarjetas" },
];

export function homeLayout() {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "columns" ? "columns" : "office";
  } catch (e) {
    return "office";
  }
}

export function setHomeLayout(id) {
  try {
    if (id === "office") localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, id);
  } catch (e) {}
}

function liveOf(conversation, sessionName, everywhere) {
  const list = (everywhere && state.allSessions ? state.allSessions.list : state.sessions.list) || [];
  return list.find((s) => (conversation ? s.conversation === conversation : s.name === sessionName)) || null;
}

function blockReason(live, tasks) {
  const waiting = tasks.find((t) => t.status === "waiting");
  if (waiting) return { text: tr("Te espera"), task: waiting, view: "waiting" };
  const partial = tasks.find((t) => t.status === "partial");
  if (partial) return { text: tr("A medias"), task: partial, view: "waiting" };
  const silent = tasks.find((t) => t.status === "sent" && !t.manual && (!t.sentAt || minutesSince(t.sentAt) >= SILENT_MIN));
  if (silent) return { text: tr("Parada sin avisar de"), task: silent, view: "sent" };
  if (live.status === "waiting") return { text: tr("Espera tu respuesta en su sesión") };
  if (live.status && !["busy", "idle"].includes(live.status)) return { text: tr("Estado «{status}»", { status: live.status }) };
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
    const row = { id: a.id, name: a.unnamed ? a.vsCodeTitle || tr("{name} (sin nombre)", { name: a.sessionName }) : a.name, sessionName: a.sessionName, conversation: a.conversation, project: a.project || live.project, since: live.statusSince, subagents: live.subagents || 0, tasks };
    const asking = ((state.permissions && state.permissions.pending) || []).find((p) => p.conversation === a.conversation);
    if (asking) out.blocked.push({ ...row, reason: { text: tr("Espera tu permiso: {what}", { what: asking.label }), view: "waiting", at: asking.at } });
    else if (live.status === "busy") out.working.push(row);
    else {
      const reason = blockReason(live, tasks);
      if (reason) out.blocked.push({ ...row, reason: { ...reason, at: (reason.task && reason.task.notice && reason.task.notice.at) || (reason.task && reason.task.sentAt) || live.statusSince } });
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
    out.system.push({ name, label: tr(name), open: !!live, working: !!live && live.status === "busy", conversation: r.conversation, session: live ? live.name : r.session || name });
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
        h("strong", { text: tr("«{name}» está parada en una pregunta al arrancar", { name: x.name }) }),
        h("span", { text: tr("El tablero no sabe contestarla sola. Ábrela, elige la opción y sigue.") }),
        x.text ? h("pre", { class: "stuck-text", text: x.text }) : null,
      ]),
      h("button", { class: "btn primary", type: "button", text: tr("Ver en directo"), onclick: () => import("../components/terminal.js").then((m) => m.openTerminal(x.conversation, x.name)) }),
    ])
  );
}

export function watchdogBanners() {
  return (state.watchdog || []).map((x) =>
    h("div", { class: "token-banner high" }, [
      h("div", {}, [h("strong", { text: x.title }), h("span", { text: tr("{detail} Visto a las {time}.", { detail: x.detail, time: when(x.at) }) })]),
      h("div", { class: "banner-actions" }, [
        x.conversation && x.kind !== "typing" ? h("button", { class: "btn", type: "button", text: tr("Ver en directo"), onclick: () => import("../components/terminal.js").then((m) => m.openTerminal(x.conversation, x.name)) }) : null,
        x.key ? h("button", { class: "btn", type: "button", text: tr("Quitar"), onclick: () => post("/api/watchdog/dismiss", { key: x.key }) }) : null,
      ]),
    ])
  );
}


const ALERT_MOOD = (el) => (el.classList.contains("overtime-banner") ? (el.classList.contains("on") ? "working" : "free") : "alert");

export function homeAlerts(items) {
  const cs = state.contextSync;
  const rows = [];
  if (cs && cs.state === "conflict") rows.push(h("div", { class: "token-banner high" }, [h("div", {}, [h("strong", { text: tr("El contexto compartido no se sincroniza") }), h("span", { text: tr("Hay un choque entre los dos ordenadores: hay que resolverlo a mano en la carpeta del contexto (git status).") })])]));
  else if (cs && cs.state === "error") rows.push(h("div", { class: "token-banner high" }, [h("div", {}, [h("strong", { text: tr("El contexto compartido no se sincroniza") }), h("span", { text: String(cs.error || "").split(/\r?\n/)[0] })])]));
  rows.push(...items.filter(Boolean));
  if (!rows.length) return null;
  if (homeLayout() === "columns") return h("div", { class: "alerts" }, rows);
  rows.forEach((el, i) => {
    el.classList.add("note", `tilt-${i % 3}`);
    el.prepend(nutria(ALERT_MOOD(el), "note-who"));
  });
  return room("cork", "Tablón de avisos", plural(rows.length, "aviso", "avisos"), [h("div", { class: "cork-board" }, rows)], { decor: [pin()] });
}

const waited = (at) => (at ? Math.max(0, minutesSince(at)) : 0);
const waitClass = (at) => (waited(at) >= 15 ? "wait-long" : waited(at) >= 5 ? "wait-some" : "");
const waitLabel = (at) => {
  const m = waited(at);
  return m < 1 ? "" : m < 60 ? tr("{m} min", { m }) : tr("{h} h {m} min", { h: Math.floor(m / 60), m: m % 60 });
};

const MOOD_TEXT = { working: tr("trabajando"), blocked: tr("bloqueada"), free: tr("libre") };
const plural = (n, one, many) => tr(`{n} ${n === 1 ? one : many}`, { n });

function madridNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { h: Number(p.hour) % 24, m: Number(p.minute) };
}

function windowDecor() {
  const { h: hour } = madridNow();
  const night = hour < 8 || hour >= 20;
  return h("span", { class: `win${night ? " night" : ""}`, title: night ? tr("De noche") : tr("De día") }, [h("span", { class: night ? "moon" : "sun" })]);
}

function clockDecor() {
  const { h: hour, m } = madridNow();
  const pad = (n) => String(n).padStart(2, "0");
  return h("span", { class: "clock", title: `${pad(hour)}:${pad(m)}` }, [h("span", { text: pad(hour) }), h("i", { class: "colon", text: ":" }), h("span", { text: pad(m) })]);
}

const plant = () => h("span", { class: "plant" }, [h("i"), h("i"), h("i")]);
const pin = () => h("span", { class: "pinned-paper" });
const poster = (text) => h("span", { class: "poster", text });

function room(kind, name, count, body, { decor = [], onclick, title, nested = false } = {}) {
  const wall = h("header", { class: "room-wall" }, [h("span", { class: "room-sign" }, [h("strong", { text: tr(name) }), count ? h("span", { text: count }) : null]), h("span", { class: "room-decor" }, decor)]);
  const floor = h("div", { class: "room-floor" }, body);
  if (onclick && nested) {
    const el = h("section", { class: `room r-${kind} go`, role: "button", tabindex: "0", title }, [wall, floor]);
    el.addEventListener("click", (e) => !e.target.closest("button") && onclick());
    el.addEventListener("keydown", (e) => e.target === el && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onclick()));
    return el;
  }
  const el = h(onclick ? "button" : "section", { class: `room r-${kind}${onclick ? " go" : ""}`, ...(onclick ? { type: "button", onclick, title } : {}) }, [wall, floor]);
  return el;
}

function deskLine(s, group) {
  if (group === "blocked" && s.reason) return h("span", { class: "plate-why", text: s.reason.text + (s.reason.task ? ` ${s.reason.task.key}` : "") + (waitLabel(s.reason.at) ? ` · ${waitLabel(s.reason.at)}` : "") });
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
const emptyLounge = () => h("span", { class: "still-row" }, [h("span", { class: "couch-empty seat-scene" }, [h("i", { class: "rug" }), h("i", { class: "sofa-back" }), sofaFront(), h("i", { class: "cushion" })]), h("span", { class: "side-table" }, [h("i", { class: "magazine" })])]);
const lonelyBox = () => h("span", { class: "lonely-box" }, [h("i")]);
const pick = (key, n) => [...String(key || "")].reduce((v, ch) => (v * 33 + ch.charCodeAt(0)) >>> 0, 11) % n;

function actor(x, id, fig, extra = "") {
  const helpers = x.subagents ? h("span", { class: "helpers" }, Array.from({ length: Math.min(x.subagents, 3) }, () => paint(nutria(id === "working" ? "working" : "relax", "tiny"), x.name))) : null;
  return h("button", { class: `seat ${id} ${extra}`.trim(), type: "button", "data-conv": x.conversation, title: x.since ? tr("{name}: {mood} desde {time}. Pulsa para verla en directo.", { name: x.name, mood: MOOD_TEXT[id], time: when(x.since) }) : tr("{name}: {mood}. Pulsa para verla en directo.", { name: x.name, mood: MOOD_TEXT[id] }), onclick: () => openLive(x.conversation, x.sessionName || x.name) }, [
    h("span", { class: "seat-scene" }, [...fig, helpers]),
    h("span", { class: "plate" }, [h("strong", { text: x.name }), deskLine(x, id), mixedProjects() && x.project ? h("span", { class: "plate-project", text: projectName(x.project) }) : null]),
  ]);
}

const otter = (x, mood, prop, cls = "") => {
  const el = paint(nutria(mood, "", prop), x.name);
  if (cls) el.classList.add(...cls.split(" ").filter(Boolean));
  return el;
};


const OFFICE_TRIPS = [
  { spot: ".ow-cooler", mood: "idle", prop: "mug", say: "Voy a por agua" },
  { spot: ".ow-counter", mood: "idle", prop: "mug", say: "Un café y vuelvo" },
  { spot: ".ow-printer", mood: "idle", prop: "paper", say: "A la impresora" },
  { spot: ".ow-cabinet", mood: "idle", prop: "paper", say: "Al cajón a por papeles" },
  { spot: ".ow-board", mood: "drawing", prop: null, say: "Apunto en la pizarra" },
  { spot: ".ow-shelf", mood: "idle", prop: "book", say: "Busco un libro" },
];
const REST_TRIPS = [
  { spot: ".rb-fridge", mood: "idle", prop: "mug", say: "A por un zumo" },
  { spot: ".rb-vending", mood: "idle", prop: "box", say: "A por galletas" },
  { spot: ".rb-window", mood: "relax", prop: null, say: "Mirando por la ventana" },
  { spot: ".rb-arcade", mood: "idle", prop: "controller", say: "Una partidita" },
  { spot: ".rb-cooler", mood: "idle", prop: "mug", say: "Voy a por agua" },
];

function trip(x, trips, salt) {
  const now = Date.now() / 1000;
  const dur = 70 + pick(x.name + salt + "pace", 45);
  const offset = pick(x.name + salt, 997);
  const lap = Math.floor((now + offset) / dur);
  const t = trips[(pick(x.name + salt + "route", trips.length) + lap) % trips.length];
  const delay = -((now + offset) % dur);
  return { ...t, timing: `--od-d:${dur}s;--od-dl:${delay.toFixed(2)}s`, key: `${salt}-${pick(x.conversation || x.name, 1e9)}` };
}

function walker(x, t) {
  return h("span", { class: "od-walker", "aria-hidden": "true", "data-from": `[data-walk="${t.key}"]`, "data-spot": t.spot, style: t.timing }, [h("b", { class: "od-say", text: tr(t.say) }), otter(x, t.mood, t.prop, "mid")]);
}

function sitStill(sprite, t) {
  sprite.classList.add("walks");
  sprite.dataset.walk = t.key;
  sprite.setAttribute("style", `${sprite.getAttribute("style") || ""};${t.timing}`);
}

function officeWall() {
  return h("span", { class: "ow-wall", "aria-hidden": "true" }, [
    h("span", { class: "ow-window" }),
    h("span", { class: "ow-board" }, [h("i"), h("i"), h("i"), h("b")]),
    h("span", { class: "ow-shelf" }, [h("i"), h("i"), h("i")]),
    h("span", { class: "ow-art" }),
  ]);
}

function deskFurniture(on) {
  return [h("span", { class: "od-chair" }), h("span", { class: "od-top" }, [h("span", { class: `od-monitor${on ? "" : " off"}` }, on ? [h("i"), h("i"), h("i")] : []), h("i", { class: "od-keys" }), h("i", { class: "od-mug" })]), h("span", { class: "od-front" })];
}

function placeWalkers(room) {
  if (!room.isConnected) return;
  const box = room.getBoundingClientRect();
  room.querySelectorAll(".od-walker").forEach((w) => {
    const from = room.querySelector(w.dataset.from);
    const spot = room.querySelector(w.dataset.spot);
    if (!from || !spot) return;
    const f = from.getBoundingClientRect();
    const t = spot.getBoundingClientRect();
    const wall = spot.closest(".ow-wall, .rb-wall");
    const ty = wall ? wall.getBoundingClientRect().bottom + 6 : t.bottom - 4;
    w.style.setProperty("--dx", `${f.left + f.width / 2 - box.left}px`);
    w.style.setProperty("--dy", `${box.bottom - f.bottom}px`);
    w.style.setProperty("--tx", `${t.left + t.width / 2 - box.left}px`);
    w.style.setProperty("--ty", `${Math.max(4, box.bottom - ty)}px`);
  });
}

function officeRoom(list) {
  const walkers = [];
  const desks = list.length
    ? list.map(({ x, id }) => {
        const sit = otter(x, id === "blocked" ? "blocked" : "typing", null, `mid od-seated ${id === "blocked" ? waitClass(x.reason && x.reason.at) : ""}`.trim());
        if (id === "working") {
          const t = trip(x, OFFICE_TRIPS, "office");
          sitStill(sit, t);
          walkers.push(walker(x, t));
        }
        const helpers = x.subagents ? h("span", { class: "helpers" }, Array.from({ length: Math.min(x.subagents, 3) }, () => paint(nutria("working", "tiny"), x.name))) : null;
        const [chair, top, front] = deskFurniture(true);
        return h("button", {
          class: `od-desk ${id}`,
          type: "button",
          "data-conv": x.conversation,
          title: x.since ? tr("{name}: {mood} desde {time}. Pulsa para verla en directo.", { name: x.name, mood: MOOD_TEXT[id], time: when(x.since) }) : tr("{name}: {mood}. Pulsa para verla en directo.", { name: x.name, mood: MOOD_TEXT[id] }),
          onclick: () => openLive(x.conversation, x.sessionName || x.name),
        }, [chair, sit, top, front, helpers, h("span", { class: "plate small" }, [h("strong", { text: x.name }), deskLine(x, id), mixedProjects() && x.project ? h("span", { class: "plate-project", text: projectName(x.project) }) : null])]);
      })
    : [0, 1, 2].map(() => h("span", { class: "od-desk empty" }, deskFurniture(false)));
  const room = h("div", { class: "office-room" }, [
    officeWall(),
    h("span", { class: "ow-printer", "aria-hidden": "true" }, [h("i"), h("b")]),
    h("span", { class: "ow-cabinet", "aria-hidden": "true" }, [h("i"), h("i"), h("i")]),
    h("div", { class: "ow-floor" }, [
      h("div", { class: "od-grid" }, desks),
      h("span", { class: "ow-kitchen", "aria-hidden": "true" }, [h("span", { class: "ow-cooler" }, [h("i")]), h("span", { class: "ow-counter" }, [h("span", { class: "ow-coffee" }, [h("i")]), h("i", { class: "ow-cups" })]), h("span", { class: "ow-plant" }, [h("i"), h("i"), h("i")])]),
    ]),
    ...walkers,
  ]);
  if (walkers.length) requestAnimationFrame(() => placeWalkers(room));
  return room;
}


const REST = [
  (x) => [h("i", { class: "sofa-back" }), otter(x, "free"), sofaFront()],
  (x) => [h("span", { class: "hammock" }, [h("i", { class: "post left" }), h("i", { class: "post right" })]), h("span", { class: "swing" }, [otter(x, "free"), h("i", { class: "cloth" })])],
  (x) => [h("span", { class: "beanbag" }), otter(x, "idle", "book")],
  (x) => [h("span", { class: "pool" }), otter(x, "relax", null, "floating"), h("span", { class: "pool-front" }), h("span", { class: "float-ring" })],
  (x) => [otter(x, "idle", "controller"), h("span", { class: "tv" }, [h("i")])],
];

const PAIRS = [
  (a, b) => ({ cls: "coffee", left: [otter(a, "idle", "mug"), h("b", { class: "say one", text: "…" })], middle: h("span", { class: "coffee-table" }), right: [otter(b, "idle", "mug", "mirror"), h("b", { class: "say two", text: tr("jaja") })] }),
  (a, b) => ({ cls: "pingpong", left: [otter(a, "idle", "paddle")], middle: h("span", { class: "pp-table" }, [h("i", { class: "net" }), h("i", { class: "ball" })]), right: [otter(b, "idle", "paddle", "mirror")] }),
  (a, b) => ({ cls: "chess", left: [otter(a, "idle"), h("b", { class: "say one", text: "?" })], middle: h("span", { class: "chess-table" }), right: [otter(b, "idle", null, "mirror")] }),
];

function restRoom(list) {
  const scenes = restScenes(list);
  const walkers = [];
  const box = h("div", { class: `rest-room${list.length ? "" : " is-empty"}` }, [
    h("span", { class: "rb-wall", "aria-hidden": "true" }, [h("span", { class: "rb-window" }), h("span", { class: "rb-fridge" }, [h("i")]), h("span", { class: "rb-vending" }, [h("i"), h("i"), h("i")]), h("span", { class: "rb-cooler" }, [h("i")]), h("span", { class: "rb-arcade" }, [h("i")])]),
    h("div", { class: "rest-floor" }, list.length ? scenes : [emptyLounge()]),
  ]);
  for (const { x } of list) {
    const seat = box.querySelector(`.seat[data-conv="${CSS.escape(x.conversation || "")}"] .nutria`);
    if (!seat || !x.conversation) continue;
    const t = trip(x, REST_TRIPS, "rest");
    sitStill(seat, t);
    walkers.push(walker(x, t));
  }
  box.append(...walkers);
  if (walkers.length) requestAnimationFrame(() => placeWalkers(box));
  return box;
}

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

function permButtons(p) {
  const yes = h("button", { class: "perm-mini yes", type: "button", title: tr("Permitir: {what}", { what: p.label }), "aria-label": tr("Permitir: {what}", { what: p.label }), text: "✓" });
  const no = h("button", { class: "perm-mini no", type: "button", title: tr("Denegar: {what}", { what: p.label }), "aria-label": tr("Denegar: {what}", { what: p.label }), text: "✕" });
  yes.addEventListener("click", () => decide(p, "allow", yes));
  no.addEventListener("click", () => decide(p, "deny", no));
  return h("span", { class: "perm-minis" }, [yes, no]);
}

function askedFor(p) {
  if (!p.native) return p.label;
  const body = String(p.detail || "").split(/Do you want/i)[0].replace(/^\s*(Bash command|Edit file|Write file|Read file|Fetch|Tool use)\s*/i, "");
  return body.replace(/\s+/g, " ").trim() || p.label;
}

function permPeeks(perms) {
  if (!perms.length) return null;
  return h("span", { class: "perm-peeks" }, perms.slice(0, 3).map((p) => h("span", { class: "perm-peek", title: askedFor(p) }, [h("strong", { text: p.areaName || tr("Una sesión") }), h("code", { text: askedFor(p) })])));
}

function queue(items) {
  const shown = items.slice(0, 5);
  return h("span", { class: "queue" }, [
    ...shown.map((x) => {
      const who = paint(nutria(x.mood || "waiting", "mid"), x.label);
      if (waitClass(x.at)) who.classList.add(waitClass(x.at));
      const late = waited(x.at) >= 5 ? h("span", { class: `wait-min ${waitClass(x.at)}`, text: waitLabel(x.at) }) : null;
      return h("span", { class: "queuer", title: waitLabel(x.at) ? tr("{what} · lleva {time}", { what: x.title, time: waitLabel(x.at) }) : x.title }, [h("span", { class: "sign", text: x.label }), who, late, x.permission ? permButtons(x.permission) : null]);
    }),
    items.length > shown.length ? h("span", { class: "queue-more", text: `+${items.length - shown.length}` }) : null,
  ]);
}

function liveButton(x) {
  if (!x.conversation) return null;
  return h("button", { class: "btn link", type: "button", text: tr("Ver en directo"), onclick: () => openLive(x.conversation, x.sessionName || x.name) });
}

function shortcuts() {
  const count = (statuses) => state.tasks.filter((t) => statuses.includes(t.status)).length;
  const perms = ((state.permissions && state.permissions.pending) || []).length;
  const data = [
    ["pending", tr("Pendientes"), count(["pending"])],
    ["waiting", tr("Te esperan"), count(["waiting", "partial"]) + perms],
    ["sent", tr("En curso"), count(["sent"])],
    ["done", tr("Hechas"), count(["done"])],
  ];
  return h("div", { class: "shortcuts" }, data.map(([id, label, n]) => h("button", { type: "button", class: `shortcut${n ? " filled" : ""}${id === "waiting" && n ? " urgent" : ""}`, onclick: () => switchView(id) }, [h("strong", { text: String(n) }), h("span", { text: label })])));
}

function sessionCard(x, group) {
  const kids = [h("div", { class: "top" }, [h("span", { class: `dot ${DOTS[group]}` }), h("strong", { class: "session-title", text: x.name }), h("span", { class: "time", text: x.since ? tr("desde {time}", { time: when(x.since) }) : "" })])];
  if (x.reason) {
    const task = x.reason.task;
    const late = waitLabel(x.reason.at);
    kids.push(h("div", { class: "reason" }, [h("b", { text: x.reason.text + (task ? " " : "") }), task ? h("button", { class: "task-link", type: "button", text: task.key, title: task.title, onclick: () => switchView(x.reason.view) }) : null, late ? h("span", { class: `wait-min ${waitClass(x.reason.at)}`, text: late }) : null]));
  }
  if (x.subagents) kids.push(h("div", { class: "meta", text: x.subagents === 1 ? tr("Con un ayudante en marcha") : tr("Con {n} ayudantes en marcha", { n: x.subagents }) }));
  const others = x.tasks.filter((task) => !x.reason || task !== x.reason.task);
  if (others.length) kids.push(h("div", { class: "meta", text: tr("Con {keys}", { keys: others.map((task) => task.key).join(", ") }) }));
  const where = mixedProjects() && x.project ? h("span", { class: "chip session-project", text: projectName(x.project) }) : null;
  kids.push(h("div", { class: "home-footer" }, [h("span", { class: "home-footer-who" }, [where]), liveButton(x)]));
  return h("article", { class: `card home-session ${group}` }, kids);
}

function sessionStrip(s) {
  const total = s.working.length + s.blocked.length + s.free.length;
  if (!total) return null;
  const parts = [
    ["working", tr("{n} trabajando", { n: s.working.length })],
    ["blocked", plural(s.blocked.length, "bloqueada", "bloqueadas")],
    ["free", plural(s.free.length, "libre", "libres")],
  ].filter(([id]) => s[id].length);
  const summary = h("summary", { class: "strip-summary" }, [h("span", { class: "strip-title", text: tr("Sesiones abiertas:") }), ...parts.flatMap(([id, label], i) => [i ? " · " : null, h("span", { class: "strip-part" }, [h("span", { class: `dot ${DOTS[id]}` }), ` ${label}`])]).filter(Boolean)]);
  const row = (x, id) => {
    const why = x.reason ? `${x.reason.text}${x.reason.task ? " " + x.reason.task.key : ""}${waitLabel(x.reason.at) ? " · " + waitLabel(x.reason.at) : ""}` : x.tasks.map((task) => task.key).join(", ");
    return h("button", { class: "strip-row", type: "button", onclick: () => openLive(x.conversation, x.sessionName || x.name) }, [h("span", { class: `dot ${DOTS[id]}` }), h("span", { class: "strip-name", text: x.name }), why ? h("span", { class: "meta", text: why }) : null]);
  };
  const det = h("details", { class: "session-strip" }, [summary, h("div", { class: "strip-list" }, BOARD.flatMap((id) => s[id].map((x) => row(x, id))))]);
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

function renderColumns(root) {
  const s = sessionSituation();
  root.appendChild(shortcuts());
  const perms = (state.permissions && state.permissions.pending) || [];
  if (perms.length) root.appendChild(h("div", { class: "perm-peeks columns" }, perms.map((p) => h("span", { class: "perm-peek", title: askedFor(p) }, [h("strong", { text: p.areaName || tr("Una sesión") }), h("code", { text: askedFor(p) }), waitLabel(p.at) ? h("span", { class: `wait-min ${waitClass(p.at)}`, text: waitLabel(p.at) }) : null, permButtons(p)]))));
  if (window.matchMedia("(max-width: 760px)").matches) {
    const strip = sessionStrip(s);
    if (strip) root.appendChild(strip);
    return;
  }
  const columns = BOARD.map((id) => {
    const [, title, note] = GROUPS.find((g) => g[0] === id);
    const head = h("div", { class: "board-head", title: note }, [h("span", { class: `dot ${DOTS[id]}` }), h("span", { text: title }), h("span", { class: "n", text: String(s[id].length) })]);
    const cards = s[id].length ? s[id].map((x) => sessionCard(x, id)) : [h("div", { class: "board-empty", text: tr("Ninguna") })];
    return h("section", { class: "board-col" }, [head, ...cards]);
  });
  root.appendChild(h("div", { class: "board" }, columns));
  if (s.system.length)
    root.appendChild(
      h("div", { class: "system-chips" }, [
        h("span", { class: "meta", text: tr("Del tablero") }),
        ...s.system.map((x) => h("button", { class: "system-chip", type: "button", title: x.working ? tr("Trabajando") : x.open ? tr("Abierta") : tr("Cerrada"), onclick: () => openLive(x.conversation, x.session) }, [h("span", { class: `dot ${x.working ? "busy" : x.open ? "on" : ""}` }), x.label])),
      ])
    );
}

export function renderHome(root) {
  if (homeLayout() === "columns") return renderColumns(root);
  const s = sessionSituation();
  const count = (st) => state.tasks.filter((t) => st.includes(t.status));
  const waiting = count(["waiting", "partial"]);
  const perms = (state.permissions && state.permissions.pending) || [];
  const pending = count(["pending"]);
  const sent = count(["sent"]).length;
  const done = count(["done"]).length;
  const atDesk = [...s.working.map((x) => ({ x, id: "working" })), ...s.blocked.map((x) => ({ x, id: "blocked" }))];
  const resting = s.free.map((x) => ({ x, id: "free" }));

  const plan = h("div", { class: `office-plan${resting.length >= 2 ? " wide-rest" : ""}${atDesk.length > 6 ? " crowded" : ""}${state.workHours === false && !(state.config && state.config.overtime) ? " lights-off" : ""}` });

  const yours = [...perms.map((p) => ({ label: p.areaName || tr("Permiso"), title: tr("{who} quiere: {what}", { who: p.areaName || tr("Una sesión"), what: p.label }), mood: "blocked", permission: p, at: p.at })), ...waiting.map((t) => ({ label: t.key, title: `${t.status === "partial" ? tr("A medias") : tr("Te espera")}: ${t.title}`, mood: t.status === "partial" ? "blocked" : "waiting", at: (t.notice && t.notice.at) || t.sentAt }))];
  const yourN = yours.length;
  plan.append(
    room(`desk${yourN ? "" : " is-empty"}`, "Tu mesa", yourN ? plural(yourN, "cosa te espera", "cosas te esperan") : tr("Nadie te espera"), [yourN ? queue(yours) : h("span", { class: "calm" }, [h("span", { class: "chair pushed" })]), h("span", { class: "big-desk" }, yourN ? [] : [deskItems()]), permPeeks(perms)], { decor: [windowDecor(), plant()], onclick: () => switchView("waiting"), title: tr("Ver lo que te espera"), nested: perms.length > 0 }),
    room("inbox", "Bandeja de entrada", pending.length ? plural(pending.length, "pendiente", "pendientes") : tr("Vacía"), [h("span", { class: "inbox-scene" }, [pending.length ? paint(nutria("pending", "mid"), "bandeja") : null, inboxPile(pending.length)]), h("strong", { class: "big-n", text: String(pending.length) })], { decor: [poster("IN")], onclick: () => switchView("pending"), title: tr("Ver las pendientes") }),
    room(`work${atDesk.length ? "" : " is-empty"}`, "Sala de trabajo", `${atDesk.length ? plural(atDesk.length, "sesión", "sesiones") : tr("Vacía")} · ${plural(sent, "tarea en curso", "tareas en curso")}`, [officeRoom(atDesk)], { decor: [clockDecor(), plant()] }),
    room(`sofa${resting.length ? "" : " is-empty"}`, "Sala de descanso", resting.length ? plural(resting.length, "libre", "libres") : tr("Vacía"), [restRoom(resting.length ? resting : [])], { decor: [h("span", { class: "lamp" })] }),
    room("archive", "Archivo", done ? plural(done, "hecha", "hechas") : tr("Nada archivado"), [h("span", { class: "archive-scene" }, [shelf(done), done ? paint(nutria("done", "mid"), "archivo") : lonelyBox()]), h("strong", { class: "big-n", text: String(done) })], { decor: [poster("✓")], onclick: () => switchView("done"), title: tr("Ver las hechas") }),
  );
  if (s.system.length) {
    plan.append(
      room("control", "Sala de control", plural(s.system.filter((x) => x.open).length, "abierta", "abiertas"), s.system.map((x) => {
        const mood = x.working ? "working" : x.open ? "free" : "closed";
        return h("button", { class: `console ${mood}`, type: "button", title: tr("{name}: {mood}. Pulsa para verla en directo.", { name: x.label, mood: x.working ? tr("trabajando") : x.open ? tr("abierta") : tr("cerrada") }), onclick: () => openLive(x.conversation, x.session) }, [h("span", { class: "screen-wall" }), paint(nutria(mood, "mid"), x.name), h("span", { class: "plate small" }, [h("strong", { text: x.label })])]);
      }), { decor: [h("span", { class: "radar" })] })
    );
  }
  root.appendChild(h("div", { class: "office" }, [plan]));
}

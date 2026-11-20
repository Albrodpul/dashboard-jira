import { nutria } from "../components/nutria.js";
import { t, LOCALE } from "./i18n.js";
export const state = { tasks: [], areas: [], sessions: { list: [], syncedAt: null }, aliases: {}, reporterRoute: null, epics: [], tab: "home", ok: true };
export const choice = {};
export const drafts = {};
const setup = () => state.jiraSetup || { jiraUrl: "", projects: [], reviewer: { name: t("el revisor") }, reviewStatus: "en revisión", deployProjects: [] };
export const isManualKey = (key) => (state.allTasks || state.tasks || []).some((x) => x.key === key && x.source === "manual");
// Each ticket links to its own Jira: the site whose project keys hold its prefix, else the main one.
const siteUrl = (key) => {
  const prefix = String(key).split("-")[0];
  const site = (setup().jiraSites || []).find((s) => s.projects.includes(prefix));
  return site ? site.url : setup().jiraUrl;
};
export const ticketUrl = (key) => (isManualKey(key) ? "" : siteUrl(key) + key);
export const reviewer = () => setup().reviewer.name;
export const reviewStatus = () => setup().reviewStatus;
export const deployProjects = () => setup().deployProjects || [];
export const exampleKey = () => `${setup().projects[0] || "ABC"}-123`;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const myName = () => (setup().me && setup().me.name) || "";
const projectsRegex = () => setup().projects.map((p) => p.replace(/[^A-Za-z0-9]/g, "")).join("|") || "NOPROJECT";

let painter = () => {};
let refresher = () => Promise.resolve();
export const setRender = (fn) => (painter = fn);
export const setRefresh = (fn) => (refresher = fn);
export const render = () => painter();
export const refresh = (force) => refresher(force);

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  if (tag === "textarea" || (tag === "input" && ["text", "search"].includes(attrs.type || "text"))) {
    for (const [k, v] of [["autocorrect", "off"], ["autocapitalize", "off"], ["spellcheck", "false"]]) if (!el.hasAttribute(k)) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

export function button(label, { cls = "", title, onClick, disabled = false } = {}) {
  const b = h("button", { class: `btn${cls ? " " + cls : ""}`, type: "button", text: label, title, disabled });
  if (onClick) b.addEventListener("click", () => onClick(b));
  return b;
}

const fmtTime = new Intl.DateTimeFormat(LOCALE, { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false });
export const fmtDay = new Intl.DateTimeFormat(LOCALE, { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit" });

export function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const today = fmtDay.format(new Date()) === fmtDay.format(d);
  return (today ? "" : fmtDay.format(d) + " ") + fmtTime.format(d);
}

export const minutesSince = (iso) => Math.round((Date.now() - new Date(iso).getTime()) / 60000);

let toastTimer;
export function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

export const request = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

export async function requestOrFail(url, body) {
  const r = await request(url, body);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}

export function post(url, body, okMsg) {
  return request(url, body)
    .then(async (r) => {
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "");
      }
      if (okMsg) toast(okMsg);
      return refresh(true);
    })
    .catch((e) => {
      toast(e && e.message ? t("No se pudo: {error}", { error: e.message }) : t("No se pudo guardar. Inténtalo de nuevo."));
      refresh(true);
    });
}

export const saveTask = (task, patch, okMsg) => post("/api/task", { key: task.id, patch }, okMsg);

export function whoSends(capitalize) {
  return capitalize ? t("El tablero") : t("el tablero");
}

const activeLimits = () => (state.restrictions || []).filter((r) => !r.releasedAt && (!r.until || Date.now() < Date.parse(r.until)));

export function limitsFor(task, area) {
  const target = { key: task.key, epicKey: task.epicKey || null, area: area || task.area || task.proposedArea || null };
  return activeLimits().filter((r) => (target.key && r.scope.tasks.includes(target.key)) || (target.epicKey && r.scope.epics.includes(target.epicKey)) || (target.area && r.scope.areas.includes(target.area)));
}

export const holdOf = (task, area) => limitsFor(task, area).find((r) => r.mode === "hold") || null;

export function limitChips(task, area) {
  return limitsFor(task, area).map((r) => h("span", { class: `chip limit limit-${r.mode}`, title: r.chip.title, text: r.chip.text }));
}

export function areaName(id) {
  const a = state.areas.find((x) => x.id === id);
  return a ? a.name : id;
}

export const targetLabel = (a) => (a.open || !a.sessionName ? a.name : t("{name} (cerrada)", { name: a.name }));

export function areaSelectFrom(list, id, current, emptyLabel, onChange) {
  const sel = h("select", { id, onchange: (e) => onChange(e.target.value) });
  sel.appendChild(h("option", { value: "", text: emptyLabel }));
  [...list]
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
    .forEach((a) => {
      const o = h("option", { value: a.id, text: targetLabel(a) });
      if (a.id === current) o.selected = true;
      sel.appendChild(o);
    });
  return sel;
}

export const areaSelect = (id, current, emptyLabel, onChange) => areaSelectFrom(state.areas.filter((a) => !a.unnamed), id, current, emptyLabel, onChange);

export const fixedAreaIds = () => new Set([state.deployerArea, state.sentry && state.sentry.errorsArea].filter(Boolean));

export const taskAreaSelect = (id, current, emptyLabel, onChange, project) => areaSelectFrom(state.areas.filter((a) => !a.unnamed && !fixedAreaIds().has(a.id) && (!project || !a.project || a.project === project)), id, current, emptyLabel, onChange);

export function switchView(tab, toTop) {
  state.tab = tab;
  try {
    localStorage.setItem("board-tab", tab);
  } catch (e) {}
  if (toTop) window.scrollTo(0, 0);
  render();
}

let ticketOpener = null;
export const setTicketOpener = (fn) => (ticketOpener = fn);
export const openTicket = (key) => {
  document.dispatchEvent(new Event("ticket-open"));
  return ticketOpener && ticketOpener(key);
};

export function ticketLink(key, cls = "ticket-link") {
  return h("a", {
    class: cls,
    href: ticketUrl(key) || "#",
    target: ticketUrl(key) ? "_blank" : null,
    rel: "noopener noreferrer",
    title: ticketUrl(key) ? t("Ver el detalle en el tablero (Ctrl+clic: abrir en Jira)") : t("Ver el detalle en el tablero (tarea sin Jira)"),
    text: key,
    onclick: (e) => {
      if (!ticketOpener || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      ticketOpener(key);
    },
  });
}

export function inline(text) {
  const out = [];
  const key = new RegExp(`^(?:${projectsRegex()})-\\d+$`);
  const pieces = new RegExp(`(\\*\\*[^*]+\\*\\*|\`[^\`]+\`|\\b(?:${projectsRegex()})-\\d+\\b)`);
  for (const p of String(text).split(pieces)) {
    if (!p) continue;
    if (p.startsWith("**") && p.endsWith("**")) out.push(h("strong", { text: p.slice(2, -2) }));
    else if (p.startsWith("`") && p.endsWith("`")) out.push(h("code", { text: p.slice(1, -1) }));
    else if (key.test(p)) out.push(ticketLink(p));
    else out.push(p);
  }
  return out;
}

export function renderMd(text) {
  const box = h("div", { class: "report-text" });
  const me = myName();
  const mine = me ? new RegExp(`asignada a ${escapeRegex(me)}`, "i") : null;
  let list = null;
  let table = null;
  let first = true;
  for (const line of String(text).split("\n")) {
    const m = /^\s*[-*] (.*)$/.exec(line);
    if (m) {
      const parts = m[1].split(" · ");
      if (/^\d{1,2}:\d{2}$/.test(parts[0]) && parts.length > 1) {
        list = null;
        if (!table) {
          table = h("tbody");
          const head = h("thead", {}, [h("tr", {}, [h("th", { scope: "col", text: t("Hora") }), h("th", { scope: "col", text: t("Ticket") }), h("th", { scope: "col", text: t("Qué ha pasado") })])]);
          box.appendChild(h("table", {}, [head, table]));
        }
        const withTicket = parts.length > 2 && new RegExp(`(?:${projectsRegex()})-\\d+`).test(parts[1]);
        table.appendChild(
          h("tr", { class: mine && mine.test(m[1]) ? "mine" : "" }, [
            h("td", { class: "hour", text: parts[0] }),
            h("td", { class: "tickets" }, withTicket ? inline(parts[1]) : []),
            h("td", {}, inline(parts.slice(withTicket ? 2 : 1).join(" · "))),
          ])
        );
        continue;
      }
      table = null;
      if (!list) {
        list = h("ul");
        box.appendChild(list);
      }
      list.appendChild(h("li", {}, inline(m[1])));
      continue;
    }
    list = null;
    table = null;
    if (!line.trim()) continue;
    const heading = /^\*\*([^*]+)\*\*$/.exec(line.trim());
    if (heading && first) box.appendChild(h("h3", {}, inline(heading[1])));
    else if (heading) {
      const ses = /^(.*?)\s*\((sesión: [^)]*|sin sesión)\)\s*$/i.exec(heading[1]);
      box.appendChild(h("h4", {}, ses ? [...inline(ses[1]), h("span", { class: "session-tag" + (/^sin/i.test(ses[2]) ? " none" : ""), text: ses[2].replace(/^sesión: /i, "") })] : inline(heading[1])));
    } else box.appendChild(h("p", {}, inline(line)));
    first = false;
  }
  return box;
}

export function empty(title, text, mood = "free") {
  return h("div", { class: "empty" }, [nutria(mood, "empty-who"), h("strong", { text: title }), h("span", { text })]);
}

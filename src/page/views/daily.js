import { state, h, when, button, post, toast } from "../lib/base.js";

let asked = {};

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

const fmt = (day) => (day ? new Date(`${day}T12:00:00`).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }) : "");

function dayCard({ title, day, entry, today }) {
  const d = state.daily || {};
  const busy = asked[day] && (!entry || entry.at < asked[day]);
  const ask = () => {
    asked[day] = new Date().toISOString();
    post("/api/daily", { today }, today ? "Redactando el de hoy…" : "Rehaciendo el resumen…");
  };
  const actions = [];
  if (entry && entry.text) actions.push(button("Copiar", { onClick: () => copyDaily(entry.text) }));
  const label = busy || (d.busy && asked[day]) ? "Redactando…" : today ? (entry && entry.text ? "Redactar de nuevo" : "Redactarlo") : "Rehacer";
  actions.push(button(label, { cls: entry && entry.text ? "subtle" : today ? "primary" : "subtle", disabled: !!busy, title: "Lo escribe Claude: gasta un poco de cuota", onClick: ask }));
  const kids = [h("div", { class: "daily-head" }, [h("div", {}, [h("h3", { text: title }), h("span", { class: "meta", text: fmt(day) })]), h("div", { class: "actions" }, actions)])];
  if (entry && entry.text) {
    kids.push(dailyBody(entry.text));
    kids.push(h("p", { class: "meta daily-at", text: `Redactado a las ${when(entry.at)}` }));
  } else if (entry && entry.empty) kids.push(h("p", { class: "daily-text", text: "Ese día no hay movimiento en Jira, commits ni despliegues tuyos." }));
  else if (!today) kids.push(h("p", { class: "daily-text meta", text: "Se prepara solo cada mañana con lo del último día laborable." }));
  if (today) kids.push(factsBlock(d.facts, !!(entry && entry.text)));
  return h("section", { class: `card daily-day${today ? " today" : ""}` }, kids);
}

function factsBlock(f, hasText) {
  const groups = f ? [["Tareas mandadas", f.tasks], ["Commits", f.commits], ["Errores mandados a arreglar", f.errors]].filter(([, l]) => l.length) : [];
  const head = h("div", { class: "facts-head" }, [h("strong", { text: "Lo que llevas hoy" }), h("span", { class: "meta", text: f ? `se actualiza solo, sin gastar cuota · ${when(f.at)}` : "" })]);
  if (!groups.length) return h("div", { class: "facts" }, [head, h("p", { class: "meta", text: "Todavía nada: ni tareas mandadas, ni commits, ni errores." })]);
  return h("div", { class: "facts" }, [head, ...groups.map(([t, l]) => h("div", { class: "facts-group" }, [h("span", { class: "facts-title", text: `${t} (${l.length})` }), h("ul", {}, l.map((x) => h("li", { text: x })))]))]);
}

export function renderDaily(root) {
  const d = state.daily || {};
  root.appendChild(
    h("div", { class: "daily-days" }, [
      dayCard({ title: "Último día laborable", day: d.prevDay, entry: d.prev, today: false }),
      dayCard({ title: "Hoy", day: d.today, entry: d.todayText, today: true }),
    ])
  );
}

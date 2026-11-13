import { state, h, when, button, toast } from "../lib/base.js";
import { currentProject } from "../components/project-filter.js";

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
const LABEL = /^(Qué|Dónde|Cómo|Estado):\s*/;
const labelled = (t) => {
  const m = LABEL.exec(t);
  return m ? [h("strong", { text: `${m[1]}: ` }), t.slice(m[0].length)] : [t];
};
const toNodes = (list) => h("ul", {}, list.map((i) => h("li", {}, [...(i.children.length ? [h("strong", { text: i.text })] : labelled(i.text)), i.children.length ? toNodes(i.children) : null])));

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

function currentDaily() {
  const p = currentProject();
  return (p && state.dailies && state.dailies[p]) || state.daily || {};
}

const fmt = (day) => (day ? new Date(`${day}T12:00:00`).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }) : "");

function dayCard({ title, day, entry, today }) {
  const actions = entry && entry.text ? [button("Copiar", { onClick: () => copyDaily(entry.text) })] : [];
  const kids = [h("div", { class: "daily-head" }, [h("div", {}, [h("h3", { text: title }), h("span", { class: "meta", text: fmt(day) })]), h("div", { class: "actions" }, actions)])];
  if (entry && entry.text) {
    kids.push(dailyBody(entry.text));
    kids.push(h("p", { class: "meta daily-at", text: `Redactado a las ${when(entry.at)}` }));
  } else if (entry && entry.empty) kids.push(h("p", { class: "daily-text", text: "Ese día no hay tareas mandadas, commits ni errores arreglados." }));
  else kids.push(h("p", { class: "daily-text meta", text: today ? `Se redacta solo a las ${draftAt()}.` : `Se redacta solo a las ${draftAt()} de ese día; si no se pudo, a la mañana siguiente.` }));
  return h("section", { class: `card daily-day${today ? " today" : ""}` }, kids);
}

function draftAt() {
  return (state.workSchedule || {}).daily || "17:00";
}

export function renderDaily(root) {
  const d = currentDaily();
  root.appendChild(
    h("div", { class: "daily-days" }, [
      dayCard({ title: "Último día laborable", day: d.prevDay, entry: d.prev, today: false }),
      dayCard({ title: "Hoy", day: d.today, entry: d.todayText, today: true }),
    ])
  );
}

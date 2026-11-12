const { load, mutate, now } = require("../core/data");

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function madrid(ms = Date.now()) {
  const p = Object.fromEntries(CLOCK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: DAY.format(new Date(ms)), min: Number(p.hour) * 60 + Number(p.minute), weekend: ["Sat", "Sun"].includes(p.weekday) };
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function isDue(r, ms = Date.now()) {
  if (!r || r.removed) return false;
  const t = madrid(ms);
  if (t.day < r.from || t.day > r.until || r.lastDay === t.day) return false;
  if (r.weekdays && t.weekend) return false;
  return t.min >= toMin(r.time);
}

function add({ area, text, time, from, until, weekdays }) {
  const clean = String(text || "").trim().slice(0, 4000);
  if (!clean) return { error: "escribe el aviso" };
  if (!TIME.test(String(time || ""))) return { error: "la hora va como HH:MM" };
  const today = madrid().day;
  from = from || today;
  if (!DATE.test(from) || !DATE.test(String(until || ""))) return { error: "las fechas van como AAAA-MM-DD" };
  if (until < from) return { error: "el último día va antes del primero" };
  const state = require("../server/state").state();
  const a = state.areas.find((x) => x.id === area);
  if (!a) return { error: "sesión desconocida" };
  const at = now();
  const r = { id: "rem-" + at.replace(/\D/g, "").slice(0, 17), area, text: clean, time, from, until, weekdays: !!weekdays, createdAt: at };
  if (from === today && madrid().min >= toMin(time)) r.lastDay = today;
  mutate((d) => d.reminders.push(r));
  require("./mailman").kick();
  return { reminder: r };
}

function remove(id) {
  return mutate((d) => {
    const r = d.reminders.find((x) => x.id === id);
    if (!r) return "aviso desconocido";
    d.reminders = d.reminders.filter((x) => x.id !== id);
    return "";
  });
}

const forPage = (d = load()) => (d.reminders || []).filter((r) => r.until >= madrid().day).map((r) => ({ ...r, delivery: r.delivery || null }));

module.exports = { madrid, isDue, add, remove, forPage };

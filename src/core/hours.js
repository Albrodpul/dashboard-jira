const { load, mutate } = require("./data");

const madrid = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

function clock(d = new Date()) {
  const p = Object.fromEntries(madrid.formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, weekend: ["Sat", "Sun"].includes(p.weekday), hour: Number(p.hour), minute: Number(p.minute), min: Number(p.hour) * 60 + Number(p.minute) };
}

const DEFAULT = { start: "07:30", end: "18:30" };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function schedule() {
  const s = (load().config || {}).workSchedule || {};
  const start = HHMM.test(s.start || "") ? s.start : DEFAULT.start;
  const end = HHMM.test(s.end || "") ? s.end : DEFAULT.end;
  return toMin(end) > toMin(start) ? { start, end } : { ...DEFAULT };
}

function setSchedule({ start, end }) {
  const next = { ...schedule(), ...(start ? { start } : {}), ...(end ? { end } : {}) };
  if (!HHMM.test(next.start) || !HHMM.test(next.end)) return { error: "hora no válida (HH:MM)" };
  if (toMin(next.end) - toMin(next.start) < 60) return { error: "la jornada tiene que durar al menos una hora" };
  mutate((d) => {
    d.config = d.config || {};
    d.config.workSchedule = next;
  });
  return { schedule: schedule() };
}

const startMin = () => toMin(schedule().start);
const endMin = () => toMin(schedule().end);
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
const workHours = (t = clock()) => !t.weekend && t.min >= startMin() && t.min < endMin();

function expired(ot, d = new Date()) {
  if (!ot || !ot.since) return false;
  const since = new Date(ot.since);
  if (day.format(since) !== day.format(d)) return true;
  const s = clock(since);
  return !s.weekend && s.min < startMin() && workHours(clock(d));
}

function overtime() {
  const ot = (load().config || {}).overtime || null;
  if (!expired(ot)) return ot;
  let dropped = false;
  mutate((d) => {
    if (d.config && expired(d.config.overtime)) {
      delete d.config.overtime;
      dropped = true;
    }
  });
  if (dropped && !workHours() && require("../cluster/cluster").primaryNow()) setImmediate(() => require("../server/startup").setOvertime(false).catch(() => {}));
  return null;
}

function setOvertime(on) {
  mutate((d) => {
    d.config = d.config || {};
    if (on) d.config.overtime = { since: new Date().toISOString() };
    else delete d.config.overtime;
  });
  return overtime();
}

module.exports = { clock, workHours, overtime, setOvertime, expired, schedule, setSchedule, startMin, endMin, toMin };

const { load, mutate } = require("./data");

const madrid = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const END = 18 * 60 + 30;

function clock(d = new Date()) {
  const p = Object.fromEntries(madrid.formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, weekend: ["Sat", "Sun"].includes(p.weekday), hour: Number(p.hour), minute: Number(p.minute), min: Number(p.hour) * 60 + Number(p.minute) };
}

const START = 7 * 60 + 30;
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
const workHours = (t = clock()) => !t.weekend && t.min >= START && t.min < END;

function expired(ot, d = new Date()) {
  if (!ot || !ot.since || !workHours(clock(d))) return false;
  const since = new Date(ot.since);
  return day.format(since) !== day.format(d) || clock(since).min < START;
}

function overtime() {
  const ot = (load().config || {}).overtime || null;
  if (!expired(ot)) return ot;
  mutate((d) => {
    if (d.config && expired(d.config.overtime)) delete d.config.overtime;
  });
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

module.exports = { clock, workHours, overtime, setOvertime, expired, END };

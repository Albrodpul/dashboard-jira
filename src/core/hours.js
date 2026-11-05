const { load, mutate } = require("./data");

const madrid = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const END = 18 * 60 + 30;

function clock(d = new Date()) {
  const p = Object.fromEntries(madrid.formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, weekend: ["Sat", "Sun"].includes(p.weekday), hour: Number(p.hour), minute: Number(p.minute), min: Number(p.hour) * 60 + Number(p.minute) };
}

const workHours = (t = clock()) => !t.weekend && t.min >= 7 * 60 + 30 && t.min < END;
const overtime = () => (load().config || {}).overtime || null;

function setOvertime(on) {
  mutate((d) => {
    d.config = d.config || {};
    if (on) d.config.overtime = { since: new Date().toISOString() };
    else delete d.config.overtime;
  });
  return overtime();
}

module.exports = { clock, workHours, overtime, setOvertime, END };

const path = require("path");
const cp = require("child_process");
const config = require("../core/config");
const { load, mutate, now } = require("../core/data");
const hours = require("../core/hours");

const ME = config.jira.me.name;
const DOC = ".claude/commands/resumen-jira.md";
const WAIT_MS = 5 * 60000;
const CHECK_MS = 15000;
const madrid = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

const reviewHours = (t = hours.clock()) => !t.weekend && t.min >= hours.startMin() && t.min <= hours.endMin();
const lastOf = (d) => (d.lastReview && d.lastReview.at) || (d.reports && d.reports[0] && d.reports[0].at) || null;
const hhmm = (iso) => new Date(iso).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
const env = () => ({ ...process.env, TOWER_WORKSPACE: config.workspace });

function freshInJira() {
  return new Promise((resolve) => {
    cp.execFile(process.execPath, [path.join(__dirname, "..", "..", "bin", "jira-window.js"), "--check"], { windowsHide: true, timeout: 90000, env: env() }, (err, out) => {
      if (err) return resolve(null);
      try {
        const n = JSON.parse(String(out).trim().split(/\r?\n/).pop()).fresh;
        resolve(Number.isInteger(n) ? n : null);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

function quietReview(label, last) {
  try {
    cp.execFileSync(process.execPath, [path.join(__dirname, "..", "cli.js"), "report", `**Revisión de las ${label}: sin novedades${last ? ` desde las ${hhmm(last)}` : ""}.**`], { windowsHide: true, timeout: 30000, stdio: "ignore", env: env() });
    return true;
  } catch (e) {
    return false;
  }
}

const reviewText = (n) => `Tablero: hay ${n === null ? "cambios por revisar" : n === 1 ? "1 novedad sin contar" : `${n} novedades sin contar`} en Jira. Haz «Cada revisión» de ${DOC} y publica el reporte con «${config.cli} report».`;
const refreshText = () => `Tablero: ${ME} ha pulsado Refrescar. Haz «Cada revisión» de ${DOC} aunque no haya novedades y publica el reporte con «${config.cli} report».`;

let E = null;
function deps() {
  return (
    E || {
      primary: () => require("../cluster/cluster").primaryNow(),
      fresh: freshInJira,
      quiet: quietReview,
      notify: (text) => require("./mailman").notifyRole("reporter", text),
      clock: () => hours.clock(),
      overtime: () => hours.overtime(),
      parts: () => Object.fromEntries(madrid.formatToParts(new Date()).map((x) => [x.type, x.value])),
      ms: () => Date.now(),
    }
  );
}

let lastQuiet = "";
let lastCheck = 0;
let waiting = null;
let running = false;

function refresh() {
  const d = load();
  const p = d.refreshRequest;
  if (!p || p.handled || p.notifiedAt) return false;
  mutate((x) => x.refreshRequest && x.refreshRequest.id === p.id && (x.refreshRequest.notifiedAt = now()));
  deps().notify(refreshText());
  waiting = { last: lastOf(d), at: deps().ms() };
  return true;
}

async function tick() {
  const e = deps();
  if (running || !e.primary()) return;
  if (refresh()) return;
  if (!reviewHours(e.clock()) && !e.overtime()) return;
  const d = load();
  if (d.config && d.config.paused) return;
  const t = e.ms();
  if (t - lastCheck < CHECK_MS) return;
  const last = lastOf(d);
  if (waiting && waiting.last === last && t - waiting.at < WAIT_MS) return;
  waiting = null;
  lastCheck = t;
  running = true;
  try {
    const n = await e.fresh();
    if (n === 0) {
      const p = e.parts();
      const minute = `${p.weekday}${p.hour}${p.minute}`;
      if (minute !== lastQuiet && e.quiet(`${p.hour}:${p.minute}`, last)) lastQuiet = minute;
      return;
    }
    waiting = { last, at: e.ms() };
    e.notify(reviewText(n));
  } finally {
    running = false;
  }
}

const _test = {
  setDeps: (x) => (E = x),
  reset: () => ((lastQuiet = ""), (lastCheck = 0), (waiting = null), (running = false), (E = null)),
};

module.exports = { tick, reviewHours, freshInJira, _test };

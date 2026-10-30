const fs = require("fs");
const path = require("path");
const net = require("net");
const cp = require("child_process");
const config = require("./config");
const { DATA_DIR, load, mutate, now } = require("./data");

const LOG_DIR = path.join(DATA_DIR, "devservers");
const STOP_AT = { hour: 18, minute: 30 };
const STOP_WINDOW_MIN = 10;
const madrid = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const starting = new Map();

const servers = () => config.devServers || [];
const find = (id) => servers().find((s) => s.id === id);

function madridNow(date = new Date()) {
  const p = Object.fromEntries(madrid.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(800, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const { listeningPids, killTree: kill } = require("./platform");

const logFile = (id) => path.join(LOG_DIR, `${id}.log`);

async function status() {
  const out = [];
  for (const s of servers()) {
    const up = await portOpen(s.port);
    const st = starting.get(s.id);
    out.push({ id: s.id, name: s.name, port: s.port, url: s.url || null, autoStart: s.autoStart !== false, state: up ? "up" : st && Date.now() - st < (s.startSeconds || 90) * 1000 ? "starting" : "down" });
  }
  const d = load().devServers || {};
  return { servers: out, autoStartedOn: d.autoStartedOn || null, autoStoppedOn: d.autoStoppedOn || null, at: now() };
}

async function start(id) {
  const s = find(id);
  if (!s) throw new Error(`proyecto desconocido: ${id}`);
  if (await portOpen(s.port)) return false;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fd = fs.openSync(logFile(id), "w");
  fs.writeSync(fd, `[${now()}] ${s.command} ${(s.args || []).join(" ")}\n`);
  const cwd = path.resolve(config.root, s.cwd || ".");
  const command = s.command.startsWith(".") ? path.resolve(cwd, s.command) : s.command;
  const child = cp.spawn(command, s.args || [], { cwd, detached: true, windowsHide: true, shell: !!s.shell, stdio: ["ignore", fd, fd] });
  child.on("error", (e) => fs.appendFileSync(logFile(id), `\n${e.message}\n`));
  child.unref();
  fs.closeSync(fd);
  starting.set(id, Date.now());
  return true;
}

async function stop(id) {
  const s = find(id);
  if (!s) throw new Error(`proyecto desconocido: ${id}`);
  starting.delete(id);
  if (s.stop) {
    try {
      cp.execFileSync(s.stop.command, s.stop.args || [], { cwd: path.resolve(config.root, s.cwd || "."), windowsHide: true, stdio: "ignore", timeout: 30000 });
    } catch (e) {}
    for (let i = 0; i < 20 && (await portOpen(s.port)); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await portOpen(s.port))) return true;
  }
  const pids = listeningPids(s.port);
  pids.forEach(kill);
  return pids.length > 0;
}

async function restart(id) {
  await stop(id);
  for (let i = 0; i < 10 && (await portOpen(find(id).port)); i++) await new Promise((r) => setTimeout(r, 500));
  return start(id);
}

async function startAll(auto) {
  const started = [];
  for (const s of servers()) if (!(auto && s.autoStart === false) && (await start(s.id))) started.push(s.id);
  return started;
}

async function stopAll() {
  const stopped = [];
  for (const s of [...servers()].reverse()) if (await stop(s.id)) stopped.push(s.id);
  return stopped;
}

function firstReportToday(d, day) {
  const at = [d.lastReview && d.lastReview.at, d.reports[0] && d.reports[0].at].filter(Boolean);
  return at.some((x) => madridNow(new Date(x)).day === day);
}

async function schedule() {
  if (!servers().length) return;
  const t = madridNow();
  if (["Sat", "Sun"].includes(t.weekday)) return;
  const d = load();
  const ds = d.devServers || {};
  const stopAt = STOP_AT.hour * 60 + STOP_AT.minute;
  if (t.minutes < stopAt && ds.autoStartedOn !== t.day && firstReportToday(d, t.day)) {
    mutate((x) => (x.devServers = { ...(x.devServers || {}), autoStartedOn: t.day }));
    await startAll(true);
  }
  if (t.minutes >= stopAt && t.minutes < stopAt + STOP_WINDOW_MIN && ds.autoStoppedOn !== t.day) {
    mutate((x) => (x.devServers = { ...(x.devServers || {}), autoStoppedOn: t.day }));
    await stopAll();
  }
}

module.exports = { status, start, stop, restart, startAll, stopAll, schedule };

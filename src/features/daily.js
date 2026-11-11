const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const config = require("../core/config");
const { mutate, load, now } = require("../core/data");

const projects = require("../core/projects");
const projectFor = (id) => config.project(id || config.mainProject.id) || config.mainProject;
const isMain = (p) => p.id === config.mainProject.id;
const ZONE = "Europe/Madrid";
const dayOf = (date) => date.toLocaleDateString("sv-SE", { timeZone: ZONE });

function lastWorkday(from = new Date()) {
  const weekday = (d) => new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "short" }).format(d);
  const d = new Date(from);
  do d.setDate(d.getDate() - 1);
  while (["Sat", "Sun"].includes(weekday(d)));
  return dayOf(d);
}


function git(dir, args) {
  try {
    return cp.execFileSync("git", ["-C", dir, ...args], { windowsHide: true, timeout: 20000, encoding: "utf8" }).trim();
  } catch (e) {
    return "";
  }
}

function repos(p) {
  if (!p.root || !fs.existsSync(p.root)) return [];
  if (fs.existsSync(path.join(p.root, ".git")) && !isMain(p)) return [[p.name, p.root]];
  return fs.readdirSync(p.root).map((name) => [name, path.join(p.root, name)]).filter(([, dir]) => fs.existsSync(path.join(dir, ".git")));
}

function commitsOf(day, p = config.mainProject) {
  const out = [];
  for (const [name, dir] of repos(p)) {
    const email = git(dir, ["config", "user.email"]);
    if (!email) continue;
    const log = git(dir, ["log", "--all", "--no-merges", `--author=${email}`, `--since=${day} 00:00`, "--date=short", "--format=%ad|%s"]);
    for (const line of log.split("\n").filter((l) => l.startsWith(`${day}|`))) out.push(`${name}: ${line.slice(day.length + 1)}`);
  }
  return [...new Set(out)];
}

function errorsOf(day, p = config.mainProject) {
  if (!isMain(p)) return [];
  const d = load();
  const on = (iso) => iso && dayOf(new Date(iso)) === day;
  const sentry = Object.values(d.sentry || {})
    .filter((x) => on(x.sentAt) || on(x.closedAt))
    .map((x) => `Sentry: ${String(x.title || "").slice(0, 160)}${x.result ? ` — ${String(x.result).slice(0, 200)}` : ""}`);
  const followUp = (d.followUps || [])
    .flatMap((r) => r.errors || [])
    .filter((e) => on(e.sentAt))
    .map((e) => `Seguimiento: ${String(e.text || "").replace(/\s+/g, " ").slice(0, 200)}`);
  return [...sentry, ...followUp];
}

function write(prompt) {
  return new Promise((resolve) => {
    const sessions = require("../sessions/registry");
    const agent = require("../agents").main();
    const [exe, args] = agent.command(agent.oneShotArgs({ prompt, model: config.sessionModel }));
    const child = cp.execFile(exe, args, { cwd: config.root, env: sessions.cleanEnv(), timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out).trim()));
    if (child.stdin) child.stdin.end();
  });
}

const running = new Map();

function tasksOf(day, p = config.mainProject) {
  const d = load();
  const on = (iso) => iso && dayOf(new Date(iso)) === day;
  const seen = new Map();
  try {
    for (const line of fs.readFileSync(path.join(require("../core/data").DATA_DIR, "task-history.jsonl"), "utf8").split("\n").filter(Boolean)) {
      const t = JSON.parse(line);
      if (on(t.sentAt) && projects.projectOf(t) === p.id) seen.set(t.key, t);
    }
  } catch (e) {}
  for (const t of Object.values(d.tasks || {})) if (on(t.sentAt) && projects.projectOf(t) === p.id) seen.set(t.key, t);
  return [...seen.values()].map((t) => `${t.kind === "returned" ? "Devuelta por el revisor" : "Nueva"}: ${t.title}${t.epicName ? ` (${t.epicName})` : ""}`);
}


function dailyStyle() {
  if (!config.dailyStyle) return "";
  try {
    return fs.readFileSync(config.dailyStyle, "utf8").trim();
  } catch (e) {
    return "";
  }
}

function genericPrompt(p, day, tasks, commits, errors = []) {
  return [
    `Escribe el mensaje que Alberto se manda a sí mismo para la daily del proyecto «${p.name}», sobre lo que hizo el ${day}. Devuelve solo el mensaje.`,
    "Empieza por «Cosas a comentar en la daily:». Frases llanas y coloquiales de España, en primera persona, sin guiones al principio, sin claves de tareas, sin nombres de ficheros, sin emojis ni negritas. Agrupa lo que sea lo mismo y cuenta lo que ahora hace el proyecto, no cómo está hecho por dentro. La longitud depende de lo que haya. No inventes nada que no salga de los datos.",
    "",
    "Tareas que mandó hacer ese día desde el tablero:",
    ...(tasks.length ? tasks : ["(ninguna)"]),
    "",
    "Sus commits de ese día (en inglés y técnicos; cuéntalos como lo contaría él):",
    ...(commits.length ? commits : ["(ninguno)"]),
    ...(errors.length ? ["", "Errores de Sentry o del seguimiento que mandó arreglar ese día:", ...errors] : []),
  ].join("\n");
}

async function makeDaily(day, p = config.mainProject) {
  const commits = commitsOf(day, p);
  const errors = errorsOf(day, p);
  const tasks = tasksOf(day, p);
  if (!commits.length && !errors.length && !tasks.length) {
    saveDaily(day, { day, text: "", empty: true, at: now() }, p);
    return;
  }
  const style = !isMain(p) ? "" : dailyStyle();
  const prompt = !style ? genericPrompt(p, day, tasks, commits, errors) : [
    `Escribe el mensaje que Alberto se manda a sí mismo en Slack para la daily, sobre lo que hizo el ${day}. Devuelve solo el mensaje.`,
    style,
    "",
    "Tareas que mandó hacer ese día desde el tablero:",
    ...(tasks.length ? tasks : ["(ninguna)"]),
    "",
    "Sus commits de ese día por proyecto (en inglés y técnicos; cuéntalos como lo contaría él):",
    ...(commits.length ? commits : ["(ninguno)"]),
    "",
    "Errores de Sentry o del seguimiento que mandó arreglar ese día:",
    ...(errors.length ? errors : ["(ninguno)"]),
  ].join("\n");
  const text = await write(prompt);
  if (text) saveDaily(day, { day, text, at: now() }, p);
}

function saveDaily(day, entry, p = config.mainProject) {
  if (!isMain(p)) {
    mutate((d) => {
      const by = { ...(d.projectDailies || {}) };
      const all = { ...(by[p.id] || {}), [day]: entry };
      for (const k of Object.keys(all).sort().slice(0, -10)) delete all[k];
      by[p.id] = all;
      d.projectDailies = by;
    });
    return;
  }
  mutate((d) => {
    const all = { ...(d.dailies || {}) };
    if (d.daily && d.daily.day && !all[d.daily.day]) all[d.daily.day] = d.daily;
    all[day] = entry;
    for (const k of Object.keys(all).sort().slice(0, -10)) delete all[k];
    d.dailies = all;
    delete d.daily;
  });
}

const today = () => dayOf(new Date());
const factsCache = new Map();

function todayFacts(p) {
  const day = today();
  const c = factsCache.get(p.id);
  if (c && c.day === day && Date.now() - c.t < 5 * 60000) return c.facts;
  let facts;
  try {
    facts = { day, tasks: tasksOf(day, p), commits: commitsOf(day, p), errors: errorsOf(day, p), at: now() };
  } catch (e) {
    facts = { day, tasks: [], commits: [], errors: [], at: now() };
  }
  factsCache.set(p.id, { day, t: Date.now(), facts });
  return facts;
}

function entriesOf(d, p) {
  if (!isMain(p)) return { ...((d.projectDailies || {})[p.id] || {}) };
  const all = { ...(d.dailies || {}) };
  if (d.daily && d.daily.day && !all[d.daily.day]) all[d.daily.day] = d.daily;
  return all;
}

function dailyState(projectId) {
  const p = projectFor(projectId);
  const all = entriesOf(load(), p);
  const prev = lastWorkday();
  return { project: p.id, prevDay: prev, prev: all[prev] || null, today: today(), todayText: all[today()] || null, facts: todayFacts(p), busy: running.has(p.id) };
}

function dailyStates() {
  const out = {};
  for (const p of config.projects) if (p.daily && p.root) out[p.id] = dailyState(p.id);
  return out;
}

const tried = new Map();

function dailyFor(day, auto, projectId) {
  const p = projectFor(projectId);
  const key = `${p.id}|${day}`;
  if (auto && Date.now() - (tried.get(key) || 0) < 60 * 60000) return Promise.resolve();
  tried.set(key, Date.now());
  if (!running.has(p.id)) running.set(p.id, makeDaily(day || lastWorkday(), p).finally(() => running.delete(p.id)));
  return running.get(p.id);
}

const has = (d, day, p) => !!entriesOf(d, p)[day];

async function dailyIfMissing() {
  if (!require("../cluster/cluster").isPrimary()) return;
  for (const p of config.projects) {
    if (!p.daily || !p.root) continue;
    const d = load();
    const t = require("../core/hours").clock();
    if (!t.weekend && t.min >= require("../core/hours").dailyMin() && !has(d, today(), p)) {
      await dailyFor(today(), true, p.id);
      continue;
    }
    const day = lastWorkday();
    if (!has(d, day, p)) await dailyFor(day, true, p.id);
  }
}

module.exports = { dailyFor, dailyIfMissing, lastWorkday, dailyState, dailyStates };

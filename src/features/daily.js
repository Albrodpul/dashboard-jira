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
  const seen = new Set();
  for (const [name, dir] of repos(p)) {
    const email = git(dir, ["config", "user.email"]);
    if (!email) continue;
    const log = git(dir, ["log", "--all", "--no-merges", `--author=${email}`, `--since=${day} 00:00`, "--date=short", "--name-only", "--format=@@%ad|%s"]);
    for (const chunk of log.split("@@").filter(Boolean)) {
      const [head, ...files] = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!head.startsWith(`${day}|`)) continue;
      const subject = head.slice(day.length + 1);
      if (seen.has(name + subject)) continue;
      seen.add(name + subject);
      const dirs = [...new Set(files.filter((f) => !/(^|\/)(lang|locales|i18n)\/|\.lock$|lock\.json$/.test(f)).map((f) => f.split("/").slice(0, 3).join("/")))].slice(0, 8);
      out.push(`${name}: ${subject}${dirs.length ? ` [toca: ${dirs.join(", ")}]` : ""}`);
    }
  }
  return out;
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
  const areas = (require("../sessions/registry").loadRoutes().areas) || {};
  const areaName = (id) => (areas[id] && areas[id].title) || id;
  return [...seen.values()].map((t) => `${t.kind === "returned" ? "Devuelta por el revisor" : "Nueva"}: ${t.title}${t.epicName ? ` (épica: ${t.epicName})` : ""}${t.area ? ` [sesión: ${areaName(t.area)}]` : ""}${t.status === "partial" ? " [a medias]" : ""}`);
}


function dailyPrompt(p, day, tasks, commits, errors) {
  const date = new Date(`${day}T12:00:00`).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  return [
    `Redacta el resumen de la daily del proyecto «${p.name}» con lo que se hizo el ${date}. Devuelve solo el resumen, en texto plano: sin markdown, sin #, sin asteriscos, sin guiones ni viñetas.`,
    "El objetivo es que se entienda de un vistazo qué se hizo, dónde y cómo, sin mezclar áreas.",
    "",
    "Formato exacto:",
    `Primera línea: «Resumen del ${date}». Después una línea en blanco.`,
    "Luego un bloque por área del producto (por ejemplo «Login y verificación del teléfono», «Wallet de entradas», «Pagos de reservas»), separados por una línea en blanco. Cada bloque es:",
    "<Nombre del área>:",
    "Qué: lo que cambia para quien usa el producto, en una o dos frases; si son varias cosas, sepáralas con punto y coma.",
    "Dónde: las aplicaciones (Web, Backoffice, Back, Donatella, App) y la pantalla o el flujo cuando se sepa.",
    "Cómo: en una frase, la solución técnica a grandes rasgos, sin nombres de ficheros ni de funciones. Si los datos no lo dicen, omite esta línea.",
    "Estado: solo si quedó a medias o la devolvió el revisor.",
    "Lo de front y back que sea la misma funcionalidad va en el mismo bloque, y un área nunca aparece en dos bloques. Ordena los bloques de más a menos trabajo.",
    "Al final, si los hay, un bloque «Errores arreglados:» con una línea por error que diga qué le pasaba al usuario y dónde, y un bloque «Otras tareas:» con una línea por cada tarea mandada que no encaje en ningún bloque (investigaciones, configuración, revisiones).",
    "",
    "Estilo: español de España, neutro e impersonal, frases cortas y claras, sin claves de Jira, sin nombres de ficheros ni emojis. Los cambios de textos son «copies». No inventes nada que no salga de los datos.",
    "",
    "Tareas mandadas ese día desde el tablero (la sesión indica el área en la que se trabajó):",
    ...(tasks.length ? tasks : ["(ninguna)"]),
    "",
    "Commits de ese día por repositorio (en inglés y técnicos; entre corchetes, las carpetas que tocan, para saber dónde):",
    ...(commits.length ? commits : ["(ninguno)"]),
    "",
    "Errores de Sentry o del seguimiento que se mandaron arreglar ese día:",
    ...(errors.length ? errors : ["(ninguno)"]),
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
  const prompt = dailyPrompt(p, day, tasks, commits, errors);
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
  return { project: p.id, prevDay: prev, prev: all[prev] || null, today: today(), todayText: all[today()] || null, busy: running.has(p.id) };
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

module.exports = { dailyFor, dailyIfMissing, lastWorkday, dailyState, dailyStates, tasksOf, errorsOf };

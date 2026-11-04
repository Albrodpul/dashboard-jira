const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const config = require("./config");
const { mutate, load, now } = require("./data");

const ROOT = config.root;
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

function commitsOf(day) {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, name);
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    const email = git(dir, ["config", "user.email"]);
    if (!email) continue;
    const log = git(dir, ["log", "--all", "--no-merges", `--author=${email}`, `--since=${day} 00:00`, "--date=short", "--format=%ad|%s"]);
    for (const line of log.split("\n").filter((l) => l.startsWith(`${day}|`))) out.push(`${name}: ${line.slice(day.length + 1)}`);
  }
  return [...new Set(out)];
}

function errorsOf(day) {
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
    const sessions = require("./sessions");
    const [exe, args] = require("./platform").claude(["-p", prompt, "--no-session-persistence", "--model", config.sessionModel, "--allowedTools="]);
    const child = cp.execFile(exe, args, { cwd: ROOT, env: sessions.cleanEnv(), timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out).trim()));
    if (child.stdin) child.stdin.end();
  });
}

let running = null;

function tasksOf(day) {
  const d = load();
  const on = (iso) => iso && dayOf(new Date(iso)) === day;
  const seen = new Map();
  try {
    for (const line of fs.readFileSync(path.join(require("./data").DATA_DIR, "task-history.jsonl"), "utf8").split("\n").filter(Boolean)) {
      const t = JSON.parse(line);
      if (on(t.sentAt)) seen.set(t.key, t);
    }
  } catch (e) {}
  for (const t of Object.values(d.tasks || {})) if (on(t.sentAt)) seen.set(t.key, t);
  return [...seen.values()].map((t) => `${t.kind === "returned" ? "Devuelta por el revisor" : "Nueva"}: ${t.title}${t.epicName ? ` (${t.epicName})` : ""}`);
}

const EXAMPLE = ``;

async function makeDaily(day) {
  const commits = commitsOf(day);
  const errors = errorsOf(day);
  const tasks = tasksOf(day);
  if (!commits.length && !errors.length && !tasks.length) {
    mutate((d) => (d.daily = { day, text: "", empty: true, at: now() }));
    return;
  }
  const prompt = [
    `Escribe el mensaje que Alberto se manda a sí mismo en Slack para la daily, sobre lo que hizo el ${day}. Devuelve solo el mensaje.`,
    "Imita su forma de escribir y de ordenarlo. Este es uno escrito por él, el modelo a seguir:",
    "",
    EXAMPLE,
    "",
    "Cómo lo hace él:",
    "- Empieza por «Cosas a comentar en la daily:». Frases llanas y coloquiales de España, sin guiones al principio, sin claves de Jira, sin nombres de ficheros, sin emojis ni negritas.",
    "- Primero lo que ha estado revisando en primera persona («He estado revisando…», «También he estado revisando…»), incluidas las tareas que le han devuelto («Revisando algunas tareas que se han echao atrás: …»).",
    "- Cuando hay mucho, lo agrupa por aplicación con «Web:» y «Admin:» (y «Back:» si toca), y ahí cuenta en impersonal lo que ahora hace el producto («Se han revisado…», «Se pueden añadir…», «Los servicios también tienen…»).",
    "- Al final, si hubo arreglos de fallos, «Por el camino he arreglado algunos errores:» con una línea corta por cada uno, contados por lo que veía el usuario.",
    "- Los cambios de textos son «copies». No menciona despliegues.",
    "- La longitud depende de lo que haya: si fue poco, pocas líneas y sin secciones. No inventes nada que no salga de los datos y agrupa lo que sea lo mismo en back y front.",
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
  if (text) mutate((d) => (d.daily = { day, text, at: now() }));
}

function dailyFor(day) {
  if (!running) running = makeDaily(day || lastWorkday()).finally(() => (running = null));
  return running;
}

async function dailyIfMissing() {
  if (!require("./cluster").isPrimary()) return;
  const day = lastWorkday();
  const cur = load().daily;
  if (cur && cur.day === day) return;
  await dailyFor(day);
}

module.exports = { dailyFor, dailyIfMissing, lastWorkday };

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
    const exe = require("./platform").claudeCli();
    const args = ["-p", prompt, "--no-session-persistence", "--model", config.sessionModel, "--allowedTools="];
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

const EXAMPLE = `Cosas a comentar en la daily:

He estado revisando la interfaz de los destacados de las membresías de backoffice y web, además de añadir algún validador en back
También he estado revisando algunos cambios en el flujo del login y registro en la web y backoffice de cosas que ha modificado Souhail y que afectaban a los fronts
Revisando algunas tareas que se han echao atrás: del sistema de diseño de la web que se cambió el otro día, loyalty programs en las reservas, algunos copies en el account de web y otro de diseño de un drawer en el show de alojamientos
Y he estado haciendo un montón de tareas revisando todo el flujo de compras:
Web:
Se han revisado temas de precios, información en botones, qué se pide, qué no, en experiencias, alojamientos, servicios con un montón de variables, mostrando mensajes más claros y corrigiendo cosas que no funcionaban bien
Se han revisado botones y flujos de pagos en correos que ahora se envían, reservas rechazadas o canceladas que ya no dejan pagarse, etc

Backoffice:
También se han mejorado modales de reservas, confirmaciones, avisos de envíos a correos
Se pueden añadir fotos del alojamiento a la galería de una habitación
Cambios en filtros en la página de reservas y pasajeros
En las villas hay campos nuevos de capacidad y precio
Los servicios también tienen antelación mínima y máxima y límite de reservas al día
Se han arreglado algunos bugs en precios de reservas de alojamiento

Por el camino he arreglado algunos errores:
de cálculos del back de precios
precios que salían mal en las reservas por mala conversión de moneda y por caché
En el search se podían encontrar planes mal filtrados por membresía
O en algunos casos algunas reservas daba error el cancelarlas`;

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
    "- Cuando hay mucho, lo agrupa por aplicación con «Web:» y «Backoffice:» (y «Back:» si toca), y ahí cuenta en impersonal lo que ahora hace el producto («Se han revisado…», «Se pueden añadir…», «Los servicios también tienen…»).",
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

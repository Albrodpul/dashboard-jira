const fs = require("fs");
const path = require("path");
const config = require("../core/config");
const { load, mutate, now } = require("../core/data");

const SECRETS = ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"];
const OPEN = ["pending", "approved", "sent", "waiting", "partial"];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PREFIX = /^[A-Z]{2,10}$/;

const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

const same = (a, b) => path.resolve(a).replace(/\\/g, "/").toLowerCase() === path.resolve(b).replace(/\\/g, "/").toLowerCase();

function writeLocal(id, root) {
  const all = config.localProjects();
  if (root) all[id] = { root: path.resolve(root) };
  else delete all[id];
  fs.writeFileSync(config.localProjectsFile(), JSON.stringify(all, null, 2) + "\n");
}

function openTasks(id) {
  const projects = require("../core/projects");
  return Object.values(load().tasks).filter((t) => OPEN.includes(t.status) && projects.projectOf(t) === id).length;
}

function list() {
  return config.projects.map((p) => ({
    id: p.id,
    name: p.name,
    main: p === config.mainProject,
    editable: true,
    fromFile: p.source !== "panel",
    taskPrefix: require("./manual-tasks").prefixOf(p),
    agent: p.agent,
    root: p.root ? p.root.replace(/\\/g, "/") : null,
    rootExists: !!p.root && fs.existsSync(p.root),
    jira: p.jira ? p.jira.projects : null,
    modules: { jira: !!p.jira, followUp: p.followUp.length > 0, sentry: !!(p.sentry && p.sentry.org), deploy: p.deployProjects.length > 0, devServers: p.devServers.length > 0, daily: !!p.daily, context: !!p.contextTidy },
    credentials: Object.fromEntries(SECRETS.map((k) => [k, !!p.secret(k)])),
    messages: p.messages || null,
    jiraConfig: p.jira ? { projects: p.jira.projects, me: (p.jira.me && p.jira.me.name) || "", reviewer: (p.jira.reviewer && p.jira.reviewer.name) || "", transitions: Object.keys(p.jira.transitions || {}), connected: !!(p.jira.me && p.jira.me.id) } : null,
    sentryConfig: p.sentry && p.sentry.org ? { org: p.sentry.org, projects: p.sentry.projects || [], errorsArea: p.errorsArea || "" } : null,
    devServers: p.devServers.map((x) => ({ id: x.id, name: x.name, port: x.port, command: [x.command, ...(x.args || [])].join(" ") })),
    openTasks: openTasks(p.id),
  }));
}

function clean(text, max) {
  const t = String(text || "").trim();
  return t ? t.slice(0, max) : "";
}

function devServersOf(input, id) {
  if (!Array.isArray(input.devServers)) return { keep: true };
  const out = [];
  const taken = new Map(config.projects.filter((p) => p.id !== id).flatMap((p) => p.devServers.map((x) => [Number(x.port), p.name])));
  for (const raw of input.devServers) {
    const name = clean(raw && raw.name, 40);
    const port = Number(raw && raw.port);
    const words = clean(raw && raw.command, 200).split(/\s+/).filter(Boolean);
    if (!name && !raw.port && !words.length) continue;
    if (!name) return { error: "cada servidor necesita un nombre" };
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: `el puerto de ${name} va de 1024 a 65535` };
    if (taken.has(port)) return { error: `el puerto ${port} ya lo usa ${taken.get(port)}` };
    if (out.some((x) => x.port === port)) return { error: `el puerto ${port} está repetido` };
    if (!words.length) return { error: `falta el comando de ${name}, por ejemplo «npm run dev»` };
    let sid = slug(name) || `web-${port}`;
    while (out.some((x) => x.id === sid)) sid += "-2";
    out.push({ id: sid, name, role: "Web", port, url: `http://localhost:${port}`, command: words[0], args: words.slice(1) });
  }
  return { list: out };
}

const words = (v) => (Array.isArray(v) ? v : String(v || "").split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function jiraOf(input, id, taskPrefix, kept) {
  if (input.jira === undefined) return { keep: true };
  if (!input.jira || input.jira.enabled === false) return { value: null };
  const keys = [...new Set(words(input.jira.projects).map((k) => k.toUpperCase()))];
  if (!keys.length) return { error: "pon al menos un proyecto de Jira, por ejemplo OPS" };
  for (const k of keys) {
    if (!PREFIX.test(k)) return { error: `${k} no parece la clave de un proyecto de Jira: de 2 a 10 letras` };
    if (k === taskPrefix) return { error: `${k} es el prefijo de las tareas a mano: usa otro para ellas` };
    const other = config.projects.find((p) => p.id !== id && p.jira && p.jira.projects.includes(k));
    if (other) return { error: `${k} ya es de ${other.name}: un proyecto de Jira solo puede ir en un proyecto del tablero` };
  }
  const old = kept || {};
  return { value: { projects: keys, ...(old.me ? { me: old.me } : {}), ...(old.reviewer ? { reviewer: old.reviewer } : {}), ...(old.transitions ? { transitions: old.transitions } : {}) } };
}

function sentryOf(input) {
  if (input.sentry === undefined) return { keep: true };
  if (!input.sentry || input.sentry.enabled === false) return { value: null, errorsArea: null };
  const org = clean(input.sentry.org, 64).toLowerCase();
  const projects = [...new Set(words(input.sentry.projects).map((x) => x.toLowerCase()))];
  if (!SLUG.test(org)) return { error: "la organización de Sentry va como aparece en su dirección, por ejemplo mi-empresa" };
  if (!projects.length) return { error: "pon al menos un proyecto de Sentry" };
  const bad = projects.find((x) => !SLUG.test(x));
  if (bad) return { error: `${bad} no parece el nombre de un proyecto de Sentry` };
  const errorsArea = clean(input.sentry.errorsArea, 80) || null;
  if (errorsArea && !require("../server/state").state().areas.some((a) => a.id === errorsArea)) return { error: "esa sesión para los errores no existe" };
  return { value: { org, projects }, errorsArea };
}

function save(input) {
  const name = clean(input.name, 60);
  if (!name) return { error: "falta el nombre" };
  const id = input.id ? String(input.id) : slug(name);
  if (!ID.test(id)) return { error: "el id solo admite minúsculas, cifras y guiones" };
  const existing = config.project(id);
  const fromFile = !!existing && existing.source !== "panel";
  if (!existing && input.id && input.create === false) return { error: "ese proyecto no existe" };
  const taskPrefix = clean(input.taskPrefix, 10).toUpperCase() || id.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10);
  if (!PREFIX.test(taskPrefix)) return { error: "el prefijo de tareas son de 2 a 10 letras" };
  const jiraKeys = config.projects.filter((p) => p.id !== id || input.jira === undefined).flatMap((p) => (p.jira ? p.jira.projects : []));
  if (jiraKeys.includes(taskPrefix)) return { error: `${taskPrefix} ya es un proyecto de Jira` };
  const manual = require("./manual-tasks");
  const clash = config.projects.find((p) => p.id !== id && manual.prefixOf(p) === taskPrefix);
  if (clash) return { error: `${clash.name} ya usa el prefijo ${taskPrefix}` };
  const base = config.workspaceBase;
  const typed = clean(input.root, 400);
  if (fromFile && typed && (!existing.root || !same(existing.root, path.resolve(base || "", typed)))) return { error: `la carpeta de ${existing.name} se cambia en board.config.json de cada ordenador` };
  let root = "";
  let folder = null;
  if (!fromFile && (typed || !existing)) {
    if (!base) return { error: "no se sabe dónde está workspace en este ordenador" };
    root = path.resolve(base, typed || id);
    folder = path.relative(base, root);
    if (!folder || folder.startsWith("..") || path.isAbsolute(folder)) return { error: `la carpeta tiene que estar dentro de ${base.replace(/\\/g, "/")}` };
    folder = folder.replace(/\\/g, "/");
    if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) return { error: "ahí hay un fichero, no una carpeta" };
    const taken = config.projects.find((p) => p.id !== id && p.root && same(p.root, root));
    if (taken) return { error: `esa carpeta ya es de ${taken.name}` };
  }
  if (!fromFile && !typed && existing) folder = (load().projectDefs || {})[id] ? load().projectDefs[id].folder || null : null;
  const servers = devServersOf(input, id);
  if (servers.error) return { error: servers.error };
  if (fromFile && !servers.keep) return { error: `los servidores de ${existing.name} se cambian en board.config.json de cada ordenador` };
  const def = (load().projectDefs || {})[id] || {};
  const jira = jiraOf(input, id, taskPrefix, def.jira);
  if (jira.error) return { error: jira.error };
  const sentry = sentryOf(input);
  if (sentry.error) return { error: sentry.error };
  if (fromFile && (!jira.keep || !sentry.keep)) return { error: `Jira y Sentry de ${existing.name} se cambian en board.config.json de cada ordenador` };
  const integrations = {};
  const jiraValue = jira.keep ? def.jira : jira.value;
  if (jiraValue) integrations.jira = jiraValue;
  const sentryValue = sentry.keep ? def.sentry : sentry.value;
  if (sentryValue) integrations.sentry = sentryValue;
  const errorsArea = sentry.keep ? def.errorsArea : sentry.errorsArea;
  if (sentryValue && errorsArea) integrations.errorsArea = errorsArea;
  const keptServers = servers.keep ? ((load().projectDefs || {})[id] || {}).devServers : servers.list;
  const messages = {};
  for (const k of ["review", "cause", "reference"]) {
    const v = input.messages ? clean(input.messages[k], 1500) : "";
    if (v) messages[k] = v;
  }
  mutate((d) => {
    d.projectDefs = { ...(d.projectDefs || {}) };
    d.projectDefs[id] = fromFile
      ? { id, override: true, name, taskPrefix, daily: !!input.daily, contextTidy: !!input.contextTidy, messages: Object.keys(messages).length ? messages : existing.fileValues ? existing.fileValues.messages : null, updatedAt: now() }
      : { id, name, taskPrefix, agent: "claude", daily: !!input.daily, contextTidy: !!input.contextTidy, ...(folder ? { folder } : {}), ...(Object.keys(messages).length ? { messages } : {}), ...(keptServers && keptServers.length ? { devServers: keptServers } : {}), ...integrations, updatedAt: now() };
  });
  if (!servers.keep && existing) {
    const gone = existing.devServers.filter((x) => !servers.list.some((y) => y.id === x.id && y.port === x.port && y.command === x.command && (y.args || []).join(" ") === (x.args || []).join(" ")));
    const devservers = require("./devservers");
    for (const x of gone) Promise.resolve(devservers.stop(existing === config.mainProject ? x.id : `${id}-${x.id}`)).catch(() => {});
  }
  if (root) {
    fs.mkdirSync(root, { recursive: true });
    writeLocal(id, root);
  }
  config.forgetProjects();
  const p = config.project(id);
  let commands = null;
  if (p && p.root) commands = require("./render-commands").renderProject(p);
  return { id, commands };
}

function remove(id) {
  const p = config.project(id);
  if (!p) return { error: "ese proyecto no existe" };
  if (p === config.mainProject) return { error: `${p.name} es el proyecto principal: la vigilancia de Jira, el reporte, el seguimiento, los despliegues y Sentry funcionan sobre él` };
  if (p.source !== "panel") return { error: `${p.name} se quita de board.config.json de cada ordenador` };
  const n = openTasks(id);
  if (n) return { error: `${p.name} tiene ${n} tarea${n === 1 ? "" : "s"} abierta${n === 1 ? "" : "s"}: ciérralas o bórralas antes` };
  mutate((d) => {
    d.projectDefs = { ...(d.projectDefs || {}) };
    d.projectDefs[id] = { id, removed: true, updatedAt: now() };
  });
  writeLocal(id, null);
  config.forgetProjects();
  return { id };
}

function setCredentials(id, values) {
  const p = config.project(id);
  if (!p) return { error: "ese proyecto no existe" };
  if (p === config.mainProject) return { error: "las credenciales del proyecto principal están en el .env del tablero" };
  let lines = [];
  try {
    lines = fs.readFileSync(p.envFile, "utf8").split(/\r?\n/);
  } catch (e) {}
  for (const k of SECRETS) {
    if (!values || !(k in values)) continue;
    const v = String(values[k] || "").trim();
    if (/[\r\n]/.test(v)) return { error: `${k} no puede tener saltos de línea` };
    lines = lines.filter((l) => !new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (v) lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(p.envFile, lines.filter((l, i) => l.trim() || i < lines.length - 1).join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  config.forgetProjects();
  return { id, credentials: Object.fromEntries(SECRETS.map((k) => [k, !!config.project(id).secret(k)])) };
}

const PICK = {
  start: (t) => /curso|progres|doing|haciendo/i.test(t.to) || t.category === "indeterminate",
  todo: (t) => /por hacer|to ?do|pendiente|backlog|abiert|open/i.test(t.to) || t.category === "new",
  block: (t) => /bloque|block/i.test(t.to) || /bloque|block/i.test(t.name),
};

async function connectJira(id, { sample, reviewer } = {}, ask) {
  const p = config.project(id);
  if (!p) return { error: "ese proyecto no existe" };
  if (p.source !== "panel") return { error: `el Jira de ${p.name} se configura en board.config.json` };
  const def = (load().projectDefs || {})[id] || {};
  if (!def.jira) return { error: "activa Jira y guarda el proyecto antes de conectarlo" };
  try {
    p.credentials();
  } catch (e) {
    return { error: "faltan el sitio, el correo o el token de Jira en las credenciales de este ordenador" };
  }
  const get = ask || ((route) => require("../jira/client").jiraGet(route, p));
  const key = clean(sample, 20).toUpperCase();
  if (key && !def.jira.projects.includes(key.split("-")[0])) return { error: `${key} no es de ${def.jira.projects.join(", ")}` };
  let me;
  try {
    me = await get("/myself");
  } catch (e) {
    return { error: `Jira no acepta estas credenciales (${e.message})` };
  }
  const jira = { ...def.jira, me: { id: me.accountId, name: me.displayName || "" } };
  const notes = [];
  const who = clean(reviewer, 80);
  if (who) {
    const found = (await get(`/user/search?query=${encodeURIComponent(who)}`).catch(() => [])) || [];
    const r = found.find((u) => u.accountType !== "app") || null;
    if (r) jira.reviewer = { id: r.accountId, name: r.displayName, mentions: [r.displayName] };
    else notes.push(`no encuentro a «${who}» en ese Jira`);
  }
  if (key) {
    let list = [];
    try {
      list = ((await get(`/issue/${encodeURIComponent(key)}/transitions`)).transitions || []).map((t) => ({ id: t.id, name: t.name || "", to: (t.to && t.to.name) || "", category: t.to && t.to.statusCategory && t.to.statusCategory.key }));
    } catch (e) {
      return { error: `no puedo leer ${key} en ese Jira (${e.message})` };
    }
    const transitions = {};
    for (const [action, test] of Object.entries(PICK)) {
      const t = list.find((x) => /bloque|block/i.test(x.to) === (action === "block") && test(x));
      if (t) transitions[action] = t.id;
    }
    jira.transitions = transitions;
    const missing = Object.keys(PICK).filter((k) => !transitions[k] && k !== "block");
    if (missing.length) notes.push(`desde el estado de ${key} no hay paso a ${missing.map((k) => (k === "start" ? "«En curso»" : "«Por hacer»")).join(" ni ")}: prueba con un ticket en otro estado`);
  }
  mutate((d) => {
    d.projectDefs = { ...(d.projectDefs || {}) };
    d.projectDefs[id] = { ...d.projectDefs[id], jira, updatedAt: now() };
  });
  config.forgetProjects();
  return { id, me: jira.me.name, reviewer: jira.reviewer ? jira.reviewer.name : "", transitions: Object.keys(jira.transitions || {}), notes };
}

module.exports = { list, save, remove, setCredentials, connectJira, SECRETS };

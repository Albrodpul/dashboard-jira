const path = require("path");
const { load, now, DATA_DIR } = require("../core/data");
const { loadRoutes, titleKey } = require("../sessions/registry");
const config = require("../core/config");
const { appendLog } = require("../core/logfile");

const RETRY_MS = 5 * 60000;
const failed = new Map();
let creating = null;
let timer = null;
let create = null;

const log = (line) => appendLog(path.join(DATA_DIR, "yolo.log"), `${now()} ${line}\n`);

const on = (d) => !!(d.config && d.config.yolo);
const projectOf = (t) => t.project || (config.mainProject && config.mainProject.id) || "";
const areaProject = (a) => a.project || (config.mainProject && config.mainProject.id) || "";

function sessionName(t, areas) {
  const base = String(t.epicName || t.title || t.key).trim().slice(0, 60);
  const clash = Object.values(areas).find((a) => titleKey(a.title) === titleKey(base) && areaProject(a) !== projectOf(t));
  if (!clash) return base;
  const p = config.project(projectOf(t));
  return `${base} (${(p && p.name) || projectOf(t)})`.slice(0, 60);
}

function targetOf(t, routes) {
  const areas = routes.areas || {};
  for (const id of [t.area, t.proposedArea]) if (id && areas[id]) return { area: id };
  if (t.epicKey) {
    const id = Object.keys(areas).find((k) => areas[k].epics && areas[k].epics[t.epicKey]);
    if (id) return { area: id };
  }
  const name = sessionName(t, areas);
  const id = Object.keys(areas).find((k) => titleKey(areas[k].title) === titleKey(name) && areaProject(areas[k]) === projectOf(t));
  if (id) return { area: id };
  return { create: name };
}

function createSession(name, t) {
  return new Promise((resolve) => {
    const send = (res, code, body) => resolve({ code, body: body || {} });
    require("../server/routes/sessions").handleNewSession(null, { title: name, epicKey: t.epicKey || undefined, epicName: t.epicName || undefined, project: projectOf(t) || undefined }, send);
  });
}

function sendErrors() {
  const area = config.errorsArea;
  if (!area) return 0;
  const holds = require("./holds");
  const ids = require("../core/data").mutate((x) => {
    if (holds.checkArea(x, "La sesión de errores", area)) return [];
    const out = [];
    for (const r of x.followUps || []) {
      for (const e of r.errors || []) {
        if (e.state !== "proposed") continue;
        Object.assign(e, { state: "approved", approvedVia: "yolo", decidedAt: now() });
        out.push(e.id);
      }
    }
    return out;
  });
  if (!ids.length) return 0;
  for (const id of ids) log(`${id} -> ${area} (posible error del seguimiento)`);
  require("../server/state").openIfClosed(area);
  require("./mailman").kick();
  return ids.length;
}

async function tick() {
  if (!require("../cluster/cluster").primaryNow()) return;
  const d = load();
  if (!on(d)) return;
  if ((d.followUps || []).some((r) => (r.errors || []).some((e) => e.state === "proposed"))) sendErrors();
  const pending = Object.values(d.tasks || {}).filter((x) => x.status === "pending" && !x.withdrawn && !(Date.now() - (failed.get(x.key) || 0) < RETRY_MS));
  if (!pending.length) return;
  const routes = loadRoutes();
  const pairs = [];
  let toCreate = null;
  for (const t of pending) {
    const target = targetOf(t, routes);
    if (target.area) pairs.push({ key: t.key, area: target.area });
    else if (!toCreate) toCreate = { name: target.create, task: t };
  }
  if (pairs.length) {
    const { approved, held } = require("../server/routes/tasks").approveMany(pairs, "yolo");
    for (const x of approved) log(`${x.key} -> ${x.area}`);
    for (const x of held) {
      failed.set(x.key, Date.now());
      log(`${x.key}: retenida (${x.error})`);
    }
  }
  if (toCreate && !creating) {
    const { name, task } = toCreate;
    log(`${task.key}: sin sesión, se crea «${name}»`);
    creating = (create || createSession)(name, task)
      .then(({ code, body }) => {
        if (code === 200) {
          log(`«${name}» creada (${body.area})`);
          kick();
        } else if (code !== 409) {
          failed.set(task.key, Date.now());
          log(`${task.key}: no se pudo crear «${name}» (${body.error || code})`);
        }
      })
      .catch((e) => {
        failed.set(task.key, Date.now());
        log(`${task.key}: no se pudo crear «${name}» (${(e && e.message) || e})`);
      })
      .finally(() => (creating = null));
  }
}

function kick() {
  clearTimeout(timer);
  timer = setTimeout(() => tick().catch(() => {}), 300);
}

module.exports = { tick, kick, targetOf, sessionName, _test: { reset: () => (failed.clear(), (creating = null), (create = null)), setCreate: (fn) => (create = fn), idle: () => creating || Promise.resolve() } };

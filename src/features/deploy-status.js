const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { DATA_DIR, readJson } = require("../core/data");
const config = require("../core/config");

const FILE = path.join(DATA_DIR, "deploy-status.json");
const ENVS = ["develop", "production"];
const ACTIVE_ACTIONS = ["queued", "in_progress", "waiting", "requested", "pending"];
const ACTIVE_CODEDEPLOY = ["Created", "Queued", "InProgress", "Baking", "Ready"];
const SLOW = 3 * 60000;
const FAST = 30000;
const RECENT = 4;
const PAIR_BEFORE = 2 * 60000;
const PAIR_AFTER = 15 * 60000;
let timer = null;
let running = null;

function run(bin, args) {
  return new Promise((resolve) => {
    cp.execFile(bin, args, { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => resolve(err ? { error: String(errOut || err.message).trim().split("\n")[0].slice(0, 200) } : { out }));
  });
}

async function actionsRuns(target) {
  const r = await run("gh", ["run", "list", "-R", target.repo, "--limit", "40", "--json", "databaseId,workflowName,headBranch,status,conclusion,createdAt,updatedAt,url,event"]);
  if (r.error) return { error: r.error };
  const runs = JSON.parse(r.out);
  const out = {};
  for (const env of ENVS) {
    const match = new RegExp((target.workflows && target.workflows[env]) || env, "i");
    const list = runs.filter((y) => match.test(y.workflowName)).slice(0, RECENT);
    if (!list.length) continue;
    out[env] = [];
    for (const x of list) {
      const run = { id: x.databaseId, workflow: x.workflowName, ref: x.headBranch, status: x.status, conclusion: x.conclusion || null, startedAt: x.createdAt, updatedAt: x.updatedAt, url: x.url };
      if (ACTIVE_ACTIONS.includes(x.status)) run.progress = await actionsProgress(target, x.databaseId);
      out[env].push(run);
    }
  }
  return out;
}

async function actionsProgress(target, id) {
  const r = await run("gh", ["run", "view", String(id), "-R", target.repo, "--json", "jobs"]);
  if (r.error) return null;
  try {
    const steps = JSON.parse(r.out).jobs.flatMap((j) => j.steps || []);
    return steps.length ? { done: steps.filter((x) => x.status === "completed").length, total: steps.length } : null;
  } catch (e) {
    return null;
  }
}

async function codedeployProgress(id) {
  const list = await run("aws", ["deploy", "list-deployment-targets", "--deployment-id", id, "--query", "targetIds", "--output", "json"]);
  if (list.error) return null;
  let ids;
  try {
    ids = JSON.parse(list.out);
  } catch (e) {
    return null;
  }
  if (!ids || !ids.length) return null;
  const info = await run("aws", ["deploy", "batch-get-deployment-targets", "--deployment-id", id, "--target-ids", ...ids.slice(0, 25), "--query", "deploymentTargets[].instanceTarget.lifecycleEvents[].status", "--output", "json"]);
  if (info.error) return null;
  try {
    const events = JSON.parse(info.out).flat().filter(Boolean);
    return events.length ? { done: events.filter((x) => x === "Succeeded" || x === "Skipped").length, total: events.length } : null;
  } catch (e) {
    return null;
  }
}

const isoTime = (t) => (t == null ? null : typeof t === "number" ? new Date(t * 1000).toISOString() : t);

async function codedeployRecent(application, group) {
  const list = await run("aws", ["deploy", "list-deployments", "--application-name", application, "--deployment-group-name", group, "--max-items", String(RECENT), "--query", "deployments", "--output", "json"]);
  if (list.error) return { error: list.error };
  let ids;
  try {
    ids = JSON.parse(list.out) || [];
  } catch (e) {
    return { error: "respuesta de CodeDeploy ilegible" };
  }
  if (!ids.length) return [];
  const info = await run("aws", ["deploy", "batch-get-deployments", "--deployment-ids", ...ids, "--query", "deploymentsInfo[].{id:deploymentId,status:status,createTime:createTime,completeTime:completeTime,overview:deploymentOverview,error:errorInformation.message}", "--output", "json"]);
  if (info.error) return { error: info.error };
  const out = [];
  for (const d of JSON.parse(info.out)) {
    const o = d.overview || {};
    const progress = ACTIVE_CODEDEPLOY.includes(d.status) ? await codedeployProgress(d.id) : null;
    out.push({ id: d.id, status: d.status, startedAt: isoTime(d.createTime), finishedAt: isoTime(d.completeTime), done: o.Succeeded || 0, total: (o.Succeeded || 0) + (o.Failed || 0) + (o.InProgress || 0) + (o.Pending || 0) + (o.Ready || 0) + (o.Skipped || 0), progress, error: d.error || null });
  }
  return out.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

const ms = (x) => new Date(x).getTime();

function pair(runs, deployments) {
  const byRun = new Map();
  const used = new Set();
  for (const d of [...deployments].reverse()) {
    const cand = runs.filter((r) => !byRun.has(r.id) && r.status === "completed" && ms(d.startedAt) >= ms(r.updatedAt) - PAIR_BEFORE && ms(d.startedAt) - ms(r.updatedAt) <= PAIR_AFTER);
    cand.sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
    if (cand[0]) {
      byRun.set(cand[0].id, d);
      used.add(d.id);
    }
  }
  return { byRun, unpaired: deployments.filter((d) => !used.has(d.id)) };
}

function overall(actions, codedeploy) {
  if (!actions) {
    if (codedeploy && ACTIVE_CODEDEPLOY.includes(codedeploy.status)) return { state: "running", step: "CodeDeploy en curso" };
    return { state: "unknown", step: "Sin despliegues" };
  }
  if (ACTIVE_ACTIONS.includes(actions.status)) return { state: "running", step: "GitHub Actions en curso" };
  if (actions.conclusion && actions.conclusion !== "success") return { state: actions.conclusion === "cancelled" ? "cancelled" : "failed", step: actions.conclusion === "cancelled" ? "Cancelado en GitHub Actions" : "Falló en GitHub Actions" };
  if (codedeploy === undefined) return { state: "success", step: "Desplegado" };
  if (!codedeploy || codedeploy.error) return Date.now() - ms(actions.updatedAt) < PAIR_AFTER ? { state: "running", step: "Esperando a CodeDeploy" } : { state: "unknown", step: "No se ve su despliegue en CodeDeploy" };
  if (ACTIVE_CODEDEPLOY.includes(codedeploy.status)) return { state: "running", step: `CodeDeploy en curso${codedeploy.total ? ` (${codedeploy.done}/${codedeploy.total} máquinas)` : ""}` };
  if (codedeploy.status === "Succeeded") return { state: "success", step: "Desplegado" };
  return { state: codedeploy.status === "Stopped" ? "cancelled" : "failed", step: `CodeDeploy: ${codedeploy.status}${codedeploy.error ? ` · ${codedeploy.error}` : ""}` };
}

async function collect() {
  const items = [];
  for (const t of config.deployTargets) {
    const runs = t.repo ? await actionsRuns(t) : {};
    const item = { id: t.id, repo: t.repo || null, error: runs.error || null, envs: {} };
    for (const env of ENVS) {
      const list = runs[env] || [];
      const group = t.codedeploy && t.codedeploy[env];
      const recent = group ? await codedeployRecent(t.codedeploy.application, group) : null;
      const cdError = recent && recent.error ? { error: recent.error } : null;
      const { byRun, unpaired } = pair(list, Array.isArray(recent) ? recent : []);
      const entry = (actions, cd) => {
        const codedeploy = !group ? undefined : cd || cdError;
        return { actions, codedeploy: codedeploy || null, hasCodedeploy: !!group, codedeployCurrent: !!cd, ...overall(actions, codedeploy) };
      };
      const chains = list.map((r) => entry(r, byRun.get(r.id)));
      const loose = unpaired.filter((d) => ACTIVE_CODEDEPLOY.includes(d.status)).map((d) => entry(null, d));
      const main = chains[0] || entry(null, null);
      const parallel = [...chains.slice(1), ...loose].filter((c) => c.state === "running");
      item.envs[env] = { ...main, parallel };
    }
    items.push(item);
  }
  return { at: new Date().toISOString(), items };
}

const readStatus = () => readJson(FILE, null);
const recentOrder = () => {
  try {
    return require("../core/data").load().deployments.some((x) => x.status === "approved" || (x.sentAt && Date.now() - new Date(x.sentAt).getTime() < 30 * 60000));
  } catch (e) {
    return false;
  }
};
const anyRunning = (s) => recentOrder() || (!!s && s.items.some((i) => ENVS.some((e) => i.envs[e] && i.envs[e].state === "running")));

function finished(prev, next) {
  if (!prev) return [];
  const out = [];
  for (const item of next.items) {
    const before = prev.items.find((x) => x.id === item.id);
    for (const env of ENVS) {
      const a = before && before.envs[env];
      const b = item.envs[env];
      if (a && b && a.state === "running" && b.state !== "running" && b.state !== "unknown") out.push({ id: item.id, env, state: b.state, ref: b.actions && b.actions.ref });
    }
  }
  return out;
}

async function refreshStatus() {
  if (running) return running;
  running = (async () => {
    const prev = readStatus();
    const next = await collect();
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, FILE);
    const ended = finished(prev, next);
    if (ended.length) {
      const name = { develop: "develop", production: "producción" };
      const word = { success: "desplegado", failed: "ha fallado", cancelled: "cancelado" };
      const text = ended.map((x) => `${x.id} en ${name[x.env]}: ${word[x.state] || x.state}`).join(" · ");
      require("../server/push").sendPush("deploys", true, text).catch(() => {});
    }
    return next;
  })().finally(() => (running = null));
  return running;
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    refreshStatus()
      .catch(() => null)
      .then((s) => {
        schedule();
      });
  }, anyRunning(readStatus()) ? FAST : SLOW);
}

function startDeployStatus() {
  if (!config.deployTargets.some((t) => t.repo)) return;
  refreshStatus()
    .catch(() => null)
    .then(schedule);
}

function handleDeployStatusRefresh(res, send) {
  refreshStatus()
    .then(() => {
      schedule();
      send(res, 200);
    })
    .catch((e) => send(res, 502, { error: String(e.message || e) }));
}

module.exports = { readStatus, refreshStatus, startDeployStatus, handleDeployStatusRefresh, anyRunning };

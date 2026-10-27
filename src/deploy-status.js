const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { DATA_DIR, readJson } = require("./data");
const config = require("./config");

const FILE = path.join(DATA_DIR, "deploy-status.json");
const ENVS = ["develop", "production"];
const ACTIVE_ACTIONS = ["queued", "in_progress", "waiting", "requested", "pending"];
const ACTIVE_CODEDEPLOY = ["Created", "Queued", "InProgress", "Baking", "Ready"];
const SLOW = 3 * 60000;
const FAST = 30000;
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
    const x = runs.find((y) => match.test(y.workflowName));
    if (x) out[env] = { id: x.databaseId, workflow: x.workflowName, ref: x.headBranch, status: x.status, conclusion: x.conclusion || null, startedAt: x.createdAt, updatedAt: x.updatedAt, url: x.url };
  }
  return out;
}

async function codedeployLast(application, group) {
  const list = await run("aws", ["deploy", "list-deployments", "--application-name", application, "--deployment-group-name", group, "--max-items", "1", "--query", "deployments[0]", "--output", "text"]);
  if (list.error) return { error: list.error };
  const id = String(list.out).trim().split(/\s+/)[0];
  if (!id || id === "None") return null;
  const info = await run("aws", ["deploy", "get-deployment", "--deployment-id", id, "--query", "deploymentInfo.{status:status,createTime:createTime,completeTime:completeTime,overview:deploymentOverview,error:errorInformation.message}", "--output", "json"]);
  if (info.error) return { error: info.error };
  const d = JSON.parse(info.out);
  const o = d.overview || {};
  return { id, status: d.status, startedAt: d.createTime, finishedAt: d.completeTime || null, done: o.Succeeded || 0, total: (o.Succeeded || 0) + (o.Failed || 0) + (o.InProgress || 0) + (o.Pending || 0) + (o.Ready || 0) + (o.Skipped || 0), error: d.error || null };
}

function overall(actions, codedeploy) {
  if (!actions) return { state: "unknown", step: "Sin despliegues" };
  if (ACTIVE_ACTIONS.includes(actions.status)) return { state: "running", step: "GitHub Actions en curso" };
  if (actions.conclusion && actions.conclusion !== "success") return { state: actions.conclusion === "cancelled" ? "cancelled" : "failed", step: actions.conclusion === "cancelled" ? "Cancelado en GitHub Actions" : "Falló en GitHub Actions" };
  if (codedeploy === undefined) return { state: "success", step: "Desplegado" };
  if (!codedeploy || codedeploy.error || new Date(codedeploy.startedAt) < new Date(actions.startedAt)) return { state: "running", step: "Esperando a CodeDeploy" };
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
      const actions = runs[env] || null;
      const group = t.codedeploy && t.codedeploy[env];
      const codedeploy = group ? await codedeployLast(t.codedeploy.application, group) : undefined;
      item.envs[env] = { actions, codedeploy: codedeploy === undefined ? null : codedeploy, ...overall(actions, codedeploy) };
    }
    items.push(item);
  }
  return { at: new Date().toISOString(), items };
}

const readStatus = () => readJson(FILE, null);
const recentOrder = () => {
  try {
    return require("./data").load().deployments.some((x) => x.status === "approved" || (x.sentAt && Date.now() - new Date(x.sentAt).getTime() < 30 * 60000));
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
      require("./push").sendPush("deploys", true, text).catch(() => {});
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

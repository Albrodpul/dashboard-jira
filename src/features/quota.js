const fs = require("fs");
const path = require("path");
const os = require("os");
const { DATA_DIR } = require("../core/data");

const FILE = path.join(DATA_DIR, "quota.json");
const CREDENTIALS = path.join(os.homedir(), ".claude", ".credentials.json");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const WINDOWS = ["five_hour", "seven_day"];

function readQuota() {
  try {
    const q = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const k of WINDOWS) if (q[k] && q[k].usado !== undefined) q[k] = { used: q[k].usado, resetsAt: q[k].renueva };
    return q;
  } catch (e) {
    return null;
  }
}

function readCredentials() {
  if (fs.existsSync(CREDENTIALS)) return fs.readFileSync(CREDENTIALS, "utf8");
  if (process.platform !== "darwin") return null;
  try {
    return require("child_process").execFileSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  } catch (e) {
    return null;
  }
}

const WAIT_FILE = path.join(DATA_DIR, "quota-wait.json");
const waitUntil = () => {
  try {
    return JSON.parse(fs.readFileSync(WAIT_FILE, "utf8")).until || 0;
  } catch (e) {
    return 0;
  }
};

function loginToken() {
  try {
    const raw = readCredentials();
    const oauth = raw ? JSON.parse(raw).claudeAiOauth : null;
    return oauth && oauth.accessToken && !(oauth.expiresAt && oauth.expiresAt < Date.now()) ? oauth.accessToken : null;
  } catch (e) {
    return null;
  }
}

function saveQuota(quota) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(quota));
  fs.renameSync(tmp, FILE);
  return quota;
}

async function askUsage(token) {
  const r = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } });
  if (r.status === 429) {
    const seconds = Number(r.headers.get("retry-after")) || 1800;
    fs.writeFileSync(WAIT_FILE, JSON.stringify({ until: Date.now() + (seconds + 60) * 1000 }));
    return null;
  }
  if (!r.ok) throw new Error(`la consulta de cuota respondió ${r.status}`);
  const j = await r.json();
  const quota = { at: new Date().toISOString() };
  for (const k of WINDOWS) if (j[k] && typeof j[k].utilization === "number") quota[k] = { used: j[k].utilization, resetsAt: j[k].resets_at || null };
  return saveQuota(quota);
}

async function quotaFromPeer() {
  const cluster = require("../cluster/cluster");
  if (!cluster.clusterEnabled()) return null;
  const theirs = await cluster.peerGet("/api/cluster/quota", 8000);
  const mine = readQuota();
  if (!theirs || !theirs.at || (mine && mine.at >= theirs.at)) return null;
  return saveQuota(theirs);
}

async function fetchQuota() {
  const primary = require("../cluster/cluster").isPrimary();
  const login = loginToken();
  if (!primary && !login) return null;
  if (login && Date.now() >= waitUntil()) return askUsage(login);
  if (!primary) return null;
  const fresh = await quotaFromPeer();
  if (fresh && Date.now() - new Date(fresh.at).getTime() < 30 * 60000) return fresh;
  const backup = require("../sessions/registry").sessionToken();
  return backup ? quotaFromHeaders(backup) : fresh;
}

async function quotaFromHeaders(token) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: "user", content: "ok" }] }),
  });
  const quota = { at: new Date().toISOString(), source: "headers" };
  for (const [k, name] of [["seven_day", "7d"], ["five_hour", "5h"]]) {
    const used = Number(r.headers.get(`anthropic-ratelimit-unified-${name}-utilization`));
    const reset = Number(r.headers.get(`anthropic-ratelimit-unified-${name}-reset`));
    if (r.headers.has(`anthropic-ratelimit-unified-${name}-utilization`) && Number.isFinite(used)) quota[k] = { used: Math.round(used * 100), resetsAt: reset ? new Date(reset * 1000).toISOString() : null };
  }
  if (!quota.seven_day && !quota.five_hour) throw new Error(`la llamada de cuota respondió ${r.status} sin cabeceras de límite`);
  return saveQuota(quota);
}

module.exports = { readQuota, fetchQuota };

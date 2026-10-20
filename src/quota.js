const fs = require("fs");
const path = require("path");
const os = require("os");
const { DATA_DIR } = require("./data");

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

async function fetchQuota() {
  const oauth = JSON.parse(fs.readFileSync(CREDENTIALS, "utf8")).claudeAiOauth;
  if (!oauth || !oauth.accessToken || (oauth.expiresAt && oauth.expiresAt < Date.now())) return null;
  const r = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" } });
  if (!r.ok) throw new Error(`la consulta de cuota respondió ${r.status}`);
  const j = await r.json();
  const quota = { at: new Date().toISOString() };
  for (const k of WINDOWS) if (j[k] && typeof j[k].utilization === "number") quota[k] = { used: j[k].utilization, resetsAt: j[k].resets_at || null };
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(quota));
  fs.renameSync(tmp, FILE);
  return quota;
}

module.exports = { readQuota, fetchQuota };

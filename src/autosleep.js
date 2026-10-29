const fs = require("fs");
const path = require("path");
const config = require("./config");
const { DATA_DIR } = require("./data");

const IDLE_MS = 30 * 60000;
const PENDING = ["approved", "sent", "waiting", "partial"];

const log = (m) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "autosleep.log"), `${new Date().toISOString()} ${m}\n`);
  } catch (e) {}
};

async function sleepIdleSessions() {
  if (!require("./cluster").isPrimary()) return;
  const host = require("./host");
  const hosted = await host.hostRequest("GET", "/sessions").catch(() => null);
  if (!Array.isArray(hosted)) return;
  const s = require("./state").state();
  const areaConversation = (id) => {
    const a = id && s.areas.find((x) => x.id === id);
    return a && a.conversation;
  };
  const keep = new Set([s.reporterRoute, s.orchestrator, s.followUpStatus, s.boardStatus].filter(Boolean).map((r) => r.conversation));
  for (const id of [s.deployerArea, config.errorsArea]) if (areaConversation(id)) keep.add(areaConversation(id));
  for (const t of s.tasks) if (PENDING.includes(t.status) && areaConversation(t.area)) keep.add(areaConversation(t.area));
  for (const p of (s.permissions && s.permissions.pending) || []) if (p.conversation) keep.add(p.conversation);
  const live = new Map(((s.sessions && s.sessions.list) || []).map((x) => [x.conversation, x]));
  for (const h of hosted) {
    if (!h.running || keep.has(h.conversation)) continue;
    const l = live.get(h.conversation);
    if (!l || l.status !== "idle" || !l.statusSince || Date.now() - new Date(l.statusSince).getTime() < IDLE_MS) continue;
    await host.hostRequest("POST", "/stop", { conversation: h.conversation }).catch(() => {});
    host.markOnDemand(h.conversation);
    log(`duerme ${h.name}: parada desde ${l.statusSince}`);
  }
}

module.exports = { sleepIdleSessions };

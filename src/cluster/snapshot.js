const fs = require("fs");
const os = require("os");
const { SPECS, STAMPS_KEY, mergeRecords } = require("../core/records");
const { SEEN_FILE, load, mutate, now } = require("../core/data");
const { st, save, log } = require("./role");
const { peerGet } = require("./peer");

const ROUTE_ROLES = ["reporter", "orchestrator", "followUp", "board"];
const SYNC_KEYS = ["tasks", "aliases", "seenEpics", "reports", "refreshRequest", "jiraEpics", "deployments", "followUps", "messages", "lastReview", "config", "contextTidy", "deleted", "permissionRules", "sentry", "sessionOverrides"];

function snapshot() {
  const d = load();
  const docs = {};
  for (const k of SYNC_KEYS) if (d[k] !== undefined) docs[k] = d[k];
  let seen = null;
  try {
    seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch (e) {}
  const routes = require("../sessions/registry").loadRoutes();
  const areas = {};
  for (const [id, a] of Object.entries(routes.areas || {})) areas[id] = { title: a.title, epics: a.epics || {} };
  for (const [id, a] of Object.entries(routes.areas || {})) if (a.conversation) Object.assign(areas[id], { conversation: a.conversation, session: a.session || null });
  const roles = {};
  for (const role of ROUTE_ROLES) if (routes[role] && routes[role].conversation) roles[role] = { conversation: routes[role].conversation, session: routes[role].session || null, title: routes[role].title || null, since: routes[role].since || null, rotatedOn: routes[role].rotatedOn || null };
  return { at: now(), host: os.hostname(), docs, stamps: d[STAMPS_KEY] || {}, seen, areas, roles, deployer: routes.deployer || null };
}

const MERGED_KEYS = ["tasks", "deleted"];

function mergeTasks(d, docs, theirsOnTie) {
  const deleted = { ...(d.deleted || {}) };
  for (const [k, at] of Object.entries(docs.deleted || {})) if (!deleted[k] || at > deleted[k]) deleted[k] = at;
  const mine = d.tasks || {};
  const theirs = docs.tasks || {};
  const tasks = {};
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const a = mine[k];
    const b = theirs[k];
    const ua = (a && a.updatedAt) || "";
    const ub = (b && b.updatedAt) || "";
    const pick = !a ? b : !b ? a : ub > ua || (ub === ua && theirsOnTie) ? b : a;
    if (deleted[k] && deleted[k] >= (pick.updatedAt || "")) continue;
    tasks[k] = pick;
  }
  d.tasks = tasks;
  d.deleted = deleted;
}

function mergePeer(s) {
  if (!s || !s.docs) return false;
  mutate(
    (d) => {
      if (s.docs.tasks) mergeTasks(d, s.docs, false);
      mergeRecords(d, s.docs, s.stamps, false);
    },
    { keepStamps: true }
  );
  return true;
}

function applySnapshot(s) {
  if (!s || !s.docs) return false;
  mutate((d) => {
    for (const k of SYNC_KEYS) if (s.docs[k] !== undefined && !MERGED_KEYS.includes(k) && !SPECS[k]) d[k] = s.docs[k];
    if (s.docs.tasks) mergeTasks(d, s.docs, true);
    mergeRecords(d, s.docs, s.stamps, true);
  }, { keepStamps: true });
  if (s.seen) fs.writeFileSync(SEEN_FILE, JSON.stringify(s.seen, null, 1));
  require("../sessions/registry").changeRoutes((r) => {
    r.areas = r.areas || {};
    for (const [id, a] of Object.entries(s.areas || {})) {
      const next = { ...(r.areas[id] || {}), title: a.title, epics: a.epics };
      if (a.conversation) Object.assign(next, { conversation: a.conversation, session: a.session || next.session, ref: null });
      r.areas[id] = next;
    }
    for (const [role, v] of Object.entries(s.roles || {})) r[role] = { ...(r[role] || {}), ...v, ref: null };
    if (s.deployer) r.deployer = s.deployer;
    return true;
  });
  st.lastSnapshot = s.at;
  save();
  return true;
}

async function pullSnapshot() {
  const s = await peerGet("/api/cluster/snapshot", 30000);
  if (s && applySnapshot(s)) log(`snapshot de ${s.host} (${s.at})`);
  return !!s;
}
module.exports = { SYNC_KEYS, snapshot, mergeTasks, mergePeer, applySnapshot, pullSnapshot };

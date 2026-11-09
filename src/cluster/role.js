const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("../core/config");
const { DATA_DIR, now } = require("../core/data");

const CLUSTER = config.cluster || null;
const STATE_FILE = path.join(DATA_DIR, "cluster.json");
const STALE_STATE_MS = 5 * 60000;
const elapsed = (iso) => Date.now() - new Date(iso).getTime();
const readState = () => {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {}
  if (!CLUSTER) return s || { role: "primary", since: now() };
  if (!s) return { role: "follower", since: now() };
  if (s.role === "primary" && s.savedAt && elapsed(s.savedAt) > STALE_STATE_MS) return { ...s, role: "follower", since: now(), manual: false, pendingPull: null, wokeStale: true };
  return s;
};
const st = readState();
const save = () => {
  st.savedAt = now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
};
const log = (m) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "cluster.log"), `[${now()}] ${m}\n`);
  } catch (e) {}
};

const isPrimary = () => !CLUSTER || st.role === "primary";
const primaryNow = () => !CLUSTER || readState().role === "primary";
const info = () => ({ label: CLUSTER ? CLUSTER.label || null : null, role: isPrimary() ? "primary" : "follower", since: st.since, manual: !!(isPrimary() && st.manual), lastSnapshot: st.lastSnapshot || null, lastTranscripts: st.lastTranscripts || null, pendingPull: st.pendingPull || null, host: os.hostname(), sshUser: os.userInfo().username, self: CLUSTER ? CLUSTER.self : null, peer: CLUSTER ? CLUSTER.peer : null, claudeToken: require("../features/claude-token").tokenStatus(), macPower: process.platform === "darwin" ? require("../features/mac-power").status() : st.peerMacPower || null });

module.exports = { CLUSTER, st, save, log, elapsed, readState, isPrimary, primaryNow, info };

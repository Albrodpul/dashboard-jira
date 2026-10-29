const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { DATA_DIR } = require("./data");

const REPO = path.join(__dirname, "..");
const HOST_FILES = ["src/host.js", "src/platform.js", "src/config.js", "src/data.js"];
let quietChecks = 0;

const log = (m) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "host.log"), `[${new Date().toISOString()}] ${m}\n`);
  } catch (e) {}
};

function git(args) {
  try {
    return cp.execFileSync("git", ["-C", REPO, ...args], { windowsHide: true }).toString().trim();
  } catch (e) {
    return null;
  }
}

function hostIsBehind(hostHead) {
  const head = git(["rev-parse", "HEAD"]);
  if (!head || hostHead === head) return false;
  if (!hostHead) return true;
  const changed = git(["diff", "--name-only", hostHead, head, "--", ...HOST_FILES]);
  return changed === null || changed.length > 0;
}

async function refreshHostWhenQuiet() {
  const host = require("./host");
  const version = await host.hostRequest("GET", "/version").catch(() => null);
  const hosted = await host.hostRequest("GET", "/sessions").catch(() => null);
  if (!Array.isArray(hosted) || !hostIsBehind(version && version.head)) return (quietChecks = 0);
  const s = require("./state").state();
  const live = new Map(((s.sessions && s.sessions.list) || []).map((x) => [x.conversation, x]));
  const quiet = hosted.filter((h) => h.running).every((h) => {
    const l = live.get(h.conversation);
    return !l || l.status === "idle";
  });
  const asking = ((s.permissions && s.permissions.pending) || []).length > 0;
  quietChecks = quiet && !asking ? quietChecks + 1 : 0;
  if (quietChecks < 2) return;
  quietChecks = 0;
  log("el gestor de sesiones va con código viejo y todas las sesiones están paradas: lo reinicio");
  await host.hostRequest("POST", "/quit").catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  await host.ensureHost();
}

module.exports = { refreshHostWhenQuiet };

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const config = require("./config");
const { mutate, now } = require("./data");

const ROOT = config.root;

function git(args) {
  return new Promise((resolve) => {
    cp.execFile("git", ["-C", ROOT, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") }));
  });
}

const enabled = () => fs.existsSync(path.join(ROOT, ".git"));

function record(patch) {
  mutate((d) => {
    d.contextSync = { ...(d.contextSync || {}), ...patch, at: now() };
  });
}

let running = false;

async function syncContext() {
  if (running || !enabled()) return;
  running = true;
  try {
    const status = await git(["status", "--porcelain"]);
    if (!status.ok) return record({ state: "error", error: status.out.slice(0, 300) });
    if (status.out.trim()) {
      await git(["add", "-A"]);
      const commit = await git(["commit", "-q", "-m", `Contexto desde ${os.hostname()}`]);
      if (!commit.ok && !/nothing to commit/.test(commit.out)) return record({ state: "error", error: commit.out.slice(0, 300) });
    }
    const pull = await git(["pull", "--rebase", "--autostash", "-q"]);
    if (!pull.ok) {
      await git(["rebase", "--abort"]);
      record({ state: "conflict", error: pull.out.slice(0, 500) });
      require("./push")
        .sendPush("sessions", true, "El contexto compartido tiene un choque entre los dos ordenadores: hay que resolverlo a mano")
        .catch(() => {});
      return;
    }
    const ahead = await git(["rev-list", "--count", "@{u}..HEAD"]);
    if (ahead.ok && Number(ahead.out.trim()) > 0) {
      const pushed = await git(["push", "-q"]);
      if (!pushed.ok) return record({ state: "error", error: pushed.out.slice(0, 300) });
    }
    record({ state: "ok", error: null, lastOk: now() });
  } finally {
    running = false;
  }
}

module.exports = { syncContext, contextSyncEnabled: enabled };

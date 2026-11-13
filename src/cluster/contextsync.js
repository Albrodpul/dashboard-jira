const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const config = require("../core/config");
const { load, mutate, now } = require("../core/data");

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
const REPO = path.join(__dirname, "..", "..");

function repoGit(args) {
  return new Promise((resolve) => {
    cp.execFile("git", ["-C", REPO, ...args], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") }));
  });
}

let runningHead = null;
try {
  runningHead = cp.execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { windowsHide: true }).toString().trim();
} catch (e) {}

function boardUpdate(patch) {
  mutate((d) => {
    d.boardUpdate = { ...(d.boardUpdate || {}), ...patch, at: now() };
  });
}

async function updateBoard() {
  const pull = await repoGit(["pull", "--ff-only", "-q"]);
  if (!pull.ok) {
    const first = !(load().boardUpdate || {}).error;
    boardUpdate({ state: "error", error: pull.out.trim().slice(0, 300) || "no se pudo bajar el tablero de GitHub" });
    if (first && !/Could not resolve host|unable to access|Network is unreachable|timed out/i.test(pull.out))
      require("../server/push")
        .sendPush("sessions", true, `El tablero de ${os.hostname()} no se puede poner al día solo: ${pull.out.trim().split("\n")[0].slice(0, 120)}`)
        .catch(() => {});
    return;
  }
  const after = await repoGit(["rev-parse", "HEAD"]);
  boardUpdate({ state: "ok", error: null, head: after.out.trim().slice(0, 7), lastOk: now() });
  if (!runningHead || !after.ok || runningHead === after.out.trim()) return;
  const changed = await repoGit(["diff", "--name-only", runningHead, after.out.trim()]);
  if (/package(-lock)?\.json/.test(changed.out)) await new Promise((r) => cp.execFile(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: REPO, shell: process.platform === "win32", windowsHide: true, timeout: 300000 }, () => r()));
  if (/(^|\n)(templates\/|install\.js)/.test(changed.out)) await new Promise((r) => cp.execFile(process.execPath, [path.join(REPO, "install.js"), config.workspace], { windowsHide: true, timeout: 60000 }, () => r()));
  cp.spawn(process.execPath, [path.join(REPO, "src", "cli.js"), "restart"], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, TOWER_WORKSPACE: config.workspace } }).unref();
}

async function syncContext() {
  if (running) return;
  running = true;
  try {
    if (enabled()) await syncContextRepo();
  } finally {
    try {
      await updateBoard();
    } finally {
      running = false;
    }
  }
}

async function syncContextRepo() {
  const status = await git(["status", "--porcelain"]);
  if (!status.ok) return record({ state: "error", error: status.out.slice(0, 300) });
  if (status.out.trim()) {
    await git(["add", "-A"]);
    const commit = await git(["commit", "-q", "-m", `Contexto desde ${os.hostname()}`]);
    if (!commit.ok && !/nothing to commit/.test(commit.out)) return record({ state: "error", error: commit.out.slice(0, 300) });
  }
  const pull = await git(["pull", "--rebase", "--autostash", "-q"]);
  if (!pull.ok) {
    const clash = /CONFLICT|could not apply|Resolve all conflicts|needs merge/i.test(pull.out);
    await git(["rebase", "--abort"]);
    if (!clash) return record({ state: "error", error: pull.out.trim().slice(0, 300) || "no se pudo hablar con GitHub (¿sin conexión al despertar?)" });
    const already = (load().contextSync || {}).state === "conflict";
    record({ state: "conflict", error: pull.out.slice(0, 500) });
    if (!already)
      require("../server/push")
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
}

let lastBeat = Date.now();

function wakeCheck() {
  const gap = Date.now() - lastBeat;
  lastBeat = Date.now();
  if (gap > 3 * 60000) setTimeout(() => syncContext().catch(() => {}), 20000);
}

module.exports = { syncContext, wakeCheck, contextSyncEnabled: enabled };

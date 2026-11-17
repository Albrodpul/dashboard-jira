const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const config = require("../core/config");
const { DATA_DIR } = require("../core/data");
const { killTree } = require("../core/platform");

const STATE = path.join(DATA_DIR, "tunnel.json");
const LOG = path.join(DATA_DIR, "tunnel.log");

const ports = () => [...new Set(require("./devservers").servers(null, true).filter((s) => s.url && s.port).map((s) => s.port))];

function read() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch (e) {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function current() {
  const t = read();
  if (t && t.pid && alive(t.pid)) return t;
  if (t) fs.rmSync(STATE, { force: true });
  return null;
}

function lastError() {
  try {
    const lines = fs.readFileSync(LOG, "utf8").trim().split(/\r?\n/).filter((l) => l && !/^Warning: Permanently added/.test(l));
    return lines.slice(-2).join(" ").slice(0, 300) || null;
  } catch (e) {
    return null;
  }
}

function status() {
  const t = current();
  return { open: !!t, host: t ? t.host : null, since: t ? t.since : null, ports: ports(), error: t ? null : lastError() };
}

async function target() {
  const cluster = require("../cluster/cluster");
  const c = config.cluster || {};
  if (!c.peer) throw new Error("no hay otro ordenador configurado");
  const peer = await cluster.peerGet("/api/cluster", 5000);
  if (!peer) throw new Error("el otro ordenador no responde");
  if (peer.role !== "primary") throw new Error("el otro ordenador no manda: los proyectos están aquí");
  const host = c.peerSsh || `${peer.sshUser || os.userInfo().username}@${new URL(c.peer).hostname}`;
  return { host, label: peer.label || "el otro ordenador" };
}

// On Windows the tunnel runs as cmd.exe > ssh.exe; the pid that holds the ports, and the one to keep and kill, is ssh's.
function sshUnder(parent) {
  const r = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(parent)} AND Name='ssh.exe'" | Select-Object -First 1).ProcessId`], { windowsHide: true, encoding: "utf8", timeout: 20000 });
  return Number(String(r.stdout || "").trim()) || null;
}

async function open() {
  if (current()) return status();
  if (require("../cluster/cluster").primaryNow()) throw new Error("este ordenador manda: los proyectos se abren aquí directamente");
  const { host, label } = await target();
  await require("./devservers").standby().catch(() => {});
  const args = ["-N", "-C", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];
  for (const p of ports()) args.push("-L", `${p}:127.0.0.1:${p}`);
  args.push(host);
  let pid;
  if (process.platform === "win32") {
    fs.writeFileSync(LOG, "");
    const wrapper = require("./devservers").spawnHidden("ssh", args, os.homedir(), LOG);
    await new Promise((r) => setTimeout(r, 3500));
    pid = alive(wrapper) ? sshUnder(wrapper) : null;
    if (!pid) throw new Error(lastError() || "ssh no arranca");
  } else {
    const fd = fs.openSync(LOG, "w");
    const child = cp.spawn("ssh", args, { detached: true, stdio: ["ignore", fd, fd] });
    fs.closeSync(fd);
    child.unref();
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3500);
      child.once("exit", () => (clearTimeout(timer), resolve(true)));
      child.once("error", () => (clearTimeout(timer), resolve(true)));
    });
    if (exited || !child.pid) throw new Error(lastError() || "ssh no arranca");
    pid = child.pid;
  }
  fs.writeFileSync(STATE, JSON.stringify({ pid, host, label, since: new Date().toISOString() }));
  return status();
}

let peerCache = { at: 0, value: null };

async function remote() {
  const cluster = require("../cluster/cluster");
  if (!cluster.clusterEnabled() || cluster.primaryNow()) return null;
  if (Date.now() - peerCache.at > 60000) {
    const peer = await cluster.peerGet("/api/cluster", 3000);
    peerCache = { at: Date.now(), value: peer && peer.role === "primary" ? { label: peer.label || "el otro ordenador" } : null };
  }
  return peerCache.value;
}

function close() {
  const t = read();
  if (t && t.pid) killTree(t.pid);
  fs.rmSync(STATE, { force: true });
  return status();
}

function guard() {
  if (current() && require("../cluster/cluster").primaryNow()) close();
}

const pid = () => {
  const t = read();
  return t && t.pid ? t.pid : null;
};

module.exports = { status, open, close, guard, remote, pid };

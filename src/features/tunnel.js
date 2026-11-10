const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const net = require("net");
const config = require("../core/config");
const { DATA_DIR } = require("../core/data");
const { killTree } = require("../core/platform");

const STATE = path.join(DATA_DIR, "tunnel.json");
const LOG = path.join(DATA_DIR, "tunnel.log");

const ports = () => (config.devServers || []).filter((s) => s.url && s.port).map((s) => s.port);

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

const relays = new Map();

function relay(port, host) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ port, host });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const end = () => (client.destroy(), upstream.destroy());
    client.on("error", end);
    upstream.on("error", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return server;
}

function listen(server, port, address) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => (server.removeListener("error", reject), resolve(server)));
  });
}

async function startRelay(port, host) {
  if (relays.has(port)) return;
  const main = await listen(relay(port, host), port, "127.0.0.1").catch((e) => {
    throw new Error(e.code === "EADDRINUSE" ? `el puerto ${port} ya está ocupado en este ordenador` : String(e.message || e));
  });
  const servers = [main];
  const v6 = await listen(relay(port, host), port, "::1").catch(() => null);
  if (v6) servers.push(v6);
  relays.set(port, servers);
}

function stopRelays() {
  for (const servers of relays.values()) for (const s of servers) s.close();
  relays.clear();
}

function reachable(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => (sock.destroy(), resolve(ok));
    sock.setTimeout(ms, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function current() {
  const t = read();
  const sshOk = t && (!t.pid || alive(t.pid));
  if (t && sshOk && (t.pid || (t.direct || []).length)) {
    if ((t.direct || []).length && t.peerHost && !require("../cluster/cluster").primaryNow()) for (const p of t.direct) if (!relays.has(p)) startRelay(p, t.peerHost).catch(() => {});
    return t;
  }
  if (t) {
    if (t.pid) killTree(t.pid);
    stopRelays();
    fs.rmSync(STATE, { force: true });
  }
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
  return { open: !!t, host: t ? t.host : null, since: t ? t.since : null, ports: ports(), direct: t ? t.direct || [] : [], error: t ? null : lastError() };
}

async function target() {
  const cluster = require("../cluster/cluster");
  const c = config.cluster || {};
  if (!c.peer) throw new Error("no hay otro ordenador configurado");
  const peer = await cluster.peerGet("/api/cluster", 5000);
  if (!peer) throw new Error("el otro ordenador no responde");
  if (peer.role !== "primary") throw new Error("el otro ordenador no manda: los proyectos están aquí");
  const host = c.peerSsh || `${peer.sshUser || os.userInfo().username}@${new URL(c.peer).hostname}`;
  return { host, label: peer.label || "el otro ordenador", peerHost: new URL(c.peer).hostname };
}

async function open() {
  if (current()) return status();
  if (require("../cluster/cluster").primaryNow()) throw new Error("este ordenador manda: los proyectos se abren aquí directamente");
  const { host, label, peerHost } = await target();
  await require("./devservers").standby().catch(() => {});
  const all = ports();
  const checks = await Promise.all(all.map((p) => reachable(peerHost, p)));
  const direct = all.filter((p, i) => checks[i]);
  const viaSsh = all.filter((p, i) => !checks[i]);
  try {
    for (const p of direct) await startRelay(p, peerHost);
  } catch (e) {
    stopRelays();
    throw e;
  }
  if (!viaSsh.length) {
    fs.writeFileSync(LOG, "");
    fs.writeFileSync(STATE, JSON.stringify({ pid: null, host, label, peerHost, direct, since: new Date().toISOString() }));
    return status();
  }
  const args = ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];
  for (const p of viaSsh) args.push("-L", `${p}:127.0.0.1:${p}`);
  args.push(host);
  const fd = fs.openSync(LOG, "w");
  const child = cp.spawn("ssh", args, { detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  child.unref();
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3500);
    child.once("exit", () => (clearTimeout(timer), resolve(true)));
    child.once("error", () => (clearTimeout(timer), resolve(true)));
  });
  if (exited || !child.pid) {
    stopRelays();
    throw new Error(lastError() || "ssh no arranca");
  }
  fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, host, label, peerHost, direct, since: new Date().toISOString() }));
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
  stopRelays();
  fs.rmSync(STATE, { force: true });
  return status();
}

function guard() {
  const t = current();
  if (t && require("../cluster/cluster").primaryNow()) close();
}

const pid = () => {
  const t = read();
  return t && t.pid ? t.pid : null;
};

module.exports = { status, open, close, guard, remote, relay, reachable, pid };

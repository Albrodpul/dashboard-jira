const http = require("http");
const { PORT, BASE_URL } = require("../core/data");
const { syncJiraEpics, refreshAttachments } = require("../jira/client");
const tasks = require("./routes/tasks");
const operations = require("./routes/operations");
const { fetchQuota } = require("../features/quota");
const learning = require("../jira/learning");
const voice = require("../features/voice");
const deployStatus = require("../features/deploy-status");
const devservers = require("../features/devservers");
const host = require("../sessions/host");
const net = require("net");
const https = require("https");
const tls = require("tls");
const cluster = require("../cluster/cluster");
const { hostOk, originOk, send } = require("./http");
const { LABEL, serveAsset } = require("./assets");
const { POST_ROUTES, handleGet } = require("./routes");

function handle(req, res) {
  if (!hostOk(req.headers.host || "")) return res.writeHead(403).end("host no permitido");
  const url = req.url.split("?")[0];
  if (forwardsToPrimary(url)) return forwardToPrimary(req, res, () => handleLocal(req, res, url));
  handleLocal(req, res, url);
}

const LOCAL_API = /^\/api\/(cluster|claude-token\/|push\/|host\/(respawned|prompt|sessions)|permission\/(check|perm-)|quit)/;
const forwardsToPrimary = (url) => url.startsWith("/api/") && !LOCAL_API.test(url) && !cluster.isPrimary() && !!cluster.info().peer;

function peerHeaders(req, peer) {
  const headers = { ...req.headers, host: peer.host };
  if (headers.origin) headers.origin = peer.origin;
  return headers;
}

function forwardToPrimary(req, res, fallback) {
  const peer = new URL(cluster.info().peer);
  const out = https.request({ host: peer.hostname, port: peer.port || 443, method: req.method, path: req.url, headers: peerHeaders(req, peer), timeout: 15000 }, (up) => {
    res.writeHead(up.statusCode, { ...up.headers, "x-tower-via": LABEL || "otro" });
    up.pipe(res);
  });
  out.on("timeout", () => out.destroy(new Error("timeout")));
  out.on("error", () => {
    if (res.headersSent) return res.destroy();
    if (req.method === "GET") {
      res.setHeader("x-tower-stale", LABEL || "otro");
      return fallback();
    }
    send(res, 502, { error: "el ordenador que manda no responde" });
  });
  req.pipe(out);
}

function handleLocal(req, res, url) {
  if (req.method === "GET" && (serveAsset(res, url) || handleGet(req, res, url))) return;
  if (req.method === "POST" && url === "/api/quit") {
    if (!originOk(req)) return res.writeHead(403).end("origen no permitido");
    res.writeHead(200).end("bye");
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (req.method === "POST" && url === "/api/upload") {
    if (!originOk(req)) return res.writeHead(403).end("origen no permitido");
    return require("./uploads").handleUpload(req, res, send);
  }
  if (req.method === "POST" && url === "/api/voice") {
    if (!originOk(req) || !(req.headers["content-type"] || "").startsWith("audio/")) return res.writeHead(403).end("origen no permitido");
    return voice.handleVoice(req, res, send, operations.handleMessage).catch((e) => send(res, 500, { error: String(e.message || e) }));
  }
  const route = req.method === "POST" && POST_ROUTES[url];
  if (!route) return res.writeHead(404).end();
  if (!originOk(req) || !(req.headers["content-type"] || "").startsWith("application/json")) return res.writeHead(403).end("origen no permitido");
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 20000) req.destroy();
  });
  req.on("end", () => {
    let input;
    try {
      input = JSON.parse(body);
    } catch (e) {
      return send(res, 400, { error: "petición no válida" });
    }
    try {
      route(res, input, send);
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
  });
}

function proxyTerminal(req, socket, head) {
  const m = /^\/api\/term\/([0-9a-f-]{36})$/.exec(req.url || "");
  if (!m || !originOk(req)) return socket.destroy();
  if (forwardsToPrimary(req.url)) return proxyTerminalToPrimary(req, socket, head);
  const upstream = net.connect(host.HOST_PORT, "127.0.0.1", () => {
    const lines = [`GET /attach/${m[1]} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^host$/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push(`Host: 127.0.0.1:${host.HOST_PORT}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function proxyTerminalToPrimary(req, socket, head) {
  const peer = new URL(cluster.info().peer);
  const headers = peerHeaders(req, peer);
  const upstream = tls.connect({ host: peer.hostname, port: Number(peer.port) || 443, servername: peer.hostname }, () => {
    const lines = [`GET ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function serve() {
  const agent = require("../core/mac-agent");
  if (agent.isMac && !agent.underAgent()) {
    const { DATA_DIR } = require("../core/data");
    const config = require("../core/config");
    if (agent.install(require("path").join(__dirname, "..", "cli.js"), config.workspace, require("path").join(DATA_DIR, "serve.log"))) {
      console.log("NutrIA pasa a ejecutarse como servicio del Mac (launchd), que lo mantiene siempre en marcha.");
      return process.exit(0);
    }
  }
  const server = http.createServer(handle);
  server.on("upgrade", proxyTerminal);
  host.ensureHost().catch(() => {});
  server.listen(PORT, "127.0.0.1", () => console.log(`NutrIA en ${BASE_URL}`));
  const every = (fn, ms) => {
    const once = () => Promise.resolve().then(fn).catch(() => {});
    once();
    setInterval(once, ms);
  };
  every(syncJiraEpics, 30 * 60 * 1000);
  every(refreshAttachments, 45 * 1000);
  every(tasks.archiveDone, 10 * 60 * 1000);
  every(fetchQuota, 10 * 60 * 1000);
  every(learning.startReading, 3 * 60 * 60 * 1000);
  deployStatus.startDeployStatus();
  every(devservers.schedule, 60 * 1000);
  every(require("../cluster/contextsync").syncContext, 3 * 60 * 1000);
  every(require("../cluster/cluster").tick, 30 * 1000);
  every(require("../sessions/autosleep").sleepIdleSessions, 5 * 60 * 1000);
  every(require("../sessions/hostfresh").refreshHostWhenQuiet, 3 * 60 * 1000);
  every(require("../features/daily").dailyIfMissing, 60 * 60 * 1000);
  every(require("../features/claude-token").warnExpiry, 3 * 60 * 60 * 1000);
  every(require("../features/memory-sync").syncMemory, 10 * 60 * 1000);
  every(require("../features/mac-power").tick, 60 * 1000);
  every(require("../sessions/rotate").rotateIfMorning, 5 * 60 * 1000);
  setTimeout(() => require("../features/files").warmFiles(), 5000);
  setTimeout(() => require("./smoke").smokeAfterUpdate().catch(() => {}), 30000);
}

module.exports = { serve };

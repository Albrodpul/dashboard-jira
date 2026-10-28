const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const { DATA_DIR, PORT, BASE_URL } = require("./data");
const { syncJiraEpics, refreshAttachments } = require("./jira");
const { pushReason, pushKeys, handlePush } = require("./push");
const { state, startOrchestrator, openIfClosed, wakeOrchestrator } = require("./state");
const tasks = require("./api-tasks");
const sessions = require("./api-sessions");
const operations = require("./api-operations");
const { handlePeople } = require("./follow-up");
const { fetchQuota } = require("./quota");
const learning = require("./learning");
const voice = require("./voice");
const speech = require("./speech");
const deployStatus = require("./deploy-status");
const sentry = require("./sentry");

const PAGE_DIR = path.join(__dirname, "page");
const HOSTS_FILE = path.join(DATA_DIR, "board-hosts.txt");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const MANIFEST = JSON.stringify({
  name: "Torre de control",
  short_name: "Torre",
  description: "Tareas de Jira que se pueden pasar a la sesión que lleva su epic.",
  lang: "es",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#eef1f4",
  theme_color: "#0b6e8a",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
});

const SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
self.addEventListener("push", (e) => {
  e.waitUntil(
    fetch("/api/push/reason", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => ({}))
      .then((d) => self.registration.showNotification(d.title || "Torre de control", { body: d.text || "Hay novedades", tag: d.tag || "board", renotify: true, icon: "/icon-192.png", badge: "/icon-192.png", data: { tab: d.tab || "" } }))
  );
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || "";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
      const w = ws.find((x) => "focus" in x);
      if (!w) return self.clients.openWindow(tab ? "/?tab=" + tab : "/");
      if (tab) w.postMessage({ tab });
      return w.focus();
    })
  );
});
`;

const icons = new Map();

function icon(side) {
  if (icons.has(side)) return icons.get(side);
  const background = [11, 110, 138];
  const paper = [255, 255, 255];
  const accent = [255, 196, 87];
  const row = side * 4 + 1;
  const raw = Buffer.alloc(row * side);
  const inside = (x, y, x0, y0, x1, y1) => x >= x0 * side && x < x1 * side && y >= y0 * side && y < y1 * side;
  for (let y = 0; y < side; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < side; x++) {
      let c = background;
      if (inside(x, y, 0.2, 0.22, 0.8, 0.36) || inside(x, y, 0.2, 0.43, 0.8, 0.57) || inside(x, y, 0.2, 0.64, 0.8, 0.78)) c = paper;
      if (inside(x, y, 0.2, 0.22, 0.26, 0.36)) c = accent;
      raw.set([...c, 255], y * row + 1 + x * 4);
    }
  }
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  icons.set(side, png);
  return png;
}

const POST_ROUTES = {
  "/api/task": (res, input, send) => tasks.handleTask(res, input, send),
  "/api/batch": (res, input, send) => tasks.handleBatch(res, input, send),
  "/api/delete": (res, input, send) => tasks.handleDelete(res, input, send),
  "/api/answer": (res, input, send) => tasks.handleAnswer(res, input, send),
  "/api/reviewed": (res, input, send) => tasks.handleReviewed(res, input, send),
  "/api/comment": (res, input, send) => tasks.handleComment(res, input, send),
  "/api/config": (res, input, send) => tasks.handleConfig(res, input, send),
  "/api/refresh": (res, input, send) => tasks.handleRefresh(res, send),
  "/api/search": (res, input, send) => tasks.handleSearch(res, input, send),
  "/api/import": (res, input, send) => tasks.handleImport(res, input, send),
  "/api/session": (res, input, send) => sessions.handleSession(res, input, send),
  "/api/new-session": (res, input, send) => sessions.handleNewSession(res, input, send),
  "/api/epic": (res, input, send) => sessions.handleEpic(res, input, send),
  "/api/deploy": (res, input, send) => operations.handleDeploy(res, input, send),
  "/api/deploy-status/refresh": (res, input, send) => deployStatus.handleDeployStatusRefresh(res, send),
  "/api/tidy": (res, input, send) => operations.handleTidy(res, send),
  "/api/message": (res, input, send) => operations.handleMessage(res, input, send),
  "/api/followup-error": (res, input, send) => operations.handleFollowUpError(res, input, send),
  "/api/followup-request": (res, input, send) => operations.handleFollowUpRequest(res, input, send),
  "/api/wake-orchestrator": (res, input, send) => {
    startOrchestrator(true).catch(() => {});
    send(res, 200);
  },
  "/api/people": (res, input, send) => handlePeople(res, input, send),
  "/api/layout-report": (res, input, send) => {
    fs.writeFileSync(path.join(DATA_DIR, "layout-report.json"), JSON.stringify({ at: new Date().toISOString(), ...input }, null, 1).slice(0, 8000));
    send(res, 200);
  },
  "/api/audio-report": (res, input, send) => {
    fs.writeFileSync(path.join(DATA_DIR, "audio-report.json"), JSON.stringify({ at: new Date().toISOString(), ...input }, null, 1).slice(0, 20000));
    send(res, 200);
  },
  "/api/sentry/send": (res, { issues, area }, send) => {
    if (!Array.isArray(issues) || !issues.length || !area) return send(res, 400, { error: "faltan los errores o la sesión" });
    const n = sentry.sendIssues(issues.slice(0, 50), String(area));
    if (n) {
      openIfClosed(String(area));
      wakeOrchestrator();
    }
    send(res, 200, { sent: n });
  },
  "/api/sentry/discard": (res, { id }, send) => send(res, sentry.discard(String(id)) ? 200 : 409),
  "/api/learning-read": (res, input, send) => send(res, 200, { started: learning.startReading() }),
  "/api/push/subscribe": (res, input, send) => handlePush(res, "/api/push/subscribe", input, send),
  "/api/push/unsubscribe": (res, input, send) => handlePush(res, "/api/push/unsubscribe", input, send),
  "/api/push/test": (res, input, send) => handlePush(res, "/api/push/test", input, send),
};

function extraHosts() {
  try {
    return fs
      .readFileSync(HOSTS_FILE, "utf8")
      .split("\n")
      .map((x) => x.trim().toLowerCase().split("://").pop().split("/")[0])
      .filter((x) => x && !x.startsWith("#"));
  } catch (e) {
    return [];
  }
}

const hostOk = (h) => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || extraHosts().includes(String(h).toLowerCase());
const originOk = (req) => !req.headers.origin || hostOk(req.headers.origin.replace(/^https?:\/\//, ""));
const send = (res, code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body || {}));

function serveBody(res, type, body, cache) {
  res.writeHead(200, { "content-type": type, "cache-control": cache || "no-store" });
  res.end(body);
}

function pageFile(url) {
  if (url === "/" || url === "/index.html") return path.join(PAGE_DIR, "index.html");
  const m = /^\/page\/([a-z0-9-]+\.(?:js|css))$/.exec(url);
  return m ? path.join(PAGE_DIR, m[1]) : null;
}

function handle(req, res) {
  if (!hostOk(req.headers.host || "")) return res.writeHead(403).end("host no permitido");
  const url = req.url.split("?")[0];
  if (req.method === "GET") {
    const file = pageFile(url);
    if (file) {
      let body;
      try {
        body = fs.readFileSync(file);
      } catch (e) {
        return res.writeHead(404).end();
      }
      return serveBody(res, TYPES[path.extname(file)], body);
    }
    if (url === "/manifest.webmanifest") return serveBody(res, "application/manifest+json", MANIFEST);
    if (url === "/sw.js") return serveBody(res, "text/javascript", SERVICE_WORKER);
    if (url === "/api/push/reason") return serveBody(res, "application/json", JSON.stringify(pushReason()));
    if (url === "/api/push/key") return serveBody(res, "application/json", JSON.stringify({ key: pushKeys().publicKey }));
    if (url === "/api/sentry" || url === "/api/sentry?force=1") {
      sentry
        .listIssues(url.endsWith("force=1"))
        .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
        .catch((e) => serveBody(res, "application/json", JSON.stringify({ available: true, issues: [], errors: [String(e.message || e)] })));
      return;
    }
    if (url === "/api/learning") return serveBody(res, "application/json", JSON.stringify(learning.learningSummary()));
    if (url === "/api/state") return serveBody(res, "application/json", JSON.stringify({ ...state(), voice: voice.voiceAvailable(), speech: speech.speechAvailable(), deployStatus: deployStatus.readStatus() }));
    if (url.startsWith("/api/voice/")) return voice.serveVoice(res, url);
    if (url.startsWith("/api/speech/")) return speech.serveSpeech(res, url);
    if (["/icon-192.png", "/icon-512.png", "/favicon.ico"].includes(url)) return serveBody(res, "image/png", icon(url === "/icon-512.png" ? 512 : 192), "max-age=86400");
  }
  if (req.method === "POST" && url === "/api/quit") {
    if (!originOk(req)) return res.writeHead(403).end("origen no permitido");
    res.writeHead(200).end("bye");
    setTimeout(() => process.exit(0), 50);
    return;
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

function serve() {
  http.createServer(handle).listen(PORT, "127.0.0.1", () => console.log(`Torre de control en ${BASE_URL}`));
  const every = (fn, ms) => {
    const once = () => Promise.resolve().then(fn).catch(() => {});
    once();
    setInterval(once, ms);
  };
  every(syncJiraEpics, 30 * 60 * 1000);
  every(refreshAttachments, 45 * 1000);
  every(tasks.archiveDone, 10 * 60 * 1000);
  every(fetchQuota, 3 * 60 * 1000);
  every(learning.startReading, 3 * 60 * 60 * 1000);
  deployStatus.startDeployStatus();
}

module.exports = { serve };

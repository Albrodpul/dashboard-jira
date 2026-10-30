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
const devservers = require("./devservers");
const permissions = require("./permissions");
const host = require("./host");
const net = require("net");
const https = require("https");
const tls = require("tls");
const cluster = require("./cluster");

const PAGE_DIR = path.join(__dirname, "page");
const HOSTS_FILE = path.join(DATA_DIR, "board-hosts.txt");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const LABEL = (require("./config").cluster || {}).label || "";
const MANIFEST = JSON.stringify({
  name: LABEL ? `NutrIA · ${LABEL}` : "NutrIA",
  short_name: LABEL ? `NutrIA ${LABEL}` : "NutrIA",
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
  let sent = null;
  try {
    sent = e.data ? e.data.json() : null;
  } catch (x) {}
  e.waitUntil(
    (sent ? Promise.resolve(sent) : fetch("/api/push/reason", { cache: "no-store" }).then((r) => r.json()))
      .catch(() => ({}))
      .then((d) => show(d))
  );
});
const section = (title) => String(title || "").split(" · ").slice(1).join(" · ");
async function show(d) {
  const item = { section: section(d.title), text: d.text || "Hay novedades", tab: d.tab || "" };
  const open = await self.registration.getNotifications({ tag: "torre" });
  const before = open.flatMap((n) => (n.data && n.data.items) || []);
  open.forEach((n) => n.close());
  const items = [item, ...before].slice(0, 20);
  const options = { tag: "torre", renotify: true, icon: "/icon-192.png", badge: "/icon-192.png", data: { tab: item.tab, items } };
  if (items.length === 1) return self.registration.showNotification(d.title || "NutrIA", { ...options, body: item.text });
  const tabs = new Set(items.map((x) => x.tab));
  options.data.tab = tabs.size === 1 ? item.tab : "home";
  const lines = items.slice(0, 6).map((x) => (x.section ? x.section + ": " : "") + x.text);
  if (items.length > 6) lines.push("y " + (items.length - 6) + " más");
  return self.registration.showNotification("NutrIA · " + items.length + " novedades", { ...options, body: lines.join(String.fromCharCode(10)) });
}
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
  const background = (require("./config").cluster || {}).color || [11, 110, 138];
  const hex = background.map((n) => n.toString(16).padStart(2, "0")).join("");
  try {
    const drawn = fs.readFileSync(path.join(PAGE_DIR, "icons", `icon-${side}-${hex}.png`));
    icons.set(side, drawn);
    return drawn;
  } catch (e) {}
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
  "/api/term-claim": (res, input, send) => {
    fs.appendFileSync(path.join(DATA_DIR, "term-claims.log"), `${new Date().toISOString()} ${String(input.conversation || "").slice(0, 8)} ${input.why} ${input.from} -> ${input.cols}x${input.rows} ${String(input.device || "").slice(0, 120)}
`);
    send(res, 200);
  },
  "/api/page-errors": (res, input, send) => {
    fs.writeFileSync(path.join(DATA_DIR, "page-errors.json"), JSON.stringify({ at: new Date().toISOString(), ...input }, null, 1).slice(0, 20000));
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
  "/api/daily": (res, { today }, send) => {
    const daily = require("./daily");
    daily.dailyFor(today ? new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" }) : daily.lastWorkday()).catch(() => {});
    send(res, 200, { ok: true });
  },
  "/api/cluster/yield": (res, input, send) => {
    cluster
      .handleYield(input)
      .catch(() => {})
      .then(() => send(res, 200));
  },
  "/api/cluster/take": (res, input, send) =>
    cluster
      .takeHere()
      .then((r) => send(res, r.ok ? 200 : 409, r))
      .catch((e) => send(res, 500, { error: String(e.message || e) })),
  "/api/cluster/auto": (res, input, send) => send(res, 200, cluster.backToAuto()),
  "/api/cluster/command": (res, { target, action }, send) =>
    cluster
      .command(target, action)
      .then((r) => send(res, r.ok ? 200 : 409, r))
      .catch((e) => send(res, 500, { error: String(e.message || e) })),
  "/api/host/respawned": (res, { conversation }, send) => {
    send(res, 200);
    if (!require("./cluster").isPrimary()) return;
    const r = require("./sessions").loadRoutes();
    const s = state();
    const is = (role) => r[role] && r[role].conversation === conversation;
    const { wakeSession, STARTUP_NOTICE } = require("./sessions");
    if (is("orchestrator") && s.orchestrator) return wakeSession(s.orchestrator.session, require("./state").ORCHESTRATOR_NOTICE).catch(() => {});
    if (is("reporter") && s.reporterStatus) return wakeSession(s.reporterStatus.session, STARTUP_NOTICE).catch(() => {});
    if (is("board") && s.boardStatus) return wakeSession(s.boardStatus.session, "Aviso del tablero: arranca la sesión del tablero. Eres la sesión del tablero registrada: ejecuta ahora .claude/commands/tablero.md (regla de AGENTS.md).").catch(() => {});
    if (is("followUp")) return require("./startup").wakeFollowUp().catch(() => {});
  },
  "/api/host/action": (res, { action, conversation, name }, send) => {
    if (!/^[0-9a-f-]{36}$/.test(String(conversation || ""))) return send(res, 400, { error: "conversación no válida" });
    const go = async () => {
      await host.ensureHost();
      if (action === "move") {
        if (host.vsCodeHas(conversation)) {
          host.markWaiting(conversation, name);
          return { waiting: true };
        }
        const isRole = ["reporter", "orchestrator", "followUp", "board"].some((k) => { const r = require("./sessions").loadRoutes()[k]; return r && r.conversation === conversation; });
        if (!isRole) {
          host.adopt(conversation, name);
          return { adopted: true };
        }
        return host.hostRequest("POST", "/start", { conversation, name });
      }
      if (action === "back") {
        await host.hostRequest("POST", "/release", { conversation });
        require("./sessions").openInVsCode(conversation);
        return { ok: true };
      }
      if (action === "open") return host.hostRequest("POST", "/start", { conversation, name });
      if (action === "sleep") {
        await host.hostRequest("POST", "/stop", { conversation });
        host.adopt(conversation, name);
        host.markOnDemand(conversation);
        return { ok: true };
      }
      if (action === "restart") {
        await host.hostRequest("POST", "/stop", { conversation });
        await new Promise((r) => setTimeout(r, 1500));
        return host.hostRequest("POST", "/start", { conversation, name });
      }
      throw new Error("acción desconocida");
    };
    go()
      .then((r) => send(res, 200, r))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
  },
  "/api/permission/check": (res, input, send) => send(res, 200, permissions.check(input)),
  "/api/permission/decide": (res, { id, decision, reason }, send) => {
    const ok = permissions.decide(String(id), decision, reason);
    if (!ok) return send(res, 409);
    const p = (require("./data").load().permissions || []).find((x) => x.id === String(id));
    if (p && p.native) host.hostRequest("POST", "/input", { conversation: p.conversation, data: decision === "deny" ? "\x1b" : "1" }).catch(() => {});
    send(res, 200);
  },
  "/api/host/prompt": (res, input, send) => {
    const id = permissions.nativePrompt(input || {});
    if (id) require("./push").sendPush("permission", true, `${input.name || "Una sesión"} pide permiso: ${String(input.question || "").slice(0, 80)}`).catch(() => {});
    send(res, 200);
  },
  "/api/permission/rule-remove": (res, { key }, send) => send(res, permissions.removeRule(String(key)) ? 200 : 404),
  "/api/devservers": (res, { action, id }, send) => {
    const run = { start: () => devservers.start(id), stop: () => devservers.stop(id), restart: () => devservers.restart(id), startAll: () => devservers.startAll(false), stopAll: devservers.stopAll }[action];
    if (!run) return send(res, 400, { error: "acción desconocida" });
    run()
      .then((r) => send(res, 200, { result: r }))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
  },
  "/api/sentry/status": (res, { issueId, id, status }, send) => {
    sentry
      .setStatus(issueId, String(id || ""), status)
      .then(() => send(res, 200))
      .catch((e) => send(res, 502, { error: String(e.message || e) }));
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
  if (forwardsToPrimary(url)) return forwardToPrimary(req, res, () => handleLocal(req, res, url));
  handleLocal(req, res, url);
}

const LOCAL_API = /^\/api\/(cluster|push\/|host\/|permission|quit)/;
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
    if (url.startsWith("/api/permission/perm-")) return serveBody(res, "application/json", JSON.stringify(permissions.poll(url.slice("/api/permission/".length))));
    if (url === "/api/cluster") return serveBody(res, "application/json", JSON.stringify(require("./cluster").info()));
    if (url === "/api/cluster/snapshot") return serveBody(res, "application/json", JSON.stringify(require("./cluster").snapshot()));
    if (url === "/api/cluster/machines") {
      cluster
        .machines()
        .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
        .catch((e) => serveBody(res, "application/json", JSON.stringify({ error: String(e.message || e) })));
      return;
    }
    if (url === "/api/cluster/transcripts") return serveBody(res, "application/json", JSON.stringify(cluster.transcripts()));
    if (url.startsWith("/api/cluster/transcript/")) {
      const part = cluster.serveTranscript(url.slice("/api/cluster/transcript/".length), Number(new URLSearchParams(req.url.split("?")[1] || "").get("from")) || 0);
      if (!part) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-tail-hash": part.tail });
      return res.end(part.body);
    }
    if (url === "/api/host/sessions") {
      host
        .hostRequest("GET", "/sessions")
        .then((v) => serveBody(res, "application/json", JSON.stringify({ up: true, sessions: v, hosted: host.readConfig() })))
        .catch(() => serveBody(res, "application/json", JSON.stringify({ up: false, sessions: [], hosted: host.readConfig() })));
      return;
    }
    if (VENDOR[url]) {
      let body;
      try {
        body = fs.readFileSync(VENDOR[url][0]);
      } catch (e) {
        return res.writeHead(404).end();
      }
      return serveBody(res, VENDOR[url][1], body, "max-age=86400");
    }
    if (url === "/api/devservers") {
      devservers
        .status()
        .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
        .catch((e) => serveBody(res, "application/json", JSON.stringify({ servers: [], error: String(e.message || e) })));
      return;
    }
    if (url === "/api/sentry" || url === "/api/sentry?force=1") {
      sentry
        .listIssues(url.endsWith("force=1"))
        .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
        .catch((e) => serveBody(res, "application/json", JSON.stringify({ available: true, issues: [], errors: [String(e.message || e)] })));
      return;
    }
    if (url === "/api/files") {
      require("./files")
        .searchFiles(new URLSearchParams(req.url.split("?")[1] || "").get("q"))
        .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
        .catch(() => serveBody(res, "application/json", "[]"));
      return;
    }
    if (url === "/api/learning") return serveBody(res, "application/json", JSON.stringify(learning.learningSummary()));
    if (url === "/api/state") {
      const body = JSON.stringify({ ...state(), voice: voice.voiceAvailable(), speech: speech.speechAvailable(), deployStatus: deployStatus.readStatus() });
      const hash = require("crypto").createHash("sha1").update(body.replace(/"syncedAt":"[^"]*"/g, "")).digest("hex");
      if (req.headers["x-state-hash"] === hash) return res.writeHead(204, { "x-state-hash": hash, "cache-control": "no-store" }).end();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-state-hash": hash });
      return res.end(body);
    }
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

const NM = path.join(__dirname, "..", "node_modules", "@xterm");
const VENDOR = {
  "/vendor/xterm.js": [path.join(NM, "xterm", "lib", "xterm.js"), "text/javascript; charset=utf-8"],
  "/vendor/xterm.css": [path.join(NM, "xterm", "css", "xterm.css"), "text/css; charset=utf-8"],
  "/vendor/addon-fit.js": [path.join(NM, "addon-fit", "lib", "addon-fit.js"), "text/javascript; charset=utf-8"],
};

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
  every(fetchQuota, 3 * 60 * 1000);
  every(learning.startReading, 3 * 60 * 60 * 1000);
  deployStatus.startDeployStatus();
  every(devservers.schedule, 60 * 1000);
  every(require("./contextsync").syncContext, 3 * 60 * 1000);
  every(require("./cluster").tick, 30 * 1000);
  every(require("./autosleep").sleepIdleSessions, 5 * 60 * 1000);
  every(require("./hostfresh").refreshHostWhenQuiet, 3 * 60 * 1000);
  every(require("./daily").dailyIfMissing, 60 * 60 * 1000);
  setTimeout(() => require("./files").warmFiles(), 5000);
  setTimeout(() => require("./smoke").smokeAfterUpdate().catch(() => {}), 30000);
}

module.exports = { serve };

const fs = require("fs");
const path = require("path");
const http = require("http");
const cp = require("child_process");
const { DATA_DIR, ROOT, BASE_URL } = require("./data");

const HOST_PORT = Number(process.env.TOWER_HOST_PORT) || 4749;
const HOST_URL = `http://127.0.0.1:${HOST_PORT}`;
const CONFIG_FILE = path.join(DATA_DIR, "host-sessions.json");
const LOG_FILE = path.join(DATA_DIR, "host.log");
const BUFFER_BYTES = 400 * 1024;
const RESTART_MS = 5000;
const WORKDIR = ROOT.replace(/\\/g, "/").replace(/^([A-Z]):/, (m, d) => `${d.toLowerCase()}:`);
const PERMISSION_MODE = "acceptEdits";
const CLAUDE = process.env.CLAUDE_BIN || path.join(require("os").homedir(), ".local", "bin", "claude.exe");
const DIALOGS = [
  [/Claude ?in ?Chrome/i, "\x1b"],
  [/fullscreen ?renderer/i, "2\r"],
  [/trust ?this ?folder/i, "\r"],
  [/MCP ?servers ?found/i, "\r"],
];

const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    return [];
  }
};
const writeConfig = (list) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(list, null, 1));
const log = (m) => {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${m}\n`);
  } catch (e) {}
};
const sizeFrame = (s) => `\u0000${JSON.stringify({ cols: s.cols, rows: s.rows })}`;
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function serve() {
  const pty = require("@lydell/node-pty");
  const { WebSocketServer } = require("ws");
  const sessions = new Map();

  function spawn(entry, notify) {
    const prev = sessions.get(entry.conversation);
    if (prev && prev.pty) return prev;
    if (notify) setTimeout(() => tellBoard(entry.conversation), 20000);
    const s = prev || { conversation: entry.conversation, name: entry.name, buffer: "", clients: new Set(), cols: 120, rows: 40, restarts: 0 };
    s.name = entry.name;
    s.stopping = false;
    s.startedAt = new Date().toISOString();
    s.dialogMark = s.buffer.length;
    const args = [...(entry.fresh ? ["--session-id", entry.conversation] : ["--resume", entry.conversation]), "-n", entry.name, "--permission-mode", PERMISSION_MODE];
    if (entry.fresh) {
      const list = readConfig();
      const e = list.find((x) => x.conversation === entry.conversation);
      if (e) delete e.fresh;
      writeConfig(list);
      delete entry.fresh;
    }
    s.pty = pty.spawn(CLAUDE, args, { name: "xterm-256color", cols: s.cols, rows: s.rows, cwd: entry.cwd || WORKDIR, env: { ...require("./sessions").cleanEnv(), TOWER_HOSTED: "1" } });
    log(`start ${entry.name} ${entry.conversation} pid ${s.pty.pid}`);
    s.pty.onData((d) => {
      s.buffer += d;
      if (s.buffer.length > BUFFER_BYTES) s.buffer = s.buffer.slice(-BUFFER_BYTES);
      for (const ws of s.clients) if (ws.readyState === 1) ws.send(d);
      clearTimeout(s.promptTimer);
      s.promptTimer = setTimeout(() => checkPrompt(s), 900);
      if (Date.now() - new Date(s.startedAt).getTime() < 60000) {
        const fresh = plain(s.buffer.slice(Math.min(s.dialogMark, s.buffer.length)));
        for (const [re, keys] of DIALOGS) {
          if (re.test(fresh) && /Enter ?to ?confirm|Space ?to ?select/i.test(fresh)) {
            s.dialogMark = s.buffer.length;
            setTimeout(() => s.pty && s.pty.write(keys), 300);
            log(`dialog ${re} in ${entry.name}`);
            break;
          }
        }
      }
    });
    s.pty.onExit(({ exitCode }) => {
      log(`exit ${entry.name} code ${exitCode}: ${JSON.stringify(plain(s.buffer.slice(-600)))}`);
      s.pty = null;
      s.exitedAt = new Date().toISOString();
      for (const ws of s.clients) if (ws.readyState === 1) ws.send(`\r\n\x1b[33m[La sesión se ha cerrado (código ${exitCode}).${s.stopping ? "" : " Se reabre sola en unos segundos."}]\x1b[0m\r\n`);
      const still = readConfig().find((x) => x.conversation === entry.conversation);
      if (!s.stopping && still) {
        s.restarts++;
        setTimeout(() => readConfig().some((x) => x.conversation === entry.conversation) && spawn(still, true), RESTART_MS * Math.min(6, s.restarts));
      }
    });
    sessions.set(entry.conversation, s);
    return s;
  }

  function stop(conversation) {
    const s = sessions.get(conversation);
    if (!s || !s.pty) return false;
    s.stopping = true;
    const pid = s.pty.pid;
    try {
      s.pty.kill();
    } catch (e) {}
    try {
      cp.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch (e) {}
    return true;
  }

  const summary = () =>
    readConfig().map((e) => {
      const s = sessions.get(e.conversation);
      return { conversation: e.conversation, name: e.name, running: !!(s && s.pty), startedAt: s && s.startedAt, exitedAt: s && s.exitedAt, restarts: s ? s.restarts : 0, viewers: s ? s.clients.size : 0, waitingForVsCode: !!e.waitingForVsCode };
    });

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body || {}));
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let input = {};
      try {
        input = body ? JSON.parse(body) : {};
      } catch (e) {}
      if (req.method === "GET" && req.url === "/sessions") return json(res, 200, summary());
      if (req.method === "POST" && req.url === "/start") {
        const list = readConfig();
        let e = list.find((x) => x.conversation === input.conversation);
        if (!e) {
          if (!input.conversation || !input.name) return json(res, 400, { error: "faltan conversation y name" });
          e = { conversation: input.conversation, name: input.name, cwd: input.cwd || null, fresh: !!input.fresh, at: new Date().toISOString() };
          list.push(e);
          writeConfig(list);
        }
        if (e.waitingForVsCode) return json(res, 200, { waiting: true });
        if (e.onDemand) {
          const list2 = readConfig();
          const e2 = list2.find((x) => x.conversation === e.conversation);
          if (e2) delete e2.onDemand;
          writeConfig(list2);
          delete e.onDemand;
        }
        spawn(e, true);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/stop") return json(res, 200, { stopped: stop(input.conversation) });
      if (req.method === "POST" && req.url === "/release") {
        stop(input.conversation);
        writeConfig(readConfig().filter((x) => x.conversation !== input.conversation));
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/input") {
        const s = sessions.get(input.conversation);
        if (!s || !s.pty) return json(res, 409, { error: "la sesión no está en marcha" });
        s.pty.write(String(input.data || ""));
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/quit") {
        json(res, 200, { ok: true });
        for (const c of sessions.keys()) stop(c);
        return setTimeout(() => process.exit(0), 300);
      }
      json(res, 404, { error: "no existe" });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const m = /^\/attach\/([0-9a-f-]{36})/.exec(req.url || "");
    const s = m && sessions.get(m[1]);
    if (!s) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      s.clients.add(ws);
      ws.send(sizeFrame(s));
      ws.send(s.buffer);
      if (!s.pty) ws.send("\r\n\x1b[33m[La sesión no está en marcha.]\x1b[0m\r\n");
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch (e) {
          return;
        }
        if (msg.type === "input" && s.pty) s.pty.write(String(msg.data));
        if (msg.type === "resize" && s.pty && msg.cols > 20 && msg.rows > 5) {
          s.cols = Math.min(300, msg.cols | 0);
          s.rows = Math.min(120, msg.rows | 0);
          try {
            s.pty.resize(s.cols, s.rows);
          } catch (e) {}
          for (const c of s.clients) if (c.readyState === 1) c.send(sizeFrame(s));
        }
      });
      ws.on("close", () => s.clients.delete(ws));
    });
  });

  server.listen(HOST_PORT, "127.0.0.1", () => {
    log(`host listening on ${HOST_PORT}`);
    for (const e of readConfig()) if (!e.waitingForVsCode && !e.onDemand) spawn(e, true);
  });

  setInterval(() => {
    const list = readConfig();
    let changed = false;
    for (const e of list) {
      if (!e.waitingForVsCode) continue;
      if (!vsCodeHas(e.conversation)) {
        delete e.waitingForVsCode;
        changed = true;
        spawn(e, true);
      }
    }
    if (changed) writeConfig(list);
  }, 3000);
}

function killOrphanWatchers() {
  let rows;
  try {
    const out = cp.execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
    rows = JSON.parse(out);
  } catch (e) {
    return 0;
  }
  const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
  const SHELLS = /^(node|bash|sh|cmd|powershell|pwsh|conhost|timeout)\.exe$/i;
  let killed = 0;
  for (const r of rows) {
    if (!/\bwatch\s+(reports|dispatches|board)\b/.test(r.CommandLine || "") || !/^node\.exe$/i.test(r.Name || "")) continue;
    let p = byPid.get(r.ParentProcessId);
    while (p && SHELLS.test(p.Name || "")) p = byPid.get(p.ParentProcessId);
    if (p) continue;
    try {
      cp.execFileSync("taskkill", ["/PID", String(r.ProcessId), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killed++;
    } catch (e) {}
  }
  if (killed) log(`killed ${killed} orphan watcher(s)`);
  return killed;
}

const PROMPT = /Do you want to [^?\n]{1,160}\?/i;

function postBoard(route, body) {
  const data = JSON.stringify(body);
  const req = http.request(`${BASE_URL}${route}`, { method: "POST", timeout: 5000, headers: { origin: BASE_URL, "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => res.resume());
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.end(data);
}

function checkPrompt(s) {
  const text = plain(s.buffer.slice(-6000));
  const m = PROMPT.exec(text.slice(-2500));
  const asking = m && /1\.\s*Yes/i.test(text.slice(-2500));
  if (asking) {
    const tail = text.slice(-2500);
    const at = tail.search(PROMPT);
    const question = tail.slice(Math.max(0, at - 700), at + 400).replace(/[─━╌│╭╮╰╯]+/g, " ").replace(/\s+/g, " ").trim();
    const key = m[0] + question.slice(0, 200);
    if (s.promptKey === key) return;
    s.promptKey = key;
    log(`native prompt in ${s.name}: ${m[0]}`);
    postBoard("/api/host/prompt", { conversation: s.conversation, name: s.name, question: m[0], text: question.slice(-1500) });
  } else if (s.promptKey) {
    s.promptKey = null;
    postBoard("/api/host/prompt", { conversation: s.conversation, cleared: true });
  }
}

function tellBoard(conversation) {
  killOrphanWatchers();
  const data = JSON.stringify({ conversation });
  const req = http.request(`${BASE_URL}/api/host/respawned`, { method: "POST", timeout: 5000, headers: { origin: BASE_URL, "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => res.resume());
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.end(data);
}

function vsCodeHas(conversation) {
  const dir = path.join(require("os").homedir(), ".claude", "sessions");
  try {
    for (const f of fs.readdirSync(dir).filter((x) => /^\d+\.json$/.test(x))) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j.sessionId !== conversation) continue;
      try {
        process.kill(j.pid, 0);
      } catch (e) {
        continue;
      }
      if (!hostedPid(j.pid)) return true;
    }
  } catch (e) {}
  return false;
}

function hostedPid(pid) {
  try {
    const out = cp.execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    return /\.local[\\/]bin[\\/]claude\.exe/i.test(out) && /--resume/.test(out);
  } catch (e) {
    return false;
  }
}

function hostRequest(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${HOST_URL}${route}`, { method, timeout: 5000, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(text || "{}"));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function ensureHost() {
  return hostRequest("GET", "/sessions").then(
    () => true,
    () => {
      const entry = path.join(__dirname, "cli.js");
      cp.spawn(process.execPath, [entry, "host"], { detached: true, stdio: "ignore", windowsHide: true, env: require("./sessions").cleanEnv() }).unref();
      return false;
    }
  );
}

const hostedConversations = () => readConfig().filter((e) => !e.waitingForVsCode).map((e) => e.conversation);

function markOnDemand(conversation) {
  const list = readConfig();
  const e = list.find((x) => x.conversation === conversation);
  if (e) e.onDemand = true;
  writeConfig(list);
}

function adopt(conversation, name) {
  const list = readConfig();
  if (!list.some((x) => x.conversation === conversation)) list.push({ conversation, name, at: new Date().toISOString(), onDemand: true });
  writeConfig(list);
}

function markWaiting(conversation, name) {
  const list = readConfig();
  if (!list.some((x) => x.conversation === conversation)) list.push({ conversation, name, at: new Date().toISOString(), waitingForVsCode: true });
  writeConfig(list);
}

module.exports = { serve, hostRequest, ensureHost, hostedConversations, markWaiting, adopt, markOnDemand, vsCodeHas, HOST_PORT, readConfig };

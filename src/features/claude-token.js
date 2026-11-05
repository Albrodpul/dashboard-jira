const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { sessionToken } = require("../sessions/registry");

const NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const AGENT = path.join(os.homedir(), "Library", "LaunchAgents", "com.nutria.claude-token.plist");

function windows(token) {
  const script = token ? `[Environment]::SetEnvironmentVariable('${NAME}', $env:NEW_VALUE, 'User')` : `[Environment]::SetEnvironmentVariable('${NAME}', $null, 'User')`;
  cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, NEW_VALUE: token || "" }, windowsHide: true, stdio: "ignore" });
}

function mac(token) {
  const uid = process.getuid();
  try {
    cp.execFileSync("/bin/launchctl", ["bootout", `gui/${uid}`, AGENT], { stdio: "ignore" });
  } catch (e) {}
  fs.mkdirSync(path.dirname(AGENT), { recursive: true });
  if (!token) {
    fs.rmSync(AGENT, { force: true });
    const once = AGENT.replace(".plist", "-remove.plist");
    fs.writeFileSync(once, agentPlist("com.nutria.claude-token-remove", ["unsetenv", NAME]));
    cp.execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, once], { stdio: "ignore" });
    cp.execFileSync("/bin/sleep", ["1"]);
    try {
      cp.execFileSync("/bin/launchctl", ["bootout", `gui/${uid}`, once], { stdio: "ignore" });
    } catch (e) {}
    fs.rmSync(once, { force: true });
    return;
  }
  fs.writeFileSync(AGENT, agentPlist("com.nutria.claude-token", ["setenv", NAME, token.replace(/[<>&]/g, "")]), { mode: 0o600 });
  fs.chmodSync(AGENT, 0o600);
  cp.execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, AGENT], { stdio: "ignore" });
}

const agentPlist = (label, args) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/launchctl</string>${args.map((x) => `<string>${x}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;

function applyUserToken(remove) {
  const token = remove ? null : sessionToken();
  if (!remove && !token) throw new Error(`No hay ${NAME} en el .env del workspace: genéralo con «claude setup-token» y añádelo allí.`);
  if (process.platform === "win32") windows(token);
  else if (process.platform === "darwin") mac(token);
  else throw new Error("Solo Windows y macOS");
  return !!token;
}

function inUserEnvironment() {
  if (process.platform === "darwin") return fs.existsSync(AGENT);
  if (process.platform !== "win32") return false;
  try {
    cp.execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", NAME], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

let cached = null;
function tokenStatus() {
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  let expires = null;
  try {
    const m = /^[ \t]*CLAUDE_TOKEN_EXPIRES[ \t]*=[ \t]*["']?(\d{4}-\d{2}-\d{2})["']?[ \t]*\r?$/m.exec(fs.readFileSync(path.join(require("../core/config").workspace, ".env"), "utf8"));
    expires = m ? m[1] : null;
  } catch (e) {}
  const value = { sessions: !!sessionToken(), vscode: inUserEnvironment(), expires };
  cached = { at: Date.now(), value };
  return value;
}

const TOKEN = /sk-ant-[A-Za-z0-9_-]{20,}/;
const ANSI = /\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;
const envFile = () => path.join(require("../core/config").workspace, ".env");
const screenText = (raw) =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ")
    .replace(/\x1b\[(\d*)C/g, (m, n) => " ".repeat(Number(n) || 1))
    .replace(/\x1b\[\d*[BEFH]|\x1b\[\d+;\d+[Hf]|\x1b\[\d*[JK]/g, "\n")
    .replace(ANSI, "");

async function authStatus(token) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: "user", content: "ok" }] }),
  });
  return r.status;
}

async function workingToken(token) {
  try {
    for (let len = token.length; len >= Math.max(90, token.length - 30); len--) if ((await authStatus(token.slice(0, len))) !== 401) return token.slice(0, len);
    return null;
  } catch (e) {
    return token;
  }
}

function saveToken(token) {
  const expires = new Date(Date.now() + 364 * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  let text = "";
  try {
    text = fs.readFileSync(envFile(), "utf8");
  } catch (e) {}
  const lines = text.split(/\r?\n/).filter((l) => !/^[ \t]*(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_TOKEN_EXPIRES)[ \t]*=/.test(l));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push(`${NAME}=${token}`, `CLAUDE_TOKEN_EXPIRES=${expires}`, "");
  fs.writeFileSync(envFile(), lines.join("\n"), { mode: 0o600 });
  cached = null;
  applyUserToken(false);
  return expires;
}

function relayMasked(write) {
  let pending = "";
  const flush = (all) => {
    let masked = pending.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…(oculto)");
    let keep = "";
    if (!all) {
      const tail = /s(?:k(?:-(?:a(?:n(?:t(?:-[A-Za-z0-9_-]*)?)?)?)?)?)?$/.exec(pending);
      if (tail) {
        keep = pending.slice(tail.index);
        masked = pending.slice(0, tail.index).replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…(oculto)");
      }
    }
    pending = keep;
    if (masked) write(masked);
  };
  return { push: (d) => ((pending += d), flush(false)), end: () => flush(true) };
}

function setupToken() {
  return new Promise((resolve, reject) => {
    const pty = require("@lydell/node-pty");
    const platform = require("../core/platform");
    const env = { ...require("../sessions/registry").cleanEnv() };
    delete env[NAME];
    const [exe, args] = platform.claude(["setup-token"]);
    const term = pty.spawn(exe, args, { name: "xterm-256color", cols: 400, rows: 40, cwd: os.homedir(), env });
    const out = relayMasked((s) => process.stdout.write(s));
    let seen = "";
    let token = null;
    term.onData((d) => {
      seen = (seen + d).slice(-20000);
      const m = TOKEN.exec(screenText(seen));
      if (m) token = m[0];
      out.push(d);
    });
    const input = (d) => term.write(d.toString());
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("data", input);
    process.stdin.resume();
    term.onExit(async () => {
      out.end();
      process.stdin.off("data", input);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (!token) return reject(new Error("No he visto el token en la salida de claude setup-token: no se ha instalado nada."));
      const good = await workingToken(token);
      if (!good) return reject(new Error("El token que dio claude setup-token no funciona contra la API: no se ha instalado nada."));
      resolve(saveToken(good));
    });
  });
}

function importToken(text) {
  const m = TOKEN.exec(String(text || ""));
  if (!m) throw new Error("No llega ningún token por la entrada estándar.");
  return saveToken(m[0]);
}

let job = null;
const mask = (s) => s.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…(oculto)");

async function copyToPeer() {
  const token = require("../sessions/registry").sessionToken();
  if (!token) return false;
  return require("../cluster/cluster").sendClaudeToken(token);
}

function startJob() {
  if (job && job.state === "running") return job;
  const pty = require("@lydell/node-pty");
  const platform = require("../core/platform");
  const env = { ...require("../sessions/registry").cleanEnv() };
  delete env[NAME];
  const [exe, args] = platform.claude(["setup-token"]);
  const term = pty.spawn(exe, args, { name: "xterm-256color", cols: 400, rows: 40, cwd: os.homedir(), env });
  const current = { state: "running", startedAt: new Date().toISOString(), url: null, asksCode: false, expires: null, peer: null, error: null, tail: "", term };
  job = current;
  let seen = "";
  let token = null;
  const timer = setTimeout(() => term.kill(), 15 * 60000);
  term.onData((d) => {
    seen = (seen + d).slice(-30000);
    const plain = screenText(seen);
    const m = TOKEN.exec(plain);
    if (m) token = m[0];
    const url = /https:\/\/[^\s"'<>]*(?:oauth|authorize)[^\s"'<>]*/i.exec(plain);
    if (url) current.url = url[0];
    if (/paste[^\n]{0,30}code|enter[^\n]{0,20}code|authorization code/i.test(plain.slice(-600)) && !token) current.asksCode = true;
    current.tail = mask(plain).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-6).join("\n").slice(-600);
  });
  term.onExit(async () => {
    clearTimeout(timer);
    current.term = null;
    if (!token) {
      current.state = "failed";
      current.error = current.cancelled ? "Cancelado." : "claude setup-token terminó sin dar un token.";
      return;
    }
    const good = await workingToken(token);
    if (!good) {
      current.state = "failed";
      current.error = "El token que dio claude setup-token no funciona contra la API: no se ha instalado nada.";
      return;
    }
    try {
      current.expires = saveToken(good);
      current.state = "done";
    } catch (e) {
      current.state = "failed";
      current.error = `Token recibido, pero no se pudo guardar: ${e.message}`;
      return;
    }
    current.peer = require("../cluster/cluster").clusterEnabled() ? await copyToPeer() : null;
  });
  return current;
}

function jobStatus() {
  if (!job) return { state: "idle" };
  const { term, ...rest } = job;
  return rest;
}

async function handleSetup(input) {
  const action = input && input.action;
  if (action === "start") startJob();
  else if (action === "code" && job && job.term) job.term.write(String(input.code || "").trim() + "\r");
  else if (action === "cancel" && job && job.term) {
    job.cancelled = true;
    job.term.kill();
  } else if (action === "copy" && job) job.peer = await copyToPeer();
  else if (action === "copy") return { ...jobStatus(), peer: await copyToPeer() };
  return jobStatus();
}

module.exports = { applyUserToken, tokenStatus, setupToken, importToken, handleSetup, jobStatus };

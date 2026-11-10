const fs = require("fs");
const os = require("os");
const path = require("path");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const home = () => path.join(os.homedir(), ".claude");
const ENV_VARIABLES = /^(CLAUDE_CODE_|CLAUDECODE|CLAUDE_PID|CLAUDE_ENV_FILE|CLAUDE_AGENT_SDK|CLAUDE_EFFORT|AI_AGENT|ELECTRON_RUN_AS_NODE)/;
const TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN";
const WAKE_MODEL = "claude-haiku-4-5-20251001";

const cli = () => process.env.CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", `claude${EXE}`);

function command(args, fallback) {
  const bin = process.env.CLAUDE_BIN;
  if (bin && /\.[cm]?js$/i.test(bin)) return [process.execPath, [bin, ...args]];
  return [bin || fallback || cli(), args];
}

function editorBinary() {
  const folder = path.join(os.homedir(), ".vscode", "extensions");
  let dirs = [];
  try {
    dirs = fs.readdirSync(folder).filter((d) => d.startsWith("anthropic.claude-code-"));
  } catch (e) {
    return null;
  }
  const version = (d) => (d.match(/\d+/g) || []).slice(0, 3).map(Number);
  dirs.sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
  for (const d of dirs) {
    const exe = path.join(folder, d, "resources", "native-binary", `claude${EXE}`);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

const hostedArgs = ({ conversation, fresh, name, permissionMode, profile = [] }) => [...(fresh ? ["--session-id", conversation] : ["--resume", conversation]), "-n", name, "--permission-mode", permissionMode, ...profile];
const createArgs = ({ id, name, model, prompt }) => ["-p", "--session-id", id, "--name", name, "--model", model, prompt];
const wakeArgs = (prompt) => ["-p", prompt, "--no-session-persistence", "--model", WAKE_MODEL, "--allowedTools=SendMessage,ListAgents,ToolSearch"];
const oneShotArgs = ({ prompt, model, tools = "" }) => ["-p", prompt, "--no-session-persistence", "--model", model, `--allowedTools=${tools}`];
const isHostedCommandLine = (line) => /\.local[\\/]bin[\\/]claude(\.exe)?\b/i.test(line) && /--resume/.test(line);
const editorUrl = (conversation) => (conversation ? `vscode://anthropic.claude-code/open?session=${conversation}` : "vscode://anthropic.claude-code/open");
const transcriptFolder = (root) => root.replace(/\\/g, "/").replace(/^([A-Z]):/, (m, d) => `${d.toLowerCase()}:`).replace(/[^a-zA-Z0-9]/g, "-");

function liveEntries() {
  const dir = path.join(home(), "sessions");
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch (e) {
    return null;
  }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j.kind !== "interactive" || !j.name || !j.sessionId) continue;
      out.push({ name: j.name, conversation: j.sessionId, cwd: j.cwd, pid: j.pid, startedMs: Number(j.startedAt), status: j.status, background: j.status === "shell", statusSinceMs: j.statusUpdatedAt ? Number(j.statusUpdatedAt) : null });
    } catch (e) {}
  }
  return out;
}

module.exports = {
  liveEntries,
  id: "claude",
  name: "Claude Code",
  home,
  sessionsDir: () => path.join(home(), "sessions"),
  transcriptsDir: () => path.join(home(), "projects"),
  credentialsFile: () => path.join(home(), ".credentials.json"),
  transcriptFolder,
  ENV_VARIABLES,
  TOKEN_VARIABLE,
  cli,
  command,
  editorBinary,
  hostedArgs,
  createArgs,
  wakeArgs,
  oneShotArgs,
  isHostedCommandLine,
  editorUrl,
};

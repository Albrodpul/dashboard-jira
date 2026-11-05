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

module.exports = { applyUserToken, tokenStatus };

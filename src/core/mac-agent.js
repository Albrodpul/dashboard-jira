const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const LABEL = "com.nutria.board";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const isMac = process.platform === "darwin";
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);
const target = () => `gui/${uid()}/${LABEL}`;
const underAgent = () => process.env.NUTRIA_AGENT === "1";

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plistBody(entry, workspace, logFile) {
  const env = { NUTRIA_AGENT: "1", TOWER_WORKSPACE: workspace, PATH: process.env.PATH || "/usr/bin:/bin", HOME: os.homedir() };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>WorkingDirectory</key><string>${xml(workspace)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

function loaded() {
  if (!isMac) return false;
  try {
    cp.execFileSync("/bin/launchctl", ["print", target()], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

function kickstart() {
  try {
    cp.execFileSync("/bin/launchctl", ["kickstart", target()], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

function install(entry, workspace, logFile) {
  if (!isMac || underAgent()) return false;
  const body = plistBody(entry, workspace, logFile);
  let current = "";
  try {
    current = fs.readFileSync(PLIST, "utf8");
  } catch (e) {}
  if (current !== body) {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, body);
    if (loaded()) {
      try {
        cp.execFileSync("/bin/launchctl", ["bootout", target()], { stdio: "ignore", timeout: 10000 });
      } catch (e) {}
    }
  }
  if (loaded()) return true;
  try {
    cp.execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid()}`, PLIST], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { isMac, loaded, kickstart, install, underAgent, PLIST };

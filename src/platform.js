const path = require("path");
const os = require("os");
const cp = require("child_process");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";

function run(cmd, args, opts = {}) {
  try {
    return cp.execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, timeout: 20000, ...opts });
  } catch (e) {
    return "";
  }
}

function processes() {
  if (IS_WIN) {
    try {
      const rows = JSON.parse(run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"]).replace(/^﻿/, "") || "[]");
      return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: String(r.Name || "").replace(/\.exe$/i, "").toLowerCase(), command: r.CommandLine || "" }));
    } catch (e) {
      return [];
    }
  }
  return run("ps", ["-A", "-o", "pid=,ppid=,comm=,args="])
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3]).toLowerCase(), command: m[4] }));
}

function commandLine(pid) {
  if (IS_WIN) return run("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { timeout: 8000 });
  return run("ps", ["-o", "args=", "-p", String(Number(pid))]);
}

function killTree(pid) {
  pid = Number(pid);
  if (!pid) return;
  if (IS_WIN) {
    run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  const all = processes();
  const doomed = [pid];
  for (let i = 0; i < doomed.length; i++) for (const p of all) if (p.ppid === doomed[i]) doomed.push(p.pid);
  for (const p of doomed.reverse()) {
    try {
      process.kill(p, "SIGKILL");
    } catch (e) {}
  }
}

function listeningPids(port) {
  if (IS_WIN) {
    const pids = new Set();
    for (const line of run("netstat", ["-ano", "-p", "tcp"]).split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && Number(m[1]) === port && m[2] !== "0") pids.add(m[2]);
    }
    return [...pids];
  }
  return run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n").map((x) => x.trim()).filter(Boolean);
}

function openUrl(url, env) {
  if (IS_WIN) cp.spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
  else cp.spawn("open", [url], { detached: true, stdio: "ignore", env }).unref();
}

function openFolderInEditor(folder, env) {
  if (IS_WIN) cp.spawn("cmd", ["/c", "code", folder], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
  else cp.spawn("open", ["-a", "Visual Studio Code", folder], { detached: true, stdio: "ignore", env }).unref();
}

const claudeCli = () => process.env.CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", `claude${EXE}`);
const isShell = (name) => ["node", "bash", "sh", "zsh", "cmd", "powershell", "pwsh", "conhost", "timeout"].includes(name);

module.exports = { IS_WIN, EXE, processes, commandLine, killTree, listeningPids, openUrl, openFolderInEditor, claudeCli, isShell };

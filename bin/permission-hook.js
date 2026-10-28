#!/usr/bin/env node
const http = require("http");

const PORT = Number(process.env.TOWER_PORT || process.env.TABLERO_PORT) || 4747;
const BASE = `http://127.0.0.1:${PORT}`;
const POLL_MS = 2000;

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${url}`, { method, timeout: 5000, headers: { origin: BASE, "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text || "{}")) : reject(new Error(String(res.statusCode)))));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function trace(event, result) {
  try {
    const dir = process.env.TOWER_WORKSPACE ? require("path").join(process.env.TOWER_WORKSPACE, "data") : null;
    if (dir) require("fs").appendFileSync(require("path").join(dir, "hook.log"), `${new Date().toISOString()} ${String(event.session_id || "").slice(0, 8)} ${event.tool_name} ${result}
`);
  } catch (e) {}
}

let current = null;

function decide(decision, reason) {
  if (current) trace(current, decision);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason || "" } }));
  process.exit(0);
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch (e) {
    return process.exit(0);
  }
  current = event;
  let r;
  try {
    r = await call("POST", "/api/permission/check", { session_id: event.session_id, tool_name: event.tool_name, tool_input: event.tool_input, cwd: event.cwd });
  } catch (e) {
    trace(event, "sin-tablero");
    return process.exit(0);
  }
  if (r.decision === "allow") return decide("allow", "Permitido por el filtro del tablero");
  if (r.decision !== "wait") return process.exit(0);
  const until = Date.now() + (r.waitMinutes || 55) * 60000;
  while (Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, POLL_MS));
    let p;
    try {
      p = await call("GET", `/api/permission/${r.id}`);
    } catch (e) {
      continue;
    }
    if (p.status === "allowed") return decide("allow", "Alberto lo ha permitido en el tablero");
    if (p.status === "denied") return decide("deny", `Alberto lo ha denegado en el tablero${p.reason ? `: ${p.reason}` : ""}. No lo intentes por otro camino; si hace falta, pregúntale.`);
    if (p.status === "expired" || p.status === "missing") break;
  }
  decide("deny", "Sin respuesta de Alberto en el tablero («Te esperan» → Permisos). Para aquí y avísale de qué necesitas; no lo intentes por otro camino.");
}

main();

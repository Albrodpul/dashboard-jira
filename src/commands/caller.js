const { loadRoutes } = require("../sessions/registry");
const { mainId } = require("../core/projects");
const { fail } = require("./args");

const ROLE_NAMES = { orchestrator: "la orquestadora", reporter: "la sesión de reporte", followUp: "la sesión de seguimiento", board: "la sesión del tablero" };

function whoCalls(env = process.env) {
  const conversation = String(env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (!conversation) return null;
  const r = loadRoutes();
  const roles = [];
  for (const role of Object.keys(ROLE_NAMES)) if (r[role] && r[role].conversation === conversation) roles.push({ role, project: mainId() });
  for (const [project, box] of Object.entries(r.projectRoles || {})) for (const [role, v] of Object.entries(box || {})) if (v && v.conversation === conversation) roles.push({ role, project });
  const found = Object.entries(r.areas || {}).find(([, a]) => a.conversation === conversation);
  const area = found ? { id: found[0], name: found[1].title || found[0], project: found[1].project || mainId() } : null;
  const name = area ? `«${area.name}»` : roles.length ? ROLE_NAMES[roles[0].role] || roles[0].role : "una sesión que el tablero no tiene registrada";
  return { conversation, roles, area, name };
}

const hasRole = (who, wanted) => !!who && who.roles.some((x) => wanted.includes(x.role));

function refuse(command, wanted, who, extra) {
  const from = wanted.map((r) => ROLE_NAMES[r] || r).join(" o ") + (extra ? ` (${extra})` : "");
  const why = who ? `y lo pide ${who.name}` : "y no se sabe qué sesión lo pide (falta CLAUDE_CODE_SESSION_ID: no viene de una sesión de Claude Code)";
  fail(`Rechazado: «board.js ${command}» solo se acepta desde ${from}, ${why}. Aprobar, retener y ordenar es cosa de Alberto: que lo haga en el tablero o se lo pida a la orquestadora. No lo intentes por otro camino.`);
}

function onlyFrom(command, wanted, env = process.env) {
  const who = whoCalls(env);
  if (!hasRole(who, wanted)) refuse(command, wanted, who);
  return who;
}

module.exports = { whoCalls, hasRole, refuse, onlyFrom, ROLE_NAMES };

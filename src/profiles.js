const config = require("./config");

const DEFAULTS = {
  reporter: { model: "sonnet", effort: "low", why: "lee Jira cada 5 minutos y resume lo que cambió" },
  orchestrator: { model: "sonnet", effort: "low", why: "reparte tareas y despliegues ya decididos" },
  followUp: { model: "sonnet", effort: "medium", why: "resume cada hora lo que hace Enric en beta" },
  deploy: { model: "sonnet", effort: "medium", why: "sigue los pasos de despliegue con cuidado" },
  errors: { model: "opus", effort: "medium", why: "investiga errores de producción" },
  board: { model: "opus", effort: "medium", why: "cambia el código del tablero" },
  area: { model: "opus", effort: "medium", why: "desarrolla tareas de Jira" },
};

const profiles = () => ({ ...DEFAULTS, ...(config.sessionProfiles || {}) });

function roleOf(conversation) {
  const r = require("./sessions").loadRoutes();
  for (const role of ["reporter", "orchestrator", "followUp", "board"]) if (r[role] && r[role].conversation === conversation) return role;
  const areaId = Object.keys(r.areas || {}).find((id) => r.areas[id].conversation === conversation);
  if (areaId && areaId === r.deployer) return "deploy";
  if (areaId && areaId === config.errorsArea) return "errors";
  return "area";
}

function profileFor(conversation) {
  const role = roleOf(conversation);
  return { role, ...profiles()[role] };
}

function profileArgs(conversation) {
  try {
    const p = profileFor(conversation);
    return [...(p.model ? ["--model", p.model] : []), ...(p.effort ? ["--effort", p.effort] : [])];
  } catch (e) {
    return [];
  }
}

module.exports = { profileFor, profileArgs, profiles };

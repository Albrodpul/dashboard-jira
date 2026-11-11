const config = require("../core/config");

const DEFAULTS = {
  reporter: { model: "sonnet", effort: "low", why: "lee Jira cada 5 minutos y resume lo que cambió" },
  orchestrator: { model: "opus", effort: "medium", why: "ordena el contexto y habla de tareas y restricciones" },
  followUp: { model: "sonnet", effort: "medium", why: "resume lo que hace cada uno en beta y en producción" },
  deploy: { model: "sonnet", effort: "medium", why: "sigue los pasos de despliegue con cuidado" },
  errors: { model: "opus", effort: "medium", why: "investiga errores de producción" },
  board: { model: "opus", effort: "medium", why: "cambia el código del tablero" },
  area: { model: "opus", effort: "medium", why: "desarrolla tareas de Jira" },
};

const profiles = () => ({ ...DEFAULTS, ...(config.sessionProfiles || {}) });

function roleOf(conversation) {
  const r = require("./registry").loadRoutes();
  for (const role of ["reporter", "orchestrator", "followUp", "board"]) if (r[role] && r[role].conversation === conversation) return role;
  const areaId = Object.keys(r.areas || {}).find((id) => r.areas[id].conversation === conversation);
  if (areaId && areaId === r.deployer) return "deploy";
  if (areaId && areaId === config.errorsArea) return "errors";
  return "area";
}

const MODELS = ["fable", "opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function overrideOf(conversation) {
  try {
    return (require("../core/data").load().sessionOverrides || {})[conversation] || null;
  } catch (e) {
    return null;
  }
}

function profileFor(conversation, overrides) {
  const role = roleOf(conversation);
  const base = profiles()[role] || {};
  const o = (overrides ? overrides[conversation] : overrideOf(conversation)) || {};
  return { role, ...base, ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}), custom: !!(o.model || o.effort), defaults: { model: base.model || null, effort: base.effort || null } };
}

function setOverride(conversation, { model, effort }) {
  if (model && !MODELS.includes(model)) throw new Error(`modelo no válido: ${model}`);
  if (effort && !EFFORTS.includes(effort)) throw new Error(`esfuerzo no válido: ${effort}`);
  require("../core/data").mutate((d) => {
    d.sessionOverrides = d.sessionOverrides || {};
    if (!model && !effort) delete d.sessionOverrides[conversation];
    else d.sessionOverrides[conversation] = { model: model || null, effort: effort || null };
  });
  return profileFor(conversation);
}

function profileArgs(conversation) {
  try {
    const p = profileFor(conversation);
    return [...(p.model ? ["--model", p.model] : []), ...(p.effort ? ["--effort", p.effort] : [])];
  } catch (e) {
    return [];
  }
}

module.exports = { profileFor, profileArgs, profiles, setOverride, MODELS, EFFORTS };

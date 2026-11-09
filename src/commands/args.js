const config = require("../core/config");
const { TASK_STATUS } = require("../core/migrate");

const ALIASES = {
  informe: "report",
  reporte: "reporter",
  "aprobar-chat": "approve-chat",
  envios: "dispatches",
  adjuntos: "attachments",
  hecha: "done",
  "a-medias": "partial",
  pregunta: "question",
  comentario: "comment",
  entregada: "delivered",
  enviada: "sent",
  respuesta: "reply",
  cambios: "changes",
  orquestador: "orchestrator",
  despliegues: "deployments",
  "despliegue-update": "deployment-update",
  arranque: "startup",
  "aviso-prueba": "push-test",
  "error-enviado": "error-sent",
  seguimiento: "people",
  "persona-cuentas": "person-accounts",
  "ordenar-estado": "tidy-status",
  "ordenar-empieza": "tidy-start",
  "ordenar-fin": "tidy-end",
  mensaje: "message",
  contesta: "answer-message",
  progreso: "progress",
  contados: "counted",
  pendiente: "refresh-request",
  "epics-jira": "jira-epics",
  abrir: "open",
  "aprendizaje-leer": "learning-read",
  causa: "cause",
};

const cmd = ALIASES[process.argv[2]] || process.argv[2];
const [a, b] = process.argv.slice(3);
const rest = (from) => process.argv.slice(from).join(" ").trim();
const keyList = (text) =>
  String(text || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const json = (x) => console.log(JSON.stringify(x, null, 2));
const option = (name) => {
  for (const n of [].concat(name)) {
    const i = process.argv.indexOf(n);
    if (i > 0) return process.argv[i + 1];
  }
  return null;
};
const withoutOptions = () => {
  const args = process.argv.slice(3);
  for (const n of ["--person", "--persona", "--environment", "--entorno"]) {
    const i = args.indexOf(n);
    if (i >= 0) args.splice(i, 2);
  }
  return args.filter((x) => x !== "--manual");
};
const environmentOption = () => {
  const raw = option(["--environment", "--entorno"]);
  const env = { produccion: "production", producción: "production", prod: "production" }[raw] || raw || "beta";
  if (!require("../features/follow-up").ENVIRONMENTS.includes(env)) fail(`entorno desconocido: ${raw} (beta o production)`);
  return env;
};
const status = (s) => TASK_STATUS[s] || s;
const ME = config.jira.me.name;
const MY_FIRST_NAME = new RegExp(String(ME).split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

function fail(text) {
  console.error(text);
  process.exit(1);
}

module.exports = { ALIASES, cmd, a, b, rest, keyList, json, option, withoutOptions, environmentOption, status, ME, MY_FIRST_NAME, fail };

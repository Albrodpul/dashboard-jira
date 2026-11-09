const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../core/data");

const ROLES = [
  ["reporter", "Reporte JIRA"],
  ["orchestrator", "Orquestar agentes"],
];

const log = (m) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "startup.log"), `${new Date().toISOString()} ${m}\n`);
  } catch (e) {}
};

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });

async function freshConversation(role, fallbackName) {
  const sessions = require("./registry");
  const host = require("./host");
  const r = sessions.loadRoutes()[role];
  if (!r || !r.conversation || r.rotatedOn === today()) return false;
  const name = r.session || fallbackName;
  const id = await sessions.createConversation(name);
  if (!id) {
    log(`no se pudo empezar la conversación del día de ${name}: sigue la de ayer`);
    return false;
  }
  const stale = host.readConfig().filter((e) => e.conversation !== id && (e.conversation === r.conversation || e.name === name));
  for (const e of stale) await host.hostRequest("POST", "/release", { conversation: e.conversation }).catch(() => {});
  sessions.changeRoutes((x) => {
    x[role] = { ...x[role], conversation: id, session: name, ref: null, previous: r.conversation, rotatedOn: today(), since: new Date().toISOString() };
    return true;
  });
  await host.ensureHost();
  await host.hostRequest("POST", "/start", { conversation: id, name }).catch(() => {});
  log(`${name}: conversación nueva del día (${id}); la de ayer era ${r.conversation}`);
  return true;
}

const LATEST = 10 * 60;

function morning(t = require("../core/hours").clock()) {
  return !t.weekend && t.min < LATEST;
}

const EARLIEST = 7 * 60 + 30;

const inRotationWindow = (t = require("../core/hours").clock()) => !t.weekend && t.min >= EARLIEST && t.min < LATEST;

async function rotateDaily() {
  if (!morning()) return;
  for (const [role, name] of ROLES) await freshConversation(role, name);
}

let busy = false;

async function rotateIfMorning() {
  if (busy || !require("../cluster/cluster").isPrimary()) return;
  if (!inRotationWindow()) return;
  const routes = require("./registry").loadRoutes();
  if (ROLES.every(([role]) => !routes[role] || routes[role].rotatedOn === today())) return;
  busy = true;
  try {
    require("../server/startup").launchStartup();
  } finally {
    setTimeout(() => (busy = false), 10 * 60 * 1000);
  }
}

module.exports = { rotateDaily, rotateIfMorning, morning, inRotationWindow };

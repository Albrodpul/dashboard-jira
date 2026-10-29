const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./data");

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
  const sessions = require("./sessions");
  const host = require("./host");
  const r = sessions.loadRoutes()[role];
  if (!r || !r.conversation || r.rotatedOn === today()) return false;
  const name = r.session || fallbackName;
  const id = await sessions.createConversation(name);
  if (!id) {
    log(`no se pudo empezar la conversación del día de ${name}: sigue la de ayer`);
    return false;
  }
  await host.hostRequest("POST", "/release", { conversation: r.conversation }).catch(() => {});
  sessions.changeRoutes((x) => {
    x[role] = { ...x[role], conversation: id, session: name, ref: null, previous: r.conversation, rotatedOn: today(), since: new Date().toISOString() };
    return true;
  });
  await host.ensureHost();
  await host.hostRequest("POST", "/start", { conversation: id, name }).catch(() => {});
  log(`${name}: conversación nueva del día (${id}); la de ayer era ${r.conversation}`);
  return true;
}

async function rotateDaily() {
  for (const [role, name] of ROLES) await freshConversation(role, name);
}

module.exports = { rotateDaily };

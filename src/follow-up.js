const fs = require("fs");
const path = require("path");
const { now, mutate } = require("./data");
const config = require("./config");

const CONFIG_FILE = path.join(config.workspace, "board.config.json");

const ENVIRONMENT_NAMES = { beta: "beta", production: "producción" };
const ENVIRONMENTS = Object.keys(ENVIRONMENT_NAMES);
const MINUTE = { beta: 3, production: 33 };
const FIRST_HOUR = 9;
const LAST_HOUR = 18;

const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).followUp;
  } catch (e) {
    return config.followUp;
  }
}

function settings() {
  const raw = readSettings();
  const list = Array.isArray(raw) ? raw : (raw && raw.people) || [];
  const every = (!Array.isArray(raw) && raw && raw.everyHours) || {};
  return { people: list, everyHours: { beta: Number(every.beta) || 1, production: Number(every.production) || 2 } };
}

function cronOf(environment, hours) {
  const n = Math.max(1, Math.min(9, Math.round(hours)));
  const last = LAST_HOUR - ((LAST_HOUR - FIRST_HOUR) % n);
  const span = n === 1 ? `${FIRST_HOUR}-${LAST_HOUR}` : `${FIRST_HOUR}-${last}/${n}`;
  return `${MINUTE[environment]} ${span} * * 1-5`;
}

const productionPeople = new WeakMap();
const environmentOf = (summary, d) => {
  if (ENVIRONMENTS.includes(summary.environment)) return summary.environment;
  if (!summary.person) return "beta";
  if (!productionPeople.has(d)) productionPeople.set(d, new Set(people(d).filter((p) => p.environment === "production").map((p) => p.id)));
  return productionPeople.get(d).has(summary.person) ? "production" : "beta";
};

const lastOf = (d, environment, scheduledOnly) => (d.followUps.find((r) => environmentOf(r, d) === environment && !(scheduledOnly && r.manual)) || {}).at || null;

function environments(d) {
  const { everyHours } = settings();
  return ENVIRONMENTS.map((id) => ({ id, name: ENVIRONMENT_NAMES[id], everyHours: everyHours[id], cron: cronOf(id, everyHours[id]), last: lastOf(d, id), lastScheduled: lastOf(d, id, true) }));
}

function withConfigPeople(stored, removed) {
  const list = Array.isArray(stored) ? stored.slice() : [];
  for (const p of settings().people) {
    if (!p.id || list.some((x) => x.id === p.id) || (Array.isArray(stored) && (removed || []).includes(p.id))) continue;
    list.push({ id: p.id, name: p.name, environment: p.environment, accounts: p.accounts || [] });
  }
  return list;
}

function people(d) {
  return withConfigPeople(d.followUp && d.followUp.people, d.followUp && d.followUp.removed).map(({ hourly, ...p }) => p);
}

function changePeople(fn) {
  return mutate((d) => {
    d.followUp = d.followUp || {};
    d.followUp.people = withConfigPeople(d.followUp.people, d.followUp.removed);
    return fn(d.followUp.people, d);
  });
}

const cleanAccounts = (xs) => [...new Set((xs || []).map((x) => String(x).trim()).filter((x) => /@/.test(x)))];

function addPerson(list, d, name, accounts) {
  const clean = String(name || "").trim().slice(0, 80);
  if (!clean) return { error: "escribe el nombre o el correo" };
  const id = slug(clean) || "person-" + Date.now();
  let p = list.find((x) => x.id === id);
  if (!p) {
    p = { id, name: clean, accounts: [] };
    list.push(p);
  }
  const more = cleanAccounts([...(accounts || []), ...(/@/.test(clean) ? [clean] : [])]);
  if (more.length) {
    p.accounts = cleanAccounts([...(p.accounts || []), ...more]);
    p.accountsAt = now();
  }
  d.followUp.removed = (d.followUp.removed || []).filter((x) => x !== id);
  return { person: p };
}

function handlePeople(res, { action, id, name, accounts }, send) {
  const error = changePeople((list, d) => {
    if (action === "add") return addPerson(list, d, name, String(accounts || "").split(/[\s,;]+/)).error || "";
    const p = list.find((x) => x.id === id);
    if (!p) return "persona desconocida";
    if (action === "remove") {
      list.splice(list.indexOf(p), 1);
      d.followUp.removed = [...new Set((d.followUp.removed || []).concat(p.id))];
    } else return "acción desconocida";
    return "";
  });
  return error ? send(res, 400, { error }) : send(res, 200);
}

const registerPerson = (name, accounts) => changePeople((list, d) => addPerson(list, d, name, accounts));

function saveAccounts(id, accounts) {
  return changePeople((list) => {
    const p = list.find((x) => x.id === id);
    if (!p) return false;
    p.accounts = cleanAccounts(accounts);
    p.accountsAt = now();
    return true;
  });
}

const environmentName = (id) => ENVIRONMENT_NAMES[id] || id;

module.exports = { ENVIRONMENTS, environmentName, environmentOf, environments, people, handlePeople, registerPerson, saveAccounts };

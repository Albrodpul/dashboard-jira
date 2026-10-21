const fs = require("fs");
const path = require("path");
const { now, load, mutate } = require("./data");
const config = require("./config");

const CONFIG_FILE = path.join(config.workspace, "board.config.json");

const INITIAL_PEOPLE = config.followUp;
const ENVIRONMENTS = ["beta", "production"];
const DEFAULT_PERSON = (INITIAL_PEOPLE.find((p) => p.hourly) || INITIAL_PEOPLE[0] || { id: "reviewer" }).id;

const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

const personOf = (summary) => summary.person || DEFAULT_PERSON;

function configPeople() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).followUp || INITIAL_PEOPLE;
  } catch (e) {
    return INITIAL_PEOPLE;
  }
}

function withConfigPeople(stored, removed) {
  const list = Array.isArray(stored) ? stored.slice() : [];
  for (const p of configPeople()) {
    if (!p.id || list.some((x) => x.id === p.id) || (Array.isArray(stored) && (removed || []).includes(p.id))) continue;
    list.push({ id: p.id, name: p.name, environment: p.environment, hourly: !!p.hourly, accounts: [] });
  }
  return list;
}

function people(d) {
  const list = withConfigPeople(d.followUp && d.followUp.people, d.followUp && d.followUp.removed);
  return list.map((p) => ({ ...p, last: (d.followUps.find((r) => personOf(r) === p.id) || {}).at || null }));
}

function changePeople(fn) {
  return mutate((d) => {
    d.followUp = d.followUp || {};
    d.followUp.people = withConfigPeople(d.followUp.people, d.followUp.removed);
    return fn(d.followUp.people, d);
  });
}

function handlePeople(res, { action, id, name, environment, value }, send) {
  const error = changePeople((list, d) => {
    if (action === "add") {
      const clean = String(name || "").trim().slice(0, 80);
      if (!clean) return "escribe el nombre o el correo";
      if (!ENVIRONMENTS.includes(environment)) return "elige beta o producción";
      const newId = slug(clean) || "person-" + Date.now();
      if (list.some((p) => p.id === newId)) return "esa persona ya está en la lista";
      list.push({ id: newId, name: clean, environment, hourly: false, accounts: /@/.test(clean) ? [clean] : [] });
      d.followUp.removed = (d.followUp.removed || []).filter((x) => x !== newId);
      return "";
    }
    const p = list.find((x) => x.id === id);
    if (!p) return "persona desconocida";
    if (action === "hourly") p.hourly = !!value;
    else if (action === "remove") {
      list.splice(list.indexOf(p), 1);
      d.followUp.removed = [...new Set((d.followUp.removed || []).concat(p.id))];
    } else return "acción desconocida";
    return "";
  });
  return error ? send(res, 400, { error }) : send(res, 200);
}

function saveAccounts(id, accounts) {
  return changePeople((list) => {
    const p = list.find((x) => x.id === id);
    if (!p) return false;
    p.accounts = accounts;
    p.accountsAt = now();
    return true;
  });
}

const nameOf = (id) => (people(load()).find((p) => p.id === id) || { name: id }).name;

module.exports = { DEFAULT_PERSON, personOf, people, handlePeople, saveAccounts, nameOf };

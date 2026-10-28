const fs = require("fs");
const { ROUTES_FILE } = require("../src/data");

const ALIASES = { soy: "iam", ruta: "route", "quitar-ruta": "unroute", libera: "release", de: "of", lista: "list" };
const ROLES = { reporte: "reporter", reporter: "reporter", orquestador: "orchestrator", orchestrator: "orchestrator", seguimiento: "followUp", followup: "followUp", "follow-up": "followUp", tablero: "board", board: "board" };
const ROLE_LABEL = { reporter: "REPORTE", orchestrator: "ORQUESTADORA", followUp: "SEGUIMIENTO", board: "TABLERO" };
const ROLE_TITLE = { orchestrator: "Orquestar agentes", followUp: "Seguimiento", board: "Tablero" };
const cmd = ALIASES[process.argv[2]] || process.argv[2];
const args = process.argv.slice(3);

const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function load() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(ROUTES_FILE, "utf8"));
  } catch (e) {}
  data.areas = data.areas || {};
  return data;
}

function save(data) {
  const tmp = `${ROUTES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, ROUTES_FILE);
}

function findArea(data, text) {
  const wanted = slug(text);
  if (!wanted) return null;
  if (data.areas[wanted]) return wanted;
  const keys = Object.keys(data.areas);
  return keys.find((k) => slug(data.areas[k].title) === wanted) || keys.find((k) => k.includes(wanted) || slug(data.areas[k].title).includes(wanted)) || null;
}

const areaOfEpic = (data, key) => Object.keys(data.areas).find((k) => data.areas[k].epics && data.areas[k].epics[key]) || null;
const now = () => new Date().toISOString();
const withRef = (session, ref) => `${session}${ref ? ` [${ref}]` : ""}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function newArea(data, text) {
  const key = slug(text);
  data.areas[key] = { title: text, epics: {}, session: null, ref: null, since: null };
  return key;
}

if (cmd === "iam") {
  const [areaText, session, ref] = args;
  if (!areaText || !session) fail("Uso: node sessions.js iam <área|reporter|orchestrator|followup|board> <nombre-de-sesión> [ref]");
  const data = load();
  const role = ROLES[slug(areaText)];
  if (role) {
    const previous = data[role] || {};
    data[role] = { ...(ROLE_TITLE[role] ? { title: previous.title || ROLE_TITLE[role] } : {}), session, ref: ref || null, since: now(), conversation: previous.session === session ? previous.conversation || null : null };
    save(data);
    console.log(`Registrada como sesión de ${ROLE_LABEL[role]}: ${withRef(session, ref)}`);
  } else {
    let key = findArea(data, areaText);
    const created = !key;
    if (created) key = newArea(data, areaText);
    for (const k of Object.keys(data.areas)) {
      if (k !== key && data.areas[k].session === session) Object.assign(data.areas[k], { session: null, ref: null, since: null });
    }
    Object.assign(data.areas[key], { session, ref: ref || null, since: now() });
    save(data);
    const epics = Object.entries(data.areas[key].epics || {}).map(([k, n]) => `${k} ${n}`);
    console.log(`${created ? "Área NUEVA" : "Área"} «${data.areas[key].title}» (${key}) -> sesión ${withRef(session, ref)}`);
    console.log(epics.length ? `Épicas que recibe: ${epics.join("; ")}` : "Todavía no tiene épicas asignadas.");
  }
} else if (cmd === "route") {
  const [epic, areaText, ...name] = args;
  if (!epic || !areaText) fail("Uso: node sessions.js route <CLAVE-ÉPICA> <área> [nombre de la épica]");
  const data = load();
  const key = findArea(data, areaText) || newArea(data, areaText);
  const previous = areaOfEpic(data, epic);
  if (previous) delete data.areas[previous].epics[epic];
  data.areas[key].epics = data.areas[key].epics || {};
  data.areas[key].epics[epic] = name.join(" ") || epic;
  save(data);
  console.log(`${epic} ${name.join(" ")} -> «${data.areas[key].title}»${previous && previous !== key ? ` (antes en ${previous})` : ""}`);
} else if (cmd === "release") {
  const [session] = args;
  if (!session) fail("Uso: node sessions.js release <nombre-de-sesión>");
  const data = load();
  let n = 0;
  for (const a of Object.values(data.areas)) {
    if (a.session === session) {
      Object.assign(a, { session: null, ref: null, since: null });
      n++;
    }
  }
  save(data);
  console.log(n ? `${session} ya no está asignada a ningún área.` : `${session} no estaba asignada.`);
} else if (cmd === "unroute") {
  const [epic] = args;
  const data = load();
  const key = areaOfEpic(data, epic);
  if (!key) fail(`${epic} no tiene ruta.`);
  delete data.areas[key].epics[epic];
  save(data);
  console.log(`${epic} ya no va a «${data.areas[key].title}».`);
} else if (cmd === "of") {
  const [epic] = args;
  const data = load();
  const key = areaOfEpic(data, epic);
  if (!key) console.log("SIN RUTA");
  else console.log(JSON.stringify({ area: key, title: data.areas[key].title, session: data.areas[key].session, ref: data.areas[key].ref }));
} else if (cmd === "list" || !cmd) {
  const data = load();
  const role = (x) => (x && x.session ? `${withRef(x.session, x.ref)} (desde ${x.since})` : x && x.conversation ? `conversación ${x.conversation}` : "sin registrar");
  console.log(`Reporte: ${role(data.reporter)}`);
  console.log(`Orquestador: ${role(data.orchestrator)}`);
  console.log(`Seguimiento: ${role(data.followUp)}`);
  console.log(`Tablero: ${role(data.board)}`);
  for (const [k, a] of Object.entries(data.areas)) {
    const epics = Object.entries(a.epics || {}).map(([key, n]) => `${key} ${n}`);
    console.log(`- ${a.title} (${k}) | sesión: ${a.session ? withRef(a.session, a.ref) : "sin registrar"} | épicas: ${epics.join("; ") || "ninguna"}`);
  }
} else {
  fail("Comandos: iam <área> <sesión> [ref] | route <CLAVE> <área> [nombre] | unroute <CLAVE> | release <sesión> | of <CLAVE> | list");
}

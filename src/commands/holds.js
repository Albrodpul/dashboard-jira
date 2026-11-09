const { load, mutate } = require("../core/data");
const { loadRoutes } = require("../sessions/registry");
const holds = require("../features/holds");
const { json, fail } = require("./args");

const USAGE = [
  "Uso:",
  '  board.js hold add [--tasks CLAVE,CLAVE] [--epics EPIC,EPIC] [--areas sesión,sesión] [--mode hold|note] [--until "9-11 18:00"] --reason "<motivo o indicación>"',
  "  board.js hold list [--all] [--json]",
  "  board.js hold release <id>",
  "  board.js hold check <CLAVE> [sesión]",
  "--mode hold (por defecto) no deja enviar; note deja enviar pero añade el texto a cada mensaje. Sin --until dura hasta que se levante. Fechas en hora de Madrid.",
].join("\n");

const FLAGS = { "--tasks": "tasks", "--task": "tasks", "--epics": "epics", "--epic": "epics", "--areas": "areas", "--area": "areas", "--sessions": "areas", "--mode": "mode", "--until": "until", "--reason": "reason" };

function parse(args) {
  const out = { tasks: [], epics: [], areas: [] };
  const free = [];
  for (let i = 0; i < args.length; i++) {
    const k = FLAGS[args[i]];
    if (!k) {
      if (args[i].startsWith("--")) fail(`opción desconocida: ${args[i]}\n${USAGE}`);
      free.push(args[i]);
      continue;
    }
    const v = args[++i];
    if (v === undefined) fail(`falta el valor de ${args[i - 1]}`);
    if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = v;
  }
  if (!out.reason && free.length) out.reason = free.join(" ");
  return out;
}

const areaName = (id) => {
  const a = loadRoutes().areas[id];
  return a && a.title ? `${a.title} (${id})` : id;
};

function describe(r) {
  const what = r.mode === "note" ? "Indicación obligatoria" : "Retención";
  return `${r.id} · ${what} · ${holds.scopeText(r, areaName)} · «${r.reason}» · ${holds.longUntil(r.until)}${r.releasedAt ? ` · levantada ${r.releasedAt}` : ""}`;
}

module.exports = {
  hold() {
    const [sub, ...args] = process.argv.slice(3);
    if (sub === "add") {
      const input = parse(args);
      const r = mutate((d) => holds.addRestriction(d, { ...input, createdBy: "chat" }, { areas: Object.keys(loadRoutes().areas) }));
      if (r.error) fail(r.error);
      console.log(`Restricción guardada: ${describe(r.restriction)}`);
      if (r.reverted.length) console.log(`Vuelven a Pendientes (estaban por enviar): ${r.reverted.join(", ")}`);
      if (r.inSession.length) console.log(`Ya estaban en una sesión: ${r.inSession.join(", ")}. El tablero les manda ahora un aviso para que paren.`);
      if (r.restriction.mode === "hold") console.log("Desde ahora el tablero no deja aprobar ni enviar lo que cubre, por ningún camino.");
      else console.log("Desde ahora el tablero añade esa indicación a cada mensaje que entregue de lo que cubre.");
      return;
    }
    if (sub === "list") {
      const nowMs = Date.now();
      const all = args.includes("--all");
      const items = (load().restrictions || []).filter((r) => all || holds.isActive(r, nowMs));
      if (args.includes("--json")) return json(items);
      if (!items.length) return console.log(all ? "No hay restricciones guardadas." : "No hay restricciones activas.");
      for (const r of items) console.log(`${describe(r)}${holds.isActive(r, nowMs) ? "" : " · ya no se aplica"}`);
      return;
    }
    if (sub === "release") {
      if (!args[0]) fail(USAGE);
      const r = mutate((d) => holds.releaseRestriction(d, args[0], { by: "chat" }));
      if (r.error) fail(r.error);
      console.log(`Restricción ${r.restriction.id} levantada. Lo que cubría ya se puede aprobar; no se envía nada solo: hay que pulsar Hacer (o aprobarlo por chat).`);
      return;
    }
    if (sub === "check") {
      if (!args[0]) fail(USAGE);
      const d = load();
      const t = d.tasks[args[0]] || { key: args[0] };
      const list = holds.restrictionsFor(d, holds.taskTarget(t, args[1]));
      if (!list.length) return console.log(`${args[0]}: sin restricciones activas.`);
      for (const r of list) console.log(describe(r));
      return;
    }
    fail(USAGE);
  },
};

const config = require("../core/config");
const { load, mutate, now } = require("../core/data");
const hours = require("../core/hours");

const MINUTE = { beta: 3, production: 33 };
const firstHour = () => Math.ceil((hours.startMin() + 57) / 60);
const lastHour = (environment) => Math.floor((hours.endMin() - MINUTE[environment] - 1) / 60);
const closing = () => hours.endMin() + 1;
const WINDOW = 10;

function slots(environment, everyHours) {
  const n = Math.max(1, Math.min(9, Math.round(everyHours || 1)));
  const out = [];
  for (let h = firstHour(); h <= lastHour(environment); h += n) out.push(h * 60 + MINUTE[environment]);
  return out;
}

function dueNow(environments, t = hours.clock()) {
  if (t.weekend) return null;
  for (const e of environments) {
    const slot = slots(e.id, e.everyHours).find((s) => t.min >= s && t.min < s + WINDOW);
    if (slot !== undefined) return { environments: [e.id], slot };
  }
  const close = closing();
  if (t.min >= close && t.min < close + WINDOW) return { environments: environments.map((e) => e.id), slot: close };
  return null;
}

const dayKey = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });

function pending(d, environments) {
  const due = d.followUpDue || {};
  return environments.filter((e) => due[e.id] && (!e.lastScheduled || e.lastScheduled < due[e.id].at)).map((e) => e.id);
}

const notice = (envs) =>
  `Aviso del tablero: toca el seguimiento de ${envs.join(" y ")}. Compruébalo con «${config.cli} followup-status» (campo due) y haz «Cada resumen» de .claude/commands/seguimiento.md para ${envs.length > 1 ? "cada uno, en ese orden" : "ese entorno"}.`;

let busy = false;

async function tick() {
  if (busy || !require("../cluster/cluster").primaryNow()) return;
  const { state } = require("../server/state");
  let e = state().followUpStatus;
  if (!e || e.paused) return;
  const hit = dueNow(e.environments);
  if (!hit) return;
  const key = `${dayKey()}@${hit.slot}`;
  const d = load();
  const due = d.followUpDue || {};
  const fresh = hit.environments.filter((env) => !due[env] || due[env].key !== key);
  if (!fresh.length) return;
  busy = true;
  try {
    mutate((x) => {
      x.followUpDue = { ...(x.followUpDue || {}) };
      for (const env of fresh) x.followUpDue[env] = { key, at: now() };
    });
    const registry = require("../sessions/registry");
    if (!e.open) {
      registry.openInVsCode(e.conversation);
      for (let i = 0; i < 24 && !(e = state().followUpStatus).open; i++) await new Promise((r) => setTimeout(r, 5000));
      if (!e.open) return;
      await new Promise((r) => setTimeout(r, 8000));
    }
    await registry.wakeSession(e.session, notice(fresh));
  } finally {
    busy = false;
  }
}

function cronOf(environment, everyHours) {
  const list = slots(environment, everyHours).map((m) => Math.floor(m / 60));
  return `${MINUTE[environment]} ${list.join(",") || "-"} * * 1-5`;
}

module.exports = { tick, slots, dueNow, pending, cronOf };

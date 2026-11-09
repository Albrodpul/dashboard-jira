const { now, load, mutate, readStdin } = require("../core/data");
const { sendPush } = require("../server/push");
const { state } = require("../server/state");
const { markSent: markSentrySent, saveResult: saveSentryResult } = require("../features/sentry");
const { a, rest, keyList, json, option, withoutOptions, environmentOption, ME, fail } = require("./args");
const config = require("../core/config");

module.exports = {
  followup() {
    const environment = environmentOption();
    const manual = process.argv.includes("--manual");
    const text = (withoutOptions()[0] || readStdin()).trim();
    if (!text) fail("falta el texto del resumen");
    const { environmentName } = require("../features/follow-up");
    mutate((d) => {
      d.followUps.unshift({ at: now(), text, environment, ...(manual ? { manual: true } : {}) });
      d.followUps = d.followUps.slice(0, 120);
      const p = d.followUpRequest;
      if (p && !p.handled && (p.environment || "beta") === environment) Object.assign(p, { handled: true, handledAt: now() });
    });
    console.log(`resumen de seguimiento de ${environmentName(environment)} guardado en el tablero`);
  },

  people() {
    json(require("../features/follow-up").people(load()));
  },

  "person-add"() {
    const accounts = process.argv.slice(4).join(",").split(",").map((x) => x.trim()).filter(Boolean);
    if (!a) fail("Uso: board.js person-add \"<Nombre>\" [<correo>[,<correo>…]]");
    const r = require("../features/follow-up").registerPerson(a, accounts);
    if (r.error) fail(r.error);
    console.log(`${r.person.name} (${r.person.id}) en el directorio; cuentas: ${(r.person.accounts || []).join(", ") || "ninguna"}`);
  },

  "person-accounts"() {
    const accounts = process.argv
      .slice(4)
      .join(",")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!a || !accounts.length) fail("Uso: board.js person-accounts <persona> <correo>[,<correo>…]");
    if (!require("../features/follow-up").saveAccounts(a, accounts)) fail(`persona desconocida: ${a}`);
    console.log(`cuentas de ${a} guardadas: ${accounts.join(", ")}`);
  },

  "followup-error"() {
    const environment = environmentOption();
    const person = option(["--person", "--persona"]);
    const { environmentOf, environmentName } = require("../features/follow-up");
    const text = (withoutOptions().join(" ") || readStdin()).trim().slice(0, 3000);
    if (!text) fail("Uso: board.js followup-error --environment <beta|production> [--person <nombre>] <posible error, con hora, cuenta, operación, respuesta y api_request_id>");
    const id = mutate((d) => {
      const r = d.followUps.find((x) => environmentOf(x, d) === environment);
      if (!r) return "";
      const at = now();
      const created = "err-" + at.replace(/[^0-9]/g, "").slice(0, 17);
      r.errors = (r.errors || []).concat({ id: created, text, state: "proposed", at, ...(person ? { person: String(person).slice(0, 80) } : {}) });
      return created;
    });
    if (!id) fail(`no hay ningún resumen de ${environmentName(environment)} al que colgarlo: publica antes el resumen`);
    console.log(`posible error ${id} añadido al último resumen; ${ME} decide si se envía a Errores sentry`);
    sendPush("followup", true, `Posible error en el seguimiento de ${environmentName(environment)}${person ? ` (${person})` : ""}`).then(
      () => {},
      () => {}
    );
  },

  "error-sent"() {
    const ids = keyList(process.argv.slice(3).join(","));
    const n = mutate((d) => {
      let k = 0;
      for (const r of d.followUps) {
        for (const e of r.errors || []) {
          if (!ids.includes(e.id) || e.state !== "approved" || e.approvedVia !== "board") continue;
          const held = require("../features/holds").checkArea(d, `El posible error ${e.id}`, config.errorsArea);
          if (held) {
            console.error(held);
            continue;
          }
          Object.assign(e, { state: "sent", sentAt: now() });
          k++;
        }
      }
      return k;
    });
    console.log(`${n} de ${ids.length} posible(s) error(es) marcados como enviados a Errores sentry`);
    if (n < ids.length) process.exit(1);
  },

  "sentry-sent"() {
    const ids = keyList(process.argv.slice(3).join(","));
    const n = markSentrySent(ids);
    console.log(`${n} de ${ids.length} error(es) de Sentry marcados como enviados`);
    if (n < ids.length) process.exit(1);
  },

  "sentry-result"() {
    const ids = keyList(a);
    const text = rest(4).slice(0, 1500);
    if (!ids.length || !text) fail("Uso: board.js sentry-result <ID>[,<ID>…] <qué se ha encontrado o hecho, en pocas líneas>");
    const n = saveSentryResult(ids, text);
    console.log(`resultado guardado en ${n} de ${ids.length} error(es) de Sentry`);
    if (!n) process.exit(1);
    sendPush("sentry", true, `Resultado de Sentry: ${ids.join(", ")}`).then(
      () => {},
      () => {}
    );
  },

  "error-result"() {
    const ids = keyList(a);
    const text = rest(4).slice(0, 1500);
    if (!ids.length || !text) fail("Uso: board.js error-result <id>[,<id>…] <qué se ha encontrado o hecho, en pocas líneas>");
    const n = mutate((d) => {
      let k = 0;
      for (const r of d.followUps) {
        for (const e of r.errors || []) {
          if (!ids.includes(e.id) || !["approved", "sent"].includes(e.state)) continue;
          e.result = { text, at: now() };
          if (e.state === "approved") Object.assign(e, { state: "sent", sentAt: now() });
          k++;
        }
      }
      return k;
    });
    console.log(`${n} de ${ids.length} posible(s) error(es) con su resultado guardado en el tablero`);
    if (n) sendPush("followup", true, "La sesión de errores ha contestado").then(() => {}, () => {});
    if (n < ids.length) process.exit(1);
  },

  "followup-status"() {
    json(state().followUpStatus);
  },
};

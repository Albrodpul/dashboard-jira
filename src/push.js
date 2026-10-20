const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR, readJson } = require("./data");

const KEYS_FILE = path.join(DATA_DIR, "push-vapid.json");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subs.json");
const LAST_FILE = path.join(DATA_DIR, "push-last.json");
const REASONS = { tasks: "Hay tareas nuevas", sessions: "Hay sesiones que necesitan tu atención", reply: "Te han contestado en el tablero", test: "Aviso de prueba del tablero" };

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pushKeys() {
  const saved = readJson(KEYS_FILE, null);
  if (saved && saved.publicKey) return saved;
  if (saved && saved.publica) {
    const converted = { publicKey: saved.publica, privateKey: saved.privada };
    fs.writeFileSync(KEYS_FILE, JSON.stringify(converted));
    return converted;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const keys = {
    publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64"), Buffer.from(jwk.y, "base64")])),
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys));
  return keys;
}

const subscriptions = () => readJson(SUBSCRIPTIONS_FILE, []);
const saveSubscriptions = (subs) => fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 1));

function pushReason() {
  const last = readJson(LAST_FILE, {});
  const recent = Object.entries(last)
    .filter(([, at]) => Date.now() - new Date(at).getTime() < 10 * 60000)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([t]) => t);
  if (recent.includes("tasks") && recent.includes("sessions")) return "Hay tareas nuevas y sesiones que necesitan tu atención";
  return REASONS[recent[0]] || "Hay novedades";
}

async function sendPush(type, force) {
  const subs = subscriptions();
  if (!subs.length) return 0;
  let last = readJson(LAST_FILE, {});
  if (!force && last[type] && Date.now() - new Date(last[type]).getTime() < 60000) return 0;
  if (type === "test") last = {};
  last[type] = new Date().toISOString();
  fs.writeFileSync(LAST_FILE, JSON.stringify(last));
  const keys = pushKeys();
  const dead = [];
  let sent = 0;
  for (const s of subs) {
    try {
      const aud = new URL(s.endpoint).origin;
      const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
      const body = b64url(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:tablero@example.com" }));
      const signature = b64url(crypto.sign("sha256", Buffer.from(`${header}.${body}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }));
      const r = await fetch(s.endpoint, { method: "POST", headers: { TTL: "3600", Urgency: "high", Authorization: `vapid t=${header}.${body}.${signature}, k=${keys.publicKey}`, "Content-Length": "0" } });
      if (r.status === 404 || r.status === 410) dead.push(s.endpoint);
      else if (r.ok) sent++;
    } catch (e) {}
  }
  if (dead.length) saveSubscriptions(subscriptions().filter((s) => !dead.includes(s.endpoint)));
  return sent;
}

function handlePush(res, route, input, send) {
  if (route === "/api/push/subscribe") {
    const s = input && input.subscription;
    if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint)) return send(res, 400, { error: "suscripción no válida" });
    const subs = subscriptions().filter((x) => x.endpoint !== s.endpoint);
    subs.push({ endpoint: s.endpoint, device: String(input.device || "").slice(0, 80), at: new Date().toISOString() });
    saveSubscriptions(subs);
    return send(res, 200, { ok: true });
  }
  if (route === "/api/push/unsubscribe") {
    const endpoint = input && input.endpoint;
    saveSubscriptions(subscriptions().filter((x) => x.endpoint !== endpoint));
    return send(res, 200, { ok: true });
  }
  sendPush("test", true).then((n) => send(res, 200, { sent: n }));
}

module.exports = { pushKeys, subscriptions, pushReason, sendPush, handlePush };

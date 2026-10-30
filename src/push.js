const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR, readJson } = require("./data");

const KEYS_FILE = path.join(DATA_DIR, "push-vapid.json");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subs.json");
const LAST_FILE = path.join(DATA_DIR, "push-last.json");
const REASONS = {
  tasks: { title: "Tareas", text: "Hay tareas nuevas en Pendientes", tab: "pending" },
  sessions: { title: "Sesiones", text: "Una sesión necesita tu respuesta", tab: "waiting" },
  followup: { title: "Seguimiento", text: "Hay novedades en el seguimiento", tab: "follow-up" },
  reply: { title: "Hablar", text: "Te han contestado en Hablar", tab: "talk" },
  deploys: { title: "Despliegues", text: "Ha terminado un despliegue", tab: "deploy" },
  permission: { title: "Permiso", text: "Una sesión pide permiso", tab: "waiting" },
  sentry: { title: "Sentry", text: "Una sesión ha contestado sobre un error de Sentry", tab: "sentry" },
  test: { title: "Prueba", text: "Aviso de prueba del tablero", tab: "home" },
};

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

const entryOf = (v) => (typeof v === "string" ? { at: v } : v || {});

function pushReason() {
  const last = readJson(LAST_FILE, {});
  const [type, entry] = Object.entries(last)
    .map(([t, v]) => [t, entryOf(v)])
    .filter(([t, v]) => REASONS[t] && v.at && Date.now() - new Date(v.at).getTime() < 10 * 60000)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))[0] || [];
  return notificationFor(type, entry && entry.text);
}

const fromB64url = (t) => Buffer.from(String(t).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function encrypt(payload, keys) {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0]), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), Buffer.from([0, 1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce"), Buffer.from([0, 1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

function notificationFor(type, text) {
  const r = REASONS[type] || { title: "", text: "Hay novedades", tab: "home" };
  return { title: r.title ? `NutrIA · ${r.title}` : "NutrIA", text: text || r.text, tab: r.tab, tag: type || "board" };
}

async function sendPush(type, force, text) {
  const subs = subscriptions();
  if (!subs.length) return 0;
  let last = readJson(LAST_FILE, {});
  const prev = entryOf(last[type]);
  if (!force && prev.at && Date.now() - new Date(prev.at).getTime() < 60000) return 0;
  if (type === "test") last = {};
  last[type] = { at: new Date().toISOString(), text: text || null };
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
      const headers = { TTL: "3600", Urgency: "high", Authorization: `vapid t=${header}.${body}.${signature}, k=${keys.publicKey}` };
      let payload = null;
      if (s.keys && s.keys.p256dh && s.keys.auth) {
        payload = encrypt(JSON.stringify(notificationFor(type, text)), s.keys);
        Object.assign(headers, { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "Content-Length": String(payload.length) });
      } else headers["Content-Length"] = "0";
      const r = await fetch(s.endpoint, { method: "POST", headers, body: payload });
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
    const device = String(input.device || "").slice(0, 80);
    const host = new URL(s.endpoint).host;
    const subs = subscriptions().filter((x) => x.endpoint !== s.endpoint && !(device && x.device === device && new URL(x.endpoint).host === host));
    const keys = s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string" ? { p256dh: s.keys.p256dh, auth: s.keys.auth } : null;
    subs.push({ endpoint: s.endpoint, keys, device, at: new Date().toISOString() });
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

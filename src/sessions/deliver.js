const fs = require("fs");

const PASTE_SETTLE_MS = 400;
const CONFIRM_MS = 15000;
const POLL_MS = 500;
const TAIL_BYTES = 4 * 1024 * 1024;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (text) =>
  String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();

function defaults() {
  const registry = require("./registry");
  const host = require("./host");
  return {
    transcript: (conversation) => registry.transcriptOf(conversation),
    write: (conversation, data) => host.hostRequest("POST", "/input", { conversation, data }),
    wait,
  };
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return 0;
  }
}

function seenSince(file, token, from) {
  if (!file) return false;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, Math.min(from, size), size - TAIL_BYTES);
    if (size <= start) return false;
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString("utf8").includes(token);
  } catch (e) {
    return false;
  }
}

function seenAnywhere(conversation, token, deps = defaults()) {
  return seenSince(deps.transcript(conversation), token, 0);
}

async function confirm(deps, conversation, token, from, ms) {
  for (let waited = 0; waited <= ms; waited += POLL_MS) {
    if (seenSince(deps.transcript(conversation), token, from)) return true;
    await deps.wait(POLL_MS);
  }
  return false;
}

async function typeInto(conversation, text, token, deps = defaults()) {
  const body = clean(text);
  if (!body.includes(token)) throw new Error("el mensaje no lleva su marca de envío");
  const file = deps.transcript(conversation);
  const from = file ? sizeOf(file) : 0;
  const put = async (data) => {
    const r = await deps.write(conversation, data);
    if (r && r.error) throw new Error(`el gestor de sesiones no deja escribir: ${r.error}`);
  };
  await put(`\x1b[200~${body}\x1b[201~`);
  await deps.wait(PASTE_SETTLE_MS);
  await put("\r");
  if (await confirm(deps, conversation, token, from, CONFIRM_MS)) return { ok: true };
  await put("\r");
  if (await confirm(deps, conversation, token, from, CONFIRM_MS)) return { ok: true, retried: true };
  return { ok: false, error: "el mensaje no aparece en la conversación de la sesión: puede tener un diálogo abierto o estar arrancando. Mírala en Hablar" };
}

async function sendMessageInto(conversation, sendTo, text, token, deps = {}) {
  const base = defaults();
  const transcript = deps.transcript || base.transcript;
  const wake = deps.wake || require("./registry").wakeSession;
  const file = conversation ? transcript(conversation) : null;
  const from = file ? sizeOf(file) : 0;
  const ok = await wake(sendTo, clean(text));
  if (!conversation) return ok ? { ok: true, unconfirmed: true } : { ok: false, error: "no se pudo mandar el mensaje entre sesiones" };
  if (await confirm({ ...base, transcript, wait: deps.wait || wait }, conversation, token, from, CONFIRM_MS)) return { ok: true };
  return { ok: false, error: ok ? "el mensaje entre sesiones no aparece en la conversación de destino" : "no se pudo mandar el mensaje entre sesiones" };
}

module.exports = { typeInto, sendMessageInto, seenSince, seenAnywhere, clean };

const fs = require("fs");
const path = require("path");
const config = require("./config");

const MAX_BYTES = 25 * 1024 * 1024;
const KEEP_DAYS = 7;
const DIR = path.join(config.root, "pruebas", "hablar");

function cleanOld() {
  let days = [];
  try {
    days = fs.readdirSync(DIR);
  } catch (e) {
    return;
  }
  const limit = Date.now() - KEEP_DAYS * 86400000;
  for (const d of days) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d).getTime() < limit) fs.rmSync(path.join(DIR, d), { recursive: true, force: true });
}

function safeName(name) {
  const base = path.basename(String(name || "fichero")).normalize("NFD").replace(/[̀-ͯ]/g, "");
  return base.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "fichero";
}

function handleUpload(req, res, send) {
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  const name = `${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}-${safeName(decodeURIComponent(req.headers["x-file-name"] || ""))}`;
  const dir = path.join(DIR, day);
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BYTES) return req.destroy();
    chunks.push(c);
  });
  req.on("end", () => {
    if (!size) return send(res, 400, { error: "fichero vacío" });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
    cleanOld();
    send(res, 200, { path: `pruebas/hablar/${day}/${name}` });
  });
  req.on("error", () => send(res, 413, { error: "demasiado grande" }));
}

module.exports = { handleUpload };

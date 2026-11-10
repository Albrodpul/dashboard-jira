const fs = require("fs");
const path = require("path");
const config = require("../core/config");

const MAX_BYTES = 25 * 1024 * 1024;
const KEEP_DAYS = 7;
const MAIN_DIR = path.join("pruebas", "hablar");
const OWN_DIR = path.join(".tablero", "hablar");

function cleanOld(dir) {
  let days = [];
  try {
    days = fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  const limit = Date.now() - KEEP_DAYS * 86400000;
  for (const d of days) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d).getTime() < limit) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
}

function safeName(name) {
  const base = path.basename(String(name || "fichero")).normalize("NFD").replace(/[̀-ͯ]/g, "");
  return base.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "fichero";
}

function keepOutOfGit(root) {
  const exclude = path.join(root, ".git", "info", "exclude");
  if (!fs.existsSync(path.dirname(exclude))) return;
  const now = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (!/^\/?\.tablero\/?$/m.test(now)) fs.writeFileSync(exclude, `${now}${now && !now.endsWith("\n") ? "\n" : ""}/.tablero/\n`);
}

function target(conversation) {
  const projects = require("../core/projects");
  const p = /^[0-9a-f-]{36}$/.test(conversation || "") ? projects.projectOfConversation(conversation) : null;
  if (!p || p.id === projects.mainId()) return { root: config.root, base: MAIN_DIR, absolute: false };
  if (!p.root || !fs.existsSync(p.root)) return { error: `«${p.name}» no tiene carpeta en este ordenador` };
  keepOutOfGit(p.root);
  return { root: p.root, base: OWN_DIR, absolute: true };
}

function handleUpload(req, res, send) {
  const where = target(String(req.headers["x-conversation"] || ""));
  if (where.error) {
    req.resume();
    return send(res, 409, { error: where.error });
  }
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  const name = `${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}-${safeName(decodeURIComponent(req.headers["x-file-name"] || ""))}`;
  const top = path.join(where.root, where.base);
  const dir = path.join(top, day);
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
    cleanOld(top);
    const rel = path.join(where.base, day, name).split(path.sep).join("/");
    send(res, 200, { path: where.absolute ? path.join(dir, name).split(path.sep).join("/") : rel });
  });
  req.on("error", () => send(res, 413, { error: "demasiado grande" }));
}

module.exports = { handleUpload, target };

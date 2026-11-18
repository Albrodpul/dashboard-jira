const fs = require("fs");
const path = require("path");
const config = require("../core/config");

const MAX_MB = 500;
const MAX_BYTES = MAX_MB * 1024 * 1024;
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
  const declared = Number(req.headers["content-length"] || 0);
  const tooBig = () => {
    res.setHeader("connection", "close");
    send(res, 413, { error: `pasa de ${MAX_MB} MB` });
    req.unpipe();
    req.resume();
  };
  if (declared > MAX_BYTES) return tooBig();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const part = `${file}.part`;
  const out = fs.createWriteStream(part);
  let size = 0;
  let failed = false;
  const fail = (code, error) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rmSync(part, { force: true });
    if (code === 413) return tooBig();
    send(res, code, { error });
  };
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BYTES) fail(413);
  });
  req.on("error", () => fail(400, "subida cortada"));
  out.on("error", (e) => fail(500, String(e.message || e)));
  out.on("finish", () => {
    if (failed) return;
    if (!size) return fail(400, "fichero vacío");
    fs.renameSync(part, file);
    cleanOld(top);
    const rel = path.join(where.base, day, name).split(path.sep).join("/");
    send(res, 200, { path: where.absolute ? file.split(path.sep).join("/") : rel });
  });
  req.pipe(out);
}

module.exports = { handleUpload, target, MAX_MB };

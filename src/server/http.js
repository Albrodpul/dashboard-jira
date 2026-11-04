const fs = require("fs");
const path = require("path");
const { DATA_DIR, PORT } = require("../core/data");

const HOSTS_FILE = path.join(DATA_DIR, "board-hosts.txt");

function extraHosts() {
  try {
    return fs
      .readFileSync(HOSTS_FILE, "utf8")
      .split("\n")
      .map((x) => x.trim().toLowerCase().split("://").pop().split("/")[0])
      .filter((x) => x && !x.startsWith("#"));
  } catch (e) {
    return [];
  }
}

const hostOk = (h) => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || extraHosts().includes(String(h).toLowerCase());
const originOk = (req) => !req.headers.origin || hostOk(req.headers.origin.replace(/^https?:\/\//, ""));
const send = (res, code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body || {}));

function serveBody(res, type, body, cache) {
  res.writeHead(200, { "content-type": type, "cache-control": cache || "no-store" });
  res.end(body);
  return true;
}

module.exports = { hostOk, originOk, send, serveBody };

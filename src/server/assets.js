const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { serveBody } = require("./http");

const PAGE_DIR = path.join(__dirname, "..", "page");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const LABEL = (require("../core/config").cluster || {}).label || "";
const MANIFEST = JSON.stringify({
  name: LABEL ? `NutrIA · ${LABEL}` : "NutrIA",
  short_name: LABEL ? `NutrIA ${LABEL}` : "NutrIA",
  description: "Tareas de Jira que se pueden pasar a la sesión que lleva su epic.",
  lang: "es",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#eef1f4",
  theme_color: "#0b6e8a",
  icons: [
    { src: "/icon-192.png?v=nutria2", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png?v=nutria2", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
});

const SERVICE_WORKER = fs.readFileSync(path.join(PAGE_DIR, "sw.js"), "utf8");

const icons = new Map();

function icon(side) {
  if (icons.has(side)) return icons.get(side);
  const background = (require("../core/config").cluster || {}).color || [11, 110, 138];
  const hex = background.map((n) => n.toString(16).padStart(2, "0")).join("");
  try {
    const drawn = fs.readFileSync(path.join(PAGE_DIR, "icons", `icon-${side}-${hex}.png`));
    icons.set(side, drawn);
    return drawn;
  } catch (e) {}
  const paper = [255, 255, 255];
  const accent = [255, 196, 87];
  const row = side * 4 + 1;
  const raw = Buffer.alloc(row * side);
  const inside = (x, y, x0, y0, x1, y1) => x >= x0 * side && x < x1 * side && y >= y0 * side && y < y1 * side;
  for (let y = 0; y < side; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < side; x++) {
      let c = background;
      if (inside(x, y, 0.2, 0.22, 0.8, 0.36) || inside(x, y, 0.2, 0.43, 0.8, 0.57) || inside(x, y, 0.2, 0.64, 0.8, 0.78)) c = paper;
      if (inside(x, y, 0.2, 0.22, 0.26, 0.36)) c = accent;
      raw.set([...c, 255], y * row + 1 + x * 4);
    }
  }
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  icons.set(side, png);
  return png;
}

function pageFile(url) {
  if (url === "/" || url === "/index.html") return path.join(PAGE_DIR, "index.html");
  const m = /^\/page\/((?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|css))$/.exec(url);
  return m ? path.join(PAGE_DIR, m[1]) : null;
}

const NM = path.join(__dirname, "..", "..", "node_modules", "@xterm");
const VENDOR = {
  "/vendor/xterm.js": [path.join(NM, "xterm", "lib", "xterm.js"), "text/javascript; charset=utf-8"],
  "/vendor/xterm.css": [path.join(NM, "xterm", "css", "xterm.css"), "text/css; charset=utf-8"],
  "/vendor/addon-fit.js": [path.join(NM, "addon-fit", "lib", "addon-fit.js"), "text/javascript; charset=utf-8"],
};

function serveAsset(res, url) {
  const file = pageFile(url);
  if (file) {
    let body;
    try {
      body = fs.readFileSync(file);
    } catch (e) {
      return res.writeHead(404).end();
    }
    return serveBody(res, TYPES[path.extname(file)], body);
  }
  if (url === "/manifest.webmanifest") return serveBody(res, "application/manifest+json", MANIFEST);
  if (url === "/sw.js") return serveBody(res, "text/javascript", SERVICE_WORKER);
  if (VENDOR[url]) {
    let body;
    try {
      body = fs.readFileSync(VENDOR[url][0]);
    } catch (e) {
      return res.writeHead(404).end();
    }
    return serveBody(res, VENDOR[url][1], body, "max-age=86400");
  }
  if (["/icon-192.png", "/icon-512.png", "/favicon.ico"].includes(url)) return serveBody(res, "image/png", icon(url === "/icon-512.png" ? 512 : 192), "max-age=86400");
  return false;
}

module.exports = { LABEL, serveAsset };

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const config = require("./config");

const ROOT = config.root;
const TTL = 60000;
let index = null;
let builtAt = 0;
let building = null;

function listRepo(dir, prefix) {
  return new Promise((resolve) => {
    cp.execFile("git", ["-C", dir, "ls-files", "-co", "--exclude-standard"], { windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        String(stdout)
          .split("\n")
          .filter(Boolean)
          .map((f) => (prefix ? `${prefix}/${f}` : f))
      );
    });
  });
}

async function build() {
  const dirs = [[ROOT, ""]];
  for (const name of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(path.join(full, ".git"))) dirs.push([full, name]);
  }
  const lists = await Promise.all(dirs.map(([d, p]) => listRepo(d, p)));
  index = [...new Set(lists.flat())];
  builtAt = Date.now();
  building = null;
  return index;
}

async function files() {
  if (index && Date.now() - builtAt < TTL) return index;
  if (!building)
    building = build().catch(() => {
      building = null;
      return index || [];
    });
  return index || building;
}

async function searchFiles(q) {
  const query = String(q || "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .trim();
  if (!query) return [];
  const all = await files();
  const scored = [];
  for (const f of all) {
    const lower = f.toLowerCase();
    const at = lower.indexOf(query);
    if (at < 0) continue;
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const score = (base.startsWith(query) ? 0 : base.includes(query) ? 1 : 2) * 1000 + f.length;
    scored.push([score, f]);
    if (scored.length > 5000) break;
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, 12)
    .map((x) => x[1]);
}

module.exports = { searchFiles, warmFiles: () => files().catch(() => {}) };

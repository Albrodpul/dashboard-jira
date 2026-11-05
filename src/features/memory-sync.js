const fs = require("fs");
const path = require("path");
const cluster = require("../cluster/cluster");

const INDEX = "MEMORY.md";
const memoryDir = () => path.join(cluster.projectDir(), "memory");
const isNote = (name) => /^[\w.-]+\.md$/.test(name);
const linksOf = (text) => new Set([...String(text).matchAll(/\]\(([\w.-]+\.md)\)/g)].map((m) => m[1]));

function memoryFiles() {
  const dir = memoryDir();
  const files = {};
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(isNote);
  } catch (e) {
    return files;
  }
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      files[name] = { text: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs };
    } catch (e) {}
  }
  return files;
}

function mergeIndex(local, peer) {
  const have = linksOf(local);
  const extra = String(peer)
    .split(/\r?\n/)
    .filter((line) => {
      const links = [...linksOf(line)];
      return links.length && links.every((l) => !have.has(l));
    });
  if (!extra.length) return null;
  const base = local.trim() ? local.replace(/\s*$/, "\n") : "# Memory Index\n\n";
  return base + extra.join("\n") + "\n";
}

async function syncMemory() {
  if (!cluster.clusterEnabled()) return;
  const peer = await cluster.peerGet("/api/cluster/memory", 15000);
  if (!peer || !peer.files) return;
  const dir = memoryDir();
  fs.mkdirSync(dir, { recursive: true });
  const local = memoryFiles();
  for (const [name, theirs] of Object.entries(peer.files)) {
    if (!isNote(name) || typeof theirs.text !== "string") continue;
    const file = path.join(dir, name);
    if (name === INDEX) {
      const merged = mergeIndex(local[name] ? local[name].text : "", theirs.text);
      if (merged) fs.writeFileSync(file, merged);
      continue;
    }
    const mine = local[name];
    if (mine && (mine.text === theirs.text || mine.mtime >= theirs.mtime)) continue;
    fs.writeFileSync(file, theirs.text);
    const when = new Date(theirs.mtime);
    fs.utimesSync(file, when, when);
  }
}

module.exports = { memoryFiles, syncMemory };

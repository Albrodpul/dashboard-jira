const fs = require("fs");
const path = require("path");
const cluster = require("../cluster/cluster");
const { DATA_DIR } = require("../core/data");

const INDEX = "MEMORY.md";
const memoryDir = () => path.join(cluster.projectDir(), "memory");
const isNote = (name) => /^[\w.-]+\.md$/.test(name);
const STATE = () => path.join(DATA_DIR, "memory-sync.json");
const TOMB_MS = 30 * 24 * 3600 * 1000;

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE(), "utf8"));
    return { known: Array.isArray(s.known) ? s.known : null, deleted: s.deleted && typeof s.deleted === "object" ? s.deleted : {} };
  } catch (e) {
    return { known: null, deleted: {} };
  }
}

function writeState(st) {
  try {
    fs.writeFileSync(STATE(), JSON.stringify(st));
  } catch (e) {}
}

function tombstones(names = Object.keys(memoryFiles())) {
  const st = readState();
  const now = Date.now();
  if (st.known) for (const n of st.known) if (n !== INDEX && !names.includes(n) && !st.deleted[n]) st.deleted[n] = now;
  for (const n of names) if (st.deleted[n] && n !== INDEX) {
    const file = path.join(memoryDir(), n);
    try {
      if (fs.statSync(file).mtimeMs > st.deleted[n]) delete st.deleted[n];
    } catch (e) {}
  }
  for (const [n, at] of Object.entries(st.deleted)) if (now - at > TOMB_MS) delete st.deleted[n];
  st.known = names;
  writeState(st);
  return st.deleted;
}

function dropFromIndex(text, gone) {
  const lines = String(text).split(/\r?\n/);
  const kept = lines.filter((line) => ![...linksOf(line)].some((l) => gone.has(l)));
  return kept.length === lines.length ? null : kept.join("\n");
}

function snapshot() {
  const files = memoryFiles();
  return { files, deleted: tombstones(Object.keys(files)) };
}

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

function mergeIndex(local, peer, gone = new Set()) {
  const have = linksOf(local);
  const extra = String(peer)
    .split(/\r?\n/)
    .filter((line) => {
      const links = [...linksOf(line)];
      return links.length && links.every((l) => !have.has(l) && !gone.has(l));
    });
  if (!extra.length) return null;
  const base = local.trim() ? local.replace(/\s*$/, "\n") : "# Memory Index\n\n";
  return base + extra.join("\n") + "\n";
}

async function syncMemory() {
  if (!cluster.clusterEnabled()) return;
  tombstones();
  const peer = await cluster.peerGet("/api/cluster/memory", 15000);
  if (!peer || !peer.files) return;
  const dir = memoryDir();
  fs.mkdirSync(dir, { recursive: true });
  let local = memoryFiles();
  const deleted = tombstones(Object.keys(local));
  for (const [n, at] of Object.entries(peer.deleted || {})) if (isNote(n) && n !== INDEX && Number(at) > (deleted[n] || 0)) deleted[n] = Number(at);
  const gone = new Set();
  for (const [n, at] of Object.entries(deleted)) {
    if (local[n] && local[n].mtime <= at) {
      try {
        fs.unlinkSync(path.join(dir, n));
      } catch (e) {}
      delete local[n];
    }
    if (!local[n]) gone.add(n);
  }
  const st = readState();
  writeState({ known: Object.keys(local), deleted: { ...st.deleted, ...deleted } });
  if (local[INDEX] && gone.size) {
    const pruned = dropFromIndex(local[INDEX].text, gone);
    if (pruned !== null) {
      fs.writeFileSync(path.join(dir, INDEX), pruned);
      local[INDEX].text = pruned;
    }
  }
  for (const [name, theirs] of Object.entries(peer.files)) {
    if (!isNote(name) || typeof theirs.text !== "string") continue;
    const file = path.join(dir, name);
    if (name === INDEX) {
      const merged = mergeIndex(local[name] ? local[name].text : "", theirs.text, gone);
      if (merged) fs.writeFileSync(file, merged);
      continue;
    }
    if (gone.has(name) && theirs.mtime <= deleted[name]) continue;
    const mine = local[name];
    if (mine && (mine.text === theirs.text || mine.mtime >= theirs.mtime)) continue;
    fs.writeFileSync(file, theirs.text);
    const when = new Date(theirs.mtime);
    fs.utimesSync(file, when, when);
  }
  tombstones();
}

module.exports = { memoryFiles, snapshot, syncMemory, mergeIndex, dropFromIndex };

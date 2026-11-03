const parse = (buf) =>
  buf
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((raw) => {
      let j = null;
      try {
        j = JSON.parse(raw);
      } catch (e) {}
      return { raw, j, key: (j && j.uuid) || raw };
    });

const firstTime = (lines) => {
  for (const l of lines) if (l.j && l.j.timestamp) return l.j.timestamp;
  return "";
};

function relink(tail, parent) {
  if (!parent || !tail.length) return tail;
  const own = new Set(tail.map((l) => l.j && l.j.uuid).filter(Boolean));
  let done = false;
  return tail.map((l) => {
    if (done || !l.j || !l.j.uuid || !("parentUuid" in l.j) || l.j.parentUuid === null || own.has(l.j.parentUuid)) return l;
    done = true;
    return { ...l, raw: JSON.stringify({ ...l.j, parentUuid: parent }) };
  });
}

function mergeTranscript(localBuf, peerBuf) {
  const local = parse(localBuf);
  const peer = parse(peerBuf);
  const peerKeys = new Set(peer.map((l) => l.key));
  const localKeys = new Set(local.map((l) => l.key));
  const peerOnly = peer.filter((l) => !localKeys.has(l.key));
  const d = local.findIndex((l) => !peerKeys.has(l.key));
  if (d < 0) return { action: "take" };
  if (!peerOnly.length) return { action: "keep" };
  const prefix = local.slice(0, d);
  const localTail = local.slice(d);
  const [first, second] = firstTime(localTail) <= firstTime(peerOnly) ? [localTail, peerOnly] : [peerOnly, localTail];
  const lastUuid = [...first].reverse().find((l) => l.j && l.j.uuid);
  const lines = [...prefix, ...first, ...relink(second, lastUuid && lastUuid.j.uuid)];
  return { action: "merge", body: Buffer.from(lines.map((l) => l.raw).join("\n") + "\n"), localOnly: localTail.length, peerOnly: peerOnly.length };
}

module.exports = { mergeTranscript };

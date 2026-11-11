const stuck = new Map();

function report({ conversation, name, text, cleared }) {
  if (!conversation) return false;
  if (cleared) return stuck.delete(conversation) && false;
  const fresh = !stuck.has(conversation);
  stuck.set(conversation, { conversation, name: String(name || "Una sesión").slice(0, 80), text: String(text || "").slice(0, 1200), at: new Date().toISOString() });
  return fresh;
}

const list = () => [...stuck.values()];

module.exports = { report, list };

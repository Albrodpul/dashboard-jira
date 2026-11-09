const { CLUSTER, info } = require("./role");

async function peerGet(route, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(CLUSTER.peer + route, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function peerPost(route, body) {
  try {
    const r = await fetch(CLUSTER.peer + route, { method: "POST", headers: { "content-type": "application/json", origin: CLUSTER.peer }, body: JSON.stringify(body || {}) });
    return r.ok;
  } catch (e) {
    return false;
  }
}

function tailscaleDevices() {
  const exe = process.platform === "darwin" ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : "tailscale";
  return new Promise((resolve) =>
    require("child_process").execFile(exe, ["status", "--json"], { windowsHide: true, timeout: 10000, env: { ...process.env, TERM: process.env.TERM || "xterm-256color" } }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out);
        resolve(
          [j.Self, ...Object.values(j.Peer || {})]
            .filter((d) => d && !/^(android|ios)$/i.test(d.OS || ""))
            .map((d) => ({ name: d.HostName, os: d.OS, online: d === j.Self || !!d.Online, lastSeen: d.LastSeen && !d.LastSeen.startsWith("0001") ? d.LastSeen : null, ip: (d.TailscaleIPs || [])[0] || null, dns: String(d.DNSName || "").replace(/\.$/, ""), self: d === j.Self }))
        );
      } catch (e) {
        resolve(null);
      }
    })
  );
}

const sendClaudeToken = (token) => (CLUSTER ? peerPost("/api/cluster/claude-token", { token }) : Promise.resolve(false));

async function machines() {
  const [devices, peer] = await Promise.all([tailscaleDevices(), CLUSTER ? peerGet("/api/cluster", 5000) : null]);
  return { self: info(), peer, devices };
}

module.exports = { peerGet, peerPost, sendClaudeToken, machines };

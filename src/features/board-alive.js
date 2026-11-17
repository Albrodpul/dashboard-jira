const http = require("http");
const { BASE_URL } = require("../core/data");

const PROBE_MS = 60 * 1000;
const TIMEOUT_MS = 20 * 1000;
const RENOTIFY_MS = 60 * 60 * 1000;
const SLEEP_GAP_MS = 3 * PROBE_MS;

function probe(url = `${BASE_URL}/manifest.webmanifest`, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(false));
  });
}

function createChecker({ minutes, push, nowMs = () => Date.now() }) {
  const limit = minutes * 60000;
  const s = { lastOk: nowMs(), lastProbe: nowMs(), alertedAt: null };
  return {
    state: s,
    async record(ok) {
      const t = nowMs();
      if (t - s.lastProbe > SLEEP_GAP_MS) s.lastOk = Math.max(s.lastOk, t - PROBE_MS);
      s.lastProbe = t;
      if (ok) {
        const was = s.alertedAt;
        const down = Math.round((t - s.lastOk) / 60000);
        s.lastOk = t;
        s.alertedAt = null;
        if (was) await push(`El tablero vuelve a responder (llevaba unos ${down} min sin hacerlo).`);
        return was ? "recovered" : "ok";
      }
      if (t - s.lastOk < limit) return "waiting";
      if (s.alertedAt && t - s.alertedAt < RENOTIFY_MS) return "alerted";
      s.alertedAt = t;
      await push(`El tablero no responde desde hace ${Math.round((t - s.lastOk) / 60000)} min. Si no vuelve solo, reinícialo (en el Mac lo relanza launchd).`);
      return "alert";
    },
  };
}

function start({ minutes = require("../core/config").boardAliveMinutes, log = () => {} } = {}) {
  const push = (text) => require("../server/push").sendPush("board", true, text).then((n) => log(`board-alive push (${n}): ${text}`), (e) => log(`board-alive push failed: ${e.message || e}`));
  const checker = createChecker({ minutes, push });
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await checker.record(await probe());
    } catch (e) {
      log(`board-alive: ${e.message || e}`);
    } finally {
      busy = false;
    }
  }, PROBE_MS);
  timer.unref && timer.unref();
  return checker;
}

module.exports = { probe, createChecker, start };

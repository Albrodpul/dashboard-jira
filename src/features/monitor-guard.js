const { load } = require("../core/data");
const hours = require("../core/hours");

const STALE_MS = 3 * 60000;
const RETRY_MS = 10 * 60000;
let staleSince = 0;
let lastWake = 0;

const reviewHours = (t = hours.clock()) => !t.weekend && t.min >= 8 * 60 && t.min <= 18 * 60 + 30;

async function tick() {
  if (!require("../cluster/cluster").primaryNow()) return;
  if (!reviewHours() && !hours.overtime()) return (staleSince = 0);
  if ((load().config || {}).paused) return (staleSince = 0);
  const state = require("../server/state");
  state.wakeOrchestrator();
  const r = state.state().reporterStatus;
  if (!r || r.watching) return (staleSince = 0);
  if (!staleSince) staleSince = Date.now();
  if (Date.now() - staleSince < STALE_MS || Date.now() - lastWake < RETRY_MS) return;
  lastWake = Date.now();
  await state.wakeReporter(require("../sessions/registry").STARTUP_NOTICE);
}

module.exports = { tick, reviewHours };

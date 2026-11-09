const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../core/data");
const { CLUSTER, log, isPrimary } = require("./role");

function keepAwake() {
  if (!CLUSTER) return;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const min = Number(p.hour) * 60 + Number(p.minute);
  const hours = require("../core/hours");
  const macPower = require("../features/mac-power");
  const want = macPower.inWindow(hours.clock());
  const extra = !!hours.overtime() && isPrimary();
  if (process.platform !== "darwin") return;
  const extraFile = path.join(DATA_DIR, "caffeinate.extra");
  if (!extra && fs.existsSync(extraFile)) letSleep();
  if (!want && !extra) return;
  const cp = require("child_process");
  const pidFile = path.join(DATA_DIR, "caffeinate.pid");
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    process.kill(pid, 0);
    if (/caffeinate/.test(cp.execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)]).toString())) return;
  } catch (e) {}
  const end = macPower.schedule().sleep;
  const seconds = Math.max(60, (Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) - min) * 60);
  const child = cp.spawn("/usr/bin/caffeinate", extra ? ["-i"] : ["-i", "-t", String(seconds)], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  if (extra) fs.writeFileSync(extraFile, child.pid + "");
  log(extra ? "caffeinate: fuera de horario activado, el Mac no se dormirá hasta que lo termines" : `caffeinate: el Mac no se dormirá solo hasta las ${end}`);
}

function letSleep() {
  if (process.platform !== "darwin") return;
  const pidFile = path.join(DATA_DIR, "caffeinate.pid");
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (/caffeinate/.test(require("child_process").execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)]).toString())) process.kill(pid);
    fs.unlinkSync(pidFile);
    log("caffeinate: parado, el Mac ya puede dormirse");
  } catch (e) {}
  try {
    fs.unlinkSync(path.join(DATA_DIR, "caffeinate.extra"));
  } catch (e) {}
}

module.exports = { keepAwake, letSleep };

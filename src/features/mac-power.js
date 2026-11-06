const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { DATA_DIR, load, mutate } = require("../core/data");

const DEFAULT = { wake: "06:00", sleep: "21:00", days: "MTWRF" };
const STATE_FILE = path.join(DATA_DIR, "mac-power.json");
const isMac = process.platform === "darwin";

const log = (m) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "mac-power.log"), `[${new Date().toISOString()}] ${m}\n`);
  } catch (e) {}
};

function schedule() {
  const s = (load().config || {}).macSchedule || {};
  const ok = (t) => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  return { wake: ok(s.wake) ? s.wake : DEFAULT.wake, sleep: ok(s.sleep) ? s.sleep : DEFAULT.sleep, days: DEFAULT.days };
}

function setSchedule({ wake, sleep }) {
  mutate((d) => {
    d.config = d.config || {};
    d.config.macSchedule = { ...schedule(), ...(wake ? { wake } : {}), ...(sleep ? { sleep } : {}) };
  });
  return schedule();
}

const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function inWindow(clock) {
  const s = schedule();
  return !clock.weekend && clock.min >= minutes(s.wake) && clock.min < minutes(s.sleep);
}

let batteryCache = null;

function battery() {
  if (!isMac) return null;
  if (batteryCache && Date.now() - batteryCache.t < 30000) return batteryCache.value;
  let value = null;
  try {
    const out = cp.execFileSync("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8", timeout: 5000 });
    const m = /(\d+)%;\s*([^;]+);/.exec(out);
    if (m) {
      const state = m[2].trim();
      value = { percent: Number(m[1]), state, charging: /^charging|finishing charge/.test(state), onAC: /AC Power/.test(out), at: new Date().toISOString() };
    }
  } catch (e) {}
  batteryCache = { t: Date.now(), value };
  return value;
}

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
};
const writeState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s));

function sudoPmset(args) {
  try {
    cp.execFileSync("/usr/bin/sudo", ["-n", "/usr/bin/pmset", ...args], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch (e) {
    return false;
  }
}

let sudoCache = null;

function canSudo() {
  if (sudoCache && Date.now() - sudoCache.t < 60000) return sudoCache.ok;
  let ok = false;
  try {
    cp.execFileSync("/usr/bin/sudo", ["-n", "-l", "/usr/bin/pmset"], { stdio: "ignore", timeout: 5000 });
    ok = true;
  } catch (e) {}
  sudoCache = { t: Date.now(), ok };
  return ok;
}

function sleepDisabled() {
  try {
    return /SleepDisabled\s+1/.test(cp.execFileSync("/usr/bin/pmset", ["-g"], { encoding: "utf8", timeout: 5000 }));
  } catch (e) {
    return false;
  }
}

function tick() {
  if (!isMac) return;
  const hours = require("../core/hours");
  const clock = hours.clock();
  const s = schedule();
  const st = readState();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
  const key = `${s.wake}-${s.sleep}`;
  if (st.repeat !== key && canSudo()) {
    if (sudoPmset(["repeat", "wakeorpoweron", s.days, `${s.wake}:00`])) {
      st.repeat = key;
      log(`despertar programado de lunes a viernes a las ${s.wake}`);
    }
  }
  const primary = require("../cluster/cluster").isPrimary();
  const overtime = !!hours.overtime() && primary;
  const awake = inWindow(clock) || overtime;
  const bat = battery();
  const nearlyEmpty = !!(bat && !bat.onAC && !bat.charging && bat.percent < 10);
  const lidAwake = awake && !nearlyEmpty;
  if (lidAwake !== sleepDisabled() && canSudo() && sudoPmset(["-a", "disablesleep", lidAwake ? "1" : "0"])) log(lidAwake ? "no se duerme ni con la tapa cerrada (en horario)" : nearlyEmpty && awake ? "batería por debajo del 10 %: se deja dormir" : "vuelve a dormirse al cerrar la tapa");
  const sleepAt = minutes(s.sleep);
  if (!clock.weekend && !overtime && clock.min >= sleepAt && clock.min < sleepAt + 30 && st.sleptOn !== today) {
    st.sleptOn = today;
    writeState(st);
    require("../cluster/cluster").letSleep();
    if (sleepDisabled()) sudoPmset(["-a", "disablesleep", "0"]);
    log(`son las ${s.sleep}: a dormir`);
    cp.execFile("/usr/bin/pmset", ["sleepnow"], () => {});
    return;
  }
  writeState(st);
}

function status() {
  return { schedule: schedule(), allowed: isMac ? canSudo() : null, battery: battery() };
}

module.exports = { battery, tick, schedule, setSchedule, inWindow, status };

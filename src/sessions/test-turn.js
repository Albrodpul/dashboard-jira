const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const MAX_PASSES = 2;
const FIRST = 6;
const SECOND = 3;
const CLAIM_MS = 20000;
const RUN = /(?:^|&&|\|\||[;|(\n])\s*(?:\w+=\S*\s+)*(?:(?:\S*\/)?php[\d.]*\s+)?(?:\S*\/)?(?:artisan\s+test|vendor\/bin\/(?:phpunit|paratest))(?=\s|$|[;&|)])/;
const TEST_PROC = /\bartisan\s+test\b|vendor\/bin\/(?:phpunit|paratest)\b|paratest\/bin\/|phpunit-wrapper/;
const isPhp = (cmd) => /^(?:\S*\/)?php(?:[\d.]+)?(?:\s|$)/.test(cmd);

function mask(command) {
  const out = command.split("");
  let quote = null;
  for (let i = 0; i < out.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        out[i] = "x";
        if (i + 1 < out.length) out[++i] = "x";
      } else if (c === quote) quote = null;
      else out[i] = "x";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    const doc = /^<<-?\s*(['"]?)(\w+)\1/.exec(command.slice(i));
    if (doc) {
      const start = command.indexOf("\n", i);
      if (start < 0) break;
      const end = new RegExp(`\\n\\s*${doc[2]}\\s*(?:\\n|$)`).exec(command.slice(start));
      const stop = end ? start + end.index + 1 : out.length;
      for (let j = start + 1; j < stop; j++) if (command[j] !== "\n") out[j] = "x";
      i = stop - 1;
    }
  }
  return out.join("");
}

const isBackTest = (command) => RUN.test(mask(String(command || "")));

function processes() {
  try {
    return cp
      .execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 })
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ pid: m[1], ppid: m[2], cmd: m[3] }));
  } catch (e) {
    return [];
  }
}

function runningPasses(list = processes()) {
  const php = new Set(list.filter((p) => isPhp(p.cmd)).map((p) => p.pid));
  return list.filter((p) => isPhp(p.cmd) && TEST_PROC.test(p.cmd) && !php.has(p.ppid)).length;
}

function claimsFile() {
  const { DATA_DIR } = require("../core/data");
  return path.join(DATA_DIR, "test-turn.json");
}

function recentClaims(file, nowMs) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).filter((at) => nowMs - at < CLAIM_MS);
  } catch (e) {
    return [];
  }
}

function withProcesses(command, n) {
  const visible = mask(command);
  if (!/--parallel\b/.test(visible)) return command;
  const procs = [...visible.matchAll(/--processes([=\s]+)(\d+)/g)];
  if (procs.length) {
    let out = command;
    for (const m of procs.reverse()) out = out.slice(0, m.index) + `--processes${m[1]}${Math.min(Number(m[2]), n)}` + out.slice(m.index + m[0].length);
    return out;
  }
  const at = visible.search(/--parallel\b/) + "--parallel".length;
  return command.slice(0, at) + ` --processes=${n}` + command.slice(at);
}

function plan(command, passes) {
  if (!isBackTest(command)) return { kind: "none" };
  if (passes >= MAX_PASSES)
    return { kind: "wait", reason: `Ya hay ${passes} pasadas de tests del back en marcha en este ordenador y más a la vez lo dejan sin memoria ni CPU (context/TESTS-CI.md). Espera a que acabe una (no la mates ni la relances) y vuelve a lanzar esta; mientras, sigue con otra cosa.` };
  const next = withProcesses(command, passes ? SECOND : FIRST);
  return next === command ? { kind: "go" } : { kind: "go", command: next };
}

function decide(command, { list, file, nowMs = Date.now() } = {}) {
  if (!isBackTest(command)) return { kind: "none" };
  file = file || claimsFile();
  const claims = recentClaims(file, nowMs);
  const p = plan(command, runningPasses(list) + claims.length);
  if (p.kind === "go") {
    try {
      fs.writeFileSync(file, JSON.stringify([...claims, nowMs]));
    } catch (e) {}
  }
  return p;
}

module.exports = { mask, isBackTest, runningPasses, withProcesses, plan, decide, MAX_PASSES };

require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const turn = require("../src/sessions/test-turn");

test("only back test runs take a turn", () => {
  assert.ok(turn.isBackTest("cd super-app && php artisan test --parallel tests/Feature/Plans"));
  assert.ok(turn.isBackTest("php vendor/bin/phpunit tests/Unit/FooTest.php"));
  assert.ok(turn.isBackTest("vendor/bin/paratest -p 4"));
  assert.ok(!turn.isBackTest("grep -rn 'artisan test' context/"));
  assert.ok(!turn.isBackTest("npm test"));
  assert.ok(!turn.isBackTest("php artisan tinker"));
  assert.ok(turn.isBackTest("XDEBUG_MODE=off php artisan test tests/Unit"));
  assert.ok(!turn.isBackTest(`echo '{"command":"cd super-app && php artisan test --parallel"}' | node hook.js`));
});

test("text inside quotes or a heredoc is never taken for a test run nor rewritten", () => {
  const heredoc = "python3 - <<'EOF'\nrun('php artisan test --parallel')\nEOF\necho done";
  assert.ok(!turn.isBackTest(heredoc));
  assert.equal(turn.withProcesses(heredoc, 3), heredoc);
  const mixed = "cd super-app && php artisan test --parallel tests && echo '--parallel'";
  assert.equal(turn.withProcesses(mixed, 3), "cd super-app && php artisan test --parallel --processes=3 tests && echo '--parallel'");
  assert.ok(turn.isBackTest("cat <<EOF > x\nhi\nEOF\nphp artisan test tests/Unit"));
});

test("a pass counts once, whatever workers it has, and the shell that launched it does not count", () => {
  const list = [
    { pid: "10", ppid: "1", cmd: "/bin/zsh -c cd super-app && php artisan test --parallel tests" },
    { pid: "11", ppid: "10", cmd: "php artisan test --parallel tests" },
    { pid: "12", ppid: "11", cmd: "/opt/homebrew/bin/php vendor/bin/paratest --processes=6" },
    { pid: "13", ppid: "12", cmd: "/opt/homebrew/bin/php vendor/brianium/paratest/bin/phpunit-wrapper.php" },
    { pid: "14", ppid: "12", cmd: "/opt/homebrew/bin/php vendor/brianium/paratest/bin/phpunit-wrapper.php" },
    { pid: "20", ppid: "1", cmd: "php vendor/bin/phpunit tests/Unit/A.php" },
    { pid: "30", ppid: "1", cmd: "php artisan serve" },
  ];
  assert.equal(turn.runningPasses(list), 2);
});

test("the first pass gets 6 processes, the second 3 and a third waits", () => {
  assert.equal(turn.plan("php artisan test --parallel tests", 0).command, "php artisan test --parallel --processes=6 tests");
  assert.equal(turn.plan("php artisan test --parallel --processes=8 tests", 1).command, "php artisan test --parallel --processes=3 tests");
  assert.equal(turn.plan("php artisan test --parallel --processes=2 tests", 1).command, undefined);
  assert.equal(turn.plan("php vendor/bin/phpunit tests/Unit/A.php", 1).kind, "go");
  assert.equal(turn.plan("php artisan test --parallel tests", 2).kind, "wait");
});

test("two runs launched at the same moment do not both get the first turn", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "turn-")), "test-turn.json");
  const a = turn.decide("php artisan test --parallel tests", { list: [], file, nowMs: 1000 });
  const b = turn.decide("php artisan test --parallel tests", { list: [], file, nowMs: 2000 });
  const c = turn.decide("php artisan test --parallel tests", { list: [], file, nowMs: 3000 });
  assert.match(a.command, /--processes=6/);
  assert.match(b.command, /--processes=3/);
  assert.equal(c.kind, "wait");
  assert.equal(turn.decide("php artisan test --parallel tests", { list: [], file, nowMs: 60000 }).command.includes("--processes=6"), true);
});

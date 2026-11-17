const box = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const cp = require("child_process");

const HOOK = path.join(__dirname, "..", "bin", "permission-hook.js");

function hook(tool_name, tool_input) {
  const r = cp.spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: "abcdef123456", tool_name, tool_input, cwd: box.root }), env: { ...process.env, TOWER_PORT: "1" }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test("with the board down, protected and asked actions fall back to Claude Code's own prompt", () => {
  for (const [tool, input] of [["Bash", { command: "git push" }], ["Bash", { command: "cat .env" }], ["Bash", { command: "node scripts/jira-write.js comment WEB-1 hola" }], ["mcp__jira__addOrEditJiraIssueComment", { issueIdOrKey: "WEB-1" }], ["mcp__jira__transitionJiraIssue", { issueIdOrKey: "WEB-1", transition: { id: "31" } }], ["Artifact", { action: "publish" }]]) {
    const out = hook(tool, input);
    assert.ok(out, `${tool} ${JSON.stringify(input)}`);
    assert.equal(out.permissionDecision, "ask", `${tool} ${JSON.stringify(input)}`);
    assert.match(out.permissionDecisionReason, /El tablero no responde/);
  }
});

test("with the board down, unprotected actions still step aside", () => {
  assert.equal(hook("Bash", { command: "ls -la" }), null);
  assert.equal(hook("Bash", { command: "node scripts/jira-write.js start WEB-1" }), null);
  assert.equal(hook("Read", { file_path: path.join(box.root, "a.js") }), null);
  assert.equal(hook("mcp__jira__getJiraIssue", { issueIdOrKey: "WEB-1" }), null);
});

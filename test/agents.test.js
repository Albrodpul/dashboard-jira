const box = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const agents = require("../src/agents");
const claude = agents.claude;

test("every project uses Claude Code unless it says otherwise", () => {
  assert.equal(agents.main().id, "claude");
  assert.equal(agents.agentFor({ agent: "nope" }).id, "claude");
});

test("the Claude adapter builds the same commands the board used before", () => {
  assert.deepEqual(claude.hostedArgs({ conversation: "c1", fresh: false, name: "Pagos", permissionMode: "acceptEdits", profile: ["--model", "x"] }), ["--resume", "c1", "-n", "Pagos", "--permission-mode", "acceptEdits", "--model", "x"]);
  assert.deepEqual(claude.hostedArgs({ conversation: "c1", fresh: true, name: "Pagos", permissionMode: "acceptEdits" }), ["--session-id", "c1", "-n", "Pagos", "--permission-mode", "acceptEdits"]);
  assert.deepEqual(claude.createArgs({ id: "i", name: "n", model: "m", prompt: "p" }), ["-p", "--session-id", "i", "--name", "n", "--model", "m", "p"]);
  assert.deepEqual(claude.wakeArgs("hola"), ["-p", "hola", "--no-session-persistence", "--model", "claude-haiku-4-5-20251001", "--allowedTools=SendMessage,ListAgents,ToolSearch"]);
  assert.deepEqual(claude.oneShotArgs({ prompt: "p", model: "m" }), ["-p", "p", "--no-session-persistence", "--model", "m", "--allowedTools="]);
  assert.equal(claude.editorUrl("abc"), "vscode://anthropic.claude-code/open?session=abc");
  assert.equal(claude.editorUrl(), "vscode://anthropic.claude-code/open");
  assert.equal(claude.transcriptFolder("C:/work/myproject"), "c--work-myproject");
  assert.equal(claude.transcriptFolder("/Users/a/workspace/myproject"), "-Users-a-workspace-myproject");
  assert.ok(claude.isHostedCommandLine("/Users/a/.local/bin/claude --resume x"));
  assert.ok(!claude.isHostedCommandLine("/Applications/Code.app/claude --resume x"));
  assert.equal(claude.sessionsDir(), path.join(box.home, ".claude", "sessions"));
  assert.ok(claude.ENV_VARIABLES.test("CLAUDE_CODE_ENTRYPOINT") && !claude.ENV_VARIABLES.test("PATH"));
});

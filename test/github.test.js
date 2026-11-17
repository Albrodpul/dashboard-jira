require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const github = require("../src/features/github");

test("pull requests, reviews and branches are told in a few words", async () => {
  const pr = { number: 12, title: "Fix filters\nmore", html_url: "u", head: { ref: "fix/x" }, base: { ref: "develop" }, merged: true };
  assert.equal((await github.describe("o/r", { type: "PullRequestEvent", payload: { action: "opened", pull_request: pr } })).text, "abre la PR #12 «Fix filters» (fix/x → develop)");
  assert.equal((await github.describe("o/r", { type: "PullRequestEvent", payload: { action: "closed", pull_request: pr } })).text, "fusiona la PR #12 «Fix filters» en develop");
  assert.equal((await github.describe("o/r", { type: "PullRequestReviewEvent", payload: { review: { state: "changes_requested" }, pull_request: pr } })).text, "revisa la PR #12 «Fix filters»: pide cambios");
  assert.equal((await github.describe("o/r", { type: "CreateEvent", payload: { ref_type: "branch", ref: "feat/y" } })).text, "crea la rama feat/y");
  assert.equal(await github.describe("o/r", { type: "PullRequestEvent", payload: { action: "assigned", pull_request: pr } }), null);
  assert.equal(await github.describe("o/r", { type: "WatchEvent", payload: {} }), null);
});

test("the repositories come from the deploy targets unless the project lists its own", () => {
  assert.deepEqual(github.reposOf({ deployTargets: [{ id: "a", repo: "o/a" }, { id: "b" }] }), ["o/a"]);
  assert.deepEqual(github.reposOf({ github: ["o/z"], deployTargets: [{ id: "a", repo: "o/a" }] }), ["o/z"]);
});

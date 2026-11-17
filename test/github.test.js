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

test("commits are read from the branches, grouped by author and pause, without mine, merges or repeats", () => {
  const c = (oid, who, at, msg = `m ${oid}`) => ({ oid, message: `${msg}\n\nbody`, committedDate: at, author: { name: `N ${who}`, user: { login: who } } });
  const branches = [
    { branch: "develop", commits: [c("a3", "sou", "2026-11-17T11:11:03Z"), c("a2", "sou", "2026-11-17T10:33:15Z"), c("m1", "sou", "2026-11-17T10:00:00Z", "Merge branch 'x'"), c("me", "Albrodpul", "2026-11-17T09:50:00Z"), c("a1", "sou", "2026-11-17T08:40:49Z")] },
    { branch: "feat/x", commits: [c("a2", "sou", "2026-11-17T10:33:15Z"), c("b1", "sou", "2026-11-16T08:00:00Z")] },
  ];
  const out = github.commitEvents("o/super-app", branches, { login: "albrodpul", seen: new Set(["a1"]) });
  assert.deepEqual(out.map((e) => [e.text, e.oids, e.at]), [
    ["sube 2 commits a develop", ["a2", "a3"], "2026-11-17T11:11:03Z"],
    ["sube un commit a feat/x", ["b1"], "2026-11-16T08:00:00Z"],
  ]);
  assert.deepEqual(out[0].items, ["m a2", "m a3"]);
  assert.equal(out[0].repo, "super-app");
});

// Two Jira sites in one board: the main project on acme.atlassian.net and a second
// project on beta.atlassian.net, each with its own credentials, account and statuses.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { sandbox } = require("./helpers/env");

const statuses = { review: "IN REVIEW", returned: ["To Do"], inProgress: ["In Progress"], closed: ["Done"], rejectLabel: "rejected" };
const box = sandbox({
  company: undefined,
  root: undefined,
  jira: undefined,
  statuses: undefined,
  followUp: undefined,
  devServers: undefined,
  projects: [
    { id: "acme", name: "Acme", jira: { projects: ["WEB", "API"], me: { id: "me-acme", name: "Tester Person" }, reviewer: { id: "rev", name: "Reviewer", mentions: ["@Reviewer"] }, transitions: { start: "11" } }, statuses },
    { id: "beta", name: "Beta", jira: { projects: ["OPS"], me: { id: "me-beta", name: "Tester Person" }, reviewer: { id: "rev2", name: "Otra", mentions: ["@Otra"] }, transitions: { start: "31" } }, statuses: { review: "QA", returned: ["Reabierta"], inProgress: ["Haciendo"], closed: ["Cerrada"], rejectLabel: "rechazada" } },
    { id: "casa", name: "Casa" },
  ],
});
fs.writeFileSync(path.join(box.workspace, ".env"), "JIRA_SITE=acme.atlassian.net\nJIRA_EMAIL=a@example.com\nJIRA_TOKEN=token-a\n");
fs.writeFileSync(path.join(box.workspace, ".env.beta"), "JIRA_SITE=beta.atlassian.net\nJIRA_EMAIL=b@example.com\nJIRA_TOKEN=token-b\n");
for (const k of ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN"]) delete process.env[k];

const test = require("node:test");
const assert = require("node:assert/strict");
const sites = require("../src/jira/sites");

const FAKE = path.join(__dirname, "helpers", "fake-jira.js");
const basic = (email, token) => "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

function run(script, args, extraEnv = {}) {
  const log = path.join(box.dir, `requests-${Date.now()}-${Math.random()}.jsonl`);
  const r = cp.spawnSync(process.execPath, ["--require", FAKE, script, ...args], { encoding: "utf8", env: { ...process.env, FAKE_JIRA_LOG: log, ...extraEnv } });
  const requests = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, requests };
}

test("each key goes to the project that lists its prefix, anything else to the main one", () => {
  assert.equal(sites.forKey("WEB-1").id, "acme");
  assert.equal(sites.forKey("OPS-7").id, "beta");
  assert.equal(sites.forKey("OPS").id, "beta");
  assert.equal(sites.forKey("CASA-3").id, "acme");
  assert.deepEqual(sites.jiraProjects().map((p) => p.id), ["acme", "beta"]);
});

test("each site uses its own credentials, account and statuses", () => {
  assert.equal(sites.auth("beta").base, "https://beta.atlassian.net/rest/api/3");
  assert.equal(sites.auth("beta").auth, basic("b@example.com", "token-b"));
  assert.equal(sites.auth().auth, basic("a@example.com", "token-a"));
  assert.equal(sites.me(sites.forKey("OPS-7")).id, "me-beta");
  assert.ok(sites.statuses("beta").closedRegex.test("Cerrada"));
  assert.ok(!sites.statuses("acme").closedRegex.test("Cerrada"));
  assert.deepEqual(sites.byProject(["WEB-1", "OPS-7", "API-2"]).map(([p, keys]) => [p.id, keys]), [
    ["acme", ["WEB-1", "API-2"]],
    ["beta", ["OPS-7"]],
  ]);
});

test("a project whose credentials are missing on this machine is left out of the reads", () => {
  fs.renameSync(path.join(box.workspace, ".env.beta"), path.join(box.workspace, ".env.beta.off"));
  try {
    const r = cp.spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(require.resolve("../src/jira/sites"))}).jiraProjects().map((p) => p.id)))`], { encoding: "utf8", env: process.env });
    assert.deepEqual(JSON.parse(r.stdout), ["acme"]);
  } finally {
    fs.renameSync(path.join(box.workspace, ".env.beta.off"), path.join(box.workspace, ".env.beta"));
  }
});

test("the Jira reader counts the news of both sites, each read with its own token", () => {
  const r = run(path.join(__dirname, "..", "bin", "jira-window.js"), ["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), { fresh: 2 });
  const hosts = r.requests.map((x) => [new URL(x.url).host, x.auth]);
  assert.ok(hosts.some(([h, a]) => h === "acme.atlassian.net" && a === basic("a@example.com", "token-a")));
  assert.ok(hosts.some(([h, a]) => h === "beta.atlassian.net" && a === basic("b@example.com", "token-b")));
  assert.ok(!hosts.some(([h, a]) => h === "beta.atlassian.net" && a !== basic("b@example.com", "token-b")));
});

test("when one site is down the reader still counts the other and says which failed", () => {
  const r = run(path.join(__dirname, "..", "bin", "jira-window.js"), ["--check"], { FAKE_JIRA_FAIL: "beta.atlassian.net" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), { fresh: 1 });
  assert.match(r.stderr, /Jira de Beta/);
});

test("when every site is down the read fails", () => {
  const r = run(path.join(__dirname, "..", "bin", "jira-window.js"), ["--check"], { FAKE_JIRA_FAIL: "acme.atlassian.net,beta.atlassian.net" });
  assert.equal(r.status, 1);
});

test("the Jira writer sends each ticket to its own site with that site's transitions", () => {
  const r = run(path.join(__dirname, "..", "bin", "jira-write.js"), ["start", "OPS-7"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].url, "https://beta.atlassian.net/rest/api/3/issue/OPS-7/transitions");
  assert.equal(r.requests[0].auth, basic("b@example.com", "token-b"));
  const main = run(path.join(__dirname, "..", "bin", "jira-write.js"), ["start", "WEB-1"]);
  assert.equal(main.requests[0].url, "https://acme.atlassian.net/rest/api/3/issue/WEB-1/transitions");
});

test("tickets asked by key are grouped and sent to their own site", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push({ host: new URL(url).host, url: decodeURIComponent(String(url)), auth: options.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ issues: [] }) };
  };
  try {
    await require("../src/jira/client").jiraIssues(["WEB-1", "OPS-7", "API-2"], 60);
  } finally {
    globalThis.fetch = original;
  }
  const acme = seen.find((s) => s.host === "acme.atlassian.net");
  const beta = seen.find((s) => s.host === "beta.atlassian.net");
  assert.match(acme.url, /key in \(WEB-1,API-2\)/);
  assert.match(beta.url, /key in \(OPS-7\)/);
  assert.equal(beta.auth, basic("b@example.com", "token-b"));
});

test("a comment mentions the reviewer of the ticket's own project", () => {
  const { adfFromText } = require("../src/jira/client");
  const doc = adfFromText("Hola @Otra, listo", sites.forKey("OPS-7"));
  const mention = doc.content[0].content.find((n) => n.type === "mention");
  assert.equal(mention.attrs.id, "rev2");
  const plain = adfFromText("Hola @Otra, listo", sites.forKey("WEB-1"));
  assert.ok(!plain.content[0].content.some((n) => n.type === "mention"));
});

test("the page gets the Jira address of every site for its links", () => {
  const page = require("../src/core/config").forPage();
  assert.deepEqual(page.jiraSites, [
    { projects: ["WEB", "API"], url: "https://acme.atlassian.net/browse/" },
    { projects: ["OPS"], url: "https://beta.atlassian.net/browse/" },
  ]);
});

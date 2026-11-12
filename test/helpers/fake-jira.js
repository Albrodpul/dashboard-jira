// Preloaded with `node --require` to stand in for every Jira site: fetch answers by host,
// with no network. FAKE_JIRA_FAIL lists hosts that answer 500; FAKE_JIRA_LOG is a file
// where each request is appended as a JSON line (method, url, auth).
const fs = require("fs");

const ISSUES = {
  "acme.atlassian.net": [{ key: "WEB-1", summary: "Ticket de Acme" }],
  "beta.atlassian.net": [{ key: "OPS-7", summary: "Ticket de Beta" }],
};
const failing = (process.env.FAKE_JIRA_FAIL || "").split(",").filter(Boolean);

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(String(url));
  const headers = options.headers || {};
  if (process.env.FAKE_JIRA_LOG) fs.appendFileSync(process.env.FAKE_JIRA_LOG, JSON.stringify({ method: options.method || "GET", url: String(url), auth: headers.Authorization || null }) + "\n");
  if (failing.includes(u.host)) return reply(500, { error: "down" });
  const issues = ISSUES[u.host] || [];
  if (u.pathname.endsWith("/search/jql")) return reply(200, { issues: issues.map((i) => ({ key: i.key, fields: { summary: i.summary } })), isLast: true });
  const m = /\/issue\/([A-Z]+-\d+)$/.exec(u.pathname);
  if (m && (options.method || "GET") === "GET") {
    const i = issues.find((x) => x.key === m[1]);
    if (!i) return reply(404, {});
    return reply(200, {
      key: i.key,
      fields: { summary: i.summary, created: new Date().toISOString(), reporter: { displayName: "Alguien" }, status: { name: "To Do" }, issuetype: { name: "Story" }, assignee: null, parent: null, comment: { comments: [] } },
      changelog: { histories: [] },
    });
  }
  return reply(204, {});
};

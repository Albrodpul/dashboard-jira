const fs = require("fs");
const os = require("os");
const path = require("path");

function sandbox(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nutria-test-"));
  const workspace = path.join(dir, "workspace");
  const data = path.join(workspace, "data");
  const home = path.join(dir, "home");
  const root = path.join(dir, "root");
  for (const d of [workspace, data, home, root]) fs.mkdirSync(d, { recursive: true });
  const config = {
    company: "Test",
    root,
    jira: { projects: ["WEB", "API"], me: { id: "me", name: "Tester Person" }, reviewer: { id: "rev", name: "Reviewer", mentions: ["@Reviewer"] }, transitions: {} },
    statuses: { review: "IN REVIEW", returned: ["To Do"], inProgress: ["In Progress"], closed: ["Done"], rejectLabel: "rejected" },
    followUp: [],
    devServers: [{ id: "web", name: "Web", port: 39999, url: "http://localhost:39999", command: "true" }],
    ...extra,
  };
  fs.writeFileSync(path.join(workspace, "board.config.json"), JSON.stringify(config));
  Object.assign(process.env, { TOWER_WORKSPACE: workspace, TOWER_DATA: data, HOME: home, USERPROFILE: home, TOWER_PORT: "39998", TOWER_HOST_PORT: "39997" });
  delete process.env.TOWER_DB;
  return { dir, workspace, data, home, root, config };
}

module.exports = { sandbox };

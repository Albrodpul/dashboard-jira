#!/usr/bin/env node
// Installs Dashboard Jira into a workspace folder:
//   node install.js <workspace folder> [--legacy-launchers]
// The workspace keeps what belongs to that machine and that company: board.config.json, .env and data/.
// The installer writes there the launchers (board.js, sessions.js, jira-window.js…) that call this repo's code,
// and renders the Claude Code slash commands from templates/ into <root>/.claude/commands.
// --legacy-launchers also writes tablero.js and sesiones.js, for workspaces whose sessions still call the old names.
const fs = require("fs");
const path = require("path");

const REPO = __dirname;
const args = process.argv.slice(2);
const target = args.find((x) => !x.startsWith("--"));
if (!target) {
  console.error("Usage: node install.js <workspace folder for board.config.json, .env and data/> [--legacy-launchers]");
  process.exit(1);
}
const workspace = path.resolve(target);
const slashes = (p) => p.replace(/\\/g, "/");

fs.mkdirSync(workspace, { recursive: true });
const hasLegacyConfig = fs.existsSync(path.join(workspace, "tablero.config.json"));
for (const [example, real] of [
  ["board.config.example.json", "board.config.json"],
  [".env.example", ".env"],
]) {
  const file = path.join(workspace, real);
  if (fs.existsSync(file) || (real === "board.config.json" && hasLegacyConfig)) continue;
  fs.copyFileSync(path.join(REPO, example), file);
  console.log(`created ${file}: fill it in before starting`);
}

const nodeLauncher = (file) => `process.env.TOWER_WORKSPACE = __dirname;\nrequire(${JSON.stringify(slashes(path.join(REPO, file)))});\n`;
const launchers = {
  "board.js": nodeLauncher("src/cli.js"),
  "sessions.js": nodeLauncher("bin/sessions.js"),
  "jira-window.js": nodeLauncher("bin/jira-window.js"),
  "jira-write.js": nodeLauncher("bin/jira-write.js"),
  "permission-hook.js": nodeLauncher("bin/permission-hook.js"),
  "jira.sh": `#!/usr/bin/env bash\nexport TOWER_WORKSPACE="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"\nexec bash ${JSON.stringify(slashes(path.join(REPO, "bin", "jira.sh")))} "$@"\n`,
};
if (args.includes("--legacy-launchers")) {
  launchers["tablero.js"] = launchers["board.js"];
  launchers["sesiones.js"] = launchers["sessions.js"];
}
for (const [name, content] of Object.entries(launchers)) fs.writeFileSync(path.join(workspace, name), content);
console.log(`launchers in ${workspace}: ${Object.keys(launchers).join(", ")}`);

process.env.TOWER_WORKSPACE = workspace;
let config;
try {
  config = require("./src/config");
  require("./src/data").database();
} catch (e) {
  console.log(`${e.message}\nFill in the configuration and run the installer again to render the commands.`);
  process.exit(0);
}
const values = {
  ROOT: slashes(config.root),
  WORKSPACE: slashes(workspace),
  REPO: slashes(REPO),
  ME: config.jira.me.name,
  REVIEWER: config.jira.reviewer.name,
  COMPANY: config.company,
  PROJECTS: config.jira.projects.join("/"),
  JQLPROJECTS: config.jira.projectsJql,
  REJECTLABEL: config.statuses.rejectLabel,
  RETURNED: config.statuses.returned.join("»/«"),
  FOLLOWUP: require("./src/follow-up").DEFAULT_PERSON,
};
const render = (text) => text.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
const templates = path.join(REPO, "templates", "commands");
const commandsOut = path.join(config.root, ".claude", "commands");
fs.mkdirSync(commandsOut, { recursive: true });
for (const f of fs.readdirSync(templates).filter((x) => x.endsWith(".md"))) {
  const text = render(fs.readFileSync(path.join(templates, f), "utf8"));
  const missing = text.match(/\{\{[A-Z]+\}\}/g);
  if (missing) console.log(`warning: ${f} has placeholders without a value: ${[...new Set(missing)].join(", ")}`);
  fs.writeFileSync(path.join(commandsOut, f), text);
}
console.log(`commands → ${commandsOut}`);
console.log("Done. Start the board with: node " + slashes(path.join(workspace, "board.js")) + " ensure");

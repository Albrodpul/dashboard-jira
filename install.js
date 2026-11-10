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
let createdExample = false;
for (const [example, real] of [
  ["board.config.example.json", "board.config.json"],
  [".env.example", ".env"],
]) {
  const file = path.join(workspace, real);
  if (fs.existsSync(file) || (real === "board.config.json" && hasLegacyConfig)) continue;
  fs.copyFileSync(path.join(REPO, example), file);
  if (real === "board.config.json") createdExample = true;
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
const example = JSON.parse(fs.readFileSync(path.join(REPO, "board.config.example.json"), "utf8"));
const exampleRoot = slashes((Array.isArray(example.projects) ? example.projects[0] : example).root);
let config;
try {
  if (createdExample) throw new Error("The configuration was just created from the examples.");
  config = require("./src/core/config");
  if (slashes(config.root) === exampleRoot) throw new Error(`board.config.json still has the example root (${exampleRoot}).`);
  require("./src/core/data").database();
} catch (e) {
  console.log(`${e.message}\nFill in the configuration and run the installer again to render the commands.`);
  process.exit(0);
}
const valuesFor = (p) => ({
  ROOT: slashes(p.root),
  WORKSPACE: slashes(workspace),
  REPO: slashes(REPO),
  ME: config.jira.me.name,
  REVIEWER: p.jira ? p.jira.reviewer.name : config.jira.me.name,
  COMPANY: p.company,
  PROJECTS: p.jira ? p.jira.projects.join("/") : "",
  JQLPROJECTS: p.jira ? p.jira.projectsJql : "",
  REJECTLABEL: p.statuses ? p.statuses.rejectLabel : "",
  RETURNED: p.statuses ? p.statuses.returned.join("»/«") : "",
});
const templates = path.join(REPO, "templates", "commands");
const wanted = (p, f) => p === config.mainProject || f === "soy.md" || (f === "resumen-jira.md" && p.jira) || (f === "seguimiento.md" && p.followUp.length);
for (const p of config.projects) {
  if (p !== config.mainProject && !fs.existsSync(p.root)) {
    console.log(`skipped ${p.id}: ${slashes(p.root)} does not exist`);
    continue;
  }
  const values = valuesFor(p);
  const render = (text) => text.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
  const commandsOut = path.join(p.root, ".claude", "commands");
  fs.mkdirSync(commandsOut, { recursive: true });
  for (const f of fs.readdirSync(templates).filter((x) => x.endsWith(".md") && wanted(p, x))) {
    const text = render(fs.readFileSync(path.join(templates, f), "utf8"));
    const missing = text.match(/\{\{[A-Z]+\}\}/g);
    if (missing) console.log(`warning: ${f} has placeholders without a value: ${[...new Set(missing)].join(", ")}`);
    fs.writeFileSync(path.join(commandsOut, f), text);
  }
  console.log(`commands (${p.id}) → ${commandsOut}`);
}
console.log("Done. Start the board with: node " + slashes(path.join(workspace, "board.js")) + " ensure");

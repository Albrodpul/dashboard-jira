const claude = require("./claude");

const AGENTS = { claude };

function agentFor(project) {
  const id = project && project.agent;
  return AGENTS[id] || claude;
}

const forProject = (id) => agentFor(require("../core/config").project(id));
const main = () => agentFor(require("../core/config").mainProject);

module.exports = { AGENTS, agentFor, forProject, main, claude };

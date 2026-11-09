const role = require("./role");
const peer = require("./peer");
const transcripts = require("./transcripts");
const snapshot = require("./snapshot");
const power = require("./power");
const handover = require("./handover");

module.exports = {
  lastReply: transcripts.lastReply,
  mergeTasks: snapshot.mergeTasks,
  mergePeer: snapshot.mergePeer,
  applySnapshot: snapshot.applySnapshot,
  isPrimary: role.isPrimary,
  primaryNow: role.primaryNow,
  info: role.info,
  peerGet: peer.peerGet,
  projectDir: transcripts.projectDir,
  keepAwake: power.keepAwake,
  letSleep: power.letSleep,
  snapshot: snapshot.snapshot,
  transcripts: transcripts.transcripts,
  serveTranscript: transcripts.serveTranscript,
  tick: handover.tick,
  handleYield: handover.handleYield,
  command: handover.command,
  takeHere: handover.takeHere,
  backToAuto: handover.backToAuto,
  machines: peer.machines,
  sendClaudeToken: peer.sendClaudeToken,
  clusterEnabled: () => !!role.CLUSTER,
};

const { cmd } = require("./commands/args");

const commands = { ...require("./commands/server"), ...require("./commands/tasks"), ...require("./commands/orchestration"), ...require("./commands/followup"), ...require("./commands/holds"), ...require("./commands/delivery") };

if (Object.prototype.hasOwnProperty.call(commands, cmd)) commands[cmd]();
else
  console.log(
    "Uso: node board.js serve | ensure | restart | add [json] | task-new "<title>" [description] [--project id] | list [status] | update <key> [json] | approve-chat <key> <area> | report [text] | reporter | board-session | watch [reports|dispatches|board] | host | refresh-request | sessions [json] | epics [json] | jira-epics | open <session> | areas | dispatches | attachments <key> | done | partial | question | comment | delivered | sent | reply | changes | orchestrator | deployments | deployment-update | startup | push-test | followup | followup-error | error-sent | error-result | sentry-sent | sentry-result | followup-status | people | person-add | person-accounts | claude-token [--setup|--import|--export|--remove] | tidy-status | tidy-start | tidy-end | message | answer-message | progress | counted | learning-read | cause | hold add|list|release|check | delivery <id> | jira-setup [ISSUE-KEY] [reviewer name]"
  );

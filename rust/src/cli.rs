//! Port of src/cli.js.
use crate::commands::args::{Args, Command};
use crate::commands::{delivery, followup, holds, orchestration, server, tasks};

pub const USAGE: &str = "Uso: node board.js serve | ensure | restart | add [json] | task-new \"<title>\" [description] [--project id] | list [status] | update <key> [json] | approve-chat <key> <area> | report [text] | reporter | board-session | watch [reports|dispatches|board] | host | refresh-request | sessions [json] | epics [json] | jira-epics | open <session> | areas | dispatches | attachments <key> | done | partial | question | comment | delivered | sent | reply | changes | orchestrator | deployments | deployment-update | startup | push-test | followup | followup-error | error-sent | error-result | sentry-sent | sentry-result | followup-status | people | person-add | person-accounts | claude-token [--setup|--import|--export|--remove] | tidy-status | tidy-start | tidy-end | message | answer-message | progress | counted | learning-read | cause | hold add|list|release|check | delivery <id> | jira-setup [ISSUE-KEY] [reviewer name]";

pub fn command(name: &str) -> Option<Command> {
    let found: Command = match name {
        "serve" => server::serve,
        "ensure" => server::ensure,
        "restart" => server::restart,
        "watch" => server::watch,
        "host" => server::host,
        "startup" => server::startup,
        "overtime" => server::overtime,
        "push-test" => server::push_test,
        "claude-token" => server::claude_token,
        "add" => tasks::add,
        "task-new" => tasks::task_new,
        "list" => tasks::list,
        "update" => tasks::update,
        "approve-chat" => tasks::approve_chat,
        "attachments" => tasks::attachments,
        "delivered" => tasks::delivered,
        "changes" => tasks::changes,
        "sessions" => tasks::sessions,
        "epics" => tasks::epics,
        "jira-epics" => tasks::jira_epics,
        "open" => tasks::open,
        "areas" => tasks::areas,
        "learning-read" => tasks::learning_read,
        "cause" => tasks::cause,
        "done" => tasks::done,
        "partial" => tasks::partial,
        "question" => tasks::question,
        "comment" => tasks::comment,
        "sent" => tasks::sent,
        "reply" => tasks::reply,
        "dispatches" => orchestration::dispatches,
        "orchestrator" => orchestration::orchestrator,
        "deployments" => orchestration::deployments,
        "deployment-update" => orchestration::deployment_update,
        "report" => orchestration::report,
        "reporter" => orchestration::reporter,
        "board-session" => orchestration::board_session,
        "counted" => orchestration::counted,
        "refresh-request" => orchestration::refresh_request,
        "tidy-status" => orchestration::tidy_status,
        "message" => orchestration::message,
        "answer-message" => orchestration::answer_message,
        "progress" => orchestration::progress,
        "jira-setup" => orchestration::jira_setup,
        "tidy-start" => orchestration::tidy_start,
        "tidy-end" => orchestration::tidy_end,
        "followup" => followup::followup,
        "people" => followup::people,
        "person-add" => followup::person_add,
        "person-accounts" => followup::person_accounts,
        "followup-error" => followup::followup_error,
        "error-sent" => followup::error_sent,
        "sentry-sent" => followup::sentry_sent,
        "sentry-result" => followup::sentry_result,
        "error-result" => followup::error_result,
        "followup-status" => followup::followup_status,
        "hold" => holds::hold,
        "delivery" => delivery::delivery,
        _ => return None,
    };
    Some(found)
}

pub fn run(args: &Args) -> i32 {
    let asked_help = args.from(3).iter().any(|x| x == "--help" || x == "-h");
    match command(&args.cmd()).filter(|_| !asked_help) {
        Some(found) => match found(args) {
            Ok(code) => code,
            Err(text) => {
                eprintln!("{text}");
                1
            }
        },
        None => {
            println!("{USAGE}");
            0
        }
    }
}

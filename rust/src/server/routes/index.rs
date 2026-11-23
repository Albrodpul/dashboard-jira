//! Port of src/server/routes/index.js.

use serde_json::Value;

use super::{operations, sessions, tasks};
use crate::server::http::{PostHandler, Req, Res};

pub fn post_route(url: &str) -> Option<PostHandler> {
    match url {
        "/api/claude-token/setup" => Some(claude_token_setup),
        "/api/cluster/claude-token" => Some(cluster_claude_token),
        "/api/task" => Some(tasks::handle_task),
        "/api/task/new" => Some(tasks::handle_new_task),
        "/api/projects-admin/save" => Some(projects_admin_save),
        "/api/projects-admin/remove" => Some(projects_admin_remove),
        "/api/projects-admin/credentials" => Some(projects_admin_credentials),
        "/api/projects-admin/connect-jira" => Some(projects_admin_connect_jira),
        "/api/batch" => Some(tasks::handle_batch),
        "/api/delete" => Some(tasks::handle_delete),
        "/api/answer" => Some(tasks::handle_answer),
        "/api/reviewed" => Some(tasks::handle_reviewed),
        "/api/reviewed-all" => Some(tasks::handle_reviewed_all),
        "/api/comment" => Some(tasks::handle_comment),
        "/api/config" => Some(tasks::handle_config),
        "/api/refresh" => Some(refresh),
        "/api/search" => Some(tasks::handle_search),
        "/api/import" => Some(tasks::handle_import),
        "/api/ticket" => Some(tasks::handle_ticket),
        "/api/session" => Some(sessions::handle_session),
        "/api/reminder" => Some(reminder),
        "/api/new-session" => Some(sessions::handle_new_session),
        "/api/epic" => Some(sessions::handle_epic),
        "/api/deploy" => Some(operations::handle_deploy),
        "/api/deploy-status/refresh" => Some(deploy_status_refresh),
        "/api/tidy" => Some(operations::handle_tidy),
        "/api/message" => Some(operations::handle_message),
        "/api/followup-error" => Some(operations::handle_follow_up_error),
        "/api/followup-request" => Some(operations::handle_follow_up_request),
        "/api/restriction" => Some(tasks::handle_restriction),
        "/api/delivery/retry" => Some(delivery_retry),
        "/api/people" => Some(people),
        "/api/layout-report" => Some(layout_report),
        "/api/term-claim" => Some(term_claim),
        "/api/page-errors" => Some(page_errors),
        "/api/audio-report" => Some(audio_report),
        "/api/sentry/send" => Some(sentry_send),
        "/api/daily" => Some(daily),
        "/api/cluster/yield" => Some(cluster_yield),
        "/api/cluster/take" => Some(cluster_take),
        "/api/watchdog/dismiss" => Some(watchdog_dismiss),
        "/api/cluster/auto" => Some(cluster_auto),
        "/api/cluster/command" => Some(cluster_command),
        "/api/host/respawned" => Some(host_respawned),
        "/api/session-profile" => Some(session_profile),
        "/api/host/action" => Some(host_action),
        "/api/permission/check" => Some(permission_check),
        "/api/permission/decide" => Some(permission_decide),
        "/api/host/prompt" => Some(host_prompt),
        "/api/host/stuck" => Some(host_stuck),
        "/api/permission/rule-remove" => Some(permission_rule_remove),
        "/api/mac-power" => Some(mac_power),
        "/api/work-hours" => Some(work_hours),
        "/api/overtime" => Some(overtime),
        "/api/devservers" => Some(devservers),
        "/api/tunnel" => Some(tunnel),
        "/api/sentry/status" => Some(sentry_status),
        "/api/sentry/discard" => Some(sentry_discard),
        "/api/learning-read" => Some(learning_read),
        "/api/push/subscribe" => Some(push_subscribe),
        "/api/push/unsubscribe" => Some(push_unsubscribe),
        "/api/push/test" => Some(push_test),
        "/api/push/prefs" => Some(push_prefs),
        _ => None,
    }
}

pub fn handle_get(req: &Req) -> Option<Res> {
    todo!()
}

fn claude_token_setup(input: &Value) -> Res {
    todo!()
}

fn cluster_claude_token(input: &Value) -> Res {
    todo!()
}

fn projects_admin_save(input: &Value) -> Res {
    todo!()
}

fn projects_admin_remove(input: &Value) -> Res {
    todo!()
}

fn projects_admin_credentials(input: &Value) -> Res {
    todo!()
}

fn projects_admin_connect_jira(input: &Value) -> Res {
    todo!()
}

fn refresh(input: &Value) -> Res {
    todo!()
}

fn reminder(input: &Value) -> Res {
    todo!()
}

fn deploy_status_refresh(input: &Value) -> Res {
    todo!()
}

fn delivery_retry(input: &Value) -> Res {
    todo!()
}

fn people(input: &Value) -> Res {
    todo!()
}

fn layout_report(input: &Value) -> Res {
    todo!()
}

fn term_claim(input: &Value) -> Res {
    todo!()
}

fn page_errors(input: &Value) -> Res {
    todo!()
}

fn audio_report(input: &Value) -> Res {
    todo!()
}

fn sentry_send(input: &Value) -> Res {
    todo!()
}

fn daily(input: &Value) -> Res {
    todo!()
}

fn cluster_yield(input: &Value) -> Res {
    todo!()
}

fn cluster_take(input: &Value) -> Res {
    todo!()
}

fn watchdog_dismiss(input: &Value) -> Res {
    todo!()
}

fn cluster_auto(input: &Value) -> Res {
    todo!()
}

fn cluster_command(input: &Value) -> Res {
    todo!()
}

fn host_respawned(input: &Value) -> Res {
    todo!()
}

fn session_profile(input: &Value) -> Res {
    todo!()
}

fn host_action(input: &Value) -> Res {
    todo!()
}

fn permission_check(input: &Value) -> Res {
    todo!()
}

fn permission_decide(input: &Value) -> Res {
    todo!()
}

fn host_prompt(input: &Value) -> Res {
    todo!()
}

fn host_stuck(input: &Value) -> Res {
    todo!()
}

fn permission_rule_remove(input: &Value) -> Res {
    todo!()
}

fn mac_power(input: &Value) -> Res {
    todo!()
}

fn work_hours(input: &Value) -> Res {
    todo!()
}

fn overtime(input: &Value) -> Res {
    todo!()
}

fn devservers(input: &Value) -> Res {
    todo!()
}

fn tunnel(input: &Value) -> Res {
    todo!()
}

fn sentry_status(input: &Value) -> Res {
    todo!()
}

fn sentry_discard(input: &Value) -> Res {
    todo!()
}

fn learning_read(input: &Value) -> Res {
    todo!()
}

fn push_subscribe(input: &Value) -> Res {
    todo!()
}

fn push_unsubscribe(input: &Value) -> Res {
    todo!()
}

fn push_test(input: &Value) -> Res {
    todo!()
}

fn push_prefs(input: &Value) -> Res {
    todo!()
}

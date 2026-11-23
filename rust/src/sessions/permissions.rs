//! Port of src/sessions/permissions.js.
#![allow(dead_code, unused_variables)]
use crate::core::data::Doc;
use regex::Regex;
use serde_json::Value;
use std::sync::{LazyLock, Mutex};

const ORDER_HOURS: i64 = 6;
const WAIT_MINUTES: i64 = 55;

const READ_WORDS: &str = "seq xargs env printenv cscript wscript claude pip pip3 cd ls pwd cat head tail wc grep egrep fgrep rg find sed awk sort uniq cut tr diff cmp comm echo printf test [ true false sleep date basename dirname realpath readlink stat file du df which where whoami type jq nl tee touch mkdir cp mv rm rmdir ln node npm npx yarn pnpm php composer python python3 py pytest vendor/bin/phpunit tasklist netstat set export source . robocopy cmd tar unzip zip gzip base64 sha256sum md5sum iconv dos2unix clear exit ps pgrep uptime hostname uname sw_vers lsof id pdftotext pdfinfo od hexdump xxd sips mdls plutil";
const GIT_READ: &str = "ls-remote for-each-ref reflog name-rev symbolic-ref check-ignore cherry pull status diff log show branch rev-parse rev-list worktree add fetch blame ls-files ls-tree grep remote config shortlog describe merge-base cat-file switch restore mv rm";
const GIT_PROTECTED: &str = "commit push merge tag rebase reset stash clean cherry-pick revert am";
const SHELL_WORDS: &str = "then fi do done else elif esac case in function select until local declare readonly unset shift wait trap read true false : !";
const PS_WORDS: &str = "foreach for if else elseif while do try catch finally switch { } ( ) % ? start-sleep sleep param return break continue";
const PROTECTED_WORDS: &str = "aws sam eb terraform kubectl";
const JIRA_WRITE_FREE: [&str; 5] = ["start", "todo", "block", "assign", "sprint"];
const ALWAYS_TOOLS: &str = "Read Grep Glob Agent Task Skill TaskStop TaskOutput SendMessage ListAgents ToolSearch WebSearch WebFetch AskUserQuestion ScheduleWakeup CronCreate CronDelete CronList PushNotification EnterWorktree ExitWorktree EnterPlanMode ExitPlanMode TodoWrite ReportFindings ListMcpResourcesTool ReadMcpResourceTool ReadMcpResourceDirTool LSP";

static SECRET_ENV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|/)\.env(\.([\w-]+))?$").unwrap());
static SECRET_EXAMPLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^example(-|$)").unwrap());
static SECRET_OTHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(pem|p12|pfx)$|(^|/)[\w-]+\.key$|(^|/)\.mcp\.json$|(^|/)\.?credentials\.json$|/\.aws/credentials$").unwrap());
static GH_READ: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^gh\s+(pr|issue|run|release|workflow|repo)\s+(view|list|diff|checks|status|watch)\b").unwrap());
static GH_PROTECTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^gh\s+(pr\s+merge|release\s+create|variable|secret|api\b.*-X\s*(POST|PUT|PATCH|DELETE)|workflow\s+run)").unwrap());
static AWS_READ: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^aws\s+(--version\b|(--\S+\s+\S+\s+)*[\w-]+\s+(list|get|describe|batch-get)-[\w-]+)").unwrap());
static AWS_SECRET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)secretsmanager|get-parameters?\b|get-secret|kms\s|get-login|get-session-token|get-authorization-token|ssm\s+start-session|send-command").unwrap());
static REMOTE_CHANGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(rm|rmdir|mv|cp|tee|truncate|chmod|chown|ln|sudo|systemctl\s+(restart|stop|start|reload|enable|disable)|service\s+\S+\s+(restart|stop|start|reload)|kill|pkill|killall|reboot|shutdown|apt|apt-get|yum|dnf|pip|npm\s+(i|install|ci|update)|composer\s+(install|update|require)|git\s+(pull|reset|checkout|clean|stash|commit|push|merge)|php\s+artisan\s+(migrate|db:|queue:restart|cache:clear|config:cache|optimize|down|up|scout:(import|flush|sync|delete))|sed\s+-i|crontab|supervisorctl\s+(restart|stop|start|update))\b|(^|[^0-9&2])>{1,2}\s*[^&\s]").unwrap()
});
static JIRA_READ: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^mcp__jira__(get|search|lookup|fetch|atlassianUserInfo)").unwrap());
static ATLASSIAN_WRITE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^mcp__.+__(addOrEditJiraIssueComment|addCommentToJiraIssue|transitionJiraIssue|createJiraIssue|editJiraIssue|executeWrite|executeDestructive|createConfluence\w*|updateConfluence\w*|(create|update|edit|delete|add|remove|transition|move|assign|set|link|upload|publish)\w*(Jira|Confluence)\w*)$").unwrap()
});
static ATLASSIAN_REST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)https?://[\w.-]*(atlassian\.net|atlassian\.com|jira\.com)\b").unwrap());
static HTTP_WRITE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\s(-X\s*|--request[= ])["']?(POST|PUT|PATCH|DELETE)\b|\s(-d|--data[\w-]*|--json|-F|--form|-T|--upload-file)(\s|=)|-Method\s+["']?(Post|Put|Patch|Delete)\b"#).unwrap());
static SESSION_ID_SPOOF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|[\s;&|(])(export\s+|env\s+|set\s+|\$env:)?CLAUDE_CODE_SESSION_ID\s*=").unwrap());
static DEV_LOGIN_GREP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*grep\s+(?:(?:-E|-m\s?1|--max-count=1|-Em1|-m1E)\s+)*(?:'\^DEV_LOGIN_CODE='|"\^DEV_LOGIN_CODE="|\^DEV_LOGIN_CODE=)\s+(?:'(?:[\w.~/-]*/)?super-app/\.env'|"(?:[\w.~/-]*/)?super-app/\.env"|(?:[\w.~/-]*/)?super-app/\.env)\s*$"#).unwrap()
});
static DB_WRITE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?im)(^|[;\n("'`]|\s-e\s*["']?)\s*(insert|update|delete|alter|drop|truncate|create|replace\s+into|grant|revoke|rename\s+table|load\s+data|set\s+global)\b"#).unwrap()
});
static WHOLE: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub kind: &'static str,
    pub key: Option<String>,
    pub git: Option<&'static str>,
    pub label: Option<String>,
}

impl Verdict {
    pub fn allow() -> Verdict {
        Verdict { kind: "allow", key: None, git: None, label: None }
    }
}

struct Words {
    rest: String,
    cmd: String,
    raw: String,
}

fn norm(p: &str) -> String {
    todo!()
}

fn secret_file(p: &str) -> bool {
    if let Some(c) = SECRET_ENV.captures(p) {
        if c.get(3).is_none_or(|x| !SECRET_EXAMPLE.is_match(x.as_str())) {
            return true;
        }
    }
    SECRET_OTHER.is_match(p)
}

fn launchctl_allowed(rest: &str) -> bool {
    todo!()
}

pub fn segments(command: &str) -> Vec<String> {
    todo!()
}

fn words(segment: &str) -> Words {
    todo!()
}

fn sql_of(rest: &str, cwd: Option<&str>, whole: &str) -> String {
    todo!()
}

fn in_repo(p: &str, repo: &str) -> bool {
    todo!()
}

fn classify_segment(segment: &str, cwd: Option<&str>) -> Verdict {
    todo!()
}

fn expand_vars(command: &str) -> String {
    todo!()
}

fn classify_command(command: &str, cwd: Option<&str>) -> Verdict {
    todo!()
}

fn dev_login_grep(input: &Value) -> bool {
    todo!()
}

fn starts_or_claims(op: &str, input: &Value) -> bool {
    todo!()
}

fn atlassian_write(tool: &str, input: &Value) -> Verdict {
    todo!()
}

pub fn classify(tool: &str, input: &Value, cwd: Option<&str>) -> Verdict {
    todo!()
}

pub fn area_of(conversation: &str) -> Option<Value> {
    todo!()
}

fn live_name(conversation: &str) -> Option<String> {
    todo!()
}

fn has_order(c: &Verdict, area: Option<&Value>, d: &Doc) -> bool {
    todo!()
}

fn detail_of(tool: &str, input: &Value) -> String {
    todo!()
}

fn new_id() -> String {
    todo!()
}

pub fn check(event: &Value) -> Value {
    todo!()
}

pub fn expire(d: &mut Doc) {
    todo!()
}

pub fn poll(id: &str) -> Value {
    todo!()
}

fn recheck(p: &Value) -> bool {
    todo!()
}

pub fn decide(id: &str, decision: &str, reason: Option<&str>) -> bool {
    todo!()
}

pub fn native_prompt(input: &Value) -> Option<String> {
    todo!()
}

pub fn remove_rule(key: &str) -> bool {
    todo!()
}

pub fn for_page(d: &Doc) -> Value {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles_and_env_examples_are_not_secret() {
        for re in [&*GH_READ, &*GH_PROTECTED, &*AWS_READ, &*AWS_SECRET, &*REMOTE_CHANGE, &*JIRA_READ, &*ATLASSIAN_WRITE, &*ATLASSIAN_REST, &*HTTP_WRITE, &*SESSION_ID_SPOOF, &*DB_WRITE] {
            let _ = re.is_match("");
        }
        assert!(secret_file("super-app/.env"));
        assert!(secret_file("super-app/.env.production"));
        assert!(!secret_file("super-app/.env.example"));
        assert!(!secret_file("super-app/.env.example-old"));
        assert!(secret_file("a/b/server.key"));
        assert!(DEV_LOGIN_GREP.is_match("grep -m1 '^DEV_LOGIN_CODE=' super-app/.env"));
        assert!(DEV_LOGIN_GREP.is_match("grep ^DEV_LOGIN_CODE= \"../super-app/.env\""));
        assert!(!DEV_LOGIN_GREP.is_match("grep '^DEV_LOGIN_CODE= super-app/.env"));
    }
}

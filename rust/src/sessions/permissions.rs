//! Port of src/sessions/permissions.js.
use crate::core::data::{Doc, load, mutate, now};
use crate::core::json::{self, truthy};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

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

fn has_word(list: &str, w: &str) -> bool {
    list.split(' ').any(|x| x == w)
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

static SECRET_ENV: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(^|/)\.env(\.([\w-]+))?$"));
static SECRET_EXAMPLE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^example(-|$)"));
static SECRET_OTHER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\.(pem|p12|pfx)$|(^|/)[\w-]+\.key$|(^|/)\.mcp\.json$|(^|/)\.?credentials\.json$|/\.aws/credentials$"));
static GH_READ: LazyLock<Regex> = LazyLock::new(|| re(r"^gh\s+(pr|issue|run|release|workflow|repo)\s+(view|list|diff|checks|status|watch)\b"));
static GH_PROTECTED: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^gh\s+(pr\s+merge|release\s+create|variable|secret|api\b.*-X\s*(POST|PUT|PATCH|DELETE)|workflow\s+run)"));
static AWS_READ: LazyLock<Regex> = LazyLock::new(|| re(r"^aws\s+(--version\b|(--\S+\s+\S+\s+)*[\w-]+\s+(list|get|describe|batch-get)-[\w-]+)"));
static AWS_SECRET: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)secretsmanager|get-parameters?\b|get-secret|kms\s|get-login|get-session-token|get-authorization-token|ssm\s+start-session|send-command"));
static REMOTE_CHANGE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"\b(rm|rmdir|mv|cp|tee|truncate|chmod|chown|ln|sudo|systemctl\s+(restart|stop|start|reload|enable|disable)|service\s+\S+\s+(restart|stop|start|reload)|kill|pkill|killall|reboot|shutdown|apt|apt-get|yum|dnf|pip|npm\s+(i|install|ci|update)|composer\s+(install|update|require)|git\s+(pull|reset|checkout|clean|stash|commit|push|merge)|php\s+artisan\s+(migrate|db:|queue:restart|cache:clear|config:cache|optimize|down|up|scout:(import|flush|sync|delete))|sed\s+-i|crontab|supervisorctl\s+(restart|stop|start|update))\b|(^|[^0-9&2])>{1,2}\s*[^&\s]")
});
static JIRA_READ: LazyLock<Regex> = LazyLock::new(|| re(r"^mcp__jira__(get|search|lookup|fetch|atlassianUserInfo)"));
static ATLASSIAN_WRITE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^mcp__.+__(addOrEditJiraIssueComment|addCommentToJiraIssue|transitionJiraIssue|createJiraIssue|editJiraIssue|executeWrite|executeDestructive|createConfluence\w*|updateConfluence\w*|(create|update|edit|delete|add|remove|transition|move|assign|set|link|upload|publish)\w*(Jira|Confluence)\w*)$")
});
static ATLASSIAN_REST: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)https?://[\w.-]*(atlassian\.net|atlassian\.com|jira\.com)\b"));
static HTTP_WRITE: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)\s(-X\s*|--request[= ])["']?(POST|PUT|PATCH|DELETE)\b|\s(-d|--data[\w-]*|--json|-F|--form|-T|--upload-file)(\s|=)|-Method\s+["']?(Post|Put|Patch|Delete)\b"#));
static SESSION_ID_SPOOF: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(^|[\s;&|(])(export\s+|env\s+|set\s+|\$env:)?CLAUDE_CODE_SESSION_ID\s*="));
static DEV_LOGIN_GREP: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"^\s*grep\s+(?:(?:-E|-m\s?1|--max-count=1|-Em1|-m1E)\s+)*(?:'\^DEV_LOGIN_CODE='|"\^DEV_LOGIN_CODE="|\^DEV_LOGIN_CODE=)\s+(?:'(?:[\w.~/-]*/)?super-app/\.env'|"(?:[\w.~/-]*/)?super-app/\.env"|(?:[\w.~/-]*/)?super-app/\.env)\s*$"#)
});
static DB_WRITE: LazyLock<Regex> = LazyLock::new(|| re(r#"(?im)(^|[;\n("'`]|\s-e\s*["']?)\s*(insert|update|delete|alter|drop|truncate|create|replace\s+into|grant|revoke|rename\s+table|load\s+data|set\s+global)\b"#));
static LAUNCHCTL_READ: LazyLock<Regex> = LazyLock::new(|| re(r"^launchctl\s+(list|print)\b"));
static LAUNCHCTL_KICK: LazyLock<Regex> = LazyLock::new(|| re(r"^launchctl\s+kickstart\s+-k\s+(\S+)$"));
static NORM_DRIVE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^/([a-z])/"));
static LINE_CONTINUATION: LazyLock<Regex> = LazyLock::new(|| re(r"\\\r?\n"));
static PAREN_OPEN_END: LazyLock<Regex> = LazyLock::new(|| re(r"\(\s*$"));
static WORDS_OPEN: LazyLock<Regex> = LazyLock::new(|| re(r"^(\(|\{)\s*"));
static WORDS_REDIRECT: LazyLock<Regex> = LazyLock::new(|| re(r"^(\d*[<>]&?\S+\s*)+"));
static WORDS_FUNCTION: LazyLock<Regex> = LazyLock::new(|| re(r"^(function\s+)?[A-Za-z_][\w-]*\s*\(\)\s*\{?\s*"));
static WORDS_KEYWORD: LazyLock<Regex> = LazyLock::new(|| re(r"^(then|do|else|elif|\{|\}|!)\s+"));
static WORDS_ASSIGN: LazyLock<Regex> = LazyLock::new(|| re(r#"^[A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s+"#));
static WORDS_WRAPPER: LazyLock<Regex> = LazyLock::new(|| re(r"^(timeout\s+\S+|time|nice|nohup|exec|command)\s+"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
static QUOTE_ENDS: LazyLock<Regex> = LazyLock::new(|| re(r#"^["']|["']$"#));
static EXE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\.(exe|cmd|bat)$"));
static SQL_FILE: LazyLock<Regex> = LazyLock::new(|| re(r#"<\s*("[^"]+"|'[^']+'|\S+\.sql)"#));
static SEG_FUNCTION_DEF: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z_][\w-]*\s*\(\)\s*\{?\s*$"));
static SEG_ASSIGN: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z_]\w*="));
static GIT_SUB: LazyLock<Regex> = LazyLock::new(|| re(r#"^git\s+(?:(?:-C\s+("[^"]+"|\S+)|-c\s+\S+|--no-pager)\s+)*([\w-]+)"#));
static GIT_TAG_LIST: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*($|-l\b|--list\b|--contains\b|--points-at\b|-n\d*\b|--sort\b)"));
static GIT_STASH_READ: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(list|show)\b"));
static GIT_CHECKOUT_ALL: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(--(\s|$)|\.(\s|$)|-f\b)"));
static PR_MERGE: LazyLock<Regex> = LazyLock::new(|| re(r"pr\s+merge"));
static SSH_TUNNEL: LazyLock<Regex> = LazyLock::new(|| re(r"\s-[A-Za-z]*[LN]"));
static MYSQL_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"\bmysql\b"));
static SSH_PREFIX: LazyLock<Regex> = LazyLock::new(|| re(r"^ssh(\s+-\S+(\s+[^-\s]\S*)?)*\s+\S+\s*"));
static TMP_REDIRECT: LazyLock<Regex> = LazyLock::new(|| re(r"\d?>{1,2}\s*(/tmp/\S+|/dev/null|&\d)"));
static TMP_COPY: LazyLock<Regex> = LazyLock::new(|| re(r"\b(tee|cp|mv|rm)\s+(-\w+\s+)*/tmp/\S+"));
static WRITES_DATA: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)->(save|update|delete|forceDelete|create|insert|increment|decrement|attach|detach|sync|truncate|restore)\s*\(|::(create|insert|update|destroy|truncate|query\(\)->(update|delete))\s*\(|DB::(statement|insert|update|delete|unprepared)\s*\(|\bscout:(import|flush|sync|delete)|\bmigrate\b")
});
static TINKER: LazyLock<Regex> = LazyLock::new(|| re(r"\btinker\b"));
static REMOTE_TARGET: LazyLock<Regex> = LazyLock::new(|| re(r"^[^/\\]*@?[\w.-]+:"));
static WIN_DRIVE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^[a-z]:[\\/]"));
static MYSQL_HOST: LazyLock<Regex> = LazyLock::new(|| re(r"(?:-h\s*|--host[= ])(\S+)"));
static MYSQL_PORT: LazyLock<Regex> = LazyLock::new(|| re(r"(?:-P\s*|--port[= ])(\d+)"));
static LOCALHOST: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(localhost|127\.0\.0\.1|::1)$"));
static JIRA_WRITE_CMD: LazyLock<Regex> = LazyLock::new(|| re(r#"^node\s+["']?\S*jira-write(\.js)?["']?(\s|$)"#));
static JIRA_WRITE_ARGS: LazyLock<Regex> = LazyLock::new(|| re(r#"jira-write(?:\.js)?["']?\s+["']?([\w-]+)["']?(?:\s+["']?([A-Z][A-Z0-9]*(?:-\d+)?)\b)?"#));
static COMMENT_OR_MENTION: LazyLock<Regex> = LazyLock::new(|| re(r"comment|mention"));
static DEFAULTS_READ: LazyLock<Regex> = LazyLock::new(|| re(r"^defaults\s+(-currentHost\s+)?read\b"));
static FDESETUP_READ: LazyLock<Regex> = LazyLock::new(|| re(r"^fdesetup\s+(status|list|isactive)\b"));
static TASKKILL_NAME: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)/IM\s+"?(node|claude)(\.exe)?"?\b"#));
static NPM_PUBLISH: LazyLock<Regex> = LazyLock::new(|| re(r"\bnpm\s+publish\b"));
static RM_RECURSIVE: LazyLock<Regex> = LazyLock::new(|| re(r"\s-\w*r"));
static RM_BROAD: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(/|~/?|[a-z]:[\\/]?|/[a-z]/?|\*|\.\.?/?)$"));
static RAW_SPECIAL: LazyLock<Regex> = LazyLock::new(|| re(r"^[\[@.]"));
static RAW_PUNCT: LazyLock<Regex> = LazyLock::new(|| re(r"^[-)(<>]|[()]"));
static PS_COMMAND: LazyLock<Regex> = LazyLock::new(|| re(r#"(?is)-(?:Command|c)\s+("([^"]*)"|'([^']*)'|(.*))$"#));
static IRM: LazyLock<Regex> = LazyLock::new(|| re(r"^(invoke-restmethod|invoke-webrequest|irm|iwr)$"));
static CMDLET: LazyLock<Regex> = LazyLock::new(|| re(r"^(get|select|where|foreach|sort|measure|format|out|write|test|join|split|resolve|convertfrom|convertto|new|copy|move|remove|rename|set|add|group|compare|import|export|clear|expand|compress)-[a-z]+$"));
static CMDLET_DANGER: LazyLock<Regex> = LazyLock::new(|| re(r"^(set-executionpolicy|new-service|remove-service)$"));
static VAR_DEF: LazyLock<Regex> = LazyLock::new(|| re(r#"(?:^|[;&|\n]\s*)([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]+)"#));
static SUBSHELL: LazyLock<Regex> = LazyLock::new(|| re(r"\$\(|`"));
static VAR_USE: LazyLock<Regex> = LazyLock::new(|| re(r"\$\{?([A-Za-z_]\w*)\}?"));
static FUNCTION_DEFS: LazyLock<Regex> = LazyLock::new(|| re(r"(?:^|[\n;&|]\s*)(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{"));
static ONLY_ASSIGN: LazyLock<Regex> = LazyLock::new(|| re(r#"^([A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s*)+$"#));
static CD: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)^cd\s+(?:/d\s+)?("[^"]+"|'[^']+'|\S+)\s*$"#));
static DEV_LOGIN_PATH: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:[\w.~:\\/-]*[\\/])?super-app[\\/]\.env$"));
static MCP_PREFIX: LazyLock<Regex> = LazyLock::new(|| re(r"^mcp__.+__"));
static EDIT_JIRA_OP: LazyLock<Regex> = LazyLock::new(|| re(r"^edit\w*Jira"));
static CREATE_JIRA_OP: LazyLock<Regex> = LazyLock::new(|| re(r"^create\w*Jira"));
static COMMENT_OP: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)Comment"));
static EXECUTE_OP: LazyLock<Regex> = LazyLock::new(|| re(r"^execute(Write|Destructive)$"));
static ARTIFACT_READ: LazyLock<Regex> = LazyLock::new(|| re(r"^(read|list|open|get|query|quickstart)$"));

thread_local! {
    static WHOLE: RefCell<String> = const { RefCell::new(String::new()) };
}

fn whole() -> String {
    WHOLE.with(|w| w.borrow().clone())
}

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

    fn protected(key: impl Into<String>, label: impl Into<String>) -> Verdict {
        Verdict { kind: "protected", key: Some(key.into()), git: None, label: Some(label.into()) }
    }

    fn ask(key: impl Into<String>, label: impl Into<String>) -> Verdict {
        Verdict { kind: "ask", key: Some(key.into()), git: None, label: Some(label.into()) }
    }
}

struct Words {
    rest: String,
    cmd: String,
    raw: String,
}

fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(other) => json::stringify(other),
    }
}

fn or_str(v: Option<&Value>) -> String {
    if truthy(v) { js_string(v) } else { String::new() }
}

fn cut(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

fn basename(p: &str) -> String {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

fn config_root() -> String {
    crate::core::config::main_project().root.as_ref().map(|r| r.to_string_lossy().to_string()).unwrap_or_default()
}

fn repo() -> String {
    crate::core::config::repo().to_string_lossy().to_string()
}

fn resolve(base: &str, p: &str) -> String {
    let joined = if base.is_empty() { Path::new(p).to_path_buf() } else { Path::new(base).join(p) };
    crate::core::config::normalize(&joined).to_string_lossy().to_string()
}

fn norm(p: &str) -> String {
    NORM_DRIVE.replace(&p.replace('\\', "/"), "$1:/").to_lowercase()
}

fn secret_file(p: &str) -> bool {
    if let Some(c) = SECRET_ENV.captures(p)
        && c.get(3).is_none_or(|x| !SECRET_EXAMPLE.is_match(x.as_str()))
    {
        return true;
    }
    SECRET_OTHER.is_match(p)
}

fn launchctl_allowed(rest: &str) -> bool {
    if LAUNCHCTL_READ.is_match(rest) {
        return true;
    }
    let Some(m) = LAUNCHCTL_KICK.captures(rest) else { return false };
    let label = m[1].rsplit('/').next().unwrap_or("").to_string();
    crate::core::config::launchd_labels().iter().any(|p| label.starts_with(p.as_str()))
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn heredoc_at(text: &str, at: usize) -> Option<(usize, String, String)> {
    let b = text.as_bytes();
    let mut j = at + 2;
    if j < b.len() && b[j] == b'-' {
        j += 1;
    }
    while j < b.len() && is_space(b[j]) {
        j += 1;
    }
    let quote = if j < b.len() && (b[j] == b'\'' || b[j] == b'"') { Some(b[j]) } else { None };
    if quote.is_some() {
        j += 1;
    }
    let word_start = j;
    while j < b.len() && is_word(b[j]) {
        j += 1;
    }
    if j == word_start {
        return None;
    }
    let word = text[word_start..j].to_string();
    if let Some(q) = quote {
        if j >= b.len() || b[j] != q {
            return None;
        }
        j += 1;
    }
    let newline = j + text[j..].find('\n')?;
    let rest = text[j..newline].to_string();
    let mut q = newline + 1;
    while q < b.len() {
        if b[q] == b'\n' {
            let mut r = q + 1;
            while r < b.len() && is_space(b[r]) {
                r += 1;
            }
            if text[r..].starts_with(&word) {
                let s = r + word.len();
                let mut e = s;
                while e < b.len() && is_space(b[e]) {
                    e += 1;
                }
                if let Some(x) = (s..=e).rev().find(|&x| x == b.len() || b[x] == b'\n') {
                    return Some((x, word, rest));
                }
            }
        }
        q += 1;
    }
    None
}

fn strip_heredocs(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::new();
    let mut last = 0;
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'<'
            && b[i + 1] == b'<'
            && let Some((end, word, rest)) = heredoc_at(text, i)
        {
            out.push_str(&text[last..i]);
            out.push_str("<<");
            out.push_str(&word);
            out.push_str(&rest);
            i = end;
            last = end;
            continue;
        }
        i += 1;
    }
    out.push_str(&text[last..]);
    out
}

pub fn segments(command: &str) -> Vec<String> {
    let text = strip_heredocs(&LINE_CONTINUATION.replace_all(command, " "));
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();
        if let Some(q) = quote {
            if ch == '\\' && q == '"' && i + 1 < chars.len() {
                cur.push(ch);
                cur.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if ch == q {
                quote = None;
            }
            cur.push(ch);
            i += 1;
            continue;
        }
        if (ch == '$' && next == Some('(')) || ch == '`' {
            out.push(std::mem::take(&mut cur));
            i += if ch == '$' { 2 } else { 1 };
            continue;
        }
        if ch == ')' && !PAREN_OPEN_END.is_match(&cur) {
            out.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            cur.push(ch);
            i += 1;
            continue;
        }
        if (ch == '&' && next == Some('&')) || (ch == '|' && next == Some('|')) {
            out.push(std::mem::take(&mut cur));
            i += 2;
            continue;
        }
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        if ch == ';' || ch == '|' || ch == '\n' || (ch == '&' && next != Some('>') && prev != Some('>')) {
            out.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    out.push(cur);
    out.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

fn strip(re: &Regex, s: &str) -> String {
    re.replacen(s, 1, "").to_string()
}

fn words(segment: &str) -> Words {
    let mut s = strip(&WORDS_REDIRECT, &strip(&WORDS_OPEN, segment));
    s = strip(&WORDS_FUNCTION, &s);
    while WORDS_KEYWORD.is_match(&s) {
        s = strip(&WORDS_KEYWORD, &s);
    }
    while WORDS_ASSIGN.is_match(&s) {
        s = strip(&WORDS_ASSIGN, &s);
    }
    s = strip(&WORDS_WRAPPER, &s);
    let first_raw = SPACES.split(&s).next().unwrap_or("").to_string();
    let first = QUOTE_ENDS.replace_all(&first_raw, "").to_string();
    let cmd = EXE_SUFFIX.replace(&basename(&first.replace('\\', "/")), "").to_lowercase();
    Words { rest: s, cmd, raw: first }
}

fn sql_of(rest: &str, cwd: Option<&str>, whole: &str) -> String {
    let Some(file) = SQL_FILE.captures(rest).map(|m| m[1].to_string()) else { return rest.to_string() };
    let base = cwd.filter(|c| !c.is_empty()).map(String::from).unwrap_or_else(config_root);
    match std::fs::read_to_string(resolve(&base, &file.replace(['"', '\''], ""))) {
        Ok(body) => format!("{rest}\n{body}"),
        Err(_) => format!("{rest}\n{whole}"),
    }
}

fn in_repo(p: &str, repo: &str) -> bool {
    let r = norm(repo);
    let r = r.strip_suffix('/').unwrap_or(&r).to_string();
    let n = norm(p);
    n.starts_with(&format!("{r}/")) || n == r
}

fn ssh_remote(rest: &str) -> String {
    let b = rest.as_bytes();
    let trimmed = rest.trim_end();
    if let Some(&last) = trimmed.as_bytes().last()
        && (last == b'\'' || last == b'"')
    {
        let close = trimmed.len() - 1;
        let mut i = 0;
        while i + 1 < close {
            if (rest[i..].chars().next().is_some_and(char::is_whitespace)) && b[i + 1] == last {
                let inner = &rest[i + 2..close];
                if !inner.is_empty() {
                    return inner.to_string();
                }
                break;
            }
            i += rest[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        }
    }
    strip(&SSH_PREFIX, rest)
}

static JIRA_WRITE_VAR: LazyLock<Regex> = LazyLock::new(|| re(r#"jira-write(?:\.js)?["']?\s+["']?\$\{?(\w+)\}?"#));

fn loop_of_free_actions(rest: &str, whole: &str) -> bool {
    let Some(var) = JIRA_WRITE_VAR.captures(rest).map(|m| m[1].to_string()) else { return false };
    let Ok(each) = Regex::new(&format!(r"(?:^|[;&|(\s])for\s+{}\s+in\s+([^;\n]*?)\s*(?:;|\n)\s*do\b", regex::escape(&var))) else { return false };
    let Some(m) = each.captures(whole) else { return false };
    let words: Vec<String> = m[1].split_whitespace().map(|w| w.trim_matches(|c| c == '"' || c == '\'').to_string()).collect();
    !words.is_empty() && words.iter().all(|w| JIRA_WRITE_FREE.contains(&w.as_str()))
}

fn classify_segment(segment: &str, cwd: Option<&str>) -> Verdict {
    let Words { rest, cmd, raw } = words(segment);
    if cmd.is_empty() {
        return Verdict::allow();
    }
    if rest.starts_with('"') || rest.starts_with('\'') || SEG_FUNCTION_DEF.is_match(&rest) || SEG_ASSIGN.is_match(&rest) {
        return Verdict::allow();
    }
    if has_word(SHELL_WORDS, &cmd) {
        return Verdict::allow();
    }
    let whole = whole();
    if cmd == "git" {
        let m = GIT_SUB.captures(&rest);
        let sub = m.as_ref().and_then(|m| m.get(2)).map(|x| x.as_str().to_string()).unwrap_or_default();
        let place = match m.as_ref().and_then(|m| m.get(1)) {
            Some(w) => Some(w.as_str().replace('"', "")),
            None => cwd.map(String::from),
        };
        let after = m.as_ref().map(|m| rest[m.get(0).unwrap().end()..].to_string()).unwrap_or_default();
        if (sub == "tag" && GIT_TAG_LIST.is_match(&after)) || (sub == "stash" && GIT_STASH_READ.is_match(&after)) {
            return Verdict::allow();
        }
        if has_word(GIT_PROTECTED, &sub) || (sub == "checkout" && GIT_CHECKOUT_ALL.is_match(&after)) {
            if ["commit", "push", "pull"].contains(&sub.as_str()) && in_repo(place.as_deref().unwrap_or(""), &repo()) {
                return Verdict::allow();
            }
            let git = ["commit", "push", "merge", "tag"].into_iter().find(|x| *x == sub);
            return Verdict { kind: "protected", key: Some(format!("git {sub}")), git, label: Some(format!("git {sub}")) };
        }
        let _ = has_word(GIT_READ, &sub);
        return Verdict::allow();
    }
    if cmd == "gh" {
        if GH_PROTECTED.is_match(&rest) {
            let label = SPACES.split(&rest).take(3).collect::<Vec<_>>().join(" ");
            return Verdict { kind: "protected", key: Some("gh".into()), git: if PR_MERGE.is_match(&rest) { Some("merge") } else { None }, label: Some(label) };
        }
        let _ = GH_READ.is_match(&rest);
        return Verdict::allow();
    }
    if cmd == "ssh" && SSH_TUNNEL.is_match(&rest) && !MYSQL_WORD.is_match(&rest) {
        return Verdict::allow();
    }
    if cmd == "ssh" && MYSQL_WORD.is_match(&rest) {
        return if DB_WRITE.is_match(&sql_of(&rest, cwd, &whole)) { Verdict::protected("bd remota escritura", "escribir en una base de datos remota") } else { Verdict::allow() };
    }
    if ["ssh", "scp", "rsync", "sftp"].contains(&cmd.as_str()) && crate::core::config::trusted_hosts().iter().any(|h| rest.contains(h.as_str())) {
        return Verdict::allow();
    }
    if cmd == "ssh" {
        let remote = ssh_remote(&rest);
        let cleaned = TMP_COPY.replace_all(&TMP_REDIRECT.replace_all(&remote, " "), " ").to_string();
        let writes_data = WRITES_DATA.is_match(&whole);
        return if REMOTE_CHANGE.is_match(&cleaned) || (TINKER.is_match(&remote) && writes_data) { Verdict::protected("servidor cambio", "cambiar algo en un servidor por ssh") } else { Verdict::allow() };
    }
    if cmd == "scp" || cmd == "rsync" || cmd == "sftp" {
        let args: Vec<&str> = SPACES.split(&rest).skip(1).filter(|a| !a.starts_with('-')).collect();
        let target = args.last().copied().unwrap_or("");
        return if REMOTE_TARGET.is_match(target) && !WIN_DRIVE.is_match(target) && !target.contains(":/tmp/") { Verdict::protected("servidor copia", format!("subir ficheros a un servidor con {cmd}")) } else { Verdict::allow() };
    }
    if cmd == "aws" && AWS_READ.is_match(&rest) && !AWS_SECRET.is_match(&rest) {
        return Verdict::allow();
    }
    if has_word(PROTECTED_WORDS, &cmd) {
        return Verdict::protected(cmd.clone(), cmd.clone());
    }
    if cmd == "mysql" || cmd == "mysqldump" || cmd == "mysqladmin" {
        let host = MYSQL_HOST.captures(&rest).map(|m| m[1].to_string());
        let port = MYSQL_PORT.captures(&rest).map(|m| m[1].to_string());
        let remote = host.as_ref().is_some_and(|h| !LOCALHOST.is_match(&h.replace(['"', '\''], ""))) || port.as_ref().is_some_and(|p| p != "3306");
        if remote && (cmd != "mysql" || DB_WRITE.is_match(&sql_of(&rest, cwd, &whole))) {
            let against = host.clone().unwrap_or_else(|| format!("el puerto {}", port.clone().unwrap_or_default()));
            return Verdict::protected("bd remota escritura", format!("{cmd} con escritura contra {against}"));
        }
        return Verdict::allow();
    }
    if cmd == "node" && JIRA_WRITE_CMD.is_match(&rest) {
        let m = JIRA_WRITE_ARGS.captures(&rest);
        let action = m.as_ref().map(|m| m[1].to_string()).unwrap_or_default();
        let key = m.as_ref().and_then(|m| m.get(2)).map(|x| x.as_str().to_string());
        let target = key.as_ref().map(|k| format!(" {k}")).unwrap_or_default();
        if JIRA_WRITE_FREE.contains(&action.as_str()) || loop_of_free_actions(&rest, &whole) {
            return Verdict::allow();
        }
        let label = if COMMENT_OR_MENTION.is_match(&action) {
            format!("comentar en{target} en Jira")
        } else if action == "create" {
            format!("crear una tarea en Jira{}", key.as_ref().map(|k| format!(" ({k})")).unwrap_or_default())
        } else if action == "assign" {
            format!("asignar{target} en Jira")
        } else if action == "sprint" {
            format!("mover{target} al sprint en Jira")
        } else {
            format!("escribir en Jira ({}{target})", if action.is_empty() { "sin acción" } else { action.as_str() })
        };
        return Verdict::protected("jira-write", label);
    }
    if (cmd == "curl" || cmd == "wget") && ATLASSIAN_REST.is_match(&rest) && HTTP_WRITE.is_match(&format!(" {rest}")) {
        return Verdict::protected("jira-rest", "escribir en Jira por la API");
    }
    if cmd == "curl" || cmd == "wget" {
        return Verdict::allow();
    }
    if cmd == "defaults" && DEFAULTS_READ.is_match(&rest) {
        return Verdict::allow();
    }
    if cmd == "fdesetup" && FDESETUP_READ.is_match(&rest) {
        return Verdict::allow();
    }
    if cmd == "launchctl" && launchctl_allowed(&rest) {
        return Verdict::allow();
    }
    if cmd == "taskkill" {
        return if TASKKILL_NAME.is_match(&rest) { Verdict::ask("taskkill /IM", "taskkill por nombre (mata los procesos de todas las sesiones)") } else { Verdict::allow() };
    }
    if cmd == "bash" || cmd == "sh" {
        return Verdict::allow();
    }
    if cmd == "npm" && NPM_PUBLISH.is_match(&rest) {
        return Verdict::ask("npm publish", "npm publish");
    }
    if ["cat", "head", "tail", "less", "more", "type", "grep", "base64"].contains(&cmd.as_str()) && SPACES.split(&rest).any(|w| secret_file(&norm(&w.replace(['"', '\''], "")))) {
        return Verdict::ask(format!("{cmd} secreto"), format!("{cmd} de un fichero con secretos"));
    }
    if cmd == "rm" && RM_RECURSIVE.is_match(&rest) && SPACES.split(&rest).skip(1).any(|w| RM_BROAD.is_match(&w.replace(['"', '\''], ""))) {
        return Verdict::ask("rm -r amplio", "borrar una carpeta raíz o demasiado amplia");
    }
    if has_word(READ_WORDS, &cmd) {
        return Verdict::allow();
    }
    if raw.starts_with('$') || RAW_SPECIAL.is_match(&raw) || has_word(PS_WORDS, &cmd) || RAW_PUNCT.is_match(&raw) {
        return Verdict::allow();
    }
    if cmd == "powershell" || cmd == "pwsh" {
        let inner = PS_COMMAND.captures(&rest).map(|m| [2, 3, 4].iter().filter_map(|i| m.get(*i)).map(|x| x.as_str()).find(|x| !x.is_empty()).unwrap_or("").to_string()).unwrap_or_default();
        return if inner.is_empty() { Verdict::allow() } else { classify_command(&inner, cwd) };
    }
    if IRM.is_match(&cmd) {
        return if ATLASSIAN_REST.is_match(&rest) && HTTP_WRITE.is_match(&format!(" {rest}")) { Verdict::protected("jira-rest", "escribir en Jira por la API") } else { Verdict::allow() };
    }
    let _ = CMDLET.is_match(&cmd) && !CMDLET_DANGER.is_match(&cmd);
    Verdict::allow()
}

fn expand_vars(command: &str) -> String {
    let mut vars: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for m in VAR_DEF.captures_iter(command) {
        if !SUBSHELL.is_match(&m[2]) {
            vars.insert(m[1].to_string(), QUOTE_ENDS.replace_all(&m[2], "").to_string());
        }
    }
    VAR_USE.replace_all(command, |c: &regex::Captures| vars.get(&c[1]).cloned().unwrap_or_else(|| c[0].to_string())).to_string()
}

fn cd_target(target: &str) -> String {
    let unquoted = target.replace(['"', '\''], "");
    let home = std::env::var("HOME").unwrap_or_default();
    let expanded = if unquoted == "~" || unquoted.starts_with("~/") { format!("{home}{}", &unquoted[1..]) } else { unquoted };
    NORM_DRIVE.replace(&expanded, "$1:/").to_string()
}

fn classify_command(command: &str, cwd: Option<&str>) -> Verdict {
    if DEV_LOGIN_GREP.is_match(command) {
        return Verdict::allow();
    }
    if SESSION_ID_SPOOF.is_match(command) {
        return Verdict::protected("suplantar sesión", "hacerse pasar por otra sesión (CLAUDE_CODE_SESSION_ID)");
    }
    let command = expand_vars(command);
    WHOLE.with(|w| *w.borrow_mut() = command.clone());
    let defined: HashSet<String> = FUNCTION_DEFS.captures_iter(&command).map(|m| m[1].to_lowercase()).collect();
    let mut place: Option<String> = cwd.map(String::from);
    let mut parts = Vec::new();
    for seg in segments(&command) {
        if ONLY_ASSIGN.is_match(&seg) {
            continue;
        }
        if let Some(cd) = CD.captures(&seg) {
            let base = place.clone().filter(|p| !p.is_empty()).unwrap_or_else(config_root);
            place = Some(resolve(&base, &cd_target(&cd[1])));
            continue;
        }
        let c = classify_segment(&seg, place.as_deref());
        parts.push(if c.kind == "ask" && c.key.as_ref().is_some_and(|k| defined.contains(k)) { Verdict::allow() } else { c });
    }
    parts.iter().find(|p| p.kind == "protected").or_else(|| parts.iter().find(|p| p.kind == "ask")).cloned().unwrap_or_else(Verdict::allow)
}

fn dev_login_grep(input: &Value) -> bool {
    let Some(o) = input.as_object() else { return false };
    let keys: Vec<&String> = o.iter().filter(|(_, v)| !v.is_null() && **v != Value::Bool(false)).map(|(k, _)| k).collect();
    if keys.iter().any(|k| !["pattern", "path", "output_mode", "-n", "head_limit"].contains(&k.as_str())) {
        return false;
    }
    if truthy(o.get("output_mode")) && !["content", "files_with_matches", "count"].contains(&js_string(o.get("output_mode")).as_str()) {
        return false;
    }
    o.get("pattern").and_then(|p| p.as_str()) == Some("^DEV_LOGIN_CODE=") && DEV_LOGIN_PATH.is_match(&or_str(o.get("path")))
}

fn starts_or_claims(op: &str, input: &Value) -> bool {
    let project = crate::core::config::main_project();
    let jira = project.jira.as_ref();
    if op.starts_with("transition") {
        let transition = input.get("transition");
        let id = or_str(transition.and_then(|t| t.get("id")).filter(|x| truthy(Some(x))).or(input.get("transitionId")));
        let name = or_str(transition.and_then(|t| t.get("name")).filter(|x| truthy(Some(x))).or(input.get("transitionName")));
        let start = jira.and_then(|j| j.transitions.get("start")).filter(|s| truthy(Some(s)));
        if let Some(start) = start
            && id == js_string(Some(start))
        {
            return true;
        }
        return id.is_empty() && !name.is_empty() && project.statuses.as_ref().is_some_and(|s| s.in_progress_regex.is_match(name.trim()));
    }
    if EDIT_JIRA_OP.is_match(op) {
        let empty = Map::new();
        let fields = input.get("fields").and_then(|f| f.as_object()).unwrap_or(&empty);
        let others = input.as_object().map(|o| o.keys().filter(|k| !["cloudId", "issueIdOrKey", "issueKey", "fields", "responseFields", "view"].contains(&k.as_str())).count()).unwrap_or(0);
        let Some(me) = jira.map(|j| &j.me).filter(|m| truthy(Some(m))) else { return false };
        return fields.len() == 1 && fields.contains_key("assignee") && others == 0 && truthy(fields.get("assignee")) && fields["assignee"].get("accountId").is_some() && fields["assignee"].get("accountId") == me.get("id");
    }
    false
}

fn atlassian_write(tool: &str, input: &Value) -> Verdict {
    let op = MCP_PREFIX.replacen(tool, 1, "").to_string();
    if starts_or_claims(&op, input) {
        return Verdict::allow();
    }
    let key = input.get("issueIdOrKey").filter(|x| truthy(Some(x))).or(input.get("issueKey")).filter(|x| truthy(Some(x))).map(|x| js_string(Some(x))).unwrap_or_default();
    let on = if key.is_empty() { String::new() } else { format!(" {key}") };
    let label = if COMMENT_OP.is_match(&op) {
        format!("comentar en{on} en Jira")
    } else if op.starts_with("transition") {
        let id = input.get("transition").and_then(|t| t.get("id")).filter(|x| truthy(Some(x)));
        format!("cambiar de estado{on} en Jira{}", id.map(|i| format!(" (transición {})", js_string(Some(i)))).unwrap_or_default())
    } else if CREATE_JIRA_OP.is_match(&op) {
        "crear una tarea en Jira".to_string()
    } else if EDIT_JIRA_OP.is_match(&op) {
        format!("editar{on} en Jira")
    } else if op.contains("Confluence") {
        "escribir en Confluence".to_string()
    } else if EXECUTE_OP.is_match(&op) {
        let name = if truthy(input.get("name")) { js_string(input.get("name")) } else { "operación sin nombre".to_string() };
        format!("{} en Atlassian ({})", if op == "executeDestructive" { "borrar o cambiar sin vuelta atrás" } else { "escribir" }, cut(&name, 80))
    } else {
        "escribir en Jira".to_string()
    };
    Verdict::protected(format!("atlassian {op}"), label)
}

pub fn classify(tool: &str, input: &Value, cwd: Option<&str>) -> Verdict {
    let empty = json!({});
    let input = if truthy(Some(input)) { input } else { &empty };
    if tool == "Bash" || tool == "PowerShell" || tool == "Monitor" {
        return if truthy(input.get("command")) { classify_command(&js_string(input.get("command")), cwd) } else { Verdict::allow() };
    }
    if tool == "Grep" && dev_login_grep(input) {
        return Verdict::allow();
    }
    if ["Read", "Grep", "Glob"].contains(&tool) {
        let p = if truthy(input.get("file_path")) { js_string(input.get("file_path")) } else { or_str(input.get("path")) };
        return if !p.is_empty() && secret_file(&norm(&p)) { Verdict::ask(format!("{tool} secreto"), format!("leer {} (puede tener secretos)", basename(&p))) } else { Verdict::allow() };
    }
    if ["Edit", "Write", "NotebookEdit", "MultiEdit"].contains(&tool) {
        let raw = if truthy(input.get("file_path")) { js_string(input.get("file_path")) } else { or_str(input.get("notebook_path")) };
        let p = norm(&raw);
        if secret_file(&p) {
            return Verdict::ask(format!("{tool} secreto"), format!("editar {}", basename(&p)));
        }
        return Verdict::allow();
    }
    if has_word(ALWAYS_TOOLS, tool) {
        return Verdict::allow();
    }
    if ATLASSIAN_WRITE.is_match(tool) {
        return atlassian_write(tool, input);
    }
    let sentry_read = tool.strip_prefix("mcp__sentry__").is_some_and(|rest| !rest.starts_with("update_issue"));
    if JIRA_READ.is_match(tool) || tool.starts_with("mcp__playwright__") || sentry_read || tool == "mcp__claude-vscode__getDiagnostics" {
        return Verdict::allow();
    }
    if tool.starts_with("mcp__jira__") {
        return Verdict::allow();
    }
    if tool == "mcp__sentry__update_issue" {
        return Verdict::protected(tool, "cambiar un error en Sentry");
    }
    if tool.starts_with("Artifact") && ARTIFACT_READ.is_match(&or_str(input.get("action"))) {
        return Verdict::allow();
    }
    if tool.starts_with("Artifact") {
        return Verdict::ask(tool, "publicar en claude.ai (la cuenta es compartida)");
    }
    Verdict::allow()
}

pub fn area_of(conversation: &str) -> Option<Value> {
    let r = crate::sessions::registry::load_routes();
    for (id, a) in r.get("areas").and_then(|a| a.as_object()).into_iter().flatten() {
        if a.get("conversation").and_then(|c| c.as_str()) == Some(conversation) {
            let name = if truthy(a.get("title")) { a["title"].clone() } else { Value::String(id.clone()) };
            return Some(json!({ "id": id, "name": name }));
        }
    }
    for (role, name) in [("reporter", "Reporte"), ("orchestrator", "Orquestadora"), ("followUp", "Seguimiento"), ("board", "Tablero")] {
        if r.get(role).filter(|x| truthy(Some(x))).and_then(|x| x.get("conversation")).and_then(|c| c.as_str()) == Some(conversation) {
            return Some(json!({ "id": role, "name": name }));
        }
    }
    None
}

fn live_name(conversation: &str) -> Option<String> {
    let live = crate::sessions::registry::live_sessions().unwrap_or_default();
    let s = live.iter().find(|s| s.get("conversation").and_then(|c| c.as_str()) == Some(conversation))?;
    let label = if truthy(s.get("title")) { js_string(s.get("title")) } else { js_string(s.get("name")) };
    Some(format!("{label} (sin registrar)"))
}

fn has_order(c: &Verdict, area: Option<&str>, d: &Doc) -> bool {
    let Some(area) = area else { return false };
    let now_ms = crate::core::time::now_ms();
    let recent = |iso: Option<&Value>| iso.filter(|x| truthy(Some(x))).and_then(|x| x.as_str()).and_then(crate::core::time::parse).is_some_and(|t| now_ms - t < ORDER_HOURS * 3600000);
    if c.git.is_some() {
        return d.get("deployments").and_then(|x| x.as_array()).into_iter().flatten().any(|x| {
            x.get("area").and_then(|a| a.as_str()) == Some(area) && ["approved", "sent"].contains(&x.get("status").and_then(|s| s.as_str()).unwrap_or("")) && recent(x.get("sentAt").filter(|s| truthy(Some(s))).or(x.get("at")))
        });
    }
    false
}

fn detail_of(input: &Value) -> String {
    if truthy(input.get("command")) {
        return js_string(input.get("command"));
    }
    if truthy(input.get("file_path")) || truthy(input.get("notebook_path")) {
        return if truthy(input.get("file_path")) { js_string(input.get("file_path")) } else { js_string(input.get("notebook_path")) };
    }
    let body = if input.is_null() { "{}".to_string() } else { json::stringify(input) };
    cut(&body, 1500)
}

fn new_id() -> String {
    let digits: String = now().chars().filter(|c| c.is_ascii_digit()).take(17).collect();
    let n: u32 = rand::random_range(10..100);
    format!("perm-{digits}{n}")
}

fn rules_have(d: &Doc, key: Option<&String>) -> bool {
    d.get("permissionRules").and_then(|r| r.as_array()).into_iter().flatten().any(|r| r.get("key").and_then(|k| k.as_str()) == key.map(|k| k.as_str()))
}

fn put(o: &mut Map<String, Value>, key: &str, v: Option<&Value>) {
    if let Some(v) = v {
        o.insert(key.into(), v.clone());
    }
}

pub fn check(event: &Value) -> Value {
    let conversation = event.get("session_id");
    let conversation_text = conversation.map(|c| js_string(Some(c))).unwrap_or_default();
    let tool = event.get("tool_name");
    let tool_text = tool.map(|t| js_string(Some(t))).unwrap_or_else(|| "undefined".into());
    let input = event.get("tool_input").cloned().unwrap_or(Value::Null);
    let cwd = event.get("cwd").filter(|c| truthy(Some(c))).map(|c| js_string(Some(c)));
    let c = classify(&tool_text, &input, cwd.as_deref());
    if c.kind == "allow" {
        return json!({ "decision": "allow" });
    }
    let d = load();
    if c.kind == "ask" && rules_have(&d, c.key.as_ref()) {
        return json!({ "decision": "allow" });
    }
    let area = area_of(&conversation_text);
    let area_id = area.as_ref().and_then(|a| a.get("id")).and_then(|x| x.as_str()).map(String::from);
    if c.kind == "protected" && has_order(&c, area_id.as_deref(), &d) {
        return json!({ "decision": "allow" });
    }
    let id = new_id();
    let area_name = match &area {
        Some(a) => a["name"].clone(),
        None => live_name(&conversation_text).map(Value::String).unwrap_or(Value::Null),
    };
    let detail = cut(&detail_of(&input), 1500);
    let small = (if truthy(Some(&input)) { json::stringify(&input) } else { "{}".into() }).encode_utf16().count() < 30000;
    let mut record = Map::new();
    record.insert("id".into(), Value::String(id.clone()));
    put(&mut record, "conversation", conversation);
    record.insert("area".into(), area_id.clone().map(Value::String).unwrap_or(Value::Null));
    record.insert("areaName".into(), area_name);
    put(&mut record, "tool", tool);
    record.insert("label".into(), c.label.clone().map(Value::String).unwrap_or(Value::Null));
    record.insert("key".into(), c.key.clone().map(Value::String).unwrap_or(Value::Null));
    record.insert("protected".into(), Value::Bool(c.kind == "protected"));
    record.insert("detail".into(), Value::String(detail));
    if small {
        put(&mut record, "input", event.get("tool_input"));
    } else {
        record.insert("input".into(), Value::Null);
    }
    record.insert("cwd".into(), cwd.clone().map(Value::String).unwrap_or(Value::Null));
    record.insert("status".into(), Value::String("pending".into()));
    record.insert("at".into(), Value::String(now()));
    mutate(|x| {
        let mut list = vec![Value::Object(record)];
        list.extend(x.get("permissions").and_then(|p| p.as_array()).cloned().unwrap_or_default());
        list.truncate(100);
        x.insert("permissions".into(), Value::Array(list));
    });
    let who = area.as_ref().map(|a| js_string(a.get("name"))).unwrap_or_else(|| "Una sesión".into());
    let text = format!("{who} pide permiso: {}", c.label.clone().unwrap_or_default());
    std::thread::spawn(move || {
        crate::server::push::send_push("permission", true, Some(&text));
    });
    json!({ "decision": "wait", "id": id, "waitMinutes": WAIT_MINUTES })
}

fn age_ms(p: &Value) -> f64 {
    p.get("at").and_then(|a| a.as_str()).and_then(crate::core::time::parse).map(|t| (crate::core::time::now_ms() - t) as f64).unwrap_or(f64::NAN)
}

fn is_pending(p: &Value) -> bool {
    p.get("status").and_then(|s| s.as_str()) == Some("pending")
}

fn assign(p: &mut Value, fields: Value) {
    if let (Some(o), Value::Object(f)) = (p.as_object_mut(), fields) {
        for (k, v) in f {
            o.insert(k, v);
        }
    }
}

pub fn expire(d: &mut Doc) {
    if let Some(list) = d.get_mut("permissions").and_then(|p| p.as_array_mut()) {
        for p in list.iter_mut() {
            if is_pending(p) && age_ms(p) > ((WAIT_MINUTES + 2) * 60000) as f64 {
                assign(p, json!({ "status": "expired", "decidedAt": now() }));
            }
        }
    }
}

pub fn poll(id: &str) -> Value {
    let d = load();
    let Some(p) = d.get("permissions").and_then(|x| x.as_array()).and_then(|l| l.iter().find(|x| x.get("id").and_then(|i| i.as_str()) == Some(id))).cloned() else { return json!({ "status": "missing" }) };
    if is_pending(&p) && age_ms(&p) > (WAIT_MINUTES * 60000) as f64 {
        mutate(expire);
        return json!({ "status": "expired" });
    }
    if is_pending(&p) && recheck(&p) {
        return json!({ "status": "allowed", "reason": null });
    }
    json!({ "status": p.get("status").cloned().unwrap_or(Value::Null), "reason": if truthy(p.get("reason")) { p["reason"].clone() } else { Value::Null } })
}

fn recheck(p: &Value) -> bool {
    let tool = js_string(p.get("tool"));
    let detail = p.get("detail").map(|d| js_string(Some(d))).unwrap_or_default();
    let input = if truthy(p.get("input")) {
        p["input"].clone()
    } else if detail.encode_utf16().count() < 1500 && ["Bash", "PowerShell", "Monitor"].contains(&tool.as_str()) {
        json!({ "command": detail })
    } else {
        return false;
    };
    let cwd = p.get("cwd").filter(|c| truthy(Some(c))).map(|c| js_string(Some(c)));
    let c = classify(&tool, &input, cwd.as_deref());
    let d = load();
    let area = p.get("area").filter(|a| truthy(Some(a))).map(|a| js_string(Some(a)));
    let passes = c.kind == "allow" || (c.kind == "ask" && rules_have(&d, c.key.as_ref())) || (c.kind == "protected" && has_order(&c, area.as_deref(), &d));
    if !passes {
        return false;
    }
    let id = p.get("id").cloned();
    mutate(|x| {
        if let Some(q) = x.get_mut("permissions").and_then(|l| l.as_array_mut()).and_then(|l| l.iter_mut().find(|y| y.get("id") == id.as_ref()))
            && is_pending(q)
        {
            assign(q, json!({ "status": "allowed", "reason": "Ya no hacía falta: el filtro corregido lo deja pasar solo", "decidedAt": now(), "auto": true }));
        }
    });
    true
}

pub fn decide(id: &str, decision: &str, reason: Option<&str>) -> bool {
    mutate(|d| {
        let Some(p) = d.get_mut("permissions").and_then(|l| l.as_array_mut()).and_then(|l| l.iter_mut().find(|x| x.get("id").and_then(|i| i.as_str()) == Some(id))) else { return false };
        if !is_pending(p) {
            return false;
        }
        let always = decision == "always" && !truthy(p.get("protected"));
        let reason = reason.filter(|r| !r.is_empty()).map(|r| Value::String(cut(r, 300))).unwrap_or(Value::Null);
        assign(p, json!({ "status": if decision == "deny" { "denied" } else { "allowed" }, "always": always, "reason": reason, "decidedAt": now() }));
        let key = p.get("key").cloned().unwrap_or(Value::Null);
        let label = p.get("label").cloned().unwrap_or(Value::Null);
        let known = d.get("permissionRules").and_then(|r| r.as_array()).into_iter().flatten().any(|r| r.get("key") == Some(&key));
        if always && !known {
            let mut rules = d.get("permissionRules").and_then(|r| r.as_array()).cloned().unwrap_or_default();
            rules.push(json!({ "key": key, "label": label, "at": now() }));
            d.insert("permissionRules".into(), Value::Array(rules));
        }
        true
    })
}

pub fn native_prompt(input: &Value) -> Option<String> {
    let conversation = input.get("conversation").cloned();
    let conversation_text = conversation.as_ref().map(|c| js_string(Some(c))).unwrap_or_default();
    let cleared = truthy(input.get("cleared"));
    mutate(|d| {
        if !truthy(d.get("permissions")) {
            d.insert("permissions".into(), json!([]));
        }
        let list = d.get_mut("permissions").and_then(|l| l.as_array_mut())?;
        for p in list.iter_mut() {
            if truthy(p.get("native")) && p.get("conversation") == conversation.as_ref() && is_pending(p) {
                if cleared {
                    assign(p, json!({ "status": "answered", "decidedAt": now(), "reason": "Contestada en la propia sesión" }));
                } else {
                    assign(p, json!({ "status": "answered", "decidedAt": now() }));
                }
            }
        }
        if cleared {
            return None;
        }
        let area = area_of(&conversation_text);
        let id = new_id();
        let area_name = match &area {
            Some(a) => a["name"].clone(),
            None if truthy(input.get("name")) => input["name"].clone(),
            None => live_name(&conversation_text).map(Value::String).unwrap_or(Value::Null),
        };
        let mut record = Map::new();
        record.insert("id".into(), Value::String(id.clone()));
        put(&mut record, "conversation", conversation.as_ref());
        record.insert("area".into(), area.as_ref().and_then(|a| a.get("id")).cloned().unwrap_or(Value::Null));
        record.insert("areaName".into(), area_name);
        record.insert("tool".into(), json!("Claude Code"));
        record.insert("label".into(), Value::String(format!("Claude Code pregunta: {}", cut(&or_str(input.get("question")), 160))));
        record.insert("key".into(), Value::Null);
        record.insert("protected".into(), Value::Bool(true));
        record.insert("native".into(), Value::Bool(true));
        record.insert("detail".into(), Value::String(cut(&or_str(input.get("text")), 1500)));
        record.insert("status".into(), json!("pending"));
        record.insert("at".into(), Value::String(now()));
        list.insert(0, Value::Object(record));
        list.truncate(100);
        Some(id)
    })
}

pub fn remove_rule(key: &str) -> bool {
    mutate(|d| {
        let rules = d.get("permissionRules").and_then(|r| r.as_array()).cloned().unwrap_or_default();
        let before = rules.len();
        let kept: Vec<Value> = rules.into_iter().filter(|r| r.get("key").and_then(|k| k.as_str()) != Some(key)).collect();
        let removed = kept.len() < before;
        d.insert("permissionRules".into(), Value::Array(kept));
        removed
    })
}

pub fn for_page(d: &Doc) -> Value {
    let list = d.get("permissions").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let stale = list.iter().filter(|p| is_pending(p) && recheck(p)).count();
    let fresh;
    let d = if stale > 0 {
        fresh = load();
        &fresh
    } else {
        d
    };
    let list = d.get("permissions").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let pending: Vec<Value> = list.iter().filter(|p| is_pending(p)).cloned().collect();
    let recent: Vec<Value> = list.iter().filter(|p| !is_pending(p)).take(8).cloned().collect();
    json!({ "pending": pending, "recent": recent, "rules": d.get("permissionRules").filter(|r| truthy(Some(r))).cloned().unwrap_or(json!([])) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> String {
        crate::testkit::sandbox().root.to_string_lossy().to_string()
    }

    fn join(base: &str, f: &str) -> String {
        Path::new(base).join(f).to_string_lossy().to_string()
    }

    fn bash_in(command: &str, cwd: &str) -> &'static str {
        classify("Bash", &json!({ "command": command }), Some(cwd)).kind
    }

    fn bash(command: &str) -> &'static str {
        bash_in(command, &root())
    }

    fn kind(tool: &str, input: Value) -> &'static str {
        crate::testkit::sandbox();
        classify(tool, &input, None).kind
    }

    #[test]
    fn reading_searching_and_editing_ordinary_files_pass_on_their_own() {
        let r = root();
        assert_eq!(kind("Read", json!({ "file_path": join(&r, "src/app.js") })), "allow");
        assert_eq!(kind("Grep", json!({ "path": r })), "allow");
        assert_eq!(kind("Edit", json!({ "file_path": join(&r, "src/app.js") })), "allow");
        assert_eq!(kind("Write", json!({ "file_path": "/somewhere/else/file.txt" })), "allow");
        assert_eq!(kind("Read", json!({ "file_path": join(&r, ".env.example") })), "allow");
    }

    #[test]
    fn files_with_secrets_are_asked_for_with_the_dedicated_tools() {
        let r = root();
        for f in [".env", ".env.local", "api/.env.production", "certs/server.pem", "keys/deploy.key", ".mcp.json", "credentials.json", ".credentials.json", "/home/u/.aws/credentials"] {
            let file = if f.starts_with('/') { format!("{r}{f}") } else { join(&r, f) };
            assert_eq!(kind("Read", json!({ "file_path": file })), "ask", "{f}");
        }
        assert_eq!(kind("Edit", json!({ "file_path": join(&r, ".env") })), "ask");
        assert_eq!(kind("Write", json!({ "file_path": "C:\\work\\api\\.env" })), "ask");
    }

    #[test]
    fn shell_commands_that_dump_secrets_are_asked_for() {
        assert_eq!(bash("cat .env"), "ask");
        assert_eq!(bash("grep TOKEN api/.env.local"), "ask");
        assert_eq!(bash("echo $(cat .env)"), "ask");
        assert_eq!(bash("head -5 .mcp.json"), "ask");
        assert_eq!(bash("cat .env.example"), "allow");
    }

    #[test]
    fn ordinary_development_commands_pass_on_their_own() {
        for c in ["ls -la", "npm test", "php artisan test --parallel", "node scripts/board.js list", "git status", "git log --oneline -5", "git diff HEAD~1", "git checkout main", "git stash list", "git tag", "git tag -l", "gh pr view 12", "curl -s https://example.com", "launchctl print gui/501/x", "some-unknown-tool --flag", "sleep 5 && echo done"] {
            assert_eq!(bash(c), "allow", "{c}");
        }
    }

    #[test]
    fn protected_git_and_gh_operations_need_an_order() {
        for c in ["git commit -m wip", "git push", "git merge develop", "git tag v1.2.3", "git reset --hard", "git stash", "git rebase main", "git checkout -- .", "git checkout .", "ls && git push origin main", "gh pr merge 12", "gh api -X POST repos/x/y/issues", "gh variable list", "gh secret set X", "gh workflow run deploy"] {
            assert_eq!(bash(c), "protected", "{c}");
        }
        let r = root();
        assert_eq!(classify("Bash", &json!({ "command": "git commit -m x" }), Some(&r)).git, Some("commit"));
        assert_eq!(classify("Bash", &json!({ "command": "gh pr merge 3" }), Some(&r)).git, Some("merge"));
        assert_eq!(classify("Bash", &json!({ "command": "git rebase main" }), Some(&r)).git, None);
    }

    #[test]
    fn commit_push_and_pull_in_the_board_repo_pass_on_their_own() {
        let repo = repo();
        assert_eq!(bash_in("git commit -m x", &repo), "allow");
        assert_eq!(bash_in("git push", &repo), "allow");
        assert_eq!(bash(&format!("git -C {repo} commit -m x")), "allow");
        assert_eq!(bash(&format!("cd {repo} && git push")), "allow");
        assert_eq!(bash_in("git reset --hard", &repo), "protected");
    }

    #[test]
    fn cloud_tooling_reads_pass_the_rest_and_secret_reads_are_protected() {
        assert_eq!(bash("aws ec2 describe-instances --region eu-west-1"), "allow");
        assert_eq!(bash("aws --profile x deploy list-deployments"), "allow");
        assert_eq!(bash("aws s3 cp a s3://b"), "protected");
        assert_eq!(bash("aws secretsmanager get-secret-value --secret-id x"), "protected");
        assert_eq!(bash("aws ssm get-parameters --names x"), "protected");
        assert_eq!(bash("terraform apply"), "protected");
    }

    #[test]
    fn ssh_passes_when_it_only_reads_and_stops_when_it_changes_the_server() {
        assert_eq!(bash(r#"ssh beta "ls -la /var/www""#), "allow");
        assert_eq!(bash(r#"ssh beta "tail -n 100 storage/logs/laravel.log > /tmp/out.txt""#), "allow");
        assert_eq!(bash("ssh -N -L 8000:localhost:8000 mac"), "allow");
        assert_eq!(bash(r#"ssh beta "sudo systemctl restart php-fpm""#), "protected");
        assert_eq!(bash(r#"ssh beta "php artisan migrate --force""#), "protected");
        assert_eq!(bash(r#"ssh beta "echo x > /var/www/.env""#), "protected");
        assert_eq!(bash(r#"ssh beta "php artisan tinker --execute='User::find(1)->delete()'""#), "protected");
        assert_eq!(bash(r#"ssh beta "php artisan tinker --execute='User::count()'""#), "allow");
    }

    #[test]
    fn remote_database_access_passes_for_reads_and_stops_for_writes() {
        assert_eq!(bash(r#"ssh beta "mysql -e 'select count(*) from users'""#), "allow");
        assert_eq!(bash(r#"ssh beta "mysql -e 'delete from users where id = 1'""#), "protected");
        assert_eq!(bash("mysql -h db.example.com -e 'select 1'"), "allow");
        assert_eq!(bash("mysql -h db.example.com -e 'update users set x = 1'"), "protected");
        assert_eq!(bash("mysqldump -h db.example.com app"), "protected");
        assert_eq!(bash("mysql -u root -e 'drop table x'"), "allow");
        std::fs::write(join(&root(), "q.sql"), "UPDATE users SET a = 1;").unwrap();
        assert_eq!(bash(r#"ssh beta "mysql app" < q.sql"#), "protected");
    }

    #[test]
    fn uploads_with_scp_stop_unless_they_go_to_tmp() {
        assert_eq!(bash("scp build.zip beta:/var/www/"), "protected");
        assert_eq!(bash("scp build.zip beta:/tmp/"), "allow");
        assert_eq!(bash("scp beta:/var/log/x.log ./"), "allow");
    }

    #[test]
    fn house_rules_broad_rm_r_taskkill_by_name_and_npm_publish_are_asked() {
        assert_eq!(bash("rm -rf /"), "ask");
        assert_eq!(bash("rm -rf ~"), "ask");
        assert_eq!(bash("rm -rf ."), "ask");
        assert_eq!(bash("rm -rf ./build"), "allow");
        assert_eq!(bash("rm file.txt"), "allow");
        assert_eq!(bash("taskkill /IM node.exe /F"), "ask");
        assert_eq!(bash("taskkill /PID 1234 /F"), "allow");
        assert_eq!(bash(r#"powershell -Command "taskkill /IM claude.exe""#), "ask");
        assert_eq!(bash("npm publish"), "ask");
    }

    #[test]
    fn jira_writes_only_jira_write_start_todo_and_block_pass_every_other_write_is_protected() {
        let repo = repo();
        let free = format!(r#"node "{repo}/bin/jira-write.js" start WEB-1"#);
        for c in ["node scripts/jira-write.js start WEB-1", "node scripts/jira-write.js todo WEB-1", "node scripts/jira-write.js block WEB-1", "node scripts/jira-write.js assign WEB-1", "node scripts/jira-write.js sprint WEB-1", free.as_str(), "cd scripts && node jira-write.js todo WEB-2"] {
            assert_eq!(bash(c), "allow", "{c}");
        }
        for c in [r#"node scripts/jira-write.js comment WEB-1 "hola""#, "node scripts/jira-write.js mention WEB-1 abc 'Ana' 'hola'", "node scripts/jira-write.js edit-comment WEB-1 10 'x'", "node scripts/jira-write.js edit-mention WEB-1 10 abc 'Ana' 'x'", "node scripts/jira-write.js create WEB task.md parent=WEB-1", "node scripts/jira-write.js transition WEB-1 start", "node scripts/jira-write.js review WEB-1", "node /Users/x/palc/scripts/jira-write.js done WEB-1", "node scripts/jira-write.js", "ls && node scripts/jira-write.js comment WEB-1 x"] {
            assert_eq!(bash(c), "protected", "{c}");
        }
        assert_eq!(classify("Bash", &json!({ "command": "node scripts/jira-write.js create WEB task.md" }), None).label.as_deref(), Some("crear una tarea en Jira (WEB)"));
        for c in ["for k in FRON-1 FRON-2; do for c in assign sprint start; do node scripts/jira-write.js $c $k 2>&1 | tail -1; done; done", "for c in assign sprint start; do node scripts/jira-write.js \"$c\" FRON-3; done"] {
            assert_eq!(classify("Bash", &json!({ "command": c }), None).kind, "allow", "{c}");
        }
        for c in ["for c in assign comment; do node scripts/jira-write.js $c FRON-3 x; done", "node scripts/jira-write.js $c FRON-3"] {
            assert_eq!(classify("Bash", &json!({ "command": c }), None).kind, "protected", "{c}");
        }
        assert_eq!(classify("Bash", &json!({ "command": "node scripts/jira-write.js comment WEB-7 hola" }), None).label.as_deref(), Some("comentar en WEB-7 en Jira"));
    }

    #[test]
    fn jira_and_confluence_mcp_writes_are_protected_on_any_server_prefix_reads_pass() {
        let ops = ["addOrEditJiraIssueComment", "addCommentToJiraIssue", "transitionJiraIssue", "createJiraIssue", "editJiraIssue", "executeWrite", "executeDestructive", "createConfluenceContent", "updateConfluenceContent", "createConfluenceFooterComment", "addWorklogToJiraIssue", "createIssueLinkInJira"];
        for server in ["jira", "claude_ai_Atlassian", "atlassian-remote"] {
            for op in ops {
                assert_eq!(kind(&format!("mcp__{server}__{op}"), json!({})), "protected", "{server} {op}");
            }
        }
        for op in ["getJiraIssue", "searchJiraIssuesUsingJql", "searchConfluence", "getConfluenceContent", "executeRead", "discover", "listJiraIssueComments", "atlassianUserInfo", "getAccessibleAtlassianResources", "lookupJiraAccountId", "search", "getJiraIssueRemoteIssueLinks"] {
            assert_eq!(kind(&format!("mcp__jira__{op}"), json!({})), "allow", "{op}");
        }
        let t = classify("mcp__jira__transitionJiraIssue", &json!({ "issueIdOrKey": "WEB-3", "transition": { "id": "31" } }), None);
        assert!(Regex::new("WEB-3.*31").unwrap().is_match(t.label.as_deref().unwrap()));
        assert_eq!(kind("mcp__jira__transitionJiraIssue", json!({ "issueIdOrKey": "WEB-3", "transition": { "id": "51" } })), "protected");
        assert!(classify("mcp__jira__executeDestructive", &json!({ "name": "deleteJiraIssue" }), None).label.unwrap().contains("deleteJiraIssue"));
    }

    #[test]
    fn jira_writes_straight_to_the_rest_api_are_protected_reads_pass() {
        assert_eq!(bash("curl -s -X POST -H 'Content-Type: application/json' https://acme.atlassian.net/rest/api/3/issue/WEB-1/comment -d '{}'"), "protected");
        assert_eq!(bash("curl -s --request PUT https://acme.atlassian.net/rest/api/3/issue/WEB-1"), "protected");
        assert_eq!(bash("curl -s https://acme.atlassian.net/rest/api/3/issue/WEB-1"), "allow");
        assert_eq!(bash("curl -s -X POST https://example.com/hook -d x"), "allow");
        assert_eq!(bash(r#"powershell -Command "Invoke-RestMethod -Method Post -Uri https://acme.atlassian.net/rest/api/3/issue""#), "protected");
    }

    #[test]
    fn pretending_to_be_another_session_through_claude_code_session_id_is_protected() {
        for c in ["CLAUDE_CODE_SESSION_ID=abc node scripts/board.js approve-chat WEB-1 pay", "export CLAUDE_CODE_SESSION_ID=abc; node scripts/board.js hold add --reason x", "env CLAUDE_CODE_SESSION_ID=abc node scripts/board.js tidy-start t1", r#"powershell -Command "$env:CLAUDE_CODE_SESSION_ID = 'abc'""#] {
            assert_eq!(bash(c), "protected", "{c}");
        }
        assert_eq!(bash("echo $CLAUDE_CODE_SESSION_ID"), "allow");
        assert_eq!(bash("node scripts/board.js approve-chat WEB-1 pay"), "allow");
    }

    #[test]
    fn only_the_dev_login_code_line_of_super_app_env_can_be_read_without_asking() {
        for c in ["grep '^DEV_LOGIN_CODE=' /Users/a/palc/super-app/.env", r#"grep "^DEV_LOGIN_CODE=" super-app/.env"#, "grep ^DEV_LOGIN_CODE= ~/workspace/palc/super-app/.env", "grep -E '^DEV_LOGIN_CODE=' super-app/.env", "grep -m1 '^DEV_LOGIN_CODE=' ./super-app/.env", "grep -E -m 1 '^DEV_LOGIN_CODE=' '/Users/a/palc/super-app/.env'"] {
            assert_eq!(bash(c), "allow", "{c}");
        }
        for c in ["grep '^DEV_LOGIN_CODE=' super-app/.env | cat", "grep '^DEV_LOGIN_CODE=' super-app/.env; cat super-app/.env", "grep '^DEV_LOGIN_CODE=' super-app/.env && cat .env", "grep '^DEV_LOGIN_CODE=' super-app/.env.production", "grep '^DEV_LOGIN_CODE=' backoffice/.env", "grep '^DB_PASSWORD=' super-app/.env", "grep 'DEV_LOGIN_CODE' super-app/.env", "grep '^DEV_LOGIN_CODE=.*' super-app/.env", "grep -A3 '^DEV_LOGIN_CODE=' super-app/.env", "grep -v '^DEV_LOGIN_CODE=' super-app/.env", "grep '^DEV_LOGIN_CODE=' super-app/.env super-app/.env.local", r#"grep '^DEV_LOGIN_CODE=" super-app/.env"#, "cat super-app/.env", "grep '^DEV_LOGIN_CODE=' super-app/.env > /tmp/x"] {
            assert_eq!(bash(c), "ask", "{c}");
        }
        let env = join(&join(&root(), "super-app"), ".env");
        assert_eq!(kind("Grep", json!({ "pattern": "^DEV_LOGIN_CODE=", "path": env, "output_mode": "content" })), "allow");
        assert_eq!(kind("Grep", json!({ "pattern": "^DEV_LOGIN_CODE=", "path": env, "output_mode": "content", "-A": 2 })), "ask");
        assert_eq!(kind("Grep", json!({ "pattern": "^DB_PASSWORD=", "path": env, "output_mode": "content" })), "ask");
        assert_eq!(kind("Grep", json!({ "pattern": "^DEV_LOGIN_CODE=", "path": join(&join(&root(), "backoffice"), ".env") })), "ask");
        assert_eq!(kind("Read", json!({ "file_path": env })), "ask");
    }

    #[test]
    fn other_tools_sentry_updates_protected_artifacts_publishing_asked_the_rest_allowed() {
        assert_eq!(kind("mcp__sentry__update_issue", json!({})), "protected");
        assert_eq!(kind("mcp__sentry__search_issues", json!({})), "allow");
        assert_eq!(kind("Artifact", json!({ "action": "publish" })), "ask");
        assert_eq!(kind("Artifact", json!({})), "ask");
        assert_eq!(kind("Artifact", json!({ "action": "read" })), "allow");
        assert_eq!(kind("mcp__playwright__browser_click", json!({})), "allow");
        assert_eq!(kind("SomeFutureTool", json!({})), "allow");
        assert_eq!(kind("Bash", json!({})), "allow");
    }

    #[test]
    fn segments_splits_on_shell_operators_but_not_inside_quotes() {
        assert_eq!(segments("a && b || c; d | e"), vec!["a", "b", "c", "d", "e"]);
        assert_eq!(segments(r#"echo "a && b"; ls"#), vec![r#"echo "a && b""#, "ls"]);
        assert_eq!(segments("echo $(git push)"), vec!["echo", "git push"]);
        assert_eq!(segments("cat <<'EOF' > x\nhello && bye\nEOF\nls"), vec!["cat <<EOF > x", "ls"]);
    }

    fn write_routes(v: Value) {
        std::fs::write(crate::testkit::sandbox().data.join("sessions.json"), json::stringify(&v)).unwrap();
    }

    fn permission(id: &str) -> Value {
        load()["permissions"].as_array().unwrap().iter().find(|x| x["id"] == id).cloned().unwrap()
    }

    #[test]
    fn check_protected_actions_pass_with_a_recent_deployment_order_for_that_session() {
        let _g = crate::testkit::fresh();
        let conversation = "11111111-2222-4333-8444-555555555555";
        write_routes(json!({ "areas": { "wallet": { "title": "Wallet", "conversation": conversation } } }));
        let input = json!({ "session_id": conversation, "tool_name": "Bash", "tool_input": { "command": "git push" }, "cwd": root() });
        mutate(|d| {
            d.insert("deployments".into(), json!([{ "id": "dep-1", "area": "wallet", "status": "sent", "at": now(), "sentAt": now() }]));
        });
        assert_eq!(check(&input), json!({ "decision": "allow" }));
        mutate(|d| {
            d.insert("deployments".into(), json!([{ "id": "dep-1", "area": "wallet", "status": "sent", "at": "2020-01-01T00:00:00.000Z", "sentAt": "2020-01-01T00:00:00.000Z" }]));
        });
        let r = check(&input);
        assert_eq!(r["decision"], "wait");
        let id = r["id"].as_str().unwrap().to_string();
        let p = permission(&id);
        assert_eq!(p["status"], "pending");
        assert_eq!(p["area"], "wallet");
        assert_eq!(p["protected"], true);
        assert_eq!(poll(&id), json!({ "status": "pending", "reason": null }));
        assert!(decide(&id, "always", Some("ok")));
        assert_eq!(load().get("permissionRules"), None);
        assert_eq!(poll(&id)["status"], "allowed");
    }

    #[test]
    fn check_an_always_answer_to_an_asked_action_becomes_a_rule() {
        let _g = crate::testkit::fresh();
        write_routes(json!({ "areas": { "wallet": { "title": "Wallet", "conversation": "11111111-2222-4333-8444-555555555555" } } }));
        let input = json!({ "session_id": "11111111-2222-4333-8444-555555555555", "tool_name": "Bash", "tool_input": { "command": "npm publish" }, "cwd": root() });
        let r = check(&input);
        assert_eq!(r["decision"], "wait");
        assert!(decide(r["id"].as_str().unwrap(), "always", None));
        assert_eq!(load()["permissionRules"].as_array().unwrap().iter().map(|x| x["key"].clone()).collect::<Vec<_>>(), vec![json!("npm publish")]);
        assert_eq!(check(&input), json!({ "decision": "allow" }));
        assert!(remove_rule("npm publish"));
        assert_eq!(check(&input)["decision"], "wait");
    }

    #[test]
    fn check_a_denied_request_reports_denied_with_its_reason() {
        let _g = crate::testkit::fresh();
        write_routes(json!({ "areas": { "wallet": { "title": "Wallet", "conversation": "x" } } }));
        let r = check(&json!({ "session_id": "x", "tool_name": "Bash", "tool_input": { "command": "terraform destroy" }, "cwd": root() }));
        assert_eq!(r["decision"], "wait");
        let id = r["id"].as_str().unwrap().to_string();
        assert!(decide(&id, "deny", Some("no")));
        assert_eq!(poll(&id), json!({ "status": "denied", "reason": "no" }));
        assert!(!decide(&id, "allow", None));
        assert_eq!(poll("perm-missing"), json!({ "status": "missing" }));
    }

    #[test]
    fn a_native_prompt_is_kept_once_and_cleared_when_answered_in_the_session() {
        let _g = crate::testkit::fresh();
        write_routes(json!({ "areas": { "wallet": { "title": "Wallet", "conversation": "c1" } } }));
        let first = native_prompt(&json!({ "conversation": "c1", "name": "Wallet", "question": "Do you want to proceed?", "text": "Bash command" })).unwrap();
        let second = native_prompt(&json!({ "conversation": "c1", "question": "Do you want to proceed?", "text": "x" })).unwrap();
        assert_eq!(permission(&first)["status"], "answered");
        let p = permission(&second);
        assert_eq!(p["label"], "Claude Code pregunta: Do you want to proceed?");
        assert_eq!(p["areaName"], "Wallet");
        assert_eq!(native_prompt(&json!({ "conversation": "c1", "cleared": true })), None);
        assert_eq!(permission(&second)["reason"], "Contestada en la propia sesión");
        assert_eq!(for_page(&load())["pending"], json!([]));
    }

    #[test]
    fn moving_a_ticket_to_in_progress_or_assigning_it_to_me_passes_without_asking() {
        assert_eq!(kind("mcp__jira__transitionJiraIssue", json!({ "issueIdOrKey": "WEB-3", "transitionName": "In Progress" })), "allow");
        assert_eq!(kind("mcp__jira__transitionJiraIssue", json!({ "issueIdOrKey": "WEB-3", "transitionName": "Done" })), "protected");
        assert_eq!(kind("mcp__jira__editJiraIssue", json!({ "issueIdOrKey": "WEB-3", "fields": { "assignee": { "accountId": "me" } } })), "allow");
        assert_eq!(kind("mcp__jira__editJiraIssue", json!({ "issueIdOrKey": "WEB-3", "fields": { "assignee": { "accountId": "rev" } } })), "protected");
        assert_eq!(kind("mcp__jira__editJiraIssue", json!({ "issueIdOrKey": "WEB-3", "fields": { "assignee": { "accountId": "me" }, "summary": "x" } })), "protected");
    }
}

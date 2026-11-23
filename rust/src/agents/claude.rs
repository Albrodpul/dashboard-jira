use crate::agents::index::Agent;
use regex::Regex;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

pub const ID: &str = "claude";
pub const NAME: &str = "Claude Code";
pub static ENV_VARIABLES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(CLAUDE_CODE_|CLAUDECODE|CLAUDE_PID|CLAUDE_ENV_FILE|CLAUDE_AGENT_SDK|CLAUDE_EFFORT|AI_AGENT|ELECTRON_RUN_AS_NODE)").unwrap());
pub const TOKEN_VARIABLE: &str = "CLAUDE_CODE_OAUTH_TOKEN";
pub const WAKE_MODEL: &str = "claude-haiku-4-5-20251001";

fn json_number(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Some(Value::Bool(b)) => {
            if *b { 1.0 } else { 0.0 }
        }
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

fn text(options: &Value, key: &str) -> String {
    match options.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => crate::core::json::stringify(other),
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x))).collect()).unwrap_or_default()
}

pub fn home() -> PathBuf {
    crate::core::platform::home_dir().join(".claude")
}

pub fn sessions_dir() -> PathBuf {
    home().join("sessions")
}

pub fn transcripts_dir() -> PathBuf {
    home().join("projects")
}

pub fn credentials_file() -> PathBuf {
    home().join(".credentials.json")
}

pub fn cli() -> String {
    match std::env::var("CLAUDE_BIN") {
        Ok(b) if !b.is_empty() => b,
        _ => crate::core::platform::home_dir().join(".local").join("bin").join(format!("claude{}", crate::core::platform::EXE)).to_string_lossy().to_string(),
    }
}

static JS_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.[cm]?js$").unwrap());

pub fn command(args: &[String], fallback: Option<&str>) -> (String, Vec<String>) {
    let bin = std::env::var("CLAUDE_BIN").ok().filter(|b| !b.is_empty());
    if let Some(b) = &bin {
        if JS_FILE.is_match(b) {
            let mut all = vec![b.clone()];
            all.extend(args.iter().cloned());
            return ("node".to_string(), all);
        }
    }
    let exe = bin.or_else(|| fallback.filter(|f| !f.is_empty()).map(str::to_string)).unwrap_or_else(cli);
    (exe, args.to_vec())
}

static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+").unwrap());

pub fn editor_binary() -> Option<String> {
    let folder = crate::core::platform::home_dir().join(".vscode").join("extensions");
    let mut dirs: Vec<String> = std::fs::read_dir(&folder).ok()?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|d| d.starts_with("anthropic.claude-code-")).collect();
    let version = |d: &str| -> Vec<u64> { DIGITS.find_iter(d).take(3).map(|m| m.as_str().parse().unwrap_or(0)).collect() };
    dirs.sort_by(|a, b| {
        let (x, y) = (version(a), version(b));
        for i in 0..3 {
            let (xi, yi) = (x.get(i).copied().unwrap_or(0), y.get(i).copied().unwrap_or(0));
            if xi != yi {
                return yi.cmp(&xi);
            }
        }
        std::cmp::Ordering::Equal
    });
    for d in dirs {
        let exe = folder.join(&d).join("resources").join("native-binary").join(format!("claude{}", crate::core::platform::EXE));
        if exe.exists() {
            return Some(exe.to_string_lossy().to_string());
        }
    }
    None
}

pub fn hosted_args(options: &Value) -> Vec<String> {
    let conversation = text(options, "conversation");
    let mut out = if crate::core::json::truthy(options.get("fresh")) { vec!["--session-id".to_string(), conversation] } else { vec!["--resume".to_string(), conversation] };
    out.extend(["-n".to_string(), text(options, "name"), "--permission-mode".to_string(), text(options, "permissionMode")]);
    out.extend(strings(options.get("profile")));
    out
}

pub fn create_args(options: &Value) -> Vec<String> {
    vec!["-p".into(), "--session-id".into(), text(options, "id"), "--name".into(), text(options, "name"), "--model".into(), text(options, "model"), text(options, "prompt")]
}

pub fn wake_args(prompt: &str) -> Vec<String> {
    vec!["-p".into(), prompt.into(), "--no-session-persistence".into(), "--model".into(), WAKE_MODEL.into(), "--allowedTools=SendMessage,ListAgents,ToolSearch".into()]
}

pub fn one_shot_args(options: &Value) -> Vec<String> {
    vec!["-p".into(), text(options, "prompt"), "--no-session-persistence".into(), "--model".into(), text(options, "model"), format!("--allowedTools={}", text(options, "tools"))]
}

static HOSTED_BIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.local[\\/]bin[\\/]claude(\.exe)?\b").unwrap());

pub fn is_hosted_command_line(line: &str) -> bool {
    HOSTED_BIN.is_match(line) && line.contains("--resume")
}

pub fn editor_url(conversation: Option<&str>) -> String {
    match conversation.filter(|c| !c.is_empty()) {
        Some(c) => format!("vscode://anthropic.claude-code/open?session={c}"),
        None => "vscode://anthropic.claude-code/open".to_string(),
    }
}

pub fn transcript_folder(root: &str) -> String {
    let mut s: Vec<char> = root.replace('\\', "/").chars().collect();
    if s.len() >= 2 && s[0].is_ascii_uppercase() && s[1] == ':' {
        s[0] = s[0].to_ascii_lowercase();
    }
    s.into_iter().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub fn folder_of_conversation(id: &str) -> Option<String> {
    let dir = transcripts_dir();
    for e in std::fs::read_dir(&dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if dir.join(&name).join(format!("{id}.jsonl")).exists() {
            return Some(name);
        }
    }
    None
}

static SESSION_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.json$").unwrap());

pub fn live_entries() -> Option<Vec<Value>> {
    let dir = sessions_dir();
    let files: Vec<String> = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| SESSION_FILE.is_match(f)).collect();
    let mut out = Vec::new();
    for f in files {
        let Some(j) = std::fs::read_to_string(dir.join(&f)).ok().and_then(|t| crate::core::json::parse(&t)) else { continue };
        if j.get("kind").and_then(Value::as_str) != Some("interactive") || !crate::core::json::truthy(j.get("name")) || !crate::core::json::truthy(j.get("sessionId")) {
            continue;
        }
        let mut e = serde_json::Map::new();
        e.insert("name".into(), j["name"].clone());
        e.insert("conversation".into(), j["sessionId"].clone());
        if let Some(cwd) = j.get("cwd") {
            e.insert("cwd".into(), cwd.clone());
        }
        if let Some(pid) = j.get("pid") {
            e.insert("pid".into(), pid.clone());
        }
        e.insert("startedMs".into(), crate::core::json::num(json_number(j.get("startedAt"))));
        if let Some(status) = j.get("status") {
            e.insert("status".into(), status.clone());
        }
        e.insert("background".into(), Value::Bool(j.get("status").and_then(Value::as_str) == Some("shell")));
        let since = if crate::core::json::truthy(j.get("statusUpdatedAt")) { crate::core::json::num(json_number(j.get("statusUpdatedAt"))) } else { Value::Null };
        e.insert("statusSinceMs".into(), since);
        out.push(Value::Object(e));
    }
    Some(out)
}

pub struct Claude;

impl Agent for Claude {
    fn id(&self) -> &'static str {
        ID
    }
    fn name(&self) -> &'static str {
        NAME
    }
    fn home(&self) -> PathBuf {
        home()
    }
    fn sessions_dir(&self) -> PathBuf {
        sessions_dir()
    }
    fn transcripts_dir(&self) -> PathBuf {
        transcripts_dir()
    }
    fn credentials_file(&self) -> PathBuf {
        credentials_file()
    }
    fn transcript_folder(&self, root: &str) -> String {
        transcript_folder(root)
    }
    fn env_variables(&self) -> &'static Regex {
        &ENV_VARIABLES
    }
    fn token_variable(&self) -> &'static str {
        TOKEN_VARIABLE
    }
    fn cli(&self) -> String {
        cli()
    }
    fn command(&self, args: &[String], fallback: Option<&str>) -> (String, Vec<String>) {
        command(args, fallback)
    }
    fn editor_binary(&self) -> Option<String> {
        editor_binary()
    }
    fn hosted_args(&self, options: &Value) -> Vec<String> {
        hosted_args(options)
    }
    fn create_args(&self, options: &Value) -> Vec<String> {
        create_args(options)
    }
    fn wake_args(&self, prompt: &str) -> Vec<String> {
        wake_args(prompt)
    }
    fn one_shot_args(&self, options: &Value) -> Vec<String> {
        one_shot_args(options)
    }
    fn is_hosted_command_line(&self, line: &str) -> bool {
        is_hosted_command_line(line)
    }
    fn editor_url(&self, conversation: Option<&str>) -> String {
        editor_url(conversation)
    }
    fn folder_of_conversation(&self, id: &str) -> Option<String> {
        folder_of_conversation(id)
    }
    fn live_entries(&self) -> Option<Vec<Value>> {
        live_entries()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_claude_adapter_builds_the_same_commands_the_board_used_before() {
        let sb = crate::testkit::sandbox();
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(hosted_args(&json!({ "conversation": "c1", "fresh": false, "name": "Pagos", "permissionMode": "acceptEdits", "profile": ["--model", "x"] })), v(&["--resume", "c1", "-n", "Pagos", "--permission-mode", "acceptEdits", "--model", "x"]));
        assert_eq!(hosted_args(&json!({ "conversation": "c1", "fresh": true, "name": "Pagos", "permissionMode": "acceptEdits" })), v(&["--session-id", "c1", "-n", "Pagos", "--permission-mode", "acceptEdits"]));
        assert_eq!(create_args(&json!({ "id": "i", "name": "n", "model": "m", "prompt": "p" })), v(&["-p", "--session-id", "i", "--name", "n", "--model", "m", "p"]));
        assert_eq!(wake_args("hola"), v(&["-p", "hola", "--no-session-persistence", "--model", "claude-haiku-4-5-20251001", "--allowedTools=SendMessage,ListAgents,ToolSearch"]));
        assert_eq!(one_shot_args(&json!({ "prompt": "p", "model": "m" })), v(&["-p", "p", "--no-session-persistence", "--model", "m", "--allowedTools="]));
        assert_eq!(editor_url(Some("abc")), "vscode://anthropic.claude-code/open?session=abc");
        assert_eq!(editor_url(None), "vscode://anthropic.claude-code/open");
        assert_eq!(transcript_folder("C:/work/myproject"), "c--work-myproject");
        assert_eq!(transcript_folder("/Users/a/workspace/myproject"), "-Users-a-workspace-myproject");
        assert!(is_hosted_command_line("/Users/a/.local/bin/claude --resume x"));
        assert!(!is_hosted_command_line("/Applications/Code.app/claude --resume x"));
        assert_eq!(sessions_dir(), sb.home.join(".claude").join("sessions"));
        assert!(ENV_VARIABLES.is_match("CLAUDE_CODE_ENTRYPOINT") && !ENV_VARIABLES.is_match("PATH"));
    }
}

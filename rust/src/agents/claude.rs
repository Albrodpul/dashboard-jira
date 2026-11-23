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

pub fn home() -> PathBuf {
    todo!()
}

pub fn sessions_dir() -> PathBuf {
    todo!()
}

pub fn transcripts_dir() -> PathBuf {
    todo!()
}

pub fn credentials_file() -> PathBuf {
    todo!()
}

pub fn cli() -> String {
    todo!()
}

pub fn command(args: &[String], fallback: Option<&str>) -> (String, Vec<String>) {
    todo!()
}

pub fn editor_binary() -> Option<String> {
    todo!()
}

pub fn hosted_args(options: &Value) -> Vec<String> {
    todo!()
}

pub fn create_args(options: &Value) -> Vec<String> {
    todo!()
}

pub fn wake_args(prompt: &str) -> Vec<String> {
    todo!()
}

pub fn one_shot_args(options: &Value) -> Vec<String> {
    todo!()
}

pub fn is_hosted_command_line(line: &str) -> bool {
    todo!()
}

pub fn editor_url(conversation: Option<&str>) -> String {
    todo!()
}

pub fn transcript_folder(root: &str) -> String {
    todo!()
}

pub fn folder_of_conversation(id: &str) -> Option<String> {
    todo!()
}

pub fn live_entries() -> Option<Vec<Value>> {
    todo!()
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

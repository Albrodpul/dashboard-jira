use crate::core::config::Project;
use regex::Regex;
use serde_json::Value;
use std::path::PathBuf;

pub use crate::agents::claude;

pub trait Agent: Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn home(&self) -> PathBuf;
    fn sessions_dir(&self) -> PathBuf;
    fn transcripts_dir(&self) -> PathBuf;
    fn credentials_file(&self) -> PathBuf;
    fn transcript_folder(&self, root: &str) -> String;
    fn env_variables(&self) -> &'static Regex;
    fn token_variable(&self) -> &'static str;
    fn cli(&self) -> String;
    fn command(&self, args: &[String], fallback: Option<&str>) -> (String, Vec<String>);
    fn editor_binary(&self) -> Option<String>;
    fn hosted_args(&self, options: &Value) -> Vec<String>;
    fn create_args(&self, options: &Value) -> Vec<String>;
    fn wake_args(&self, prompt: &str) -> Vec<String>;
    fn one_shot_args(&self, options: &Value) -> Vec<String>;
    fn is_hosted_command_line(&self, line: &str) -> bool;
    fn editor_url(&self, conversation: Option<&str>) -> String;
    fn folder_of_conversation(&self, id: &str) -> Option<String>;
    fn live_entries(&self) -> Option<Vec<Value>>;
}

pub static AGENTS: [(&str, &dyn Agent); 1] = [("claude", &claude::Claude)];

pub fn agent_for(project: Option<&Project>) -> &'static dyn Agent {
    let id = project.map(|p| p.agent.as_str()).unwrap_or("");
    AGENTS.iter().find(|(k, _)| *k == id).map(|(_, a)| *a).unwrap_or(&claude::Claude)
}

pub fn for_project(id: &str) -> &'static dyn Agent {
    agent_for(crate::core::config::project(id).as_ref())
}

pub fn main() -> &'static dyn Agent {
    agent_for(Some(crate::core::config::main_project()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_project_uses_claude_code_unless_it_says_otherwise() {
        crate::testkit::sandbox();
        assert_eq!(main().id(), "claude");
        let mut p = crate::core::config::main_project().clone();
        p.agent = "nope".into();
        assert_eq!(agent_for(Some(&p)).id(), "claude");
    }
}

use std::io::Write;
use tower::commands::args::Args;
use tower::{cli, tools};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let tool_args = argv.get(1..).unwrap_or(&[]);
    let code = match argv.first().map(String::as_str) {
        Some("hook") => tools::permission_hook::run(tool_args),
        Some("routes") => tools::sessions::run(tool_args),
        Some("jira-window") => tools::jira_window::run(tool_args),
        Some("jira-write") => tools::jira_write::run(tool_args),
        _ => cli::run(&Args::from_env()),
    };
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(code);
}

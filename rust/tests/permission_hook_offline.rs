use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

fn hook(tool_name: &str, tool_input: Value) -> Option<Value> {
    let sb = tower::testkit::sandbox();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tower"))
        .arg("hook")
        .env("TOWER_PORT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let event = json!({ "session_id": "abcdef123456", "tool_name": tool_name, "tool_input": tool_input, "cwd": sb.root.to_string_lossy() });
    child.stdin.take().unwrap().write_all(event.to_string().as_bytes()).unwrap();
    let r = child.wait_with_output().unwrap();
    assert_eq!(r.status.code(), Some(0), "{}", String::from_utf8_lossy(&r.stderr));
    let out = String::from_utf8_lossy(&r.stdout).to_string();
    if out.is_empty() { None } else { Some(serde_json::from_str::<Value>(&out).unwrap()["hookSpecificOutput"].clone()) }
}

#[test]
fn with_the_board_down_protected_and_asked_actions_fall_back_to_claude_codes_own_prompt() {
    for (tool, input) in [
        ("Bash", json!({ "command": "git push" })),
        ("Bash", json!({ "command": "cat .env" })),
        ("Bash", json!({ "command": "node scripts/jira-write.js comment WEB-1 hola" })),
        ("mcp__jira__addOrEditJiraIssueComment", json!({ "issueIdOrKey": "WEB-1" })),
        ("mcp__jira__transitionJiraIssue", json!({ "issueIdOrKey": "WEB-1", "transition": { "id": "31" } })),
        ("Artifact", json!({ "action": "publish" })),
    ] {
        let out = hook(tool, input.clone()).unwrap_or_else(|| panic!("{tool} {input}"));
        assert_eq!(out["permissionDecision"], "ask", "{tool} {input}");
        assert!(out["permissionDecisionReason"].as_str().unwrap().contains("El tablero no responde"));
    }
}

#[test]
fn with_the_board_down_unprotected_actions_still_step_aside() {
    let sb = tower::testkit::sandbox();
    assert_eq!(hook("Bash", json!({ "command": "ls -la" })), None);
    assert_eq!(hook("Bash", json!({ "command": "node scripts/jira-write.js start WEB-1" })), None);
    assert_eq!(hook("Read", json!({ "file_path": sb.root.join("a.js").to_string_lossy() })), None);
    assert_eq!(hook("mcp__jira__getJiraIssue", json!({ "issueIdOrKey": "WEB-1" })), None);
}

#[test]
fn input_that_is_not_json_steps_aside_silently() {
    tower::testkit::sandbox();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tower")).arg("hook").env("TOWER_PORT", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"not json").unwrap();
    let r = child.wait_with_output().unwrap();
    assert_eq!(r.status.code(), Some(0));
    assert!(r.stdout.is_empty());
}

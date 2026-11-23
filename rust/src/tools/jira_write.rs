//! Port of bin/jira-write.js.
use crate::commands::args::{slice_chars, text};
use crate::core::config::Project;
use crate::core::json::{stringify, truthy};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

static NESTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{2,}-\s+(.*)$").unwrap());
static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-\s+(.*)$").unwrap());
static ORDERED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.\s+(.*)$").unwrap());
static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`]+`").unwrap());

struct Writer {
    project: Project,
    base: String,
    agile: String,
    auth: String,
}

struct Reply {
    status: u16,
    body: String,
}

fn request(method: &str, url: &str, auth: &str, body: Option<&Value>, json_content: bool) -> Result<Reply, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let result = match (method, body) {
        ("GET", _) => agent.get(url).header("Authorization", auth).header("Accept", "application/json").call(),
        ("PUT", Some(b)) => agent.put(url).header("Authorization", auth).header("Content-Type", "application/json").header("Accept", "application/json").send(stringify(b)),
        (_, Some(b)) => {
            let r = agent.post(url).header("Authorization", auth).header("Content-Type", "application/json");
            let r = if json_content { r.header("Accept", "application/json") } else { r };
            r.send(stringify(b))
        }
        (_, None) => agent.post(url).header("Authorization", auth).header("Accept", "application/json").send_empty(),
    };
    let mut response = result.map_err(|_| "fetch failed".to_string())?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().unwrap_or_default();
    Ok(Reply { status, body })
}

impl Writer {
    fn call(&self, method: &str, url: &str, body: Option<&Value>) -> Result<(), String> {
        let r = request(method, &format!("{}{url}", self.base), &self.auth, body, true)?;
        println!("{method} {url} {} {}", r.status, slice_chars(&r.body, 200));
        Ok(())
    }

    fn get(&self, url: &str) -> Result<Value, String> {
        let r = request("GET", &format!("{}{url}", self.agile), &self.auth, None, true)?;
        if !(200..300).contains(&r.status) {
            return Err(format!("GET {url} {} {}", r.status, slice_chars(&r.body, 200)));
        }
        serde_json::from_str(&r.body).map_err(|e| e.to_string())
    }

    fn move_to_active_sprint(&self, key: &str) -> Result<i32, String> {
        let issue = self.get(&format!("/issue/{key}?fields=sprint"))?;
        let sprint = issue.get("fields").and_then(|f| f.get("sprint")).filter(|s| truthy(Some(s)));
        if sprint.and_then(|s| s.get("state")).and_then(Value::as_str) == Some("active") {
            println!("{key} ya está en el sprint activo {}", text(sprint.and_then(|s| s.get("name"))));
            return Ok(0);
        }
        let prefix = key.split('-').next().unwrap_or("");
        let boards = self.get(&format!("/board?projectKeyOrId={prefix}&type=scrum"))?;
        for board in boards.get("values").and_then(Value::as_array).cloned().unwrap_or_default() {
            let sprints = self.get(&format!("/board/{}/sprint?state=active", text(board.get("id"))))?;
            let Some(sprint) = sprints.get("values").and_then(|v| v.get(0)).filter(|s| truthy(Some(s))) else { continue };
            let r = request("POST", &format!("{}/sprint/{}/issue", self.agile, text(sprint.get("id"))), &self.auth, Some(&json!({ "issues": [key] })), false)?;
            println!("{key} → {} {} {}", text(sprint.get("name")), r.status, slice_chars(&r.body, 200));
            return Ok(0);
        }
        eprintln!("No hay sprint activo en ningún tablero de {prefix}");
        Ok(1)
    }

    fn create(&self, project_key: &str, file: &str, options: &[String]) -> Result<i32, String> {
        let mut settings: Map<String, Value> = Map::new();
        for option in options {
            let mut parts = option.split('=');
            let k = parts.next().unwrap_or("").to_string();
            settings.insert(k, parts.next().map(Value::from).unwrap_or(Value::Null));
        }
        let setting = |k: &str| settings.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
        let issue = issue_from_markdown(&std::fs::read_to_string(file).map_err(|e| e.to_string())?);
        let issue_type = setting("type").or_else(|| self.project.jira.as_ref().and_then(|j| j.default_issue_type.clone()).filter(|t| !t.is_empty())).unwrap_or_else(|| "Historia".into());
        let mut fields = json!({
            "project": { "key": project_key },
            "issuetype": { "name": issue_type },
            "summary": issue["summary"],
            "description": issue["description"],
            "priority": { "name": setting("priority").unwrap_or_else(|| "Medium".into()) },
        });
        if let Some(parent) = setting("parent") {
            fields["parent"] = json!({ "key": parent });
        }
        if let Some(labels) = setting("labels") {
            fields["labels"] = Value::Array(labels.split(',').map(Value::from).collect());
        }
        let r = request("POST", &format!("{}/issue", self.base), &self.auth, Some(&json!({ "fields": fields })), true)?;
        let created: Value = serde_json::from_str(&r.body).map_err(|e| e.to_string())?;
        let key = created.get("key").filter(|k| truthy(Some(k))).map(|k| text(Some(k)));
        println!("create {} {}", r.status, key.clone().unwrap_or_else(|| slice_chars(&stringify(&created), 400)));
        let Some(key) = key else { return Ok(1) };
        if let Some(blocks) = setting("blocks") {
            self.call("POST", "/issueLink", Some(&json!({ "type": { "name": "Blocks" }, "outwardIssue": { "key": blocks }, "inwardIssue": { "key": key } })))?;
        }
        if setting("sprint").as_deref() != Some("no") {
            return self.move_to_active_sprint(&key);
        }
        Ok(0)
    }
}

fn doc(text: &str, mention: Option<(&str, &str)>) -> Value {
    let content: Vec<Value> = text
        .split("||")
        .enumerate()
        .map(|(index, line)| {
            let inner = match mention {
                Some((id, name)) if index == 0 => json!([{ "type": "mention", "attrs": { "id": id, "text": format!("@{name}") } }, { "type": "text", "text": format!(" {line}") }]),
                _ => json!([{ "type": "text", "text": line }]),
            };
            json!({ "type": "paragraph", "content": inner })
        })
        .collect();
    json!({ "type": "doc", "version": 1, "content": content })
}

fn inline(text: &str) -> Value {
    let mut parts: Vec<Value> = Vec::new();
    let mut last = 0;
    let push_text = |parts: &mut Vec<Value>, s: &str| {
        if !s.is_empty() {
            parts.push(json!({ "type": "text", "text": s }));
        }
    };
    for m in CODE.find_iter(text) {
        push_text(&mut parts, &text[last..m.start()]);
        let code = m.as_str();
        parts.push(json!({ "type": "text", "text": &code[1..code.len() - 1], "marks": [{ "type": "code" }] }));
        last = m.end();
    }
    push_text(&mut parts, &text[last..]);
    Value::Array(parts)
}

fn item(text: &str) -> Value {
    json!({ "type": "listItem", "content": [{ "type": "paragraph", "content": inline(text) }] })
}

fn issue_from_markdown(source: &str) -> Value {
    let mut lines: Vec<&str> = source.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let first = if lines.is_empty() { "" } else { lines.remove(0) };
    let summary = Regex::new(r"^#\s*").unwrap().replace(first, "").trim().to_string();
    let mut content: Vec<Value> = Vec::new();
    let mut list: Option<usize> = None;
    for line in lines {
        let nested = NESTED.captures(line);
        let bullet = BULLET.captures(line);
        let ordered = ORDERED.captures(line);
        if let (Some(n), Some(i)) = (&nested, list) {
            let items = content[i]["content"].as_array_mut().unwrap();
            let parent = items.last_mut().unwrap();
            let parent_content = parent["content"].as_array_mut().unwrap();
            let position = parent_content.iter().position(|node| node.get("type").and_then(Value::as_str) == Some("bulletList"));
            let position = match position {
                Some(p) => p,
                None => {
                    parent_content.push(json!({ "type": "bulletList", "content": [] }));
                    parent_content.len() - 1
                }
            };
            parent_content[position]["content"].as_array_mut().unwrap().push(item(&n[1]));
        } else if bullet.is_some() || ordered.is_some() {
            let kind = if bullet.is_some() { "bulletList" } else { "orderedList" };
            let captured = bullet.as_ref().or(ordered.as_ref()).unwrap()[1].to_string();
            let same = list.is_some_and(|i| content[i].get("type").and_then(Value::as_str) == Some(kind));
            if !same {
                content.push(json!({ "type": kind, "content": [] }));
                list = Some(content.len() - 1);
            }
            content[list.unwrap()]["content"].as_array_mut().unwrap().push(item(&captured));
        } else {
            list = None;
            if let Some(heading) = line.strip_prefix("## ") {
                content.push(json!({ "type": "heading", "attrs": { "level": 3 }, "content": inline(heading.trim()) }));
            } else if !line.trim().is_empty() {
                content.push(json!({ "type": "paragraph", "content": inline(line.trim()) }));
            }
        }
    }
    json!({ "summary": summary, "description": { "type": "doc", "version": 1, "content": content } })
}

fn main_flow(args: &[String]) -> Result<i32, String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    let key = args.get(1).map(String::as_str).unwrap_or("");
    let rest: Vec<String> = args.iter().skip(2).cloned().collect();
    let project = crate::jira::sites::for_key(key);
    let auth = crate::jira::sites::auth(Some(&project))?;
    let writer = Writer { agile: format!("https://{}/rest/agile/1.0", auth.site), base: auth.base, auth: auth.auth, project };
    let me = crate::jira::sites::me(Some(&writer.project)).get("id").cloned().unwrap_or(Value::Null);
    let transitions = writer.project.jira.as_ref().map(|j| j.transitions.clone()).unwrap_or(json!({}));
    let words = |from: usize| rest.iter().skip(from).cloned().collect::<Vec<_>>().join(" ");
    let arg = |i: usize| rest.get(i).cloned().unwrap_or_else(|| "undefined".into());
    match action {
        "create" => writer.create(key, rest.first().map(String::as_str).unwrap_or(""), rest.get(1..).unwrap_or(&[])),
        "assign" => writer.call("PUT", &format!("/issue/{key}/assignee"), Some(&json!({ "accountId": me }))).map(|_| 0),
        "sprint" => writer.move_to_active_sprint(key),
        _ if truthy(transitions.get(action)) => writer.call("POST", &format!("/issue/{key}/transitions"), Some(&json!({ "transition": { "id": transitions[action] } }))).map(|_| 0),
        "comment" => writer.call("POST", &format!("/issue/{key}/comment"), Some(&json!({ "body": doc(&words(0), None) }))).map(|_| 0),
        "mention" => writer.call("POST", &format!("/issue/{key}/comment"), Some(&json!({ "body": doc(&words(2), Some((&arg(0), &arg(1)))) }))).map(|_| 0),
        "edit-comment" => writer.call("PUT", &format!("/issue/{key}/comment/{}", arg(0)), Some(&json!({ "body": doc(&words(1), None) }))).map(|_| 0),
        "edit-mention" => writer.call("PUT", &format!("/issue/{key}/comment/{}", arg(0)), Some(&json!({ "body": doc(&words(3), Some((&arg(1), &arg(2)))) }))).map(|_| 0),
        _ => {
            eprintln!("Unknown action. See the header of this script.");
            Ok(1)
        }
    }
}

pub fn run(args: &[String]) -> i32 {
    match main_flow(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("Error: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_markdown_issue_keeps_title_sections_lists_sublists_and_code() {
        let issue = issue_from_markdown("# Título\r\n## Problema\nUn `código` aquí\n- uno\n  - sub\n- dos\n1. primero\n\nfin");
        assert_eq!(issue["summary"], "Título");
        let content = issue["description"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "heading");
        assert_eq!(content[1]["content"][1]["marks"][0]["type"], "code");
        assert_eq!(content[2]["type"], "bulletList");
        assert_eq!(content[2]["content"][0]["content"][1]["content"][0]["content"][0]["content"][0]["text"], "sub");
        assert_eq!(content[2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(content[3]["type"], "orderedList");
        assert_eq!(content[4]["content"][0]["text"], "fin");
    }

    #[test]
    fn a_comment_splits_paragraphs_on_double_bars_and_mentions_first() {
        let d = doc("hola||adiós", Some(("abc", "Ana")));
        assert_eq!(d["content"][0]["content"][0]["attrs"]["text"], "@Ana");
        assert_eq!(d["content"][0]["content"][1]["text"], " hola");
        assert_eq!(d["content"][1]["content"][0]["text"], "adiós");
    }
}

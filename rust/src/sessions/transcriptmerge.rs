//! Port of src/sessions/transcriptmerge.js.
use crate::core::json::{self, truthy};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq)]
pub enum Merge {
    Take,
    Keep,
    Merge { body: Vec<u8>, local_only: usize, peer_only: usize },
}

impl Merge {
    pub fn action(&self) -> &'static str {
        match self {
            Merge::Take => "take",
            Merge::Keep => "keep",
            Merge::Merge { .. } => "merge",
        }
    }
}

#[derive(Clone)]
struct Line {
    raw: String,
    j: Option<Value>,
    key: String,
}

fn uuid_of(j: &Option<Value>) -> Option<&Value> {
    j.as_ref().and_then(|j| j.get("uuid")).filter(|u| truthy(Some(u)))
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => json::stringify(other),
    }
}

fn parse(buf: &[u8]) -> Vec<Line> {
    String::from_utf8_lossy(buf)
        .split('\n')
        .filter(|raw| !raw.is_empty())
        .map(|raw| {
            let j = json::parse(raw);
            let key = uuid_of(&j).map(text_of).unwrap_or_else(|| raw.to_string());
            Line { raw: raw.to_string(), j, key }
        })
        .collect()
}

fn first_time(lines: &[Line]) -> String {
    for l in lines {
        if let Some(t) = l.j.as_ref().and_then(|j| j.get("timestamp")).filter(|t| truthy(Some(t))) {
            return text_of(t);
        }
    }
    String::new()
}

fn relink(tail: Vec<Line>, parent: Option<&Value>) -> Vec<Line> {
    let Some(parent) = parent else { return tail };
    if tail.is_empty() {
        return tail;
    }
    let own: HashSet<String> = tail.iter().filter_map(|l| uuid_of(&l.j)).map(json::stringify).collect();
    let mut done = false;
    tail.into_iter()
        .map(|l| {
            if done || uuid_of(&l.j).is_none() {
                return l;
            }
            let Some(obj) = l.j.as_ref().and_then(|j| j.as_object()) else { return l };
            match obj.get("parentUuid") {
                None | Some(Value::Null) => return l,
                Some(p) if own.contains(&json::stringify(p)) => return l,
                _ => {}
            }
            done = true;
            let mut relinked = obj.clone();
            relinked.insert("parentUuid".into(), parent.clone());
            Line { raw: json::stringify(&Value::Object(relinked)), ..l }
        })
        .collect()
}

pub fn merge_transcript(local_buf: &[u8], peer_buf: &[u8]) -> Merge {
    let local = parse(local_buf);
    let peer = parse(peer_buf);
    let peer_keys: HashSet<&str> = peer.iter().map(|l| l.key.as_str()).collect();
    let local_keys: HashSet<&str> = local.iter().map(|l| l.key.as_str()).collect();
    let peer_only: Vec<Line> = peer.iter().filter(|l| !local_keys.contains(l.key.as_str())).cloned().collect();
    let Some(d) = local.iter().position(|l| !peer_keys.contains(l.key.as_str())) else { return Merge::Take };
    if peer_only.is_empty() {
        return Merge::Keep;
    }
    let prefix = &local[..d];
    let local_tail: Vec<Line> = local[d..].to_vec();
    let (local_count, peer_count) = (local_tail.len(), peer_only.len());
    let (first, second) = if first_time(&local_tail) <= first_time(&peer_only) { (local_tail, peer_only) } else { (peer_only, local_tail) };
    let last_uuid = first.iter().rev().find_map(|l| uuid_of(&l.j)).cloned();
    let second = relink(second, last_uuid.as_ref());
    let lines: Vec<&str> = prefix.iter().chain(first.iter()).chain(second.iter()).map(|l| l.raw.as_str()).collect();
    Merge::Merge { body: format!("{}\n", lines.join("\n")).into_bytes(), local_only: local_count, peer_only: peer_count }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn l(uuid: &str, parent_uuid: Option<&str>, timestamp: &str) -> String {
        json::stringify(&json!({ "uuid": uuid, "parentUuid": parent_uuid, "timestamp": timestamp }))
    }

    fn buf(xs: &[String]) -> Vec<u8> {
        format!("{}\n", xs.join("\n")).into_bytes()
    }

    #[test]
    fn merge_transcript_takes_keeps_or_chains_both_continuations() {
        let base = vec![l("a", None, "1"), l("b", Some("a"), "2")];
        let with = |extra: String| {
            let mut v = base.clone();
            v.push(extra);
            buf(&v)
        };
        assert_eq!(merge_transcript(&buf(&base), &with(l("c", Some("b"), "3"))).action(), "take");
        assert_eq!(merge_transcript(&with(l("c", Some("b"), "3")), &buf(&base)).action(), "keep");
        let m = merge_transcript(&with(l("mine", Some("b"), "3")), &with(l("theirs", Some("b"), "4")));
        assert_eq!(m.action(), "merge");
        let Merge::Merge { body, local_only, peer_only } = m else { unreachable!() };
        assert_eq!((local_only, peer_only), (1, 1));
        let lines: Vec<Value> = String::from_utf8(body).unwrap().trim().split('\n').map(|x| json::parse(x).unwrap()).collect();
        assert_eq!(lines.iter().map(|x| x["uuid"].as_str().unwrap()).collect::<Vec<_>>(), vec!["a", "b", "mine", "theirs"]);
        assert_eq!(lines[3]["parentUuid"], "mine");
        assert_eq!(json::stringify(&lines[3]), r#"{"uuid":"theirs","parentUuid":"mine","timestamp":"4"}"#);
    }
}

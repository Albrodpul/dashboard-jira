use crate::core::json::stringify;
use serde_json::{Map, Value};
use std::collections::HashMap;

pub const STAMPS_KEY: &str = "syncStamps";
const TOMBSTONE_MS: i64 = 30 * 24 * 3600 * 1000;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Map,
    List,
    Doc,
}

#[derive(Clone, Copy)]
pub struct Spec {
    pub kind: Kind,
    pub id: &'static str,
    pub cap: Option<usize>,
    pub ascending: bool,
    pub at: Option<&'static str>,
}

const fn map() -> Spec {
    Spec { kind: Kind::Map, id: "", cap: None, ascending: false, at: None }
}
const fn doc() -> Spec {
    Spec { kind: Kind::Doc, id: "", cap: None, ascending: false, at: None }
}
const fn list(id: &'static str, cap: Option<usize>) -> Spec {
    Spec { kind: Kind::List, id, cap, ascending: false, at: None }
}

pub const SPECS: [(&str, Spec); 17] = [
    ("config", map()),
    ("aliases", map()),
    ("seenEpics", map()),
    ("sentry", map()),
    ("sessionOverrides", map()),
    ("projectDefs", map()),
    ("contextTidies", map()),
    ("deployments", list("id", Some(40))),
    ("messages", list("id", Some(60))),
    ("followUps", list("at", Some(120))),
    ("reports", list("at", Some(20))),
    ("permissionRules", Spec { kind: Kind::List, id: "key", cap: None, ascending: true, at: None }),
    ("restrictions", Spec { kind: Kind::List, id: "id", cap: None, ascending: false, at: Some("createdAt") }),
    ("deliveries", list("id", Some(120))),
    ("refreshRequest", doc()),
    ("lastReview", doc()),
    ("contextTidy", doc()),
];

pub fn spec(key: &str) -> Option<Spec> {
    SPECS.iter().find(|(k, _)| *k == key).map(|(_, s)| *s)
}

/// Records of a key by id, or None when the value does not have the expected shape.
pub fn to_map(spec: &Spec, value: Option<&Value>) -> Option<Map<String, Value>> {
    let value = value.filter(|v| !v.is_null());
    match spec.kind {
        Kind::Doc => {
            let mut m = Map::new();
            if let Some(v) = value {
                m.insert(String::new(), v.clone());
            }
            Some(m)
        }
        Kind::Map => match value {
            None => Some(Map::new()),
            Some(Value::Object(o)) => Some(o.clone()),
            _ => None,
        },
        Kind::List => match value {
            None => Some(Map::new()),
            Some(Value::Array(a)) => {
                let mut m = Map::new();
                for r in a {
                    let id = r.as_object().and_then(|o| o.get(spec.id)).and_then(|v| v.as_str())?;
                    if id.is_empty() || m.contains_key(id) {
                        return None;
                    }
                    m.insert(id.to_string(), r.clone());
                }
                Some(m)
            }
            _ => None,
        },
    }
}

fn text(v: Option<&Value>) -> Option<String> {
    v.map(stringify)
}

/// Marks with `at` every record that changed between `raw_before` (texts) and `d`. Returns whether stamps changed.
pub fn stamp_records(raw_before: &HashMap<String, String>, d: &mut Map<String, Value>, texts: Option<&HashMap<String, String>>, at: &str) -> bool {
    let mut stamps: Option<Map<String, Value>> = None;
    let cutoff = crate::core::time::iso(crate::core::time::parse(at).unwrap_or(0) - TOMBSTONE_MS);
    for (key, spec) in SPECS.iter() {
        let after = match texts {
            Some(t) => t.get(*key).cloned(),
            None => text(d.get(*key)),
        };
        if after.as_ref() == raw_before.get(*key) {
            continue;
        }
        let before = raw_before.get(*key).and_then(|t| serde_json::from_str::<Value>(t).ok());
        let (Some(a), Some(b)) = (to_map(spec, before.as_ref()), to_map(spec, d.get(*key))) else { continue };
        let ids: Vec<String> = {
            let mut seen = Vec::new();
            for k in a.keys().chain(b.keys()) {
                if !seen.contains(k) {
                    seen.push(k.clone());
                }
            }
            seen
        };
        let mut own: Option<Map<String, Value>> = None;
        for id in ids {
            if text(a.get(&id)) == text(b.get(&id)) {
                continue;
            }
            let st = stamps.get_or_insert_with(|| d.get(STAMPS_KEY).and_then(|v| v.as_object()).cloned().unwrap_or_default());
            let o = own.get_or_insert_with(|| st.get(*key).and_then(|v| v.as_object()).cloned().unwrap_or_default());
            o.insert(id, Value::from(at));
        }
        let Some(mut o) = own else { continue };
        o.retain(|id, t| b.contains_key(id) || t.as_str().unwrap_or("") >= cutoff.as_str());
        stamps.as_mut().unwrap().insert(key.to_string(), Value::Object(o));
    }
    match stamps {
        Some(s) => {
            d.insert(STAMPS_KEY.into(), Value::Object(s));
            true
        }
        None => false,
    }
}

fn sort_list(spec: &Spec, mut list: Vec<Value>) -> Vec<Value> {
    let field = spec.at.unwrap_or("at");
    let at = |r: &Value| -> String {
        match r.get(field) {
            Some(Value::String(s)) => s.clone(),
            Some(v) if crate::core::json::truthy(Some(v)) => v.to_string(),
            _ => String::new(),
        }
    };
    let mut indexed: Vec<(usize, Value)> = list.drain(..).enumerate().collect();
    indexed.sort_by(|(i, x), (j, y)| {
        let o = if spec.ascending { at(x).cmp(&at(y)) } else { at(y).cmp(&at(x)) };
        o.then(i.cmp(j))
    });
    let mut out: Vec<Value> = indexed.into_iter().map(|(_, v)| v).collect();
    if let Some(cap) = spec.cap {
        out.truncate(cap);
    }
    out
}

fn stamp_of(m: &Map<String, Value>, id: &str) -> String {
    m.get(id).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

pub struct Merged {
    pub value: Option<Value>,
    pub stamps: Map<String, Value>,
}

pub fn merge_key(spec: &Spec, mine: Option<&Value>, theirs: Option<&Value>, mine_stamps: &Map<String, Value>, their_stamps: &Map<String, Value>, theirs_on_tie: bool) -> Merged {
    if spec.kind == Kind::Doc {
        let (ta, tb) = (stamp_of(mine_stamps, ""), stamp_of(their_stamps, ""));
        let take = tb > ta || (tb == ta && theirs_on_tie);
        let stamp = if take { tb } else { ta };
        let mut stamps = Map::new();
        if !stamp.is_empty() {
            stamps.insert(String::new(), Value::from(stamp));
        }
        return Merged { value: if take { theirs.cloned() } else { mine.cloned() }, stamps };
    }
    let (Some(a), Some(b)) = (to_map(spec, mine), to_map(spec, theirs)) else {
        return if theirs_on_tie { Merged { value: theirs.cloned(), stamps: their_stamps.clone() } } else { Merged { value: mine.cloned(), stamps: mine_stamps.clone() } };
    };
    let (first, second) = if theirs_on_tie { (&b, &a) } else { (&a, &b) };
    let mut ids: Vec<String> = Vec::new();
    for k in first.keys().chain(second.keys()).chain(mine_stamps.keys()).chain(their_stamps.keys()) {
        if !ids.contains(k) {
            ids.push(k.clone());
        }
    }
    let mut out = Map::new();
    let mut stamps = Map::new();
    for id in ids {
        let (ta, tb) = (stamp_of(mine_stamps, &id), stamp_of(their_stamps, &id));
        let take = tb > ta || (tb == ta && theirs_on_tie);
        let value = if take { b.get(&id) } else { a.get(&id) };
        let stamp = if take { tb } else { ta };
        if let Some(v) = value {
            out.insert(id.clone(), v.clone());
        }
        if !stamp.is_empty() {
            stamps.insert(id, Value::from(stamp));
        }
    }
    if spec.kind == Kind::Map {
        let value = if out.is_empty() && mine.map_or(true, |v| v.is_null()) { mine.cloned() } else { Some(Value::Object(out)) };
        return Merged { value, stamps };
    }
    Merged { value: Some(Value::Array(sort_list(spec, out.into_iter().map(|(_, v)| v).collect()))), stamps }
}

pub fn merge_records(d: &mut Map<String, Value>, docs: &Map<String, Value>, their_stamps: Option<&Map<String, Value>>, theirs_on_tie: bool) {
    let mine = d.get(STAMPS_KEY).and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let empty = Map::new();
    let theirs_all = their_stamps.unwrap_or(&empty);
    let mut next = mine.clone();
    for (key, spec) in SPECS.iter() {
        if !docs.contains_key(*key) && !crate::core::json::truthy(theirs_all.get(*key)) {
            continue;
        }
        let ms = mine.get(*key).and_then(|v| v.as_object()).cloned().unwrap_or_default();
        let ts = theirs_all.get(*key).and_then(|v| v.as_object()).cloned().unwrap_or_default();
        let r = merge_key(spec, d.get(*key), docs.get(*key), &ms, &ts, theirs_on_tie);
        match r.value {
            Some(v) => {
                d.insert(key.to_string(), v);
            }
            None => {
                d.remove(*key);
            }
        }
        if r.stamps.is_empty() {
            next.remove(*key);
        } else {
            next.insert(key.to_string(), Value::Object(r.stamps));
        }
    }
    d.insert(STAMPS_KEY.into(), Value::Object(next));
}


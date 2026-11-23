use crate::cluster::role::{CLUSTER, cluster_field, info};
use crate::core::json::truthy;
use serde_json::{Value, json};

pub fn peer_get(route: &str, ms: Option<u64>) -> Option<Value> {
    let peer = cluster_field("peer").unwrap_or_default();
    let r = crate::jira::client::http("GET", &format!("{peer}{route}"), &[], None, Some(ms.unwrap_or(8000))).ok()?;
    if !r.ok() {
        return None;
    }
    r.json().ok()
}

pub fn peer_post(route: &str, body: &Value) -> bool {
    let peer = cluster_field("peer").unwrap_or_default();
    let payload = if truthy(Some(body)) { body.clone() } else { json!({}) };
    match crate::jira::client::http("POST", &format!("{peer}{route}"), &[("content-type", "application/json"), ("origin", &peer)], Some(crate::core::json::stringify(&payload).into_bytes()), Some(300_000)) {
        Ok(r) => r.ok(),
        Err(_) => false,
    }
}

fn tailscale_devices() -> Option<Vec<Value>> {
    let exe = if cfg!(target_os = "macos") { "/Applications/Tailscale.app/Contents/MacOS/Tailscale" } else { "tailscale" };
    let term = std::env::var("TERM").ok().filter(|t| !t.is_empty()).unwrap_or_else(|| "xterm-256color".to_string());
    let out = crate::core::platform::run_output(exe, &["status".into(), "--json".into()], 10000, None, &[("TERM", &term)]);
    if !out.ok {
        return None;
    }
    let j = crate::core::json::parse(&out.stdout)?;
    let me = j.get("Self").cloned().unwrap_or(Value::Null);
    let mut all = vec![(me, true)];
    if let Some(peers) = j.get("Peer").and_then(Value::as_object) {
        all.extend(peers.values().map(|p| (p.clone(), false)));
    }
    let mobile = regex::Regex::new(r"(?i)^(android|ios)$").unwrap();
    Some(
        all.into_iter()
            .filter(|(d, _)| truthy(Some(d)) && !mobile.is_match(d.get("OS").and_then(Value::as_str).unwrap_or("")))
            .map(|(d, is_self)| {
                let last_seen = d.get("LastSeen").and_then(Value::as_str).filter(|s| !s.is_empty() && !s.starts_with("0001")).map(Value::from).unwrap_or(Value::Null);
                json!({
                    "name": d.get("HostName").cloned().unwrap_or(Value::Null),
                    "os": d.get("OS").cloned().unwrap_or(Value::Null),
                    "online": is_self || truthy(d.get("Online")),
                    "lastSeen": last_seen,
                    "ip": d.get("TailscaleIPs").and_then(|a| a.get(0)).cloned().unwrap_or(Value::Null),
                    "dns": d.get("DNSName").and_then(Value::as_str).unwrap_or("").strip_suffix('.').map(str::to_string).unwrap_or_else(|| d.get("DNSName").and_then(Value::as_str).unwrap_or("").to_string()),
                    "self": is_self,
                })
            })
            .collect(),
    )
}

pub fn send_claude_token(token: &str) -> bool {
    CLUSTER.is_some() && peer_post("/api/cluster/claude-token", &json!({ "token": token }))
}

pub fn machines() -> Value {
    let (devices, peer) = std::thread::scope(|s| {
        let d = s.spawn(tailscale_devices);
        let p = s.spawn(|| if CLUSTER.is_some() { peer_get("/api/cluster", Some(5000)) } else { None });
        (d.join().ok().flatten(), p.join().ok().flatten())
    });
    json!({ "self": info(), "peer": peer, "devices": devices })
}

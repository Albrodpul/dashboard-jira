use std::path::{Path, PathBuf};

pub struct Config {
    pub port: u16,
    pub node_port: u16,
    pub repo: PathBuf,
    pub data_dir: PathBuf,
    pub label: String,
    pub color: [u8; 3],
}

fn env_port(names: &[&str], default: u16) -> u16 {
    names.iter().find_map(|n| std::env::var(n).ok()?.parse().ok()).unwrap_or(default)
}

impl Config {
    pub fn load() -> Config {
        let repo = std::env::var("TOWER_REPO").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
        let workspace = std::env::var("TOWER_WORKSPACE").map(PathBuf::from).unwrap_or_else(|_| repo.clone());
        let data_dir = std::env::var("TOWER_DATA").map(PathBuf::from).unwrap_or_else(|_| workspace.join("data"));
        let port = env_port(&["TOWER_PORT", "TABLERO_PORT"], 4747);
        let node_port = env_port(&["TOWER_NODE_PORT"], port + 10);
        let cluster = std::fs::read_to_string(workspace.join("board.config.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|c| c.get("cluster").cloned())
            .unwrap_or(serde_json::Value::Null);
        let label = cluster.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let color = cluster
            .get("color")
            .and_then(|v| v.as_array())
            .filter(|a| a.len() == 3)
            .map(|a| {
                let n = |i: usize| a[i].as_u64().unwrap_or(0).min(255) as u8;
                [n(0), n(1), n(2)]
            })
            .unwrap_or([11, 110, 138]);
        Config { port, node_port, repo, data_dir, label, color }
    }

    pub fn page_dir(&self) -> PathBuf {
        self.repo.join("src").join("page")
    }

    fn extra_hosts(&self) -> Vec<String> {
        std::fs::read_to_string(self.data_dir.join("board-hosts.txt"))
            .unwrap_or_default()
            .lines()
            .map(|l| {
                let l = l.trim().to_lowercase();
                let l = l.rsplit("://").next().unwrap_or("").to_string();
                l.split('/').next().unwrap_or("").to_string()
            })
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect()
    }

    pub fn host_ok(&self, host: &str) -> bool {
        let host = host.to_lowercase();
        host == format!("127.0.0.1:{}", self.port) || host == format!("localhost:{}", self.port) || self.extra_hosts().contains(&host)
    }

}

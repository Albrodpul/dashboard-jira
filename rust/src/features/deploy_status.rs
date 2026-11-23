//! Port of src/features/deploy-status.js.
use crate::core::data::DATA_DIR;
use crate::server::http::Res;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, LazyLock, Mutex};

static FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("deploy-status.json"));
const ENVS: [&str; 2] = ["develop", "production"];
const ACTIVE_ACTIONS: [&str; 5] = ["queued", "in_progress", "waiting", "requested", "pending"];
const ACTIVE_CODEDEPLOY: [&str; 5] = ["Created", "Queued", "InProgress", "Baking", "Ready"];
const SLOW: u64 = 3 * 60000;
const FAST: u64 = 30000;
const RECENT: usize = 4;
const PAIR_BEFORE: i64 = 2 * 60000;
const PAIR_AFTER: i64 = 15 * 60000;

type Refresh = Arc<(Mutex<Option<Result<Value, String>>>, Condvar)>;

static TIMER: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(0));
static RUNNING: LazyLock<Mutex<Option<Refresh>>> = LazyLock::new(|| Mutex::new(None));

pub struct Pairing {
    pub by_run: HashMap<String, Value>,
    pub unpaired: Vec<Value>,
}

pub fn read_status() -> Option<Value> {
    todo!()
}

pub fn refresh_status() -> Result<Value, String> {
    todo!()
}

pub fn start_deploy_status() {
    todo!()
}

pub fn handle_deploy_status_refresh() -> Res {
    todo!()
}

pub fn any_running(s: Option<&Value>) -> bool {
    todo!()
}

pub fn pair(runs: &[Value], deployments: &[Value]) -> Pairing {
    todo!()
}

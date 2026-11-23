//! Port of src/features/yolo.js.

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::JoinHandle;

use serde_json::Value;

const RETRY_MS: i64 = 5 * 60000;

pub type CreateFn = Arc<dyn Fn(&str, &Value) -> Result<(u16, Value), String> + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Area(String),
    Create(String),
}

static FAILED: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CREATING: LazyLock<Mutex<Option<JoinHandle<()>>>> = LazyLock::new(|| Mutex::new(None));
static CREATE: LazyLock<Mutex<Option<CreateFn>>> = LazyLock::new(|| Mutex::new(None));
static KICK_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn session_name(t: &Value, areas: &Value) -> String {
    todo!()
}

pub fn target_of(t: &Value, routes: &Value) -> Target {
    todo!()
}

pub fn tick() {
    todo!()
}

pub fn kick() {
    todo!()
}

pub mod test_hooks {
    use super::CreateFn;

    pub fn reset() {
        todo!()
    }

    pub fn set_create(create: Option<CreateFn>) {
        todo!()
    }

    pub fn idle() {
        todo!()
    }
}

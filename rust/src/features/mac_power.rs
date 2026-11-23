//! Port of src/features/mac-power.js.
use crate::core::data::DATA_DIR;
use crate::core::time::Clock;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Child;
use std::sync::{LazyLock, Mutex};

const DEFAULT_WAKE: &str = "06:00";
const DEFAULT_SLEEP: &str = "21:00";
const DEFAULT_DAYS: &str = "MTWRF";
const DEFAULT_WEEKLY_OFF: bool = true;
const IS_MAC: bool = cfg!(target_os = "macos");
static STATE_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("mac-power.json"));

static BATTERY_CACHE: LazyLock<Mutex<Option<(i64, Option<Value>)>>> = LazyLock::new(|| Mutex::new(None));
static SUDO_CACHE: LazyLock<Mutex<Option<(i64, bool)>>> = LazyLock::new(|| Mutex::new(None));
static SCREEN_KEEPER: LazyLock<Mutex<Option<Child>>> = LazyLock::new(|| Mutex::new(None));
static AUTO_LOGIN_CACHE: LazyLock<Mutex<Option<(i64, bool)>>> = LazyLock::new(|| Mutex::new(None));

pub fn battery() -> Option<Value> {
    todo!()
}

pub fn tick() {
    todo!()
}

pub fn schedule() -> Value {
    todo!()
}

pub fn set_schedule(input: &Value) -> Value {
    todo!()
}

pub fn in_window(clock: &Clock) -> bool {
    todo!()
}

pub fn status() -> Value {
    todo!()
}

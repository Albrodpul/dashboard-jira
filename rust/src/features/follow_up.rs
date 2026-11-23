//! Port of src/features/follow-up.js.

use std::path::PathBuf;
use std::sync::LazyLock;

use serde_json::Value;

use crate::core::data::Doc;
use crate::server::http::Res;

pub const ENVIRONMENTS: [&str; 2] = ["beta", "production"];

static CONFIG_FILE: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::workspace().join("board.config.json"));

pub fn environment_name(id: &str) -> String {
    todo!()
}

pub fn environment_of(summary: &Value, d: &Doc) -> String {
    todo!()
}

pub fn environments(d: &Doc) -> Value {
    todo!()
}

pub fn people(d: &Doc) -> Value {
    todo!()
}

pub fn handle_people(input: &Value) -> Res {
    todo!()
}

pub fn register_person(name: &str, accounts: &[String]) -> Result<Value, String> {
    todo!()
}

pub fn save_accounts(id: &str, accounts: &[String]) -> bool {
    todo!()
}

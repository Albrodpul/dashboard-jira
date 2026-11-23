//! Port of src/features/manual-tasks.js.

use serde_json::Value;

use crate::core::config::Project;
use crate::core::data::Doc;

pub fn is_manual(t: &Value) -> bool {
    todo!()
}

pub fn prefix_of(project: &Project) -> String {
    todo!()
}

pub fn next_key(d: &Doc, prefix: &str) -> String {
    todo!()
}

pub fn create_task(d: &mut Doc, input: &Value) -> Result<String, String> {
    todo!()
}

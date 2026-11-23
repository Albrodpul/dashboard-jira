//! Port of src/features/render-commands.js.

use serde_json::Value;

use crate::core::config::Project;

pub fn render_project(p: &Project, warn: Option<&dyn Fn(&str)>) -> Result<Value, String> {
    todo!()
}

pub fn render_all(log: Option<&dyn Fn(&str)>) {
    todo!()
}

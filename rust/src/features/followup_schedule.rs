//! Port of src/features/followup-schedule.js.

use std::sync::atomic::AtomicBool;

use serde_json::Value;

use crate::core::data::Doc;
use crate::core::time::Clock;

const WINDOW: u32 = 10;

static BUSY: AtomicBool = AtomicBool::new(false);

fn minute_of(environment: &str) -> u32 {
    if environment == "production" { 33 } else { 3 }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Due {
    pub environments: Vec<String>,
    pub slot: u32,
}

pub fn tick() {
    todo!()
}

pub fn slots(environment: &str, every_hours: f64) -> Vec<u32> {
    todo!()
}

pub fn due_now(environments: &Value, t: Option<&Clock>) -> Option<Due> {
    todo!()
}

pub fn pending(d: &Doc, environments: &Value) -> Vec<String> {
    todo!()
}

pub fn cron_of(environment: &str, every_hours: f64) -> String {
    todo!()
}

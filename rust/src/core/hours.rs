use crate::core::time::Clock;
use serde_json::Value;

const DEFAULT_START: &str = "07:30";
const DEFAULT_END: &str = "18:30";
const DAILY_LEAD: u32 = 90;

pub fn clock() -> Clock {
    todo!()
}

pub fn clock_at(ms: i64) -> Clock {
    todo!()
}

pub fn to_min(t: &str) -> u32 {
    todo!()
}

pub fn schedule() -> Value {
    todo!()
}

pub fn set_schedule(input: &Value) -> Value {
    todo!()
}

pub fn start_min() -> u32 {
    todo!()
}

pub fn end_min() -> u32 {
    todo!()
}

pub fn daily_min() -> u32 {
    todo!()
}

pub fn work_hours(t: Option<&Clock>) -> bool {
    todo!()
}

pub fn expired(ot: Option<&Value>, now_ms: Option<i64>) -> bool {
    todo!()
}

pub fn overtime() -> Option<Value> {
    todo!()
}

pub fn set_overtime(on: bool) -> Option<Value> {
    todo!()
}

pub fn resting(t: Option<&Clock>) -> bool {
    todo!()
}

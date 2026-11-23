use crate::core::config::Project;
use serde_json::Value;

pub fn main_id() -> String {
    todo!()
}

pub fn project_of_path(dir: Option<&str>) -> Option<Project> {
    todo!()
}

pub fn project_of_key(key: &str) -> Option<String> {
    todo!()
}

pub fn project_of(record: &Value) -> String {
    todo!()
}

pub fn area_project(area: Option<&str>, routes: Option<&Value>) -> Option<String> {
    todo!()
}

pub fn cross_project(record: &Value, area: Option<&str>, routes: Option<&Value>) -> String {
    todo!()
}

pub fn project_of_folder(folder: Option<&str>) -> Option<Project> {
    todo!()
}

pub fn project_of_conversation(id: &str) -> Option<Project> {
    todo!()
}

pub fn role_route(routes: Option<&Value>, role: &str, project_id: Option<&str>) -> Option<Value> {
    todo!()
}

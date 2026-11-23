use serde_json::json;

#[test]
fn the_minutes_come_from_board_config_json_and_default_to_five() {
    tower::testkit::sandbox_with(json!({ "boardAliveMinutes": 7 }));
    assert_eq!(tower::core::config::board_alive_minutes(), 7.0);
}

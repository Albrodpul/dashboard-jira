#[cfg(test)]
mod tests {
    #[test]
    fn real_board_documents_round_trip() {
        let Ok(file) = std::env::var("ROUNDTRIP_DB") else { return };
        let conn = rusqlite::Connection::open(file).unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM documents").unwrap();
        let rows: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
        let mut bad = vec![];
        for (k, v) in &rows {
            let parsed: serde_json::Value = serde_json::from_str(v).unwrap();
            if crate::core::json::stringify(&parsed) != *v {
                bad.push(k.clone());
            }
        }
        assert!(bad.is_empty(), "{} of {} keys differ: {:?}", bad.len(), rows.len(), bad);
        eprintln!("{} keys round-trip", rows.len());
    }
}

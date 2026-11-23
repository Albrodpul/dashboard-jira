use std::fs;
use std::io::Write;
use std::path::Path;

pub const MAX_BYTES: u64 = 1024 * 1024;

pub fn rotate(file: &Path, max: u64) -> bool {
    match fs::metadata(file) {
        Ok(m) if m.len() >= max => fs::rename(file, format!("{}.1", file.display())).is_ok(),
        _ => false,
    }
}

pub fn rotate_in_place(file: &Path, max: u64) -> bool {
    match fs::metadata(file) {
        Ok(m) if m.len() >= max => fs::copy(file, format!("{}.1", file.display())).is_ok() && fs::OpenOptions::new().write(true).truncate(true).open(file).is_ok(),
        _ => false,
    }
}

pub fn append_log(file: &Path, text: &str) {
    append_log_max(file, text, MAX_BYTES)
}

pub fn append_log_max(file: &Path, text: &str, max: u64) {
    rotate(file, max);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = f.write_all(text.as_bytes());
    }
}

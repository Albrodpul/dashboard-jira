use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Europe::Madrid;

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Same text as `new Date(ms).toISOString()`.
pub fn iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Same text as `new Date().toISOString()`.
pub fn now() -> String {
    iso(now_ms())
}

/// Like `Date.parse` for the forms the board writes and reads (ISO with or without zone, plain dates).
pub fn parse(text: &str) -> Option<i64> {
    let t = text.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(t) {
        return Some(d.timestamp_millis());
    }
    if let Ok(d) = DateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f%z") {
        return Some(d.timestamp_millis());
    }
    if let Ok(d) = DateTime::parse_from_rfc2822(t) {
        return Some(d.timestamp_millis());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(t, f) {
            return chrono::Local.from_local_datetime(&n).single().map(|d| d.timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(t, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
}

/// Minutes since `iso`, like `(Date.now() - new Date(iso)) / 60000`; 0 when it does not parse.
pub fn minutes_since(iso: &str) -> f64 {
    parse(iso).map(|t| (now_ms() - t) as f64 / 60000.0).unwrap_or(0.0)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Clock {
    /// "Mon".."Sun", like `Intl` with `weekday: "short"` in en-GB.
    pub weekday: &'static str,
    pub weekend: bool,
    pub hour: u32,
    pub minute: u32,
    /// Minutes since midnight in Madrid.
    pub min: u32,
    /// "YYYY-MM-DD" in Madrid.
    pub day: String,
}

const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// Wall clock in Madrid at `ms`.
pub fn madrid(ms: i64) -> Clock {
    let d = Utc.timestamp_millis_opt(ms).single().unwrap_or_default().with_timezone(&Madrid);
    let wd = d.weekday().num_days_from_monday() as usize;
    Clock { weekday: DAYS[wd], weekend: wd >= 5, hour: d.hour(), minute: d.minute(), min: d.hour() * 60 + d.minute(), day: d.format("%Y-%m-%d").to_string() }
}

pub fn madrid_now() -> Clock {
    madrid(now_ms())
}

/// "HH:MM" in Madrid.
pub fn madrid_hhmm(ms: i64) -> String {
    let c = madrid(ms);
    format!("{:02}:{:02}", c.hour, c.minute)
}

/// "DD/MM" in Madrid, like `fmtDay` with es-ES.
pub fn madrid_ddmm(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default().with_timezone(&Madrid).format("%d/%m").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_and_madrid_match_javascript() {
        let ms = parse("2026-11-21T08:19:22.896Z").unwrap();
        assert_eq!(iso(ms), "2026-11-21T08:19:22.896Z");
        let c = madrid(ms);
        assert_eq!((c.weekday, c.weekend, c.hour, c.minute, c.day.as_str()), ("Sat", true, 9, 19, "2026-11-21"));
        assert_eq!(madrid(parse("2026-07-01T22:30:00Z").unwrap()).day, "2026-07-02");
        assert_eq!(parse("2026-11-23T07:30:00+01:00"), parse("2026-11-23T06:30:00.000Z"));
    }
}

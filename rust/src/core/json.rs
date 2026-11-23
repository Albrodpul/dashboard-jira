use serde::Serialize;
use serde_json::Value;
use serde_json::ser::{CompactFormatter, Formatter, PrettyFormatter};
use std::io;

struct Js<F>(F);

macro_rules! delegate {
    ($($name:ident($($arg:ident: $t:ty),*);)*) => {
        $(fn $name<W: ?Sized + io::Write>(&mut self, w: &mut W $(, $arg: $t)*) -> io::Result<()> { self.0.$name(w $(, $arg)*) })*
    };
}

impl<F: Formatter> Formatter for Js<F> {
    fn write_f64<W: ?Sized + io::Write>(&mut self, w: &mut W, value: f64) -> io::Result<()> {
        if !value.is_finite() {
            return w.write_all(b"null");
        }
        let mut b = ryu_js::Buffer::new();
        w.write_all(b.format_finite(value).as_bytes())
    }
    fn write_f32<W: ?Sized + io::Write>(&mut self, w: &mut W, value: f32) -> io::Result<()> {
        self.write_f64(w, value as f64)
    }
    delegate! {
        begin_array();
        end_array();
        begin_array_value(first: bool);
        end_array_value();
        begin_object();
        end_object();
        begin_object_key(first: bool);
        end_object_key();
        begin_object_value();
        end_object_value();
    }
}

fn write<F: Formatter>(v: &Value, f: F) -> String {
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, Js(f));
    v.serialize(&mut ser).expect("JSON");
    String::from_utf8(out).expect("UTF-8")
}

/// Same text as `JSON.stringify(v)`.
pub fn stringify(v: &Value) -> String {
    write(v, CompactFormatter)
}

/// Same text as `JSON.stringify(v, null, indent)`.
pub fn stringify_pretty(v: &Value, indent: usize) -> String {
    let pad = " ".repeat(indent);
    write(v, PrettyFormatter::with_indent(pad.as_bytes()))
}

pub fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// JS truthiness of a JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A number the way JS keeps it: whole numbers stay integers so they print without ".0".
pub fn num(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        Value::from(x as i64)
    } else {
        serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prints_like_json_stringify() {
        assert_eq!(stringify(&json!({"b": 1, "a": [1.5, 2.0, "é\n\"x\""], "c": null})), r#"{"b":1,"a":[1.5,2,"é\n\"x\""],"c":null}"#);
        assert_eq!(stringify(&json!(1e21)), "1e+21");
        assert_eq!(stringify(&json!(0.1 + 0.2)), "0.30000000000000004");
        assert_eq!(stringify_pretty(&json!({"a": [], "b": {}, "c": [1]}), 2), "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1\n  ]\n}");
        assert_eq!(stringify(&num(3.0)), "3");
    }
}

use std::fmt::Write;

use serde::Serialize;
use serde_json::Value;

use crate::chunker::Chunk;
use crate::search::SearchResult;

/// Trait for types that can be serialized into TOON row format.
pub trait ToonSerializable {
    fn toon_collection_name() -> &'static str;
    fn toon_fields() -> &'static [&'static str];
    fn toon_values(&self) -> Vec<String>;
}

#[derive(Debug, Default)]
pub struct ToonSerializer {
    indent_level: usize,
}

impl ToonSerializer {
    pub fn new() -> Self {
        Self { indent_level: 0 }
    }

    pub fn with_indent(indent_level: usize) -> Self {
        Self { indent_level }
    }

    pub fn serialize<T: ToonSerializable>(&self, items: &[T]) -> String {
        let mut buf = String::new();
        self.write_to(&mut buf, items);
        buf
    }

    pub fn write_to<T: ToonSerializable>(&self, buf: &mut String, items: &[T]) {
        let base_indent = "  ".repeat(self.indent_level);
        let row_indent = format!("{base_indent}  ");

        let name = T::toon_collection_name();
        let fields = T::toon_fields();
        let count = items.len();

        let _ = write!(buf, "{base_indent}{name}[{count}]{{");
        for (i, field) in fields.iter().enumerate() {
            if i > 0 {
                buf.push(',');
            }
            buf.push_str(field);
        }
        buf.push_str("}:\n");

        for item in items {
            buf.push_str(&row_indent);
            let values = item.toon_values();
            for (i, val) in values.iter().enumerate() {
                if i > 0 {
                    buf.push(',');
                }
                write_escaped_value(buf, val);
            }
            buf.push('\n');
        }
    }
}

/// Convenience function: serialize a slice using the `ToonSerializable` trait.
pub fn to_toon_string<T: ToonSerializable>(items: &[T]) -> String {
    ToonSerializer::new().serialize(items)
}

/// Generic serde-based serializer: convert any `Vec<T: Serialize>` into TOON tabular format.
///
/// Introspects field names from the first row's JSON object representation.
pub fn serialize_array<T: Serialize>(name: &str, items: &[T]) -> String {
    if items.is_empty() {
        return format!("{name}[0]{{}}:\n");
    }

    let rows: Vec<Value> = items
        .iter()
        .filter_map(|item| serde_json::to_value(item).ok())
        .collect();

    if rows.is_empty() {
        return format!("{name}[0]{{}}:\n");
    }

    let fields = extract_field_names(&rows[0]);
    let count = rows.len();

    let mut out = String::new();
    let _ = writeln!(
        out,
        "{name}[{count}]{{{fields_str}}}:",
        fields_str = fields.join(",")
    );

    for row in &rows {
        out.push_str("  ");
        for (i, field) in fields.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            let val = row.get(field).unwrap_or(&Value::Null);
            out.push_str(&format_value(val));
        }
        out.push('\n');
    }

    out
}

/// Serialize a single object in TOON inline format: `name{field1,field2}: val1,val2`
pub fn serialize_object<T: Serialize>(name: &str, item: &T) -> String {
    let Ok(value) = serde_json::to_value(item) else {
        return format!("{name}: null\n");
    };

    match &value {
        Value::Object(map) => {
            let fields: Vec<&str> = map.keys().map(String::as_str).collect();
            let vals: Vec<String> = fields
                .iter()
                .map(|f| format_value(map.get(*f).unwrap_or(&Value::Null)))
                .collect();
            format!(
                "{name}{{{fields_str}}}: {vals_str}\n",
                fields_str = fields.join(","),
                vals_str = vals.join(",")
            )
        }
        _ => format!("{name}: {}\n", format_value(&value)),
    }
}

/// Serialize nested/hierarchical data with YAML-style indentation.
pub fn serialize_nested<T: Serialize>(name: &str, item: &T) -> String {
    let Ok(value) = serde_json::to_value(item) else {
        return format!("{name}: null\n");
    };

    let mut out = String::new();
    write_nested_value(&mut out, name, &value, 0);
    out
}

/// Serialize chunks with nested content using pipe-prefixed block format.
pub fn to_toon_nested(chunks: &[Chunk]) -> String {
    let mut buf = String::new();
    let count = chunks.len();

    let _ = writeln!(buf, "chunks_nested[{count}]{{file,kind,name,lines}}:");

    for chunk in chunks {
        buf.push_str("  ");
        write_escaped_value(&mut buf, &chunk.file_path);
        buf.push(',');
        buf.push_str(&chunk.kind.to_string());
        buf.push(',');
        write_escaped_value(&mut buf, chunk.name.as_deref().unwrap_or(""));
        buf.push(',');
        let _ = write!(buf, "{}-{}", chunk.start_line, chunk.end_line);
        buf.push('\n');

        for line in chunk.content.lines() {
            let _ = writeln!(buf, "    |{line}");
        }
    }

    buf
}

/// Estimate token count of a string (rough heuristic: 1 token ≈ 4 chars).
pub fn estimate_tokens(s: &str) -> usize {
    s.len().div_ceil(4)
}

/// Compare TOON output tokens vs JSON output tokens for the same data.
#[allow(clippy::cast_precision_loss)]
pub fn token_savings<T: Serialize>(name: &str, items: &[T]) -> (usize, usize, f64) {
    let toon = serialize_array(name, items);
    let json = serde_json::to_string(items).unwrap_or_default();
    let toon_tokens = estimate_tokens(&toon);
    let json_tokens = estimate_tokens(&json);
    let savings = if json_tokens > 0 {
        1.0 - (toon_tokens as f64 / json_tokens as f64)
    } else {
        0.0
    };
    (toon_tokens, json_tokens, savings)
}

// --- Private helpers ---

fn write_nested_value(out: &mut String, key: &str, value: &Value, indent: usize) {
    let prefix = "  ".repeat(indent);
    match value {
        Value::Object(map) => {
            let _ = writeln!(out, "{prefix}{key}:");
            for (k, v) in map {
                write_nested_value(out, k, v, indent + 1);
            }
        }
        Value::Array(arr) => {
            if arr.is_empty() {
                let _ = writeln!(out, "{prefix}{key}: []");
            } else if arr.iter().all(Value::is_object) {
                let toon = serialize_array(key, arr);
                for line in toon.lines() {
                    let _ = writeln!(out, "{prefix}{line}");
                }
            } else {
                let vals: Vec<String> = arr.iter().map(format_value).collect();
                let _ = writeln!(out, "{prefix}{key}[{}]: {}", arr.len(), vals.join(","));
            }
        }
        _ => {
            let _ = writeln!(out, "{prefix}{key}: {}", format_value(value));
        }
    }
}

fn extract_field_names(value: &Value) -> Vec<String> {
    match value {
        Value::Object(map) => map.keys().cloned().collect(),
        _ => vec![],
    }
}

fn format_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format_string_value(s),
        Value::Array(arr) => {
            let vals: Vec<String> = arr.iter().map(format_value).collect();
            format!("[{}]", vals.join(","))
        }
        Value::Object(_) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
    }
}

fn format_string_value(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    if s.contains(',') || s.contains('\n') || s.contains('"') {
        let escaped = s
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n");
        format!("\"{escaped}\"")
    } else {
        s.to_string()
    }
}

fn write_escaped_value(buf: &mut String, val: &str) {
    if val.contains(',') || val.contains('\n') || val.contains('"') {
        buf.push('"');
        for ch in val.chars() {
            match ch {
                '"' => buf.push_str("\\\""),
                '\n' => buf.push_str("\\n"),
                other => buf.push(other),
            }
        }
        buf.push('"');
    } else {
        buf.push_str(val);
    }
}

// --- ToonSerializable implementations for crate types ---

impl ToonSerializable for Chunk {
    fn toon_collection_name() -> &'static str {
        "chunks"
    }

    fn toon_fields() -> &'static [&'static str] {
        &["file", "kind", "name", "lines", "signature"]
    }

    fn toon_values(&self) -> Vec<String> {
        vec![
            self.file_path.clone(),
            self.kind.to_string(),
            self.name.clone().unwrap_or_default(),
            format!("{}-{}", self.start_line, self.end_line),
            self.signature.clone().unwrap_or_default(),
        ]
    }
}

impl ToonSerializable for SearchResult {
    fn toon_collection_name() -> &'static str {
        "results"
    }

    fn toon_fields() -> &'static [&'static str] {
        &["file", "kind", "name", "score", "lines", "signature"]
    }

    fn toon_values(&self) -> Vec<String> {
        vec![
            self.chunk.file_path.clone(),
            self.chunk.kind.to_string(),
            self.chunk.name.clone().unwrap_or_default(),
            format!("{:.3}", self.score),
            format!("{}-{}", self.chunk.start_line, self.chunk.end_line),
            self.chunk.signature.clone().unwrap_or_default(),
        ]
    }
}

/// Wrapper for serializing chunks with their full content.
pub struct ChunkWithContent<'a>(pub &'a Chunk);

impl ToonSerializable for ChunkWithContent<'_> {
    fn toon_collection_name() -> &'static str {
        "chunks_full"
    }

    fn toon_fields() -> &'static [&'static str] {
        &["file", "kind", "name", "lines", "content"]
    }

    fn toon_values(&self) -> Vec<String> {
        vec![
            self.0.file_path.clone(),
            self.0.kind.to_string(),
            self.0.name.clone().unwrap_or_default(),
            format!("{}-{}", self.0.start_line, self.0.end_line),
            self.0.content.clone(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::ChunkKind;

    fn sample_chunk(name: &str, file: &str) -> Chunk {
        Chunk {
            id: format!("id-{name}"),
            file_path: file.to_string(),
            start_line: 1,
            end_line: 10,
            kind: ChunkKind::Function,
            name: Some(name.to_string()),
            language: "rust".to_string(),
            content: format!("fn {name}() {{}}\n"),
            content_hash: format!("hash-{name}"),
            parent_name: None,
            signature: Some(format!("fn {name}()")),
        }
    }

    #[test]
    fn test_trait_based_serialization() {
        let chunks = vec![
            sample_chunk("foo", "src/lib.rs"),
            sample_chunk("bar", "src/main.rs"),
        ];

        let output = to_toon_string(&chunks);
        assert!(output.starts_with("chunks[2]{file,kind,name,lines,signature}:\n"));
        assert!(output.contains("  src/lib.rs,function,foo,1-10,fn foo()\n"));
        assert!(output.contains("  src/main.rs,function,bar,1-10,fn bar()\n"));
    }

    #[test]
    fn test_search_result_trait_serialization() {
        let results = vec![
            SearchResult {
                chunk: sample_chunk("handler", "src/api.rs"),
                score: 0.85,
                bm25_rank: Some(1),
                vector_rank: Some(2),
            },
            SearchResult {
                chunk: sample_chunk("parse", "src/parser.rs"),
                score: 0.42,
                bm25_rank: Some(3),
                vector_rank: None,
            },
        ];

        let output = to_toon_string(&results);
        assert!(output.starts_with("results[2]{file,kind,name,score,lines,signature}:\n"));
        assert!(output.contains("0.850"));
        assert!(output.contains("0.420"));
    }

    #[test]
    fn test_serde_generic_serialize_array() {
        #[derive(Serialize)]
        struct Hit {
            file: String,
            line: usize,
            name: String,
            kind: String,
            score: f64,
        }

        let items = vec![
            Hit {
                file: "src/auth.ts".into(),
                line: 42,
                name: "validateToken".into(),
                kind: "function".into(),
                score: 0.95,
            },
            Hit {
                file: "src/auth.ts".into(),
                line: 78,
                name: "refreshToken".into(),
                kind: "function".into(),
                score: 0.87,
            },
            Hit {
                file: "src/middleware.ts".into(),
                line: 15,
                name: "authGuard".into(),
                kind: "function".into(),
                score: 0.82,
            },
        ];

        let output = serialize_array("results", &items);
        assert!(output.starts_with("results[3]{file,line,name,kind,score}:\n"));
        assert!(output.contains("src/auth.ts,42,validateToken,function,0.95"));
        assert!(output.contains("src/middleware.ts,15,authGuard,function,0.82"));
    }

    #[test]
    fn test_empty_array() {
        #[derive(Serialize)]
        struct Row {
            x: i32,
        }
        let items: Vec<Row> = vec![];
        let output = serialize_array("data", &items);
        assert_eq!(output, "data[0]{}:\n");
    }

    #[test]
    fn test_string_quoting_with_commas() {
        #[derive(Serialize)]
        struct Row {
            msg: String,
            count: u32,
        }

        let items = vec![
            Row {
                msg: "hello, world".into(),
                count: 1,
            },
            Row {
                msg: "no commas here".into(),
                count: 2,
            },
        ];

        let output = serialize_array("messages", &items);
        assert!(output.contains("\"hello, world\",1"));
        assert!(output.contains("no commas here,2"));
    }

    #[test]
    fn test_quoting_in_trait_serialization() {
        let mut chunk = sample_chunk("complex", "src/lib.rs");
        chunk.signature = Some("fn complex(a: i32, b: i32)".to_string());

        let output = to_toon_string(std::slice::from_ref(&chunk));
        assert!(output.contains("\"fn complex(a: i32, b: i32)\""));
    }

    #[test]
    fn test_token_savings_over_json() {
        #[derive(Serialize)]
        struct Hit {
            file: String,
            line: usize,
            name: String,
            kind: String,
            score: f64,
        }

        let items: Vec<Hit> = (0..10)
            .map(|i| Hit {
                file: format!("src/module_{i}.ts"),
                line: i * 10 + 1,
                name: format!("function_{i}"),
                kind: "function".into(),
                score: 0.9 - (i as f64 * 0.05),
            })
            .collect();

        let (toon_tokens, json_tokens, savings) = token_savings("results", &items);
        assert!(
            toon_tokens < json_tokens,
            "TOON ({toon_tokens}) should use fewer tokens than JSON ({json_tokens})"
        );
        assert!(savings > 0.0, "savings should be positive: {savings}");
    }

    #[test]
    fn test_serialize_object() {
        #[derive(Serialize)]
        struct Item {
            id: u32,
            label: String,
            active: bool,
        }

        let item = Item {
            id: 42,
            label: "test".into(),
            active: true,
        };
        let output = serialize_object("item", &item);
        assert!(output.contains("item{"));
        assert!(output.contains("42"));
        assert!(output.contains("test"));
        assert!(output.contains("true"));
    }

    #[test]
    fn test_nested_serialization() {
        #[derive(Serialize)]
        struct Config {
            name: String,
            version: u32,
        }

        let item = Config {
            name: "test".into(),
            version: 2,
        };
        let output = serialize_nested("config", &item);
        assert!(output.contains("config:"));
        assert!(output.contains("name: test"));
        assert!(output.contains("version: 2"));
    }

    #[test]
    fn test_nested_content_with_pipes() {
        let chunk = Chunk {
            id: "id-main".to_string(),
            file_path: "src/main.rs".to_string(),
            start_line: 1,
            end_line: 3,
            kind: ChunkKind::Function,
            name: Some("main".to_string()),
            language: "rust".to_string(),
            content: "fn main() {\n    println!(\"hello\");\n}".to_string(),
            content_hash: "hash-main".to_string(),
            parent_name: None,
            signature: Some("fn main()".to_string()),
        };

        let output = to_toon_nested(&[chunk]);
        assert!(output.starts_with("chunks_nested[1]{file,kind,name,lines}:\n"));
        assert!(output.contains("    |fn main() {\n"));
        assert!(output.contains("    |    println!(\"hello\");\n"));
        assert!(output.contains("    |}\n"));
    }

    #[test]
    fn test_count_matches_rows() {
        let chunks = vec![
            sample_chunk("a", "a.rs"),
            sample_chunk("b", "b.rs"),
            sample_chunk("c", "c.rs"),
        ];
        let output = to_toon_string(&chunks);
        assert!(output.starts_with("chunks[3]"));
        let row_count = output
            .lines()
            .skip(1)
            .filter(|l| l.starts_with("  "))
            .count();
        assert_eq!(row_count, 3);
    }

    #[test]
    fn test_data_integrity_roundtrip() {
        #[derive(Serialize)]
        struct Hit {
            file: String,
            line: usize,
            name: String,
            kind: String,
            score: f64,
        }

        let items = vec![
            Hit {
                file: "a.rs".into(),
                line: 1,
                name: "foo".into(),
                kind: "fn".into(),
                score: 0.5,
            },
            Hit {
                file: "b.rs".into(),
                line: 2,
                name: "bar".into(),
                kind: "fn".into(),
                score: 0.3,
            },
        ];

        let output = serialize_array("r", &items);
        let lines: Vec<&str> = output.lines().collect();

        assert!(lines[0].contains("[2]"));
        assert_eq!(lines.len(), 3);

        let row1: Vec<&str> = lines[1].trim().split(',').collect();
        assert_eq!(row1[0], "a.rs");
        assert_eq!(row1[1], "1");
        assert_eq!(row1[2], "foo");
        assert_eq!(row1[3], "fn");
        assert_eq!(row1[4], "0.5");
    }
}

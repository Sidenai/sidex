//! Strict, BOM-aware text decoding helpers.
//!
//! Extension manifests (`package.json`, vsix-packaged metadata) written by
//! Windows tooling frequently begin with a UTF-8 byte-order mark (EF BB BF),
//! which `serde_json` rejects. Conversely, decoding with
//! `String::from_utf8_lossy` silently mojibakes invalid bytes (e.g. display
//! names) instead of surfacing an error. These helpers strip a leading BOM
//! and decode strictly, producing readable errors.

use std::path::Path;

/// UTF-8 byte-order mark.
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Decode `bytes` as strict UTF-8, tolerating (and stripping) a leading
/// UTF-8 BOM. Returns a readable error when the content is not valid UTF-8.
pub fn decode_utf8_strict(bytes: &[u8]) -> Result<&str, String> {
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    std::str::from_utf8(body).map_err(|e| {
        format!(
            "invalid UTF-8 at byte offset {}: content must be UTF-8 encoded",
            e.valid_up_to()
        )
    })
}

/// Read `path` and parse it as JSON into `T`, stripping a leading UTF-8 BOM
/// and decoding strictly. Errors carry the file path for context.
pub fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let text = decode_utf8_strict(&bytes).map_err(|e| format!("decode {}: {e}", path.display()))?;
    serde_json::from_str(text).map_err(|e| format!("parse {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_bom() {
        let bytes = b"\xEF\xBB\xBF{\"a\":1}";
        assert_eq!(decode_utf8_strict(bytes).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn passes_through_without_bom() {
        assert_eq!(decode_utf8_strict(b"hello").unwrap(), "hello");
    }

    #[test]
    fn rejects_invalid_utf8() {
        let err = decode_utf8_strict(b"ok\xFF\xFE").unwrap_err();
        assert!(err.contains("invalid UTF-8"));
    }

    #[test]
    fn empty_input_is_ok() {
        assert_eq!(decode_utf8_strict(b"").unwrap(), "");
    }

    #[test]
    fn bom_only_is_empty() {
        assert_eq!(decode_utf8_strict(b"\xEF\xBB\xBF").unwrap(), "");
    }
}

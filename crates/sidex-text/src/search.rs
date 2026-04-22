//! Find/replace engine with regex, whole-word, and case-preserving support.
//!
//! This module mirrors the search capabilities of Monaco's `FindModel` and
//! `TextModelSearch`, providing `find_all`, `find_next`, `find_previous`,
//! `replace_all`, and the full `find_matches` port of VS Code's
//! `TextModel.findMatches(searchString, searchScope, isRegex, matchCase,
//! wordSeparators, captureMatches)`.

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::edit::EditOperation;
use crate::{Buffer, Position, Range};

/// Maximum matches returned by [`find_matches`] by default (mirrors VS Code's
/// `LIMIT_FIND_COUNT`).
pub const LIMIT_FIND_COUNT: usize = 999;

/// Describes a search query with all Monaco-style options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[allow(clippy::struct_excessive_bools)]
pub struct SearchQuery {
    /// The search pattern (literal text or regex).
    pub pattern: String,
    /// Interpret `pattern` as a regular expression.
    pub is_regex: bool,
    /// Match case exactly (when `false`, search is case-insensitive).
    pub case_sensitive: bool,
    /// Match whole words only (word-boundary detection).
    pub whole_word: bool,
    /// When replacing, preserve the case style of the original match.
    pub preserve_case: bool,
}

impl SearchQuery {
    /// Creates a simple literal, case-sensitive search query.
    pub fn literal(pattern: impl Into<String>) -> Self {
        Self {
            pattern: pattern.into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            preserve_case: false,
        }
    }
}

/// A single search match (without capture groups).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchMatch {
    /// The range of the match in the buffer.
    pub range: Range,
    /// The matched text.
    pub text: String,
}

/// A search match with optional capture groups — mirrors VS Code's `FindMatch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindMatch {
    /// The range of the full match in the buffer.
    pub range: Range,
    /// Captured groups. `matches[0]` is the full match text, `matches[1..]`
    /// are capture groups. Empty when `capture_matches` is false.
    pub matches: Vec<String>,
}

/// Options for [`find_matches`], modelled after VS Code's
/// `TextModel.findMatches` parameters.
#[derive(Debug, Clone)]
pub struct FindMatchesOptions {
    /// The search string (literal or regex).
    pub search_string: String,
    /// Restrict search to these ranges. `None` = entire document.
    pub search_scope: Option<Vec<Range>>,
    /// Interpret `search_string` as a regex.
    pub is_regex: bool,
    /// Case-sensitive matching.
    pub match_case: bool,
    /// Word separator characters for whole-word matching. `None` disables
    /// whole-word matching.
    pub word_separators: Option<String>,
    /// Whether to capture groups.
    pub capture_matches: bool,
    /// Maximum number of results (defaults to [`LIMIT_FIND_COUNT`]).
    pub limit_result_count: usize,
}

impl Default for FindMatchesOptions {
    fn default() -> Self {
        Self {
            search_string: String::new(),
            search_scope: None,
            is_regex: false,
            match_case: true,
            word_separators: None,
            capture_matches: false,
            limit_result_count: LIMIT_FIND_COUNT,
        }
    }
}

// ── Internal helpers ─────────────────────────────────────────────────

fn build_regex(query: &SearchQuery) -> Option<Regex> {
    let mut pattern = if query.is_regex {
        query.pattern.clone()
    } else {
        regex::escape(&query.pattern)
    };

    if query.whole_word {
        pattern = format!(r"\b{pattern}\b");
    }

    RegexBuilder::new(&pattern)
        .case_insensitive(!query.case_sensitive)
        .build()
        .ok()
}

fn build_find_regex(opts: &FindMatchesOptions) -> Option<Regex> {
    if opts.search_string.is_empty() {
        return None;
    }

    let mut pattern = if opts.is_regex {
        opts.search_string.clone()
    } else {
        regex::escape(&opts.search_string)
    };

    if let Some(ref seps) = opts.word_separators {
        if !seps.is_empty() {
            pattern = format!(r"\b{pattern}\b");
        }
    }

    RegexBuilder::new(&pattern)
        .case_insensitive(!opts.match_case)
        .multi_line(true)
        .build()
        .ok()
}

/// Convert a byte offset in `text` to a `(line, column)` pair.
fn byte_offset_to_position(text: &str, byte_offset: usize) -> Position {
    let mut line: u32 = 0;
    let mut col: u32 = 0;
    for (i, c) in text.char_indices() {
        if i == byte_offset {
            return Position::new(line, col);
        }
        if c == '\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    Position::new(line, col)
}

/// Convert a `Position` to a byte offset in `text`.
fn position_to_byte_offset(text: &str, pos: Position) -> usize {
    let mut line: u32 = 0;
    let mut col: u32 = 0;
    for (i, c) in text.char_indices() {
        if line == pos.line && col == pos.column {
            return i;
        }
        if c == '\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    text.len()
}

fn collect_matches(text: &str, re: &Regex) -> Vec<SearchMatch> {
    re.find_iter(text)
        .map(|m| {
            let start = byte_offset_to_position(text, m.start());
            let end = byte_offset_to_position(text, m.end());
            SearchMatch {
                range: Range::new(start, end),
                text: m.as_str().to_string(),
            }
        })
        .collect()
}

// ── Case-preserving replace ──────────────────────────────────────────

/// Transfers the case pattern of `original` onto `replacement`.
///
/// Rules (matching Monaco):
/// - If `original` is all-uppercase → uppercase the replacement.
/// - If `original` starts with an uppercase letter and the rest is lowercase
///   → title-case the replacement.
/// - If `original` is all-lowercase → lowercase the replacement.
/// - Otherwise → return `replacement` unchanged.
fn case_preserving_replace(original: &str, replacement: &str) -> String {
    if original.is_empty() || replacement.is_empty() {
        return replacement.to_string();
    }

    let all_upper = original
        .chars()
        .all(|c| !c.is_alphabetic() || c.is_uppercase());
    let all_lower = original
        .chars()
        .all(|c| !c.is_alphabetic() || c.is_lowercase());

    if all_upper && original.chars().any(char::is_alphabetic) {
        return replacement.to_uppercase();
    }

    if all_lower {
        return replacement.to_lowercase();
    }

    // Title case: first alpha char is upper, rest lower.
    let first_alpha_upper = original
        .chars()
        .find(|c| c.is_alphabetic())
        .is_some_and(char::is_uppercase);
    let rest_lower = original
        .chars()
        .skip_while(|c| !c.is_alphabetic())
        .skip(1)
        .all(|c| !c.is_alphabetic() || c.is_lowercase());
    if first_alpha_upper && rest_lower {
        let mut result = String::with_capacity(replacement.len());
        let mut first = true;
        for c in replacement.chars() {
            if first && c.is_alphabetic() {
                result.extend(c.to_uppercase());
                first = false;
            } else {
                result.extend(c.to_lowercase());
            }
        }
        return result;
    }

    replacement.to_string()
}

// ── Public API ───────────────────────────────────────────────────────

// ── TextSearchEngine (standalone, buffer-free search) ────────────────

/// Standalone search options for the [`TextSearchEngine`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchOptions {
    /// Case-sensitive matching.
    pub case_sensitive: bool,
    /// Match whole words only.
    pub whole_word: bool,
    /// Interpret the query as a regular expression.
    pub regex: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            case_sensitive: true,
            whole_word: false,
            regex: false,
        }
    }
}

/// A single search match with optional capture groups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Match {
    /// Byte start offset in the searched text.
    pub start: usize,
    /// Byte end offset (exclusive) in the searched text.
    pub end: usize,
    /// Capture group byte ranges (for regex search). The first element is
    /// the full match, subsequent elements are capture groups.
    pub captures: Vec<(usize, usize)>,
}

/// A buffer-free text search engine operating on raw `&str`.
///
/// Use this for quick searches that don't need `Buffer` or `Position` types.
pub struct TextSearchEngine;

impl TextSearchEngine {
    /// Finds all non-overlapping matches of `query` in `text`.
    pub fn find_all(text: &str, query: &str, options: &SearchOptions) -> Vec<Match> {
        let Some(re) = Self::build_regex(query, options) else {
            return Vec::new();
        };
        if options.regex {
            re.captures_iter(text)
                .map(|caps| {
                    let full = caps.get(0).unwrap();
                    let mut captures = Vec::new();
                    for i in 0..caps.len() {
                        if let Some(g) = caps.get(i) {
                            captures.push((g.start(), g.end()));
                        }
                    }
                    Match {
                        start: full.start(),
                        end: full.end(),
                        captures,
                    }
                })
                .collect()
        } else {
            re.find_iter(text)
                .map(|m| Match {
                    start: m.start(),
                    end: m.end(),
                    captures: vec![(m.start(), m.end())],
                })
                .collect()
        }
    }

    /// Finds the next match at or after byte offset `from`.
    pub fn find_next(
        text: &str,
        query: &str,
        from: usize,
        options: &SearchOptions,
    ) -> Option<Match> {
        let re = Self::build_regex(query, options)?;
        re.find_at(text, from).map(|m| Match {
            start: m.start(),
            end: m.end(),
            captures: vec![(m.start(), m.end())],
        })
    }

    /// Finds the previous match ending before byte offset `from`.
    pub fn find_prev(
        text: &str,
        query: &str,
        from: usize,
        options: &SearchOptions,
    ) -> Option<Match> {
        let re = Self::build_regex(query, options)?;
        let search_text = if from <= text.len() {
            &text[..from]
        } else {
            text
        };
        re.find_iter(search_text).last().map(|m| Match {
            start: m.start(),
            end: m.end(),
            captures: vec![(m.start(), m.end())],
        })
    }

    /// Replaces a single match range with `replacement`.
    pub fn replace(text: &str, match_range: std::ops::Range<usize>, replacement: &str) -> String {
        let mut result = String::with_capacity(text.len() + replacement.len());
        result.push_str(&text[..match_range.start]);
        result.push_str(replacement);
        result.push_str(&text[match_range.end..]);
        result
    }

    /// Replaces all non-overlapping matches with `replacement`, returning
    /// the new string and the number of replacements made.
    pub fn replace_all(
        text: &str,
        query: &str,
        replacement: &str,
        options: &SearchOptions,
    ) -> (String, u32) {
        let Some(re) = Self::build_regex(query, options) else {
            return (text.to_string(), 0);
        };
        let mut count = 0u32;
        let result = re.replace_all(text, |_caps: &regex::Captures<'_>| {
            count += 1;
            replacement.to_string()
        });
        (result.into_owned(), count)
    }

    fn build_regex(query: &str, options: &SearchOptions) -> Option<Regex> {
        if query.is_empty() {
            return None;
        }
        let mut pattern = if options.regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        if options.whole_word {
            pattern = format!(r"\b{pattern}\b");
        }
        RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            .multi_line(true)
            .build()
            .ok()
    }
}

// ── Buffer-based search API ──────────────────────────────────────────

/// Finds all matches of `query` in `buffer`.
pub fn find_all(buffer: &Buffer, query: &SearchQuery) -> Vec<SearchMatch> {
    let Some(re) = build_regex(query) else {
        return Vec::new();
    };
    let text = buffer.text();
    collect_matches(&text, &re)
}

/// Finds the next match of `query` at or after `from`.
pub fn find_next(buffer: &Buffer, query: &SearchQuery, from: Position) -> Option<SearchMatch> {
    let re = build_regex(query)?;
    let text = buffer.text();
    let byte_start = position_to_byte_offset(&text, from);
    re.find_at(&text, byte_start).map(|m| {
        let start = byte_offset_to_position(&text, m.start());
        let end = byte_offset_to_position(&text, m.end());
        SearchMatch {
            range: Range::new(start, end),
            text: m.as_str().to_string(),
        }
    })
}

/// Finds the previous match of `query` before `from`.
pub fn find_previous(buffer: &Buffer, query: &SearchQuery, from: Position) -> Option<SearchMatch> {
    let re = build_regex(query)?;
    let text = buffer.text();
    let byte_end = position_to_byte_offset(&text, from);
    let search_text = &text[..byte_end];
    re.find_iter(search_text).last().map(|m| {
        let start = byte_offset_to_position(&text, m.start());
        let end = byte_offset_to_position(&text, m.end());
        SearchMatch {
            range: Range::new(start, end),
            text: m.as_str().to_string(),
        }
    })
}

/// Computes replacement [`EditOperation`]s for every match of `query`,
/// but does **not** apply them. The caller can inspect or apply them via
/// [`Buffer::apply_edits`].
pub fn replace_all(buffer: &Buffer, query: &SearchQuery, replacement: &str) -> Vec<EditOperation> {
    let matches = find_all(buffer, query);
    matches
        .iter()
        .map(|m| {
            let text = if query.preserve_case {
                case_preserving_replace(&m.text, replacement)
            } else {
                replacement.to_string()
            };
            EditOperation::replace(m.range, text)
        })
        .collect()
}

/// Full port of VS Code's `TextModel.findMatches`.
///
/// Supports regex, case sensitivity, word separators for whole-word matching,
/// optional capture groups, search scopes, and a result-count limit.
pub fn find_matches(buffer: &Buffer, opts: &FindMatchesOptions) -> Vec<FindMatch> {
    let Some(re) = build_find_regex(opts) else {
        return Vec::new();
    };

    let text = buffer.text();

    let scopes: Vec<Range> = match &opts.search_scope {
        Some(ranges) if !ranges.is_empty() => {
            let mut sorted = ranges.clone();
            sorted.sort_by_key(|r| r.start);
            sorted
        }
        _ => vec![buffer.get_full_model_range()],
    };

    let limit = opts.limit_result_count;
    let mut results = Vec::new();

    for scope in &scopes {
        if results.len() >= limit {
            break;
        }
        let scope_byte_start = position_to_byte_offset(&text, scope.start);
        let scope_byte_end = position_to_byte_offset(&text, scope.end);
        let scope_text = &text[scope_byte_start..scope_byte_end];

        if opts.capture_matches {
            for caps in re.captures_iter(scope_text) {
                if results.len() >= limit {
                    break;
                }
                let full = caps.get(0).unwrap();
                let abs_start = scope_byte_start + full.start();
                let abs_end = scope_byte_start + full.end();
                let start_pos = byte_offset_to_position(&text, abs_start);
                let end_pos = byte_offset_to_position(&text, abs_end);

                let mut groups = Vec::new();
                for i in 0..caps.len() {
                    groups.push(
                        caps.get(i)
                            .map_or(String::new(), |m| m.as_str().to_string()),
                    );
                }

                results.push(FindMatch {
                    range: Range::new(start_pos, end_pos),
                    matches: groups,
                });
            }
        } else {
            for m in re.find_iter(scope_text) {
                if results.len() >= limit {
                    break;
                }
                let abs_start = scope_byte_start + m.start();
                let abs_end = scope_byte_start + m.end();
                let start_pos = byte_offset_to_position(&text, abs_start);
                let end_pos = byte_offset_to_position(&text, abs_end);

                results.push(FindMatch {
                    range: Range::new(start_pos, end_pos),
                    matches: Vec::new(),
                });
            }
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(line: u32, col: u32) -> Position {
        Position::new(line, col)
    }

    // ── find_all ─────────────────────────────────────────────────────

    #[test]
    fn find_all_literal() {
        let buf = Buffer::from_str("hello world hello");
        let q = SearchQuery::literal("hello");
        let matches = find_all(&buf, &q);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].range.start, pos(0, 0));
        assert_eq!(matches[0].range.end, pos(0, 5));
        assert_eq!(matches[1].range.start, pos(0, 12));
    }

    #[test]
    fn find_all_case_insensitive() {
        let buf = Buffer::from_str("Hello HELLO hello");
        let q = SearchQuery {
            pattern: "hello".into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            preserve_case: false,
        };
        let matches = find_all(&buf, &q);
        assert_eq!(matches.len(), 3);
    }

    #[test]
    fn find_all_whole_word() {
        let buf = Buffer::from_str("hello helloworld hello");
        let q = SearchQuery {
            pattern: "hello".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: true,
            preserve_case: false,
        };
        let matches = find_all(&buf, &q);
        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn find_all_regex() {
        let buf = Buffer::from_str("foo123 bar456 baz");
        let q = SearchQuery {
            pattern: r"[a-z]+\d+".into(),
            is_regex: true,
            case_sensitive: true,
            whole_word: false,
            preserve_case: false,
        };
        let matches = find_all(&buf, &q);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].text, "foo123");
        assert_eq!(matches[1].text, "bar456");
    }

    #[test]
    fn find_all_multiline() {
        let buf = Buffer::from_str("line1 match\nline2\nline3 match");
        let q = SearchQuery::literal("match");
        let matches = find_all(&buf, &q);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].range.start, pos(0, 6));
        assert_eq!(matches[1].range.start, pos(2, 6));
    }

    #[test]
    fn find_all_no_matches() {
        let buf = Buffer::from_str("hello world");
        let q = SearchQuery::literal("xyz");
        let matches = find_all(&buf, &q);
        assert!(matches.is_empty());
    }

    #[test]
    fn find_all_empty_pattern() {
        let buf = Buffer::from_str("hello");
        let q = SearchQuery::literal("");
        let matches = find_all(&buf, &q);
        // Empty regex matches at every position
        assert!(!matches.is_empty());
    }

    // ── find_next ────────────────────────────────────────────────────

    #[test]
    fn find_next_from_start() {
        let buf = Buffer::from_str("aaa bbb aaa");
        let q = SearchQuery::literal("aaa");
        let m = find_next(&buf, &q, pos(0, 0));
        assert_eq!(m.unwrap().range.start, pos(0, 0));
    }

    #[test]
    fn find_next_from_middle() {
        let buf = Buffer::from_str("aaa bbb aaa");
        let q = SearchQuery::literal("aaa");
        let m = find_next(&buf, &q, pos(0, 1));
        assert_eq!(m.unwrap().range.start, pos(0, 8));
    }

    #[test]
    fn find_next_no_more() {
        let buf = Buffer::from_str("aaa bbb");
        let q = SearchQuery::literal("aaa");
        let m = find_next(&buf, &q, pos(0, 4));
        assert!(m.is_none());
    }

    // ── find_previous ────────────────────────────────────────────────

    #[test]
    fn find_previous_from_end() {
        let buf = Buffer::from_str("aaa bbb aaa");
        let q = SearchQuery::literal("aaa");
        let m = find_previous(&buf, &q, pos(0, 11));
        assert_eq!(m.unwrap().range.start, pos(0, 8));
    }

    #[test]
    fn find_previous_from_middle() {
        let buf = Buffer::from_str("aaa bbb aaa");
        let q = SearchQuery::literal("aaa");
        let m = find_previous(&buf, &q, pos(0, 7));
        assert_eq!(m.unwrap().range.start, pos(0, 0));
    }

    #[test]
    fn find_previous_none() {
        let buf = Buffer::from_str("bbb aaa");
        let q = SearchQuery::literal("aaa");
        let m = find_previous(&buf, &q, pos(0, 3));
        assert!(m.is_none());
    }

    // ── replace_all ──────────────────────────────────────────────────

    #[test]
    fn replace_all_literal() {
        let mut buf = Buffer::from_str("foo bar foo");
        let q = SearchQuery::literal("foo");
        let ops = replace_all(&buf, &q, "baz");
        assert_eq!(ops.len(), 2);
        buf.apply_edits(&ops);
        assert_eq!(buf.text(), "baz bar baz");
    }

    #[test]
    fn replace_all_case_preserving() {
        let buf = Buffer::from_str("Hello HELLO hello");
        let q = SearchQuery {
            pattern: "hello".into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            preserve_case: true,
        };
        let ops = replace_all(&buf, &q, "world");
        assert_eq!(ops[0].text, "World");
        assert_eq!(ops[1].text, "WORLD");
        assert_eq!(ops[2].text, "world");
    }

    #[test]
    fn replace_all_regex() {
        let mut buf = Buffer::from_str("a1 b2 c3");
        let q = SearchQuery {
            pattern: r"\d".into(),
            is_regex: true,
            case_sensitive: true,
            whole_word: false,
            preserve_case: false,
        };
        let ops = replace_all(&buf, &q, "X");
        buf.apply_edits(&ops);
        assert_eq!(buf.text(), "aX bX cX");
    }

    // ── case_preserving_replace ──────────────────────────────────────

    #[test]
    fn case_preserve_upper() {
        assert_eq!(case_preserving_replace("FOO", "bar"), "BAR");
    }

    #[test]
    fn case_preserve_lower() {
        assert_eq!(case_preserving_replace("foo", "BAR"), "bar");
    }

    #[test]
    fn case_preserve_title() {
        assert_eq!(case_preserving_replace("Foo", "bar"), "Bar");
    }

    #[test]
    fn case_preserve_mixed() {
        assert_eq!(case_preserving_replace("fOo", "bar"), "bar");
    }

    // ── byte_offset_to_position ──────────────────────────────────────

    #[test]
    fn byte_offset_position_multiline() {
        let text = "abc\ndef\nghi";
        assert_eq!(byte_offset_to_position(text, 0), pos(0, 0));
        assert_eq!(byte_offset_to_position(text, 4), pos(1, 0));
        assert_eq!(byte_offset_to_position(text, 8), pos(2, 0));
        assert_eq!(byte_offset_to_position(text, 10), pos(2, 2));
    }

    #[test]
    fn position_to_byte_offset_multiline() {
        let text = "abc\ndef\nghi";
        assert_eq!(position_to_byte_offset(text, pos(0, 0)), 0);
        assert_eq!(position_to_byte_offset(text, pos(1, 0)), 4);
        assert_eq!(position_to_byte_offset(text, pos(2, 2)), 10);
    }

    // ── find_matches ────────────────────────────────────────────────────

    #[test]
    fn find_matches_literal() {
        let buf = Buffer::from_str("hello world hello");
        let opts = FindMatchesOptions {
            search_string: "hello".into(),
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].range.start, pos(0, 0));
        assert_eq!(results[1].range.start, pos(0, 12));
    }

    #[test]
    fn find_matches_case_insensitive() {
        let buf = Buffer::from_str("Hello HELLO hello");
        let opts = FindMatchesOptions {
            search_string: "hello".into(),
            match_case: false,
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn find_matches_regex_with_captures() {
        let buf = Buffer::from_str("foo123 bar456");
        let opts = FindMatchesOptions {
            search_string: r"([a-z]+)(\d+)".into(),
            is_regex: true,
            capture_matches: true,
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].matches.len(), 3);
        assert_eq!(results[0].matches[0], "foo123");
        assert_eq!(results[0].matches[1], "foo");
        assert_eq!(results[0].matches[2], "123");
    }

    #[test]
    fn find_matches_scoped() {
        let buf = Buffer::from_str("aaa bbb aaa ccc aaa");
        let scope = Range::new(pos(0, 4), pos(0, 15));
        let opts = FindMatchesOptions {
            search_string: "aaa".into(),
            search_scope: Some(vec![scope]),
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].range.start, pos(0, 8));
    }

    #[test]
    fn find_matches_limit() {
        let buf = Buffer::from_str("a a a a a a a a a a");
        let opts = FindMatchesOptions {
            search_string: "a".into(),
            limit_result_count: 3,
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn find_matches_whole_word() {
        let buf = Buffer::from_str("cat caterpillar cat");
        let opts = FindMatchesOptions {
            search_string: "cat".into(),
            word_separators: Some(" ".into()),
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn find_matches_no_captures() {
        let buf = Buffer::from_str("test123");
        let opts = FindMatchesOptions {
            search_string: r"(\w+)(\d+)".into(),
            is_regex: true,
            capture_matches: false,
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert_eq!(results.len(), 1);
        assert!(results[0].matches.is_empty());
    }

    #[test]
    fn find_matches_multiline() {
        let buf = Buffer::from_str("line1 match\nline2\nline3 match");
        let opts = FindMatchesOptions {
            search_string: "match".into(),
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].range.start, pos(0, 6));
        assert_eq!(results[1].range.start, pos(2, 6));
    }

    #[test]
    fn find_matches_empty_string() {
        let buf = Buffer::from_str("hello");
        let opts = FindMatchesOptions {
            search_string: String::new(),
            ..Default::default()
        };
        let results = find_matches(&buf, &opts);
        assert!(results.is_empty());
    }

    // ── TextSearchEngine ─────────────────────────────────────────────

    #[test]
    fn engine_find_all_literal() {
        let opts = SearchOptions::default();
        let matches = TextSearchEngine::find_all("hello world hello", "hello", &opts);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].start, 0);
        assert_eq!(matches[0].end, 5);
        assert_eq!(matches[1].start, 12);
    }

    #[test]
    fn engine_find_all_case_insensitive() {
        let opts = SearchOptions {
            case_sensitive: false,
            ..Default::default()
        };
        let matches = TextSearchEngine::find_all("Hello HELLO hello", "hello", &opts);
        assert_eq!(matches.len(), 3);
    }

    #[test]
    fn engine_find_all_whole_word() {
        let opts = SearchOptions {
            whole_word: true,
            ..Default::default()
        };
        let matches = TextSearchEngine::find_all("hello helloworld hello", "hello", &opts);
        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn engine_find_all_regex_captures() {
        let opts = SearchOptions {
            regex: true,
            ..Default::default()
        };
        let matches = TextSearchEngine::find_all("foo123 bar456", r"([a-z]+)(\d+)", &opts);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].captures.len(), 3);
    }

    #[test]
    fn engine_find_next_from_offset() {
        let opts = SearchOptions::default();
        let m = TextSearchEngine::find_next("aaa bbb aaa", "aaa", 1, &opts);
        assert!(m.is_some());
        assert_eq!(m.unwrap().start, 8);
    }

    #[test]
    fn engine_find_prev() {
        let opts = SearchOptions::default();
        let m = TextSearchEngine::find_prev("aaa bbb aaa", "aaa", 11, &opts);
        assert!(m.is_some());
        assert_eq!(m.unwrap().start, 8);
    }

    #[test]
    fn engine_replace_single() {
        let result = TextSearchEngine::replace("hello world", 6..11, "rust");
        assert_eq!(result, "hello rust");
    }

    #[test]
    fn engine_replace_all() {
        let opts = SearchOptions::default();
        let (result, count) = TextSearchEngine::replace_all("foo bar foo", "foo", "baz", &opts);
        assert_eq!(result, "baz bar baz");
        assert_eq!(count, 2);
    }

    #[test]
    fn engine_replace_all_no_match() {
        let opts = SearchOptions::default();
        let (result, count) = TextSearchEngine::replace_all("hello", "xyz", "abc", &opts);
        assert_eq!(result, "hello");
        assert_eq!(count, 0);
    }

    #[test]
    fn engine_find_all_empty_returns_empty() {
        let opts = SearchOptions::default();
        let matches = TextSearchEngine::find_all("hello", "", &opts);
        assert!(matches.is_empty());
    }
}

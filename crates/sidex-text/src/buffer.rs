/// The core text buffer backed by a [`ropey::Rope`].
///
/// `Buffer` is the central data structure for text storage and manipulation.
/// It provides efficient insert, delete, and replace operations on large
/// documents, along with position/offset conversions and UTF-16 support
/// for LSP interoperability.
use std::borrow::Cow;
use std::io::Read;
use std::ops::Range as StdRange;
use std::sync::Arc;

use ropey::Rope;
use serde::{Deserialize, Serialize};

use crate::edit::{ChangeEvent, EditOperation};
use crate::line_ending::{detect_line_ending, normalize_line_endings, LineEnding};
use crate::utf16::{
    char_col_to_utf16_col, lsp_position_to_position, position_to_lsp_position,
    utf16_col_to_char_col, Utf16Position,
};
use crate::Position;

/// Classification of a word token within a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WordType {
    /// An alphanumeric/identifier word.
    Word,
    /// Whitespace between tokens.
    Whitespace,
    /// Punctuation / separator characters.
    Separator,
}

/// A word (or whitespace / separator run) extracted from a line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordInfo {
    /// The text of the word.
    pub text: String,
    /// Start column (char offset within the line).
    pub start_column: u32,
    /// End column (exclusive, char offset).
    pub end_column: u32,
    /// The type of this token.
    pub word_type: WordType,
}

/// A word at a position in the buffer — mirrors VS Code's `IWordAtPosition`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordAtPosition {
    /// The word text.
    pub word: String,
    /// Start column of the word on its line (0-based char offset).
    pub start_column: u32,
    /// End column of the word on its line (exclusive, 0-based char offset).
    pub end_column: u32,
}

/// Information about a buffer's detected indentation style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndentInfo {
    /// `true` if the predominant indentation uses tabs.
    pub use_tabs: bool,
    /// The detected indentation size (in spaces, or 1 for tabs).
    pub tab_size: u32,
}

/// Information about an active indent guide for a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndentGuide {
    /// The column (0-based) where the guide is drawn.
    pub column: u32,
    /// The indent level (0-based) this guide represents.
    pub indent_level: u32,
    /// The first line of the indented block this guide belongs to.
    pub start_line: u32,
    /// The last line of the indented block this guide belongs to.
    pub end_line: u32,
}

/// The result of applying a single edit, including the inverse edit for undo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditResult {
    /// The range in the buffer after the edit was applied.
    pub range: crate::Range,
    /// The text that was inserted.
    pub text: String,
    /// An edit that, when applied, undoes this edit.
    pub inverse_edit: EditOperation,
}

/// An immutable, cheaply-clonable snapshot of a [`Buffer`] at a point in time.
///
/// Backed by `Arc<Rope>` so clones are O(1). Useful for handing to background
/// threads (syntax highlighting, search, diff) without blocking the editor.
#[derive(Debug, Clone)]
pub struct BufferSnapshot {
    rope: Arc<Rope>,
}

impl BufferSnapshot {
    /// Total characters in the snapshot.
    pub fn len_chars(&self) -> usize {
        self.rope.len_chars()
    }

    /// Total bytes in the snapshot.
    pub fn len_bytes(&self) -> usize {
        self.rope.len_bytes()
    }

    /// Number of lines in the snapshot.
    pub fn len_lines(&self) -> usize {
        self.rope.len_lines()
    }

    /// Whether the snapshot is empty.
    pub fn is_empty(&self) -> bool {
        self.rope.len_chars() == 0
    }

    /// Line content (including trailing newline) as `Cow<str>`.
    pub fn line(&self, line_idx: usize) -> Cow<'_, str> {
        self.rope.line(line_idx).into()
    }

    /// Line content without trailing newline.
    pub fn line_content(&self, line_idx: usize) -> String {
        let line: Cow<'_, str> = self.rope.line(line_idx).into();
        line.trim_end_matches(&['\n', '\r'][..]).to_string()
    }

    /// Full text content of the snapshot.
    pub fn text(&self) -> String {
        String::from(self.rope.as_ref())
    }

    /// Substring by character range.
    pub fn slice(&self, range: StdRange<usize>) -> String {
        let slice = self.rope.slice(range);
        Cow::<str>::from(slice).into_owned()
    }

    /// Character offset to line index.
    pub fn char_to_line(&self, char_idx: usize) -> usize {
        self.rope.char_to_line(char_idx)
    }

    /// Line index to character offset.
    pub fn line_to_char(&self, line_idx: usize) -> usize {
        self.rope.line_to_char(line_idx)
    }

    /// Character offset to [`Position`].
    pub fn offset_to_position(&self, char_offset: usize) -> Position {
        let line = self.rope.char_to_line(char_offset);
        let line_start = self.rope.line_to_char(line);
        let column = char_offset - line_start;
        #[allow(clippy::cast_possible_truncation)]
        Position::new(line as u32, column as u32)
    }

    /// [`Position`] to character offset.
    pub fn position_to_offset(&self, pos: Position) -> usize {
        let line_start = self.rope.line_to_char(pos.line as usize);
        line_start + pos.column as usize
    }
}

/// A rope-backed text buffer with efficient editing of large documents.
#[derive(Debug, Clone)]
pub struct Buffer {
    rope: Rope,
    /// The line ending style for this buffer.
    eol: LineEnding,
}

impl Buffer {
    /// Creates a new, empty buffer.
    #[must_use]
    pub fn new() -> Self {
        Self {
            rope: Rope::new(),
            eol: LineEnding::Lf,
        }
    }

    /// Creates a buffer from the given string.
    #[must_use]
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        let eol = detect_line_ending(s);
        Self {
            rope: Rope::from_str(s),
            eol,
        }
    }

    /// Creates a buffer by reading from the given reader.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the reader fails.
    pub fn from_reader(reader: impl Read) -> std::io::Result<Self> {
        let rope = Rope::from_reader(reader)?;
        let sample: String = rope.slice(..rope.len_chars().min(10_000)).into();
        let eol = detect_line_ending(&sample);
        Ok(Self { rope, eol })
    }

    /// Returns the total number of characters (Unicode scalar values) in the buffer.
    #[must_use]
    pub fn len_chars(&self) -> usize {
        self.rope.len_chars()
    }

    /// Returns the total number of bytes in the buffer.
    #[must_use]
    pub fn len_bytes(&self) -> usize {
        self.rope.len_bytes()
    }

    /// Returns the number of lines in the buffer.
    ///
    /// A buffer always has at least one line (even when empty).
    #[must_use]
    pub fn len_lines(&self) -> usize {
        self.rope.len_lines()
    }

    /// Returns `true` if the buffer contains no text.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rope.len_chars() == 0
    }

    /// Returns the text content of the given line as a `Cow<str>`.
    ///
    /// # Panics
    ///
    /// Panics if `line_idx` is out of bounds.
    #[must_use]
    pub fn line(&self, line_idx: usize) -> Cow<'_, str> {
        self.rope.line(line_idx).into()
    }

    /// Returns the text content of the given line without trailing newline.
    #[must_use]
    pub fn line_content(&self, line_idx: usize) -> String {
        let line: Cow<'_, str> = self.rope.line(line_idx).into();
        line.trim_end_matches(&['\n', '\r'][..]).to_string()
    }

    /// Returns the number of content characters in the given line (excluding
    /// trailing newline).
    #[must_use]
    pub fn line_content_len(&self, line_idx: usize) -> usize {
        self.line_content(line_idx).chars().count()
    }

    /// Returns the line index for the given character offset.
    ///
    /// # Panics
    ///
    /// Panics if `char_idx` is out of bounds (greater than `len_chars()`).
    #[must_use]
    pub fn char_to_line(&self, char_idx: usize) -> usize {
        self.rope.char_to_line(char_idx)
    }

    /// Returns the character offset for the start of the given line.
    ///
    /// # Panics
    ///
    /// Panics if `line_idx` is out of bounds.
    #[must_use]
    pub fn line_to_char(&self, line_idx: usize) -> usize {
        self.rope.line_to_char(line_idx)
    }

    /// Returns the byte offset for the given character offset.
    ///
    /// # Panics
    ///
    /// Panics if `char_idx` is out of bounds.
    #[must_use]
    pub fn char_to_byte(&self, char_idx: usize) -> usize {
        self.rope.char_to_byte(char_idx)
    }

    /// Returns a `String` of the text in the given character range.
    ///
    /// # Panics
    ///
    /// Panics if the range is out of bounds.
    #[must_use]
    pub fn slice(&self, range: StdRange<usize>) -> String {
        let slice = self.rope.slice(range);
        Cow::<str>::from(slice).into_owned()
    }

    /// Returns the full text content of the buffer as a `String`.
    ///
    /// Prefer [`slice`](Buffer::slice) or [`line`](Buffer::line) for large
    /// buffers to avoid allocating the entire document.
    #[must_use]
    pub fn text(&self) -> String {
        String::from(&self.rope)
    }

    /// Inserts `text` at the given character offset.
    ///
    /// # Panics
    ///
    /// Panics if `char_idx` is out of bounds.
    pub fn insert(&mut self, char_idx: usize, text: &str) {
        self.rope.insert(char_idx, text);
    }

    /// Removes the text in the given character range.
    ///
    /// # Panics
    ///
    /// Panics if the range is out of bounds.
    pub fn remove(&mut self, range: StdRange<usize>) {
        self.rope.remove(range);
    }

    /// Replaces the text in the given character range with `text`.
    ///
    /// # Panics
    ///
    /// Panics if the range is out of bounds.
    pub fn replace(&mut self, range: StdRange<usize>, text: &str) {
        self.rope.remove(range.clone());
        self.rope.insert(range.start, text);
    }

    /// Returns the number of characters in the given line (including any
    /// trailing newline).
    ///
    /// # Panics
    ///
    /// Panics if `line_idx` is out of bounds.
    #[must_use]
    pub fn line_len_chars(&self, line_idx: usize) -> usize {
        self.rope.line(line_idx).len_chars()
    }

    // ── Position/offset conversion ───────────────────────────────────

    /// Converts a character offset to a [`Position`].
    ///
    /// # Panics
    ///
    /// Panics if `char_offset` is out of bounds.
    #[must_use]
    pub fn offset_to_position(&self, char_offset: usize) -> Position {
        let line = self.rope.char_to_line(char_offset);
        let line_start = self.rope.line_to_char(line);
        let column = char_offset - line_start;
        #[allow(clippy::cast_possible_truncation)]
        Position::new(line as u32, column as u32)
    }

    /// Converts a [`Position`] to a character offset.
    ///
    /// # Panics
    ///
    /// Panics if the position is out of bounds.
    #[must_use]
    pub fn position_to_offset(&self, pos: Position) -> usize {
        let line_start = self.rope.line_to_char(pos.line as usize);
        line_start + pos.column as usize
    }

    // ── Edit operations ──────────────────────────────────────────────

    /// Applies a single [`EditOperation`] to the buffer, returning a
    /// [`ChangeEvent`] describing what changed.
    pub fn apply_edit(&mut self, edit: &EditOperation) -> ChangeEvent {
        let start_offset = self.position_to_offset(edit.range.start);
        let end_offset = self.position_to_offset(edit.range.end);
        let range_length = end_offset - start_offset;

        if start_offset != end_offset {
            self.rope.remove(start_offset..end_offset);
        }
        if !edit.text.is_empty() {
            self.rope.insert(start_offset, &edit.text);
        }

        ChangeEvent {
            range: edit.range,
            text: edit.text.clone(),
            range_length,
        }
    }

    /// Applies multiple non-overlapping [`EditOperation`]s to the buffer.
    ///
    /// Edits are applied in reverse document order so that earlier offsets
    /// remain valid as later edits are applied.
    pub fn apply_edits(&mut self, edits: &[EditOperation]) -> Vec<ChangeEvent> {
        let mut sorted: Vec<&EditOperation> = edits.iter().collect();
        sorted.sort_by_key(|e| std::cmp::Reverse(e.range.start));
        sorted.iter().map(|edit| self.apply_edit(edit)).collect()
    }

    // ── UTF-16 support ───────────────────────────────────────────────

    /// Converts a UTF-16 column offset on a given line to an absolute
    /// character offset in the buffer.
    ///
    /// # Panics
    ///
    /// Panics if `line` is out of bounds.
    #[must_use]
    pub fn utf16_offset_to_char(&self, line: usize, utf16_col: usize) -> usize {
        let line_text: Cow<'_, str> = self.rope.line(line).into();
        let char_col = utf16_col_to_char_col(&line_text, utf16_col);
        self.rope.line_to_char(line) + char_col
    }

    /// Converts a character column offset on a given line to a UTF-16
    /// column offset.
    ///
    /// # Panics
    ///
    /// Panics if `line` is out of bounds.
    #[must_use]
    pub fn char_to_utf16_offset(&self, line: usize, char_col: usize) -> usize {
        let line_text: Cow<'_, str> = self.rope.line(line).into();
        char_col_to_utf16_col(&line_text, char_col)
    }

    /// Converts an LSP [`Utf16Position`] to a buffer [`Position`].
    ///
    /// # Panics
    ///
    /// Panics if the line is out of bounds.
    #[must_use]
    pub fn lsp_position_to_position(&self, lsp_pos: Utf16Position) -> Position {
        let line_text: Cow<'_, str> = self.rope.line(lsp_pos.line as usize).into();
        lsp_position_to_position(&line_text, lsp_pos)
    }

    /// Converts a buffer [`Position`] to an LSP [`Utf16Position`].
    ///
    /// # Panics
    ///
    /// Panics if the position's line is out of bounds.
    #[must_use]
    pub fn position_to_lsp_position(&self, pos: Position) -> Utf16Position {
        let line_text: Cow<'_, str> = self.rope.line(pos.line as usize).into();
        position_to_lsp_position(&line_text, pos)
    }

    // ── Word segmentation ────────────────────────────────────────────

    /// Returns word-level segmentation for the given line.
    ///
    /// Each contiguous run of alphanumeric/identifier chars, whitespace, or
    /// punctuation is returned as a [`WordInfo`].
    #[must_use]
    pub fn words_at(&self, line_idx: usize) -> Vec<WordInfo> {
        let content = self.line_content(line_idx);
        segment_words(&content)
    }

    // ── Indentation ──────────────────────────────────────────────────

    /// Returns the indentation level of the given line.
    ///
    /// Tabs count as 1 level each; spaces are grouped by 4 (configurable via
    /// [`detect_indentation`]).
    #[must_use]
    pub fn indent_level(&self, line_idx: usize) -> u32 {
        let info = self.detect_indentation();
        let prefix = self.indent_string_owned(line_idx);
        if info.use_tabs {
            #[allow(clippy::cast_possible_truncation)]
            let count = prefix.chars().filter(|&c| c == '\t').count() as u32;
            count
        } else {
            #[allow(clippy::cast_possible_truncation)]
            let spaces: u32 = prefix.chars().filter(|&c| c == ' ').count() as u32;
            spaces.checked_div(info.tab_size).unwrap_or(0)
        }
    }

    /// Returns the whitespace prefix of the given line.
    #[must_use]
    pub fn indent_string(&self, line_idx: usize) -> String {
        self.indent_string_owned(line_idx)
    }

    fn indent_string_owned(&self, line_idx: usize) -> String {
        let content = self.line_content(line_idx);
        content.chars().take_while(|c| c.is_whitespace()).collect()
    }

    /// Detect indentation style (tabs vs spaces) and size from buffer content.
    ///
    /// Scans up to the first 10 000 lines, looking at leading whitespace to
    /// determine the predominant style.
    #[must_use]
    pub fn detect_indentation(&self) -> IndentInfo {
        let max_lines = self.len_lines().min(10_000);
        let mut tab_lines = 0u32;
        let mut space_lines = 0u32;
        let mut space_diffs = [0u32; 9]; // index 1..=8

        let mut prev_spaces: Option<u32> = None;

        for i in 0..max_lines {
            let content = self.line_content(i);
            let first = content.chars().next();
            match first {
                Some('\t') => {
                    tab_lines += 1;
                    prev_spaces = None;
                }
                Some(' ') => {
                    #[allow(clippy::cast_possible_truncation)]
                    let n = content.chars().take_while(|&c| c == ' ').count() as u32;
                    if n > 0 && !content.trim().is_empty() {
                        space_lines += 1;
                        if let Some(prev) = prev_spaces {
                            let diff = n.abs_diff(prev);
                            if (1..=8).contains(&diff) {
                                space_diffs[diff as usize] += 1;
                            }
                        }
                        prev_spaces = Some(n);
                    }
                }
                _ => {
                    prev_spaces = None;
                }
            }
        }

        if tab_lines > space_lines {
            return IndentInfo {
                use_tabs: true,
                tab_size: 4,
            };
        }

        // Find the most common space-indent delta
        let best = space_diffs
            .iter()
            .enumerate()
            .skip(1)
            .max_by_key(|(_, &count)| count)
            .map_or(4, |(size, _)| {
                #[allow(clippy::cast_possible_truncation)]
                let s = size as u32;
                s
            });

        IndentInfo {
            use_tabs: false,
            tab_size: if best == 0 { 4 } else { best },
        }
    }

    // ── Line queries ─────────────────────────────────────────────────

    /// Returns `true` if the line is empty or contains only whitespace.
    #[must_use]
    pub fn line_is_empty(&self, line_idx: usize) -> bool {
        self.line_content(line_idx).trim().is_empty()
    }

    /// Returns `true` if the line (after trimming leading whitespace) starts
    /// with `comment_prefix`.
    #[must_use]
    pub fn line_is_comment(&self, line_idx: usize, comment_prefix: &str) -> bool {
        self.line_content(line_idx)
            .trim_start()
            .starts_with(comment_prefix)
    }

    // ── Bracket matching ─────────────────────────────────────────────

    /// Finds the matching bracket for the bracket at `pos`.
    ///
    /// `brackets` is a slice of (open, close) pairs to match against.
    /// Returns `None` if the character at `pos` is not a bracket or no match
    /// is found.
    #[must_use]
    pub fn find_matching_bracket(
        &self,
        pos: Position,
        brackets: &[(char, char)],
    ) -> Option<Position> {
        let offset = self.position_to_offset(pos);
        if offset >= self.len_chars() {
            return None;
        }
        let ch = self.slice(offset..offset + 1).chars().next()?;

        // Is it an open bracket?
        for &(open, close) in brackets {
            if ch == open {
                return self.find_bracket_forward(offset, open, close);
            }
            if ch == close {
                return self.find_bracket_backward(offset, open, close);
            }
        }
        None
    }

    fn find_bracket_forward(&self, start: usize, open: char, close: char) -> Option<Position> {
        let text = self.text();
        let mut depth: i32 = 0;
        for (i, c) in text
            .char_indices()
            .map(|(byte_idx, c)| (text[..byte_idx].chars().count(), c))
        {
            if i < start {
                continue;
            }
            if c == open {
                depth += 1;
            } else if c == close {
                depth -= 1;
                if depth == 0 {
                    return Some(self.offset_to_position(i));
                }
            }
        }
        None
    }

    fn find_bracket_backward(&self, start: usize, open: char, close: char) -> Option<Position> {
        let text = self.text();
        let chars: Vec<char> = text.chars().collect();
        let mut depth: i32 = 0;
        for i in (0..=start).rev() {
            let c = chars[i];
            if c == close {
                depth += 1;
            } else if c == open {
                depth -= 1;
                if depth == 0 {
                    return Some(self.offset_to_position(i));
                }
            }
        }
        None
    }

    /// Text-based bracket matching that skips string literals and comments.
    ///
    /// This is a heuristic for when no tree-sitter parser is available.
    /// It tracks single-quoted, double-quoted, backtick strings, and
    /// `//` line-comments / `/* */` block-comments so brackets inside
    /// them are ignored.
    #[must_use]
    pub fn find_matching_bracket_smart(
        &self,
        pos: Position,
        brackets: &[(char, char)],
    ) -> Option<Position> {
        let offset = self.position_to_offset(pos);
        if offset >= self.len_chars() {
            return None;
        }
        let ch = self.slice(offset..offset + 1).chars().next()?;

        for &(open, close) in brackets {
            if ch == open {
                return self.find_bracket_forward_smart(offset, open, close);
            }
            if ch == close {
                return self.find_bracket_backward_smart(offset, open, close);
            }
        }
        None
    }

    fn find_bracket_forward_smart(
        &self,
        start: usize,
        open: char,
        close: char,
    ) -> Option<Position> {
        let chars: Vec<char> = self.text().chars().collect();
        let len = chars.len();
        let mut depth: i32 = 0;
        let mut i = start;
        while i < len {
            let c = chars[i];
            if c == '"' || c == '\'' || c == '`' {
                i = skip_string_forward(&chars, i, c);
                continue;
            }
            if c == '/' && i + 1 < len {
                if chars[i + 1] == '/' {
                    while i < len && chars[i] != '\n' {
                        i += 1;
                    }
                    continue;
                }
                if chars[i + 1] == '*' {
                    i += 2;
                    while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                        i += 1;
                    }
                    i += 2;
                    continue;
                }
            }
            if c == open {
                depth += 1;
            } else if c == close {
                depth -= 1;
                if depth == 0 {
                    return Some(self.offset_to_position(i));
                }
            }
            i += 1;
        }
        None
    }

    fn find_bracket_backward_smart(
        &self,
        start: usize,
        open: char,
        close: char,
    ) -> Option<Position> {
        let chars: Vec<char> = self.text().chars().collect();
        let mut depth: i32 = 0;
        let mut i: usize = start;
        loop {
            let c = chars[i];
            if c == '"' || c == '\'' || c == '`' {
                let ni = skip_string_backward(&chars, i, c);
                if ni == 0 {
                    return None;
                }
                i = ni - 1;
                continue;
            }
            if c == '/' && i >= 1 && chars[i - 1] == '*' {
                if i < 2 {
                    return None;
                }
                i -= 2;
                while i >= 1 && !(chars[i] == '/' && chars[i + 1] == '*') {
                    i -= 1;
                }
                if i == 0 {
                    return None;
                }
                i -= 1;
                continue;
            }
            if c == close {
                depth += 1;
            } else if c == open {
                depth -= 1;
                if depth == 0 {
                    return Some(self.offset_to_position(i));
                }
            }
            if i == 0 {
                break;
            }
            i -= 1;
        }
        None
    }

    /// Heuristic: should the editor auto-close a bracket pair at `pos`?
    ///
    /// Returns `true` when the character after the cursor is whitespace, a
    /// closing bracket, or end-of-line — the same heuristic Monaco uses.
    #[must_use]
    pub fn auto_close_pair(&self, pos: Position, _open: char, close: char) -> bool {
        let offset = self.position_to_offset(pos);
        if offset >= self.len_chars() {
            return true;
        }
        let next_char = self.slice(offset..offset + 1).chars().next();
        match next_char {
            None => true,
            Some(c) => c.is_whitespace() || c == close || c == ')' || c == ']' || c == '}',
        }
    }

    /// Finds the positions of the innermost surrounding bracket pair around
    /// `pos`.
    ///
    /// Searches outward from `pos` for any of the standard bracket pairs
    /// `()`, `[]`, `{}`.
    #[must_use]
    pub fn surrounding_pairs(&self, pos: Position) -> Option<(Position, Position)> {
        let pairs = [('(', ')'), ('[', ']'), ('{', '}')];
        let offset = self.position_to_offset(pos);
        let text = self.text();
        let chars: Vec<char> = text.chars().collect();

        // For each pair, search backward for an unmatched open, then forward
        // for the matching close.
        let mut best: Option<(usize, usize)> = None;

        for &(open, close) in &pairs {
            // search backward for unmatched open
            let mut depth: i32 = 0;
            let mut open_idx = None;
            for i in (0..offset).rev() {
                if chars[i] == close {
                    depth += 1;
                } else if chars[i] == open {
                    if depth == 0 {
                        open_idx = Some(i);
                        break;
                    }
                    depth -= 1;
                }
            }
            let Some(oi) = open_idx else { continue };

            // search forward for matching close
            depth = 0;
            let mut close_idx = None;
            for (i, &ch) in chars.iter().enumerate().skip(offset) {
                if ch == open {
                    depth += 1;
                } else if ch == close {
                    if depth == 0 {
                        close_idx = Some(i);
                        break;
                    }
                    depth -= 1;
                }
            }
            let Some(ci) = close_idx else { continue };

            // Prefer the tightest (innermost) pair.
            let span = ci - oi;
            if best.is_none_or(|(_, prev_span)| span < prev_span) {
                best = Some((oi, span));
            }
        }

        best.map(|(oi, span)| {
            let ci = oi + span;
            (self.offset_to_position(oi), self.offset_to_position(ci))
        })
    }

    // ── Validate position / range (port of VS Code) ─────────────────

    /// Clamps a [`Position`] to valid buffer bounds.
    ///
    /// Mirrors VS Code's `TextModel.validatePosition`: line is clamped to
    /// `[0, line_count-1]`, column is clamped to `[0, line_content_len]`.
    #[must_use]
    pub fn validate_position(&self, pos: Position) -> Position {
        let line_count = self.len_lines();
        if line_count == 0 {
            return Position::ZERO;
        }
        let last_line = line_count - 1;

        #[allow(clippy::cast_possible_truncation)]
        let line = (pos.line as usize).min(last_line) as u32;
        let max_col = self.line_content_len(line as usize);
        #[allow(clippy::cast_possible_truncation)]
        let column = (pos.column as usize).min(max_col) as u32;
        Position::new(line, column)
    }

    /// Clamps a [`Range`] so both endpoints are valid buffer positions.
    ///
    /// Mirrors VS Code's `TextModel.validateRange`.
    #[must_use]
    pub fn validate_range(&self, range: crate::Range) -> crate::Range {
        let start = self.validate_position(range.start);
        let end = self.validate_position(range.end);
        crate::Range::new(start, end)
    }

    // ── Full model range ────────────────────────────────────────────

    /// Returns a [`Range`] covering the entire document.
    ///
    /// Mirrors VS Code's `TextModel.getFullModelRange`.
    #[must_use]
    pub fn get_full_model_range(&self) -> crate::Range {
        let line_count = self.len_lines();
        if line_count == 0 || self.is_empty() {
            return crate::Range::new(Position::ZERO, Position::ZERO);
        }
        let last_line = line_count - 1;
        #[allow(clippy::cast_possible_truncation)]
        let end_col = self.line_content_len(last_line) as u32;
        #[allow(clippy::cast_possible_truncation)]
        crate::Range::new(Position::ZERO, Position::new(last_line as u32, end_col))
    }

    // ── Line whitespace queries ─────────────────────────────────────

    /// Returns the 0-based column of the first non-whitespace character on
    /// the line, or the line length if the line is blank.
    ///
    /// Mirrors VS Code's `getLineFirstNonWhitespaceColumn` (but 0-based).
    #[must_use]
    pub fn line_first_non_whitespace_column(&self, line_idx: usize) -> u32 {
        let content = self.line_content(line_idx);
        let pos = content
            .chars()
            .position(|c| !c.is_whitespace())
            .unwrap_or(content.chars().count());
        #[allow(clippy::cast_possible_truncation)]
        {
            pos as u32
        }
    }

    /// Returns the 0-based column *after* the last non-whitespace character
    /// on the line, or 0 if the line is blank.
    ///
    /// Mirrors VS Code's `getLineLastNonWhitespaceColumn` (but 0-based).
    #[must_use]
    pub fn line_last_non_whitespace_column(&self, line_idx: usize) -> u32 {
        let content = self.line_content(line_idx);
        let chars: Vec<char> = content.chars().collect();
        for i in (0..chars.len()).rev() {
            if !chars[i].is_whitespace() {
                #[allow(clippy::cast_possible_truncation)]
                return (i + 1) as u32;
            }
        }
        0
    }

    // ── Modify position ─────────────────────────────────────────────

    /// Moves a position by `offset` characters (can be negative).
    ///
    /// Mirrors VS Code's `TextModel.modifyPosition`. The result is clamped
    /// to valid buffer bounds.
    #[must_use]
    pub fn modify_position(&self, pos: Position, offset: i64) -> Position {
        let current = self.position_to_offset(self.validate_position(pos));
        let max = self.len_chars();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let candidate = if offset >= 0 {
            current.saturating_add(offset.unsigned_abs() as usize)
        } else {
            current.saturating_sub(offset.unsigned_abs() as usize)
        };
        let clamped = candidate.min(max);
        self.offset_to_position(clamped)
    }

    // ── Line ending management ────────────────────────────────────

    /// Returns the document's line ending style.
    #[must_use]
    pub fn get_eol(&self) -> LineEnding {
        self.eol
    }

    /// Sets the document's line ending style and normalizes all existing
    /// line endings in the buffer to match.
    pub fn set_eol(&mut self, eol: LineEnding) {
        if eol == self.eol {
            return;
        }
        self.eol = eol;
        let text = String::from(&self.rope);
        let normalized = normalize_line_endings(&text, eol);
        self.rope = Rope::from_str(&normalized);
    }

    // ── Range-based text retrieval ──────────────────────────────────

    /// Returns the text within a [`Range`], joining lines with the specified
    /// line ending.
    ///
    /// Mirrors VS Code's `TextModel.getValueInRange`.
    #[must_use]
    pub fn get_value_in_range(&self, range: crate::Range, eol: LineEnding) -> String {
        let range = self.validate_range(range);
        let start_offset = self.position_to_offset(range.start);
        let end_offset = self.position_to_offset(range.end);
        if start_offset >= end_offset {
            return String::new();
        }
        let raw = self.slice(start_offset..end_offset);
        normalize_line_endings(&raw, eol)
    }

    /// Returns the number of characters in a [`Range`] without allocating
    /// the string content.
    ///
    /// Mirrors VS Code's `TextModel.getValueLengthInRange`.
    #[must_use]
    pub fn get_value_length_in_range(&self, range: crate::Range) -> usize {
        let range = self.validate_range(range);
        let start_offset = self.position_to_offset(range.start);
        let end_offset = self.position_to_offset(range.end);
        end_offset.saturating_sub(start_offset)
    }

    // ── Line column queries ────────────────────────────────────────

    /// Returns the maximum column on the given line (i.e. the length of
    /// the line content, excluding trailing newline).
    ///
    /// Mirrors VS Code's `TextModel.getLineMaxColumn` (but 0-based).
    #[must_use]
    pub fn get_line_max_column(&self, line: usize) -> u32 {
        if line >= self.len_lines() {
            return 0;
        }
        #[allow(clippy::cast_possible_truncation)]
        {
            self.line_content_len(line) as u32
        }
    }

    /// Returns the first non-whitespace column on the given line, or 0 if
    /// the line is blank. Alias for `line_first_non_whitespace_column`.
    ///
    /// Mirrors VS Code's `TextModel.getLineMinColumn` (but 0-based and
    /// returns first non-WS, matching practical usage).
    #[must_use]
    pub fn get_line_min_column(&self, line: usize) -> u32 {
        if line >= self.len_lines() {
            return 0;
        }
        self.line_first_non_whitespace_column(line)
    }

    // ── Bracket pair finding ────────────────────────────────────────

    /// Finds the matching bracket pair enclosing a position.
    ///
    /// Searches outward from `pos` for the nearest bracket pair from the
    /// standard set `()`, `[]`, `{}`. Returns both the open-bracket range
    /// and close-bracket range.
    #[must_use]
    pub fn find_bracket_pair(&self, pos: Position) -> Option<(crate::Range, crate::Range)> {
        let (open_pos, close_pos) = self.surrounding_pairs(pos)?;
        let open_range =
            crate::Range::new(open_pos, Position::new(open_pos.line, open_pos.column + 1));
        let close_range = crate::Range::new(
            close_pos,
            Position::new(close_pos.line, close_pos.column + 1),
        );
        Some((open_range, close_range))
    }

    // ── Active indent guide ─────────────────────────────────────────

    /// Returns the "active" indent guide for a given line.
    ///
    /// The active guide is the deepest indent guide that covers the current
    /// line. This mirrors VS Code's indent-guide highlighting behavior.
    #[must_use]
    pub fn get_active_indent_guide(&self, line: usize) -> Option<IndentGuide> {
        if line >= self.len_lines() {
            return None;
        }
        let info = self.detect_indentation();
        let tab_size = if info.tab_size == 0 { 4 } else { info.tab_size };

        let current_indent = if self.line_is_empty(line) {
            let mut above = 0u32;
            if line > 0 {
                for l in (0..line).rev() {
                    if !self.line_is_empty(l) {
                        above = self.indent_level(l);
                        break;
                    }
                }
            }
            let mut below = 0u32;
            for l in (line + 1)..self.len_lines() {
                if !self.line_is_empty(l) {
                    below = self.indent_level(l);
                    break;
                }
            }
            above.max(below)
        } else {
            self.indent_level(line)
        };

        if current_indent == 0 {
            return None;
        }

        let guide_indent = current_indent;

        let mut start_line = 0;
        for l in (0..line).rev() {
            if !self.line_is_empty(l) && self.indent_level(l) < guide_indent {
                start_line = l + 1;
                break;
            }
        }

        let mut end_line = self.len_lines() - 1;
        for l in (line + 1)..self.len_lines() {
            if !self.line_is_empty(l) && self.indent_level(l) < guide_indent {
                end_line = l - 1;
                break;
            }
        }

        let column = if info.use_tabs {
            guide_indent - 1
        } else {
            (guide_indent - 1) * tab_size
        };

        #[allow(clippy::cast_possible_truncation)]
        Some(IndentGuide {
            column,
            indent_level: guide_indent,
            start_line: start_line as u32,
            end_line: end_line as u32,
        })
    }

    // ── Word at position ────────────────────────────────────────────

    /// Returns the word at `pos`, or `None` if the cursor is not on a word.
    ///
    /// Mirrors VS Code's `TextModel.getWordAtPosition`. Uses the same
    /// character classification as [`words_at`].
    #[must_use]
    pub fn get_word_at_position(&self, pos: Position) -> Option<WordAtPosition> {
        let pos = self.validate_position(pos);
        let content = self.line_content(pos.line as usize);
        let col = pos.column as usize;
        word_at_column(&content, col)
    }

    /// Returns the word fragment *before* the cursor at `pos`.
    ///
    /// Mirrors VS Code's `TextModel.getWordUntilPosition`. Useful for
    /// completion prefix detection. If the cursor is not inside a word,
    /// returns an empty word at the cursor position.
    #[must_use]
    pub fn get_word_until_position(&self, pos: Position) -> WordAtPosition {
        let pos = self.validate_position(pos);
        let content = self.line_content(pos.line as usize);
        let col = pos.column as usize;

        // Try the character at cursor first, then the character before cursor
        // (VS Code considers the cursor "at end of word" to still be in
        // that word for completion purposes).
        let word = word_at_column(&content, col).or_else(|| {
            if col > 0 {
                word_at_column(&content, col - 1)
            } else {
                None
            }
        });

        match word {
            Some(w) if w.start_column <= pos.column && w.end_column >= pos.column => {
                let prefix_end = pos.column.min(w.end_column);
                let start = w.start_column as usize;
                let end = prefix_end as usize;
                let word_text: String = content.chars().skip(start).take(end - start).collect();
                WordAtPosition {
                    word: word_text,
                    start_column: w.start_column,
                    end_column: prefix_end,
                }
            }
            _ => WordAtPosition {
                word: String::new(),
                start_column: pos.column,
                end_column: pos.column,
            },
        }
    }

    // ── Batch edit with undo ─────────────────────────────────────────

    /// Applies multiple [`EditOperation`]s and returns an [`EditResult`] for
    /// each, including the inverse edit needed for undo.
    ///
    /// Edits are sorted in reverse document order and applied bottom-to-top
    /// so earlier offsets stay valid. The returned results are in the same
    /// order as the input edits.
    pub fn apply_edits_with_undo(&mut self, edits: &[EditOperation]) -> Vec<EditResult> {
        let mut indexed: Vec<(usize, &EditOperation)> = edits.iter().enumerate().collect();
        indexed.sort_by_key(|e| std::cmp::Reverse(e.1.range.start));

        let mut results: Vec<(usize, EditResult)> = Vec::with_capacity(edits.len());

        for (original_idx, edit) in &indexed {
            let start_offset = self.position_to_offset(edit.range.start);
            let end_offset = self.position_to_offset(edit.range.end);
            let old_text = if start_offset < end_offset {
                self.slice(start_offset..end_offset)
            } else {
                String::new()
            };

            let event = self.apply_edit(edit);

            let new_end_offset = start_offset + edit.text.chars().count();
            let new_end_pos = if new_end_offset <= self.len_chars() {
                self.offset_to_position(new_end_offset)
            } else {
                self.offset_to_position(self.len_chars())
            };

            let inverse_edit =
                EditOperation::replace(crate::Range::new(edit.range.start, new_end_pos), old_text);

            results.push((
                *original_idx,
                EditResult {
                    range: crate::Range::new(event.range.start, new_end_pos),
                    text: event.text,
                    inverse_edit,
                },
            ));
        }

        results.sort_by_key(|(idx, _)| *idx);
        results.into_iter().map(|(_, r)| r).collect()
    }

    // ── Convenience line accessors ───────────────────────────────────

    /// Returns the content of a line by its 0-based number (without trailing
    /// newline). Returns `""` for out-of-bounds lines.
    #[must_use]
    pub fn get_line_content(&self, line: u32) -> String {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return String::new();
        }
        self.line_content(idx)
    }

    /// Returns the number of content characters on a line (excluding trailing
    /// newline). Returns `0` for out-of-bounds lines.
    #[must_use]
    pub fn get_line_length(&self, line: u32) -> u32 {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return 0;
        }
        #[allow(clippy::cast_possible_truncation)]
        {
            self.line_content_len(idx) as u32
        }
    }

    /// Returns the total number of lines as `u32`.
    #[must_use]
    pub fn get_line_count(&self) -> u32 {
        #[allow(clippy::cast_possible_truncation)]
        {
            self.len_lines() as u32
        }
    }

    /// Returns the column of the first non-whitespace character on a line,
    /// or `None` if the line is blank.
    #[must_use]
    pub fn get_line_first_non_whitespace(&self, line: u32) -> Option<u32> {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return None;
        }
        let content = self.line_content(idx);
        content.chars().position(|c| !c.is_whitespace()).map(|p| {
            #[allow(clippy::cast_possible_truncation)]
            {
                p as u32
            }
        })
    }

    /// Returns the column *after* the last non-whitespace character on a
    /// line, or `None` if the line is blank.
    #[must_use]
    pub fn get_line_last_non_whitespace(&self, line: u32) -> Option<u32> {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return None;
        }
        let content = self.line_content(idx);
        let chars: Vec<char> = content.chars().collect();
        for i in (0..chars.len()).rev() {
            if !chars[i].is_whitespace() {
                #[allow(clippy::cast_possible_truncation)]
                return Some((i + 1) as u32);
            }
        }
        None
    }

    // ── Bracket finding (position-only) ─────────────────────────────

    /// Finds the position of the matching bracket for the bracket at `pos`,
    /// using the standard bracket pairs `()`, `[]`, `{}`.
    #[must_use]
    pub fn find_matching_bracket_default(&self, pos: Position) -> Option<Position> {
        let pairs = [('(', ')'), ('[', ']'), ('{', '}')];
        self.find_matching_bracket(pos, &pairs)
    }

    /// Finds the positions of the innermost enclosing brackets around
    /// `pos`. Alias for [`surrounding_pairs`](Buffer::surrounding_pairs).
    #[must_use]
    pub fn find_enclosing_brackets(&self, pos: Position) -> Option<(Position, Position)> {
        self.surrounding_pairs(pos)
    }

    // ── Indentation by tab_size ─────────────────────────────────────

    /// Returns the leading whitespace of a line.
    #[must_use]
    pub fn get_line_indent(&self, line: u32) -> String {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return String::new();
        }
        self.indent_string(idx)
    }

    /// Returns the indentation level of a line given a specific `tab_size`.
    #[must_use]
    pub fn get_line_indent_level(&self, line: u32, tab_size: u32) -> u32 {
        let idx = line as usize;
        if idx >= self.len_lines() || tab_size == 0 {
            return 0;
        }
        let content = self.line_content(idx);
        let mut visual_col: u32 = 0;
        for c in content.chars() {
            match c {
                ' ' => visual_col += 1,
                '\t' => visual_col += tab_size - (visual_col % tab_size),
                _ => break,
            }
        }
        visual_col / tab_size
    }

    // ── Simple text retrieval by Range ───────────────────────────────

    /// Returns the text within a [`Range`] using the buffer's own line
    /// ending style.
    #[must_use]
    pub fn get_text_in_range(&self, range: crate::Range) -> String {
        self.get_value_in_range(range, self.eol)
    }

    // ── Search convenience ──────────────────────────────────────────

    /// Counts all non-overlapping occurrences of `needle` in the buffer.
    #[must_use]
    pub fn count_occurrences(&self, needle: &str) -> usize {
        if needle.is_empty() {
            return 0;
        }
        let text = self.text();
        text.matches(needle).count()
    }

    // ── Snapshot ─────────────────────────────────────────────────────

    /// Creates a copy-on-write snapshot of the buffer suitable for handing
    /// to background tasks.
    #[must_use]
    pub fn snapshot(&self) -> BufferSnapshot {
        BufferSnapshot {
            rope: Arc::new(self.rope.clone()),
        }
    }
}

impl Default for Buffer {
    fn default() -> Self {
        Self::new()
    }
}

fn classify_char(c: char) -> WordType {
    if c.is_alphanumeric() || c == '_' {
        WordType::Word
    } else if c.is_whitespace() {
        WordType::Whitespace
    } else {
        WordType::Separator
    }
}

fn segment_words(line: &str) -> Vec<WordInfo> {
    let mut words = Vec::new();
    let mut chars = line.chars().peekable();
    let mut col: u32 = 0;

    while let Some(&c) = chars.peek() {
        let kind = classify_char(c);
        let start = col;
        let mut text = String::new();

        while let Some(&next) = chars.peek() {
            if classify_char(next) != kind {
                break;
            }
            text.push(next);
            chars.next();
            col += 1;
        }

        words.push(WordInfo {
            text,
            start_column: start,
            end_column: col,
            word_type: kind,
        });
    }

    words
}

/// Finds the word at a 0-based `col` within `line`.
fn word_at_column(line: &str, col: usize) -> Option<WordAtPosition> {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() || col > chars.len() {
        return None;
    }

    let target = if col >= chars.len() {
        col.saturating_sub(1)
    } else {
        col
    };
    if !is_word_char(chars[target]) {
        return None;
    }

    let mut start = target;
    while start > 0 && is_word_char(chars[start - 1]) {
        start -= 1;
    }

    let mut end = target;
    while end < chars.len() && is_word_char(chars[end]) {
        end += 1;
    }

    let word: String = chars[start..end].iter().collect();
    #[allow(clippy::cast_possible_truncation)]
    Some(WordAtPosition {
        word,
        start_column: start as u32,
        end_column: end as u32,
    })
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn skip_string_forward(chars: &[char], start: usize, quote: char) -> usize {
    let mut i = start + 1;
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i] == quote {
            return i + 1;
        }
        if quote != '`' && chars[i] == '\n' {
            return i;
        }
        i += 1;
    }
    chars.len()
}

/// Returns the index to continue scanning from (0 means reached the
/// beginning without finding the opening quote).
fn skip_string_backward(chars: &[char], start: usize, quote: char) -> usize {
    if start == 0 {
        return 0;
    }
    let mut i = start - 1;
    loop {
        if chars[i] == quote {
            if i > 0 && chars[i - 1] == '\\' {
                if i < 2 {
                    return 0;
                }
                i -= 2;
                continue;
            }
            return i;
        }
        if quote != '`' && chars[i] == '\n' {
            return i;
        }
        if i == 0 {
            return 0;
        }
        i -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Range;

    fn pos(line: u32, col: u32) -> Position {
        Position::new(line, col)
    }

    // ── Creation ─────────────────────────────────────────────────────

    #[test]
    fn empty_buffer() {
        let buf = Buffer::new();
        assert!(buf.is_empty());
        assert_eq!(buf.len_chars(), 0);
        assert_eq!(buf.len_bytes(), 0);
        assert_eq!(buf.len_lines(), 1);
    }

    #[test]
    fn from_str() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.len_chars(), 5);
        assert_eq!(buf.text(), "hello");
    }

    #[test]
    fn from_multiline_str() {
        let buf = Buffer::from_str("line1\nline2\nline3");
        assert_eq!(buf.len_lines(), 3);
        assert_eq!(buf.text(), "line1\nline2\nline3");
    }

    #[test]
    fn from_reader() {
        let data = b"hello from reader";
        let buf = Buffer::from_reader(&data[..]).unwrap();
        assert_eq!(buf.text(), "hello from reader");
    }

    // ── Line access ──────────────────────────────────────────────────

    #[test]
    fn line_access() {
        let buf = Buffer::from_str("aaa\nbbb\nccc");
        assert_eq!(buf.line(0).as_ref(), "aaa\n");
        assert_eq!(buf.line(1).as_ref(), "bbb\n");
        assert_eq!(buf.line(2).as_ref(), "ccc");
    }

    #[test]
    fn line_len_chars() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.line_len_chars(0), 6); // "hello\n"
        assert_eq!(buf.line_len_chars(1), 5); // "world"
    }

    // ── Offset conversions ───────────────────────────────────────────

    #[test]
    fn char_to_line_and_back() {
        let buf = Buffer::from_str("abc\ndef\nghi");
        assert_eq!(buf.char_to_line(0), 0);
        assert_eq!(buf.char_to_line(3), 0);
        assert_eq!(buf.char_to_line(4), 1);
        assert_eq!(buf.char_to_line(8), 2);
    }

    #[test]
    fn line_to_char() {
        let buf = Buffer::from_str("abc\ndef\nghi");
        assert_eq!(buf.line_to_char(0), 0);
        assert_eq!(buf.line_to_char(1), 4);
        assert_eq!(buf.line_to_char(2), 8);
    }

    #[test]
    fn char_to_byte_ascii() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.char_to_byte(0), 0);
        assert_eq!(buf.char_to_byte(3), 3);
    }

    #[test]
    fn char_to_byte_multibyte() {
        let buf = Buffer::from_str("a😀b");
        assert_eq!(buf.char_to_byte(0), 0);
        assert_eq!(buf.char_to_byte(1), 1);
        assert_eq!(buf.char_to_byte(2), 5); // 😀 is 4 bytes in UTF-8
    }

    // ── Slice ────────────────────────────────────────────────────────

    #[test]
    fn slice_range() {
        let buf = Buffer::from_str("hello world");
        assert_eq!(buf.slice(0..5), "hello");
        assert_eq!(buf.slice(6..11), "world");
    }

    #[test]
    fn text_full() {
        let buf = Buffer::from_str("abc\ndef");
        assert_eq!(buf.text(), "abc\ndef");
    }

    // ── Insert ───────────────────────────────────────────────────────

    #[test]
    fn insert_at_beginning() {
        let mut buf = Buffer::from_str("world");
        buf.insert(0, "hello ");
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn insert_at_middle() {
        let mut buf = Buffer::from_str("helo");
        buf.insert(3, "l");
        assert_eq!(buf.text(), "hello");
    }

    #[test]
    fn insert_at_end() {
        let mut buf = Buffer::from_str("hello");
        buf.insert(5, " world");
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn insert_newline() {
        let mut buf = Buffer::from_str("ab");
        buf.insert(1, "\n");
        assert_eq!(buf.len_lines(), 2);
        assert_eq!(buf.text(), "a\nb");
    }

    // ── Delete ───────────────────────────────────────────────────────

    #[test]
    fn delete_at_beginning() {
        let mut buf = Buffer::from_str("hello world");
        buf.remove(0..6);
        assert_eq!(buf.text(), "world");
    }

    #[test]
    fn delete_at_middle() {
        let mut buf = Buffer::from_str("hello world");
        buf.remove(5..6);
        assert_eq!(buf.text(), "helloworld");
    }

    #[test]
    fn delete_at_end() {
        let mut buf = Buffer::from_str("hello world");
        buf.remove(5..11);
        assert_eq!(buf.text(), "hello");
    }

    // ── Replace ──────────────────────────────────────────────────────

    #[test]
    fn replace_text() {
        let mut buf = Buffer::from_str("hello world");
        buf.replace(6..11, "rust");
        assert_eq!(buf.text(), "hello rust");
    }

    #[test]
    fn replace_with_longer() {
        let mut buf = Buffer::from_str("ab");
        buf.replace(0..1, "xyz");
        assert_eq!(buf.text(), "xyzb");
    }

    #[test]
    fn replace_with_shorter() {
        let mut buf = Buffer::from_str("abcdef");
        buf.replace(1..5, "X");
        assert_eq!(buf.text(), "aXf");
    }

    // ── Position/offset roundtrip ────────────────────────────────────

    #[test]
    fn offset_to_position_and_back() {
        let buf = Buffer::from_str("abc\ndef\nghi");
        for offset in 0..buf.len_chars() {
            let p = buf.offset_to_position(offset);
            let back = buf.position_to_offset(p);
            assert_eq!(offset, back, "roundtrip failed for offset {offset}");
        }
    }

    #[test]
    fn offset_to_position_specific() {
        let buf = Buffer::from_str("abc\ndef\nghi");
        assert_eq!(buf.offset_to_position(0), pos(0, 0));
        assert_eq!(buf.offset_to_position(2), pos(0, 2));
        assert_eq!(buf.offset_to_position(4), pos(1, 0));
        assert_eq!(buf.offset_to_position(8), pos(2, 0));
        assert_eq!(buf.offset_to_position(10), pos(2, 2));
    }

    // ── Apply edits ──────────────────────────────────────────────────

    #[test]
    fn apply_edit_insert() {
        let mut buf = Buffer::from_str("hello world");
        let edit = EditOperation::insert(pos(0, 5), ", beautiful".into());
        let event = buf.apply_edit(&edit);
        assert_eq!(buf.text(), "hello, beautiful world");
        assert_eq!(event.range_length, 0);
    }

    #[test]
    fn apply_edit_delete() {
        let mut buf = Buffer::from_str("hello world");
        let edit = EditOperation::delete(Range::new(pos(0, 5), pos(0, 11)));
        let event = buf.apply_edit(&edit);
        assert_eq!(buf.text(), "hello");
        assert_eq!(event.range_length, 6);
    }

    #[test]
    fn apply_edit_replace() {
        let mut buf = Buffer::from_str("hello world");
        let edit = EditOperation::replace(Range::new(pos(0, 6), pos(0, 11)), "rust".into());
        let event = buf.apply_edit(&edit);
        assert_eq!(buf.text(), "hello rust");
        assert_eq!(event.range_length, 5);
        assert_eq!(event.text, "rust");
    }

    #[test]
    fn apply_edits_multiple() {
        let mut buf = Buffer::from_str("aaa bbb ccc");
        let edits = vec![
            EditOperation::replace(Range::new(pos(0, 0), pos(0, 3)), "AAA".into()),
            EditOperation::replace(Range::new(pos(0, 8), pos(0, 11)), "CCC".into()),
        ];
        buf.apply_edits(&edits);
        assert_eq!(buf.text(), "AAA bbb CCC");
    }

    #[test]
    fn apply_edits_multiline() {
        let mut buf = Buffer::from_str("line1\nline2\nline3");
        let edits = vec![
            EditOperation::replace(Range::new(pos(0, 0), pos(0, 5)), "LINE1".into()),
            EditOperation::replace(Range::new(pos(2, 0), pos(2, 5)), "LINE3".into()),
        ];
        buf.apply_edits(&edits);
        assert_eq!(buf.text(), "LINE1\nline2\nLINE3");
    }

    // ── UTF-16 ───────────────────────────────────────────────────────

    #[test]
    fn utf16_offset_to_char_ascii() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.utf16_offset_to_char(0, 3), 3);
        assert_eq!(buf.utf16_offset_to_char(1, 2), 8);
    }

    #[test]
    fn utf16_offset_to_char_emoji() {
        let buf = Buffer::from_str("a😀b\ncd");
        assert_eq!(buf.utf16_offset_to_char(0, 0), 0);
        assert_eq!(buf.utf16_offset_to_char(0, 1), 1);
        assert_eq!(buf.utf16_offset_to_char(0, 3), 2);
    }

    #[test]
    fn char_to_utf16_offset_emoji() {
        let buf = Buffer::from_str("a😀b\ncd");
        assert_eq!(buf.char_to_utf16_offset(0, 0), 0);
        assert_eq!(buf.char_to_utf16_offset(0, 1), 1);
        assert_eq!(buf.char_to_utf16_offset(0, 2), 3);
    }

    #[test]
    fn lsp_position_roundtrip() {
        let buf = Buffer::from_str("a😀b\ncd");
        let p = pos(0, 2);
        let lsp = buf.position_to_lsp_position(p);
        assert_eq!(lsp.character, 3);
        let back = buf.lsp_position_to_position(lsp);
        assert_eq!(back, p);
    }

    // ── Edge cases ───────────────────────────────────────────────────

    #[test]
    fn single_char_buffer() {
        let buf = Buffer::from_str("x");
        assert_eq!(buf.len_chars(), 1);
        assert_eq!(buf.len_lines(), 1);
        assert_eq!(buf.text(), "x");
    }

    #[test]
    fn empty_lines() {
        let buf = Buffer::from_str("\n\n\n");
        assert_eq!(buf.len_lines(), 4);
        assert_eq!(buf.line(0).as_ref(), "\n");
        assert_eq!(buf.line(3).as_ref(), "");
    }

    #[test]
    fn very_long_line() {
        let long = "a".repeat(10_000);
        let buf = Buffer::from_str(&long);
        assert_eq!(buf.len_chars(), 10_000);
        assert_eq!(buf.len_lines(), 1);
        assert_eq!(buf.slice(9_998..10_000), "aa");
    }

    #[test]
    fn default_is_empty() {
        let buf = Buffer::default();
        assert!(buf.is_empty());
    }

    #[test]
    fn insert_into_empty() {
        let mut buf = Buffer::new();
        buf.insert(0, "hello");
        assert_eq!(buf.text(), "hello");
    }

    #[test]
    fn delete_everything() {
        let mut buf = Buffer::from_str("hello");
        buf.remove(0..5);
        assert!(buf.is_empty());
        assert_eq!(buf.text(), "");
    }

    // ── Word segmentation ────────────────────────────────────────────

    #[test]
    fn words_at_simple() {
        let buf = Buffer::from_str("hello world");
        let words = buf.words_at(0);
        assert_eq!(words.len(), 3);
        assert_eq!(words[0].text, "hello");
        assert_eq!(words[0].word_type, WordType::Word);
        assert_eq!(words[1].text, " ");
        assert_eq!(words[1].word_type, WordType::Whitespace);
        assert_eq!(words[2].text, "world");
        assert_eq!(words[2].word_type, WordType::Word);
    }

    #[test]
    fn words_at_with_punctuation() {
        let buf = Buffer::from_str("foo(bar)");
        let words = buf.words_at(0);
        assert_eq!(words.len(), 4);
        assert_eq!(words[0].text, "foo");
        assert_eq!(words[1].text, "(");
        assert_eq!(words[1].word_type, WordType::Separator);
        assert_eq!(words[2].text, "bar");
        assert_eq!(words[3].text, ")");
    }

    #[test]
    fn words_at_empty_line() {
        let buf = Buffer::from_str("hello\n\nworld");
        let words = buf.words_at(1);
        assert!(words.is_empty());
    }

    #[test]
    fn words_at_columns_correct() {
        let buf = Buffer::from_str("ab cd");
        let words = buf.words_at(0);
        assert_eq!(words[0].start_column, 0);
        assert_eq!(words[0].end_column, 2);
        assert_eq!(words[1].start_column, 2);
        assert_eq!(words[1].end_column, 3);
        assert_eq!(words[2].start_column, 3);
        assert_eq!(words[2].end_column, 5);
    }

    // ── Indentation ──────────────────────────────────────────────────

    #[test]
    fn indent_string_spaces() {
        let buf = Buffer::from_str("    hello");
        assert_eq!(buf.indent_string(0), "    ");
    }

    #[test]
    fn indent_string_tabs() {
        let buf = Buffer::from_str("\t\thello");
        assert_eq!(buf.indent_string(0), "\t\t");
    }

    #[test]
    fn indent_string_no_indent() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.indent_string(0), "");
    }

    #[test]
    fn indent_level_spaces() {
        let buf = Buffer::from_str("        code\n    code\ncode");
        assert_eq!(buf.indent_level(0), 2);
        assert_eq!(buf.indent_level(1), 1);
        assert_eq!(buf.indent_level(2), 0);
    }

    #[test]
    fn detect_indentation_spaces() {
        let src = "function() {\n    a;\n    b;\n        c;\n}";
        let buf = Buffer::from_str(src);
        let info = buf.detect_indentation();
        assert!(!info.use_tabs);
        assert_eq!(info.tab_size, 4);
    }

    #[test]
    fn detect_indentation_tabs() {
        let src = "function() {\n\ta;\n\tb;\n\t\tc;\n}";
        let buf = Buffer::from_str(src);
        let info = buf.detect_indentation();
        assert!(info.use_tabs);
    }

    #[test]
    fn detect_indentation_two_spaces() {
        let src = "a:\n  b:\n    c:\n  d:";
        let buf = Buffer::from_str(src);
        let info = buf.detect_indentation();
        assert!(!info.use_tabs);
        assert_eq!(info.tab_size, 2);
    }

    // ── Line queries ─────────────────────────────────────────────────

    #[test]
    fn line_is_empty_true() {
        let buf = Buffer::from_str("hello\n   \nworld");
        assert!(!buf.line_is_empty(0));
        assert!(buf.line_is_empty(1));
        assert!(!buf.line_is_empty(2));
    }

    #[test]
    fn line_is_empty_blank_line() {
        let buf = Buffer::from_str("a\n\nb");
        assert!(buf.line_is_empty(1));
    }

    #[test]
    fn line_is_comment_true() {
        let buf = Buffer::from_str("  // this is a comment\ncode");
        assert!(buf.line_is_comment(0, "//"));
        assert!(!buf.line_is_comment(1, "//"));
    }

    #[test]
    fn line_is_comment_hash() {
        let buf = Buffer::from_str("  # python comment");
        assert!(buf.line_is_comment(0, "#"));
    }

    #[test]
    fn line_is_comment_not_comment() {
        let buf = Buffer::from_str("let x = 1; // inline");
        assert!(!buf.line_is_comment(0, "//"));
    }

    // ── Bracket matching ─────────────────────────────────────────────

    #[test]
    fn find_matching_bracket_forward() {
        let buf = Buffer::from_str("(hello)");
        let brackets = [('(', ')')];
        let m = buf.find_matching_bracket(pos(0, 0), &brackets);
        assert_eq!(m, Some(pos(0, 6)));
    }

    #[test]
    fn find_matching_bracket_backward() {
        let buf = Buffer::from_str("(hello)");
        let brackets = [('(', ')')];
        let m = buf.find_matching_bracket(pos(0, 6), &brackets);
        assert_eq!(m, Some(pos(0, 0)));
    }

    #[test]
    fn find_matching_bracket_nested() {
        let buf = Buffer::from_str("((inner))");
        let brackets = [('(', ')')];
        let m = buf.find_matching_bracket(pos(0, 0), &brackets);
        assert_eq!(m, Some(pos(0, 8)));
        let m2 = buf.find_matching_bracket(pos(0, 1), &brackets);
        assert_eq!(m2, Some(pos(0, 7)));
    }

    #[test]
    fn find_matching_bracket_none() {
        let buf = Buffer::from_str("(unclosed");
        let brackets = [('(', ')')];
        let m = buf.find_matching_bracket(pos(0, 0), &brackets);
        assert_eq!(m, None);
    }

    #[test]
    fn find_matching_bracket_multiline() {
        let buf = Buffer::from_str("{\n  hello\n}");
        let brackets = [('{', '}')];
        let m = buf.find_matching_bracket(pos(0, 0), &brackets);
        assert_eq!(m, Some(pos(2, 0)));
    }

    #[test]
    fn find_matching_bracket_not_a_bracket() {
        let buf = Buffer::from_str("hello");
        let brackets = [('(', ')')];
        assert_eq!(buf.find_matching_bracket(pos(0, 0), &brackets), None);
    }

    // ── Auto close pair ──────────────────────────────────────────────

    #[test]
    fn auto_close_pair_at_end() {
        let buf = Buffer::from_str("hello");
        assert!(buf.auto_close_pair(pos(0, 5), '(', ')'));
    }

    #[test]
    fn auto_close_pair_before_whitespace() {
        let buf = Buffer::from_str("hello world");
        assert!(buf.auto_close_pair(pos(0, 5), '(', ')'));
    }

    #[test]
    fn auto_close_pair_before_close_bracket() {
        let buf = Buffer::from_str("(x)");
        assert!(buf.auto_close_pair(pos(0, 2), '[', ']'));
    }

    #[test]
    fn auto_close_pair_before_word() {
        let buf = Buffer::from_str("abc");
        assert!(!buf.auto_close_pair(pos(0, 1), '(', ')'));
    }

    // ── Surrounding pairs ────────────────────────────────────────────

    #[test]
    fn surrounding_pairs_found() {
        let buf = Buffer::from_str("(hello)");
        let result = buf.surrounding_pairs(pos(0, 3));
        assert_eq!(result, Some((pos(0, 0), pos(0, 6))));
    }

    #[test]
    fn surrounding_pairs_nested() {
        let buf = Buffer::from_str("([inner])");
        let result = buf.surrounding_pairs(pos(0, 4));
        assert_eq!(result, Some((pos(0, 1), pos(0, 7))));
    }

    #[test]
    fn surrounding_pairs_none() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.surrounding_pairs(pos(0, 2)), None);
    }

    // ── Snapshot ─────────────────────────────────────────────────────

    #[test]
    fn snapshot_is_immutable_view() {
        let mut buf = Buffer::from_str("hello");
        let snap = buf.snapshot();
        buf.insert(5, " world");
        assert_eq!(snap.text(), "hello");
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn snapshot_line_access() {
        let buf = Buffer::from_str("aaa\nbbb\nccc");
        let snap = buf.snapshot();
        assert_eq!(snap.len_lines(), 3);
        assert_eq!(snap.line_content(1), "bbb");
    }

    #[test]
    fn snapshot_position_conversions() {
        let buf = Buffer::from_str("abc\ndef");
        let snap = buf.snapshot();
        let p = snap.offset_to_position(5);
        assert_eq!(p, pos(1, 1));
        assert_eq!(snap.position_to_offset(p), 5);
    }

    #[test]
    fn snapshot_clone_is_cheap() {
        let buf = Buffer::from_str("hello world");
        let snap1 = buf.snapshot();
        let snap2 = snap1.clone();
        assert_eq!(snap1.text(), snap2.text());
    }

    // ── validate_position ────────────────────────────────────────────

    #[test]
    fn validate_position_within_bounds() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.validate_position(pos(0, 3)), pos(0, 3));
        assert_eq!(buf.validate_position(pos(1, 2)), pos(1, 2));
    }

    #[test]
    fn validate_position_clamps_line() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.validate_position(pos(99, 0)), pos(1, 0));
    }

    #[test]
    fn validate_position_clamps_column() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.validate_position(pos(0, 99)), pos(0, 5));
        assert_eq!(buf.validate_position(pos(1, 99)), pos(1, 5));
    }

    #[test]
    fn validate_position_empty_buffer() {
        let buf = Buffer::new();
        assert_eq!(buf.validate_position(pos(5, 5)), pos(0, 0));
    }

    // ── validate_range ──────────────────────────────────────────────

    #[test]
    fn validate_range_normal() {
        let buf = Buffer::from_str("hello\nworld");
        let r = Range::new(pos(0, 2), pos(1, 3));
        assert_eq!(buf.validate_range(r), r);
    }

    #[test]
    fn validate_range_clamps() {
        let buf = Buffer::from_str("hello\nworld");
        let r = Range::new(pos(0, 0), pos(99, 99));
        let v = buf.validate_range(r);
        assert_eq!(v.start, pos(0, 0));
        assert_eq!(v.end, pos(1, 5));
    }

    // ── get_full_model_range ────────────────────────────────────────

    #[test]
    fn full_model_range_single_line() {
        let buf = Buffer::from_str("hello");
        let r = buf.get_full_model_range();
        assert_eq!(r.start, pos(0, 0));
        assert_eq!(r.end, pos(0, 5));
    }

    #[test]
    fn full_model_range_multiline() {
        let buf = Buffer::from_str("abc\ndef\nghi");
        let r = buf.get_full_model_range();
        assert_eq!(r.start, pos(0, 0));
        assert_eq!(r.end, pos(2, 3));
    }

    #[test]
    fn full_model_range_empty() {
        let buf = Buffer::new();
        let r = buf.get_full_model_range();
        assert_eq!(r.start, pos(0, 0));
        assert_eq!(r.end, pos(0, 0));
    }

    #[test]
    fn full_model_range_trailing_newline() {
        let buf = Buffer::from_str("abc\n");
        let r = buf.get_full_model_range();
        assert_eq!(r.start, pos(0, 0));
        assert_eq!(r.end, pos(1, 0));
    }

    // ── line whitespace columns ─────────────────────────────────────

    #[test]
    fn first_non_whitespace_column() {
        let buf = Buffer::from_str("    hello");
        assert_eq!(buf.line_first_non_whitespace_column(0), 4);
    }

    #[test]
    fn first_non_whitespace_column_no_indent() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.line_first_non_whitespace_column(0), 0);
    }

    #[test]
    fn first_non_whitespace_column_blank_line() {
        let buf = Buffer::from_str("   \nhello");
        assert_eq!(buf.line_first_non_whitespace_column(0), 3);
    }

    #[test]
    fn last_non_whitespace_column() {
        let buf = Buffer::from_str("hello   ");
        assert_eq!(buf.line_last_non_whitespace_column(0), 5);
    }

    #[test]
    fn last_non_whitespace_column_no_trailing() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.line_last_non_whitespace_column(0), 5);
    }

    #[test]
    fn last_non_whitespace_column_blank() {
        let buf = Buffer::from_str("   \nhello");
        assert_eq!(buf.line_last_non_whitespace_column(0), 0);
    }

    // ── modify_position ─────────────────────────────────────────────

    #[test]
    fn modify_position_forward() {
        let buf = Buffer::from_str("abc\ndef");
        let p = buf.modify_position(pos(0, 0), 5);
        assert_eq!(p, pos(1, 1));
    }

    #[test]
    fn modify_position_backward() {
        let buf = Buffer::from_str("abc\ndef");
        let p = buf.modify_position(pos(1, 2), -3);
        assert_eq!(p, pos(0, 3));
    }

    #[test]
    fn modify_position_clamps_to_start() {
        let buf = Buffer::from_str("hello");
        let p = buf.modify_position(pos(0, 2), -100);
        assert_eq!(p, pos(0, 0));
    }

    #[test]
    fn modify_position_clamps_to_end() {
        let buf = Buffer::from_str("hello");
        let p = buf.modify_position(pos(0, 2), 100);
        assert_eq!(p, pos(0, 5));
    }

    // ── get_word_at_position ────────────────────────────────────────

    #[test]
    fn word_at_position_middle() {
        let buf = Buffer::from_str("hello world");
        let w = buf.get_word_at_position(pos(0, 7)).unwrap();
        assert_eq!(w.word, "world");
        assert_eq!(w.start_column, 6);
        assert_eq!(w.end_column, 11);
    }

    #[test]
    fn word_at_position_start() {
        let buf = Buffer::from_str("hello world");
        let w = buf.get_word_at_position(pos(0, 0)).unwrap();
        assert_eq!(w.word, "hello");
        assert_eq!(w.start_column, 0);
        assert_eq!(w.end_column, 5);
    }

    #[test]
    fn word_at_position_on_space() {
        let buf = Buffer::from_str("hello world");
        let w = buf.get_word_at_position(pos(0, 5));
        assert!(w.is_none());
    }

    #[test]
    fn word_at_position_underscore() {
        let buf = Buffer::from_str("foo_bar baz");
        let w = buf.get_word_at_position(pos(0, 4)).unwrap();
        assert_eq!(w.word, "foo_bar");
    }

    #[test]
    fn word_at_position_multiline() {
        let buf = Buffer::from_str("hello\nworld");
        let w = buf.get_word_at_position(pos(1, 2)).unwrap();
        assert_eq!(w.word, "world");
    }

    // ── get_word_until_position ──────────────────────────────────────

    #[test]
    fn word_until_position_middle() {
        let buf = Buffer::from_str("hello world");
        let w = buf.get_word_until_position(pos(0, 3));
        assert_eq!(w.word, "hel");
        assert_eq!(w.start_column, 0);
        assert_eq!(w.end_column, 3);
    }

    #[test]
    fn word_until_position_end() {
        let buf = Buffer::from_str("hello world");
        let w = buf.get_word_until_position(pos(0, 5));
        assert_eq!(w.word, "hello");
        assert_eq!(w.start_column, 0);
        assert_eq!(w.end_column, 5);
    }

    #[test]
    fn word_until_position_on_space() {
        let buf = Buffer::from_str("hello world");
        let w = buf.get_word_until_position(pos(0, 5));
        assert_eq!(w.word, "hello");
    }

    #[test]
    fn word_until_position_not_on_word() {
        let buf = Buffer::from_str("  hello");
        let w = buf.get_word_until_position(pos(0, 1));
        assert_eq!(w.word, "");
        assert_eq!(w.start_column, 1);
        assert_eq!(w.end_column, 1);
    }

    // ── Smart bracket matching ──────────────────────────────────────

    #[test]
    fn smart_bracket_skips_string() {
        let buf = Buffer::from_str(r#"( ")" )"#);
        let brackets = [('(', ')')];
        let m = buf.find_matching_bracket_smart(pos(0, 0), &brackets);
        assert_eq!(m, Some(pos(0, 6)));
    }

    #[test]
    fn smart_bracket_skips_line_comment() {
        let buf = Buffer::from_str("(\n// )\n)");
        let brackets = [('(', ')')];
        let m = buf.find_matching_bracket_smart(pos(0, 0), &brackets);
        assert_eq!(m, Some(pos(2, 0)));
    }

    #[test]
    fn smart_bracket_skips_block_comment() {
        let buf = Buffer::from_str("( /* ) */ )");
        let brackets = [('(', ')')];
        let m = buf.find_matching_bracket_smart(pos(0, 0), &brackets);
        assert_eq!(m, Some(pos(0, 10)));
    }

    #[test]
    fn smart_bracket_backward() {
        let buf = Buffer::from_str(r#"( "(" )"#);
        let brackets = [('(', ')')];
        let m = buf.find_matching_bracket_smart(pos(0, 6), &brackets);
        assert_eq!(m, Some(pos(0, 0)));
    }

    // ── get_eol / set_eol ──────────────────────────────────────────

    #[test]
    fn get_eol_default_lf() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.get_eol(), crate::LineEnding::Lf);
    }

    #[test]
    fn get_eol_crlf() {
        let buf = Buffer::from_str("hello\r\nworld\r\n");
        assert_eq!(buf.get_eol(), crate::LineEnding::CrLf);
    }

    #[test]
    fn set_eol_normalizes() {
        let mut buf = Buffer::from_str("hello\nworld\n");
        buf.set_eol(crate::LineEnding::CrLf);
        assert_eq!(buf.get_eol(), crate::LineEnding::CrLf);
        assert!(buf.text().contains("\r\n"));
        assert!(!buf.text().contains("\r\n\r\n")); // no doubled line endings
    }

    // ── get_value_in_range ─────────────────────────────────────────

    #[test]
    fn get_value_in_range_single_line() {
        let buf = Buffer::from_str("hello world");
        let r = Range::new(pos(0, 0), pos(0, 5));
        assert_eq!(buf.get_value_in_range(r, crate::LineEnding::Lf), "hello");
    }

    #[test]
    fn get_value_in_range_multiline() {
        let buf = Buffer::from_str("abc\ndef\nghi");
        let r = Range::new(pos(0, 0), pos(2, 3));
        let val = buf.get_value_in_range(r, crate::LineEnding::CrLf);
        assert_eq!(val, "abc\r\ndef\r\nghi");
    }

    // ── get_value_length_in_range ──────────────────────────────────

    #[test]
    fn get_value_length_in_range_basic() {
        let buf = Buffer::from_str("hello world");
        let r = Range::new(pos(0, 0), pos(0, 5));
        assert_eq!(buf.get_value_length_in_range(r), 5);
    }

    #[test]
    fn get_value_length_in_range_multiline() {
        let buf = Buffer::from_str("abc\ndef");
        let r = Range::new(pos(0, 0), pos(1, 3));
        assert_eq!(buf.get_value_length_in_range(r), 7); // "abc\ndef"
    }

    // ── get_line_max_column / get_line_min_column ──────────────────

    #[test]
    fn get_line_max_column_basic() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.get_line_max_column(0), 5);
        assert_eq!(buf.get_line_max_column(1), 5);
    }

    #[test]
    fn get_line_min_column_basic() {
        let buf = Buffer::from_str("    hello\nworld");
        assert_eq!(buf.get_line_min_column(0), 4);
        assert_eq!(buf.get_line_min_column(1), 0);
    }

    // ── find_bracket_pair ──────────────────────────────────────────

    #[test]
    fn find_bracket_pair_basic() {
        let buf = Buffer::from_str("(hello)");
        let pair = buf.find_bracket_pair(pos(0, 3));
        assert!(pair.is_some());
        let (open, close) = pair.unwrap();
        assert_eq!(open.start, pos(0, 0));
        assert_eq!(close.start, pos(0, 6));
    }

    // ── get_active_indent_guide ────────────────────────────────────

    #[test]
    fn active_indent_guide_none_for_unindented() {
        let buf = Buffer::from_str("hello\nworld");
        assert!(buf.get_active_indent_guide(0).is_none());
    }

    #[test]
    fn active_indent_guide_returns_guide() {
        let src = "if (true) {\n  a;\n    b;\n  c;\n}";
        let buf = Buffer::from_str(src);
        let guide = buf.get_active_indent_guide(1);
        assert!(guide.is_some());
        let g = guide.unwrap();
        assert!(g.indent_level > 0);
    }

    // ── apply_edits_with_undo ────────────────────────────────────────

    #[test]
    fn apply_edits_with_undo_produces_inverse() {
        let mut buf = Buffer::from_str("hello world");
        let edits = vec![EditOperation::replace(
            Range::new(pos(0, 6), pos(0, 11)),
            "rust".into(),
        )];
        let results = buf.apply_edits_with_undo(&edits);
        assert_eq!(buf.text(), "hello rust");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].inverse_edit.text, "world");

        buf.apply_edit(&results[0].inverse_edit);
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn apply_edits_with_undo_insert() {
        let mut buf = Buffer::from_str("ab");
        let edits = vec![EditOperation::insert(pos(0, 1), "X".into())];
        let results = buf.apply_edits_with_undo(&edits);
        assert_eq!(buf.text(), "aXb");
        buf.apply_edit(&results[0].inverse_edit);
        assert_eq!(buf.text(), "ab");
    }

    // ── get_line_content ────────────────────────────────────────────

    #[test]
    fn get_line_content_basic() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.get_line_content(0), "hello");
        assert_eq!(buf.get_line_content(1), "world");
    }

    #[test]
    fn get_line_content_out_of_bounds() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.get_line_content(99), "");
    }

    // ── get_line_length ─────────────────────────────────────────────

    #[test]
    fn get_line_length_basic() {
        let buf = Buffer::from_str("hello\nhi");
        assert_eq!(buf.get_line_length(0), 5);
        assert_eq!(buf.get_line_length(1), 2);
    }

    // ── get_line_count ──────────────────────────────────────────────

    #[test]
    fn get_line_count_basic() {
        let buf = Buffer::from_str("a\nb\nc");
        assert_eq!(buf.get_line_count(), 3);
    }

    // ── get_line_first_non_whitespace / last ────────────────────────

    #[test]
    fn first_nonws_some() {
        let buf = Buffer::from_str("   hello");
        assert_eq!(buf.get_line_first_non_whitespace(0), Some(3));
    }

    #[test]
    fn first_nonws_blank() {
        let buf = Buffer::from_str("   \nhello");
        assert_eq!(buf.get_line_first_non_whitespace(0), None);
    }

    #[test]
    fn last_nonws_some() {
        let buf = Buffer::from_str("hello   ");
        assert_eq!(buf.get_line_last_non_whitespace(0), Some(5));
    }

    #[test]
    fn last_nonws_blank() {
        let buf = Buffer::from_str("   \nhello");
        assert_eq!(buf.get_line_last_non_whitespace(0), None);
    }

    // ── find_matching_bracket_default ───────────────────────────────

    #[test]
    fn matching_bracket_default() {
        let buf = Buffer::from_str("{hello}");
        assert_eq!(
            buf.find_matching_bracket_default(pos(0, 0)),
            Some(pos(0, 6))
        );
    }

    // ── find_enclosing_brackets ────────────────────────────────────

    #[test]
    fn enclosing_brackets_found() {
        let buf = Buffer::from_str("[hello]");
        assert_eq!(
            buf.find_enclosing_brackets(pos(0, 3)),
            Some((pos(0, 0), pos(0, 6)))
        );
    }

    // ── get_line_indent / indent_level ─────────────────────────────

    #[test]
    fn get_line_indent_basic() {
        let buf = Buffer::from_str("    hello");
        assert_eq!(buf.get_line_indent(0), "    ");
    }

    #[test]
    fn get_line_indent_level_spaces() {
        let buf = Buffer::from_str("        code");
        assert_eq!(buf.get_line_indent_level(0, 4), 2);
    }

    #[test]
    fn get_line_indent_level_tabs() {
        let buf = Buffer::from_str("\t\tcode");
        assert_eq!(buf.get_line_indent_level(0, 4), 2);
    }

    // ── count_occurrences ───────────────────────────────────────────

    #[test]
    fn count_occurrences_basic() {
        let buf = Buffer::from_str("aaa bbb aaa ccc aaa");
        assert_eq!(buf.count_occurrences("aaa"), 3);
    }

    #[test]
    fn count_occurrences_empty_needle() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.count_occurrences(""), 0);
    }
}

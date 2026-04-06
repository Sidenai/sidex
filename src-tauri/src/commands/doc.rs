use encoding_rs::{Encoding, UTF_8};

// UTF-8 BOM bytes
const UTF_8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::{channel, Sender};
use tokio::time::{sleep, Duration, Instant};

/// Maximum number of undo operations to keep per document
const MAX_UNDO_STACK_SIZE: usize = 100;
/// Threshold for using memory-mapped files (1 MB)
const MMAP_THRESHOLD_BYTES: usize = 1024 * 1024;
/// Default auto-save delay in milliseconds
const DEFAULT_AUTOSAVE_DELAY_MS: u64 = 2000;

/// Unique document handle
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Hash, Eq, PartialEq)]
pub struct DocHandle(pub u32);

/// Line range for partial content retrieval (1-based line numbers)
#[derive(Debug, Deserialize)]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

/// Single edit operation
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EditOp {
    pub range: TextRange,
    pub new_text: String,
    pub old_text: Option<String>,
}

/// Text position range
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextRange {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

/// Document statistics
#[derive(Debug, Serialize)]
pub struct DocStats {
    pub handle: DocHandle,
    pub path: Option<String>,
    pub line_count: usize,
    pub char_count: usize,
    pub is_dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub encoding: String,
    pub line_endings: String,
}

/// Source of a piece in the piece table
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PieceSource {
    Original,
    AddBuffer,
}

/// A piece in the piece table
#[derive(Debug, Clone)]
struct Piece {
    source: PieceSource,
    start: usize,
    length: usize,
}

/// Internal document storage using piece table
struct Document {
    handle: DocHandle,
    path: Option<PathBuf>,
    /// Original file content (may be memory-mapped for large files)
    original: OriginalContent,
    /// Append-only buffer for inserts
    add_buffer: Vec<u8>,
    /// Sequence of pieces
    pieces: Vec<Piece>,
    /// Undo stack (groups of edits)
    undo_stack: Vec<Vec<EditOp>>,
    /// Redo stack
    redo_stack: Vec<Vec<EditOp>>,
    /// Document modified since last save
    is_dirty: bool,
    /// File encoding
    encoding: &'static Encoding,
    /// Has BOM
    has_bom: bool,
    /// Line endings style
    line_endings: LineEnding,
    /// Auto-save configuration
    autosave: Option<AutosaveConfig>,
    /// Channel sender for triggering auto-save
    autosave_tx: Option<Sender<AutosaveMsg>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    fn as_str(&self) -> &'static str {
        match self {
            LineEnding::Lf => "LF",
            LineEnding::Crlf => "CRLF",
        }
    }

    fn detect(content: &[u8]) -> Self {
        // Count CRLF and LF (not preceded by CR)
        let mut crlf_count = 0;
        let mut lf_only_count = 0;

        for window in content.windows(2) {
            if window == b"\r\n" {
                crlf_count += 1;
            }
        }

        for i in 0..content.len() {
            if content[i] == b'\n' {
                if i == 0 || content[i - 1] != b'\r' {
                    lf_only_count += 1;
                }
            }
        }

        if crlf_count > lf_only_count {
            LineEnding::Crlf
        } else {
            LineEnding::Lf
        }
    }

    fn to_bytes(&self) -> &'static [u8] {
        match self {
            LineEnding::Lf => b"\n",
            LineEnding::Crlf => b"\r\n",
        }
    }
}

/// Original content storage - either in-memory or memory-mapped
enum OriginalContent {
    Owned(Vec<u8>),
    Mmapped(Mmap),
}

impl OriginalContent {
    fn as_bytes(&self) -> &[u8] {
        match self {
            OriginalContent::Owned(v) => v.as_slice(),
            OriginalContent::Mmapped(m) => m.as_ref(),
        }
    }

    fn len(&self) -> usize {
        self.as_bytes().len()
    }
}

/// Auto-save configuration
#[derive(Debug, Clone)]
struct AutosaveConfig {
    enabled: bool,
    delay_ms: u64,
}

/// Message for auto-save task
#[derive(Debug)]
enum AutosaveMsg {
    Trigger,
    UpdateDelay(u64),
    Shutdown,
}

/// Document store - manages all open documents
pub struct DocStore {
    documents: RwLock<HashMap<DocHandle, Mutex<Document>>>,
    next_handle: AtomicU32,
    app_handle: Mutex<Option<AppHandle>>,
}

impl DocStore {
    pub fn new() -> Self {
        Self {
            documents: RwLock::new(HashMap::new()),
            next_handle: AtomicU32::new(1),
            app_handle: Mutex::new(None),
        }
    }

    pub fn set_app_handle(&self, app: AppHandle) {
        let mut handle = self.app_handle.lock().unwrap();
        *handle = Some(app);
    }

    fn emit_event(&self, event: &str, payload: impl Serialize + Clone) {
        if let Ok(handle) = self.app_handle.lock() {
            if let Some(app) = handle.as_ref() {
                let _ = app.emit(event, payload);
            }
        }
    }
}

impl Default for DocStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Detect encoding from BOM or default to UTF-8
fn detect_encoding(data: &[u8]) -> (&'static Encoding, bool) {
    if data.starts_with(UTF_8_BOM) {
        (UTF_8, true)
    } else if data.starts_with(&[0xFF, 0xFE]) {
        // UTF-16 LE
        (encoding_rs::UTF_16LE, true)
    } else if data.starts_with(&[0xFE, 0xFF]) {
        // UTF-16 BE
        (encoding_rs::UTF_16BE, true)
    } else {
        (UTF_8, false)
    }
}

/// Get BOM length for an encoding
fn bom_len(encoding: &'static Encoding) -> usize {
    if encoding == UTF_8 {
        UTF_8_BOM.len()
    } else if encoding == encoding_rs::UTF_16LE || encoding == encoding_rs::UTF_16BE {
        2
    } else {
        0
    }
}

/// Decode bytes to string using the specified encoding
fn decode_to_string(
    encoding: &'static Encoding,
    data: &[u8],
    has_bom: bool,
) -> Result<String, String> {
    let start = if has_bom { bom_len(encoding) } else { 0 };
    let (cow, _had_errors) = encoding.decode_without_bom_handling(&data[start..]);
    if _had_errors {
        // Try lossy conversion anyway
        Ok(cow.into_owned())
    } else {
        Ok(cow.into_owned())
    }
}

/// Encode string to bytes using the specified encoding
fn encode_to_bytes(encoding: &'static Encoding, text: &str, has_bom: bool) -> Vec<u8> {
    let (cow, _enc, _had_errors) = encoding.encode(text);
    let mut result = Vec::with_capacity(cow.len() + if has_bom { bom_len(encoding) } else { 0 });

    if has_bom {
        // Add appropriate BOM
        if encoding == UTF_8 {
            result.extend_from_slice(UTF_8_BOM);
        } else if encoding == encoding_rs::UTF_16LE {
            result.extend_from_slice(&[0xFF, 0xFE]);
        } else if encoding == encoding_rs::UTF_16BE {
            result.extend_from_slice(&[0xFE, 0xFF]);
        }
    }

    result.extend_from_slice(&cow);
    result
}

/// Convert (line, column) to byte offset in UTF-8 text
fn position_to_offset(text: &str, line: usize, column: usize) -> usize {
    let mut current_line = 1;
    let mut current_col = 1;
    let mut offset = 0;

    for ch in text.chars() {
        if current_line == line && current_col == column {
            break;
        }
        if ch == '\n' {
            current_line += 1;
            current_col = 1;
        } else {
            current_col += 1;
        }
        offset += ch.len_utf8();
    }

    offset
}

/// Get line start offsets
fn get_line_offsets(text: &str) -> Vec<usize> {
    let mut offsets = vec![0];
    let mut offset = 0;

    for ch in text.chars() {
        offset += ch.len_utf8();
        if ch == '\n' {
            offsets.push(offset);
        }
    }

    offsets
}

/// Convert TextRange to byte offsets
fn range_to_byte_offsets(text: &str, range: &TextRange) -> (usize, usize) {
    let start = position_to_offset(text, range.start_line, range.start_column);
    let end = position_to_offset(text, range.end_line, range.end_column);
    (start, end)
}

impl Document {
    /// Create a new document from file path or as untitled
    fn new(handle: DocHandle, path: Option<PathBuf>) -> Result<Self, String> {
        let (original, encoding, has_bom, line_endings) = if let Some(ref p) = path {
            // Load from file
            let file = File::open(p).map_err(|e| format!("Failed to open file: {}", e))?;
            let metadata = file
                .metadata()
                .map_err(|e| format!("Failed to get file metadata: {}", e))?;
            let file_size = metadata.len() as usize;

            let (encoding, has_bom) = if file_size > 0 {
                // Read first few bytes to detect BOM
                let mut bom_buf = [0u8; 4];
                let mut file_ref = file.try_clone().map_err(|e| e.to_string())?;
                let _ = file_ref.read(&mut bom_buf);
                detect_encoding(&bom_buf)
            } else {
                (UTF_8, false)
            };

            let original = if file_size > MMAP_THRESHOLD_BYTES {
                // Use memory mapping for large files
                let mmap = unsafe {
                    Mmap::map(&file).map_err(|e| format!("Failed to memory-map file: {}", e))?
                };
                OriginalContent::Mmapped(mmap)
            } else {
                // Read into memory for small files
                let mut buf = Vec::with_capacity(file_size);
                let mut file_ref = file.try_clone().map_err(|e| e.to_string())?;
                file_ref
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Failed to read file: {}", e))?;
                OriginalContent::Owned(buf)
            };

            let line_endings = LineEnding::detect(original.as_bytes());

            (original, encoding, has_bom, line_endings)
        } else {
            // Untitled document - empty
            (
                OriginalContent::Owned(Vec::new()),
                UTF_8,
                false,
                LineEnding::Lf,
            )
        };

        let pieces = vec![Piece {
            source: PieceSource::Original,
            start: 0,
            length: original.len(),
        }];

        Ok(Document {
            handle,
            path,
            original,
            add_buffer: Vec::new(),
            pieces,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            is_dirty: false,
            encoding,
            has_bom,
            line_endings,
            autosave: None,
            autosave_tx: None,
        })
    }

    /// Get the full content as a string (expensive operation)
    fn get_content(&self) -> Result<String, String> {
        let bytes = self.get_content_bytes();
        decode_to_string(self.encoding, &bytes, self.has_bom)
    }

    /// Get content as bytes
    fn get_content_bytes(&self) -> Vec<u8> {
        let mut result = Vec::with_capacity(self.total_length());

        for piece in &self.pieces {
            let bytes = match piece.source {
                PieceSource::Original => {
                    &self.original.as_bytes()[piece.start..piece.start + piece.length]
                }
                PieceSource::AddBuffer => &self.add_buffer[piece.start..piece.start + piece.length],
            };
            result.extend_from_slice(bytes);
        }

        result
    }

    /// Get content for a specific line range
    fn get_content_range(&self, range: &LineRange) -> Result<String, String> {
        let full_text = self.get_content()?;
        let lines: Vec<&str> = full_text.lines().collect();

        let start = (range.start.saturating_sub(1)).min(lines.len());
        let end = range.end.min(lines.len());

        if start >= end {
            return Ok(String::new());
        }

        let selected: Vec<&str> = lines[start..end].to_vec();
        Ok(selected.join(self.line_endings.as_str()))
    }

    /// Get total length in bytes
    fn total_length(&self) -> usize {
        self.pieces.iter().map(|p| p.length).sum()
    }

    /// Get line count
    fn line_count(&self) -> usize {
        let content = self.get_content_bytes();
        let mut count = 1; // At least 1 line
        for &b in &content {
            if b == b'\n' {
                count += 1;
            }
        }
        count
    }

    /// Get character count
    fn char_count(&self) -> usize {
        match self.get_content() {
            Ok(text) => text.chars().count(),
            Err(_) => self.total_length(),
        }
    }

    /// Apply a sequence of edit operations
    fn apply_edits(&mut self, edits: Vec<EditOp>, save_undo: bool) -> Result<(), String> {
        // Sort edits by position (reverse order to apply from end to start)
        let mut sorted_edits = edits.clone();
        sorted_edits.sort_by(|a, b| {
            let a_pos = (a.range.start_line, a.range.start_column);
            let b_pos = (b.range.start_line, b.range.start_column);
            b_pos.cmp(&a_pos) // Reverse order
        });

        let mut undo_ops = Vec::new();

        for edit in sorted_edits {
            let content = self.get_content()?;
            let (start_offset, end_offset) = range_to_byte_offsets(&content, &edit.range);

            // Store old text for undo if not provided
            let old_text = edit
                .old_text
                .clone()
                .unwrap_or_else(|| content[start_offset..end_offset].to_string());

            // Apply the edit to the piece table
            self.replace_range_bytes(start_offset, end_offset, &edit.new_text)?;

            // Create undo operation (reverse of the edit)
            undo_ops.push(EditOp {
                range: TextRange {
                    start_line: edit.range.start_line,
                    start_column: edit.range.start_column,
                    end_line: edit.range.start_line
                        + edit.new_text.lines().count().saturating_sub(1),
                    end_column: if edit.new_text.lines().count() == 1 {
                        edit.range.start_column + edit.new_text.len()
                    } else {
                        edit.new_text.lines().last().map(|l| l.len()).unwrap_or(0)
                    },
                },
                new_text: old_text.clone(),
                old_text: Some(edit.new_text.clone()),
            });

            self.is_dirty = true;
        }

        if save_undo && !undo_ops.is_empty() {
            // Add to undo stack
            self.undo_stack.push(undo_ops);
            if self.undo_stack.len() > MAX_UNDO_STACK_SIZE {
                self.undo_stack.remove(0);
            }
            // Clear redo stack on new edit
            self.redo_stack.clear();
        }

        Ok(())
    }

    /// Replace a byte range in the piece table
    fn replace_range_bytes(
        &mut self,
        start: usize,
        end: usize,
        new_text: &str,
    ) -> Result<(), String> {
        let new_text_bytes = encode_to_bytes(self.encoding, new_text, false);

        // Find the piece indices that contain start and end positions
        let mut current_offset = 0;
        let mut start_piece_idx = None;
        let mut start_piece_offset = 0;
        let mut end_piece_idx = None;
        let mut end_piece_offset = 0;

        for (idx, piece) in self.pieces.iter().enumerate() {
            let piece_end = current_offset + piece.length;

            if start_piece_idx.is_none() && start < piece_end {
                start_piece_idx = Some(idx);
                start_piece_offset = start - current_offset;
            }

            if end_piece_idx.is_none() && end <= piece_end {
                end_piece_idx = Some(idx);
                end_piece_offset = end - current_offset;
                break;
            }

            current_offset = piece_end;
        }

        let start_idx = start_piece_idx.ok_or("Start position out of bounds")?;
        let end_idx = end_piece_idx.ok_or("End position out of bounds")?;

        // Append new text to add_buffer
        let add_start = self.add_buffer.len();
        self.add_buffer.extend_from_slice(&new_text_bytes);

        // Create new pieces
        let mut new_pieces = Vec::new();

        // Add pieces before start
        new_pieces.extend_from_slice(&self.pieces[..start_idx]);

        // Add partial piece from start of start_piece to split point
        if start_piece_offset > 0 {
            let start_piece = &self.pieces[start_idx];
            new_pieces.push(Piece {
                source: start_piece.source,
                start: start_piece.start,
                length: start_piece_offset,
            });
        }

        // Add the new text piece
        if !new_text_bytes.is_empty() {
            new_pieces.push(Piece {
                source: PieceSource::AddBuffer,
                start: add_start,
                length: new_text_bytes.len(),
            });
        }

        // Add partial piece from end split point to end of end_piece
        let end_piece = &self.pieces[end_idx];
        let remaining_in_end = end_piece.length - end_piece_offset;
        if remaining_in_end > 0 {
            new_pieces.push(Piece {
                source: end_piece.source,
                start: end_piece.start + end_piece_offset,
                length: remaining_in_end,
            });
        }

        // Add pieces after end
        new_pieces.extend_from_slice(&self.pieces[end_idx + 1..]);

        self.pieces = new_pieces;

        // Merge adjacent pieces from the same source
        self.merge_adjacent_pieces();

        Ok(())
    }

    /// Merge adjacent pieces from the same source for efficiency
    fn merge_adjacent_pieces(&mut self) {
        if self.pieces.len() < 2 {
            return;
        }

        let mut merged = Vec::with_capacity(self.pieces.len());
        merged.push(self.pieces[0].clone());

        for piece in self.pieces.iter().skip(1) {
            let last = merged.last_mut().unwrap();
            if last.source == piece.source && last.start + last.length == piece.start {
                last.length += piece.length;
            } else {
                merged.push(piece.clone());
            }
        }

        self.pieces = merged;
    }

    /// Undo last operation
    fn undo(&mut self) -> Option<Vec<EditOp>> {
        if let Some(ops) = self.undo_stack.pop() {
            // Apply reverse operations
            let _ = self.apply_edits(ops.clone(), false);
            self.redo_stack.push(ops.clone());
            self.is_dirty = !self.undo_stack.is_empty();
            Some(ops)
        } else {
            None
        }
    }

    /// Redo last undone operation
    fn redo(&mut self) -> Option<Vec<EditOp>> {
        if let Some(ops) = self.redo_stack.pop() {
            let _ = self.apply_edits(ops.clone(), false);
            self.undo_stack.push(ops.clone());
            self.is_dirty = true;
            Some(ops)
        } else {
            None
        }
    }

    /// Save document to disk
    fn save(&mut self, path: Option<PathBuf>) -> Result<PathBuf, String> {
        let save_path = path
            .or_else(|| self.path.clone())
            .ok_or("No path specified for save")?;

        let content = self.get_content_bytes();

        // Convert line endings if needed
        let final_content = if self.line_endings == LineEnding::Lf {
            content
        } else {
            // Replace LF with CRLF
            let text = String::from_utf8_lossy(&content);
            let converted = text.replace('\n', "\r\n").replace("\r\r\n", "\r\n");
            encode_to_bytes(self.encoding, &converted, self.has_bom)
        };

        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&save_path)
            .map_err(|e| format!("Failed to open file for writing: {}", e))?;

        file.write_all(&final_content)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        // Update state after successful save
        self.path = Some(save_path.clone());
        self.is_dirty = false;

        // Reset original content to the saved state
        // Note: For large files, this could be optimized
        self.original = OriginalContent::Owned(self.get_content_bytes());
        self.add_buffer.clear();
        self.pieces = vec![Piece {
            source: PieceSource::Original,
            start: 0,
            length: self.original.len(),
        }];
        self.undo_stack.clear();
        self.redo_stack.clear();

        Ok(save_path)
    }

    /// Get stats
    fn stats(&self) -> DocStats {
        DocStats {
            handle: self.handle,
            path: self.path.as_ref().map(|p| p.to_string_lossy().to_string()),
            line_count: self.line_count(),
            char_count: self.char_count(),
            is_dirty: self.is_dirty,
            can_undo: !self.undo_stack.is_empty(),
            can_redo: !self.redo_stack.is_empty(),
            encoding: self.encoding.name().to_string(),
            line_endings: self.line_endings.as_str().to_string(),
        }
    }

    /// Setup auto-save task
    fn setup_autosave(&mut self, app_handle: Option<AppHandle>, enabled: bool, delay_ms: u64) {
        self.autosave = Some(AutosaveConfig { enabled, delay_ms });

        // Shutdown existing auto-save task
        if let Some(tx) = self.autosave_tx.take() {
            let _ = tx.try_send(AutosaveMsg::Shutdown);
        }

        if enabled {
            let (tx, mut rx) = channel::<AutosaveMsg>(10);
            self.autosave_tx = Some(tx.clone());

            let handle = self.handle;
            let path = self.path.clone();

            tokio::spawn(async move {
                let mut last_edit = Instant::now();
                let mut current_delay = Duration::from_millis(delay_ms);

                loop {
                    tokio::select! {
                        msg = rx.recv() => {
                            match msg {
                                Some(AutosaveMsg::Trigger) => {
                                    last_edit = Instant::now();
                                }
                                Some(AutosaveMsg::UpdateDelay(new_delay)) => {
                                    current_delay = Duration::from_millis(new_delay);
                                }
                                Some(AutosaveMsg::Shutdown) | None => {
                                    break;
                                }
                            }
                        }
                        _ = sleep(current_delay) => {
                            if last_edit.elapsed() >= current_delay {
                                // Time to auto-save
                                if let Some(ref app) = app_handle {
                                    let _ = app.emit("doc-autosave", serde_json::json!({
                                        "handle": handle.0,
                                        "path": path.as_ref().map(|p| p.to_string_lossy().to_string()),
                                    }));
                                }
                            }
                        }
                    }
                }
            });
        }
    }

    /// Trigger auto-save (call after edits)
    fn trigger_autosave(&self) {
        if let Some(ref tx) = self.autosave_tx {
            let _ = tx.try_send(AutosaveMsg::Trigger);
        }
    }
}

/// Open a document (load from disk or create new)
#[tauri::command]
pub fn doc_open(
    state: State<'_, Arc<DocStore>>,
    path: Option<String>,
) -> Result<DocHandle, String> {
    let path_buf = path.as_ref().map(|p| PathBuf::from(p));
    let path_for_event = path.clone();

    // Check if document is already open
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    for (handle, doc) in docs.iter() {
        let doc = doc.lock().map_err(|e| e.to_string())?;
        if doc.path == path_buf {
            return Ok(*handle);
        }
    }
    drop(docs);

    // Create new document
    let handle = DocHandle(state.next_handle.fetch_add(1, Ordering::SeqCst));
    let doc = Document::new(handle, path_buf)?;

    let mut docs = state.documents.write().map_err(|e| e.to_string())?;
    docs.insert(handle, Mutex::new(doc));

    state.emit_event(
        "doc-opened",
        serde_json::json!({
            "handle": handle.0,
            "path": path_for_event,
        }),
    );

    Ok(handle)
}

/// Get document content (with optional line range)
#[tauri::command]
pub fn doc_get(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
    range: Option<LineRange>,
) -> Result<String, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let doc = doc.lock().map_err(|e| e.to_string())?;

    match range {
        Some(r) => doc.get_content_range(&r),
        None => doc.get_content(),
    }
}

/// Apply edit operations
#[tauri::command]
pub fn doc_edit(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
    edits: Vec<EditOp>,
) -> Result<(), String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let mut doc = doc.lock().map_err(|e| e.to_string())?;

    doc.apply_edits(edits, true)?;
    doc.trigger_autosave();

    drop(doc);
    drop(docs);

    state.emit_event(
        "doc-changed",
        serde_json::json!({
            "handle": handle.0,
        }),
    );

    Ok(())
}

/// Get document stats
#[tauri::command]
pub fn doc_stats(state: State<'_, Arc<DocStore>>, handle: DocHandle) -> Result<DocStats, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let doc = doc.lock().map_err(|e| e.to_string())?;

    Ok(doc.stats())
}

/// Save document to disk
#[tauri::command]
pub fn doc_save(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
    path: Option<String>,
) -> Result<(), String> {
    let path_buf = path.map(PathBuf::from);

    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let mut doc = doc.lock().map_err(|e| e.to_string())?;

    // Save returns the path
    doc.save(path_buf.clone())?;
    let path_str = path_buf
        .or_else(|| doc.path.clone())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    drop(doc);
    drop(docs);

    state.emit_event(
        "doc-saved",
        serde_json::json!({
            "handle": handle.0,
            "path": path_str,
        }),
    );

    Ok(())
}

/// Close document (free memory)
#[tauri::command]
pub fn doc_close(state: State<'_, Arc<DocStore>>, handle: DocHandle) -> Result<(), String> {
    let mut docs = state.documents.write().map_err(|e| e.to_string())?;

    if let Some(doc) = docs.remove(&handle) {
        // Shutdown auto-save task
        if let Ok(doc) = doc.lock() {
            if let Some(ref tx) = doc.autosave_tx {
                let _ = tx.try_send(AutosaveMsg::Shutdown);
            }
        }
    }

    state.emit_event(
        "doc-closed",
        serde_json::json!({
            "handle": handle.0,
        }),
    );

    Ok(())
}

/// Undo last operation
#[tauri::command]
pub fn doc_undo(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
) -> Result<Option<Vec<EditOp>>, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let mut doc = doc.lock().map_err(|e| e.to_string())?;

    let result = doc.undo();

    if result.is_some() {
        drop(doc);
        drop(docs);

        state.emit_event(
            "doc-changed",
            serde_json::json!({
                "handle": handle.0,
                "action": "undo",
            }),
        );
    }

    Ok(result)
}

/// Redo last undone operation
#[tauri::command]
pub fn doc_redo(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
) -> Result<Option<Vec<EditOp>>, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let mut doc = doc.lock().map_err(|e| e.to_string())?;

    let result = doc.redo();

    if result.is_some() {
        drop(doc);
        drop(docs);

        state.emit_event(
            "doc-changed",
            serde_json::json!({
                "handle": handle.0,
                "action": "redo",
            }),
        );
    }

    Ok(result)
}

/// Enable/disable auto-save
#[tauri::command]
pub fn doc_autosave(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
    enabled: bool,
    delay_ms: Option<u64>,
) -> Result<(), String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let mut doc = doc.lock().map_err(|e| e.to_string())?;

    let delay = delay_ms.unwrap_or(DEFAULT_AUTOSAVE_DELAY_MS);

    // Get app handle from DocStore
    let app_handle = state.app_handle.lock().ok().and_then(|h| h.clone());

    doc.setup_autosave(app_handle, enabled, delay);

    state.emit_event(
        "doc-autosave-configured",
        serde_json::json!({
            "handle": handle.0,
            "enabled": enabled,
            "delay_ms": delay,
        }),
    );

    Ok(())
}

/// List all open documents
#[tauri::command]
pub fn doc_list(state: State<'_, Arc<DocStore>>) -> Result<Vec<DocStats>, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let mut stats = Vec::new();

    for (_, doc) in docs.iter() {
        if let Ok(doc) = doc.lock() {
            stats.push(doc.stats());
        }
    }

    Ok(stats)
}

/// Check if document has unsaved changes
#[tauri::command]
pub fn doc_is_dirty(state: State<'_, Arc<DocStore>>, handle: DocHandle) -> Result<bool, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let doc = doc.lock().map_err(|e| e.to_string())?;

    Ok(doc.is_dirty)
}

/// Get the path of a document
#[tauri::command]
pub fn doc_path(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
) -> Result<Option<String>, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let doc = doc.lock().map_err(|e| e.to_string())?;

    Ok(doc.path.as_ref().map(|p| p.to_string_lossy().to_string()))
}

/// Force auto-save trigger (for testing or manual auto-save)
#[tauri::command]
pub fn doc_trigger_autosave(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
) -> Result<(), String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let doc = doc.lock().map_err(|e| e.to_string())?;

    doc.trigger_autosave();

    Ok(())
}

/// Get encoding and line ending information
#[tauri::command]
pub fn doc_encoding_info(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
) -> Result<serde_json::Value, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let doc = doc.lock().map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "encoding": doc.encoding.name(),
        "hasBom": doc.has_bom,
        "lineEndings": doc.line_endings.as_str(),
    }))
}

/// Set line endings style (converts on next save)
#[tauri::command]
pub fn doc_set_line_endings(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
    line_endings: String,
) -> Result<(), String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let mut doc = doc.lock().map_err(|e| e.to_string())?;

    doc.line_endings = match line_endings.as_str() {
        "LF" | "lf" => LineEnding::Lf,
        "CRLF" | "crlf" => LineEnding::Crlf,
        _ => return Err("Invalid line endings. Use 'LF' or 'CRLF'".to_string()),
    };

    doc.is_dirty = true;

    Ok(())
}

/// Get the byte offset for a position (line, column)
#[tauri::command]
pub fn doc_position_to_offset(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
    line: usize,
    column: usize,
) -> Result<usize, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let doc = doc.lock().map_err(|e| e.to_string())?;

    let content = doc.get_content()?;
    Ok(position_to_offset(&content, line, column))
}

/// Get position (line, column) for a byte offset
#[tauri::command]
pub fn doc_offset_to_position(
    state: State<'_, Arc<DocStore>>,
    handle: DocHandle,
    offset: usize,
) -> Result<serde_json::Value, String> {
    let docs = state.documents.read().map_err(|e| e.to_string())?;
    let doc = docs.get(&handle).ok_or("Document not found")?;
    let doc = doc.lock().map_err(|e| e.to_string())?;

    let content = doc.get_content()?;
    let mut current_offset = 0;
    let mut line = 1;
    let mut column = 1;

    for ch in content.chars() {
        if current_offset >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
        current_offset += ch.len_utf8();
    }

    Ok(serde_json::json!({
        "line": line,
        "column": column,
    }))
}

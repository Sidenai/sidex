//! Document outline / symbols panel — tree view of symbols in the current file.
//!
//! Updated via LSP `textDocument/documentSymbol`, supports filtering,
//! follow-cursor, and breadcrumbs integration.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Symbol types
// ---------------------------------------------------------------------------

/// LSP-compatible symbol kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SymbolKind {
    File,
    Module,
    Namespace,
    Package,
    Class,
    Method,
    Property,
    Field,
    Constructor,
    Enum,
    Interface,
    Function,
    Variable,
    Constant,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Key,
    Null,
    EnumMember,
    Struct,
    Event,
    Operator,
    TypeParameter,
}

impl SymbolKind {
    /// Human-readable label for the kind.
    pub fn label(self) -> &'static str {
        match self {
            Self::File => "File",
            Self::Module => "Module",
            Self::Namespace => "Namespace",
            Self::Package => "Package",
            Self::Class => "Class",
            Self::Method => "Method",
            Self::Property => "Property",
            Self::Field => "Field",
            Self::Constructor => "Constructor",
            Self::Enum => "Enum",
            Self::Interface => "Interface",
            Self::Function => "Function",
            Self::Variable => "Variable",
            Self::Constant => "Constant",
            Self::String => "String",
            Self::Number => "Number",
            Self::Boolean => "Boolean",
            Self::Array => "Array",
            Self::Object => "Object",
            Self::Key => "Key",
            Self::Null => "Null",
            Self::EnumMember => "Enum Member",
            Self::Struct => "Struct",
            Self::Event => "Event",
            Self::Operator => "Operator",
            Self::TypeParameter => "Type Parameter",
        }
    }

    /// Icon name used for rendering.
    pub fn icon_name(self) -> &'static str {
        match self {
            Self::File => "symbol-file",
            Self::Module => "symbol-module",
            Self::Namespace => "symbol-namespace",
            Self::Package => "symbol-package",
            Self::Class => "symbol-class",
            Self::Method => "symbol-method",
            Self::Property => "symbol-property",
            Self::Field => "symbol-field",
            Self::Constructor => "symbol-constructor",
            Self::Enum => "symbol-enum",
            Self::Interface => "symbol-interface",
            Self::Function => "symbol-function",
            Self::Variable => "symbol-variable",
            Self::Constant => "symbol-constant",
            Self::String => "symbol-string",
            Self::Number => "symbol-number",
            Self::Boolean => "symbol-boolean",
            Self::Array => "symbol-array",
            Self::Object => "symbol-object",
            Self::Key => "symbol-key",
            Self::Null => "symbol-null",
            Self::EnumMember => "symbol-enum-member",
            Self::Struct => "symbol-struct",
            Self::Event => "symbol-event",
            Self::Operator => "symbol-operator",
            Self::TypeParameter => "symbol-type-parameter",
        }
    }
}

/// A 0-based line/column position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

/// A range in a document (start inclusive, end exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

impl Range {
    pub fn contains_position(&self, pos: Position) -> bool {
        if pos.line < self.start.line || pos.line > self.end.line {
            return false;
        }
        if pos.line == self.start.line && pos.character < self.start.character {
            return false;
        }
        if pos.line == self.end.line && pos.character > self.end.character {
            return false;
        }
        true
    }
}

/// A document symbol with hierarchical children (LSP `DocumentSymbol`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: SymbolKind,
    pub range: Range,
    pub selection_range: Range,
    pub children: Vec<DocumentSymbol>,
}

impl DocumentSymbol {
    /// Total number of symbols in this subtree (inclusive).
    pub fn count(&self) -> usize {
        1 + self
            .children
            .iter()
            .map(DocumentSymbol::count)
            .sum::<usize>()
    }

    /// Flatten the tree into a depth-first list with depth info.
    pub fn flatten(&self, depth: usize) -> Vec<(usize, &DocumentSymbol)> {
        let mut out = vec![(depth, self)];
        for child in &self.children {
            out.extend(child.flatten(depth + 1));
        }
        out
    }

    /// Find the deepest symbol whose range contains the given position.
    pub fn symbol_at(&self, pos: Position) -> Option<&DocumentSymbol> {
        if !self.range.contains_position(pos) {
            return None;
        }
        for child in &self.children {
            if let Some(found) = child.symbol_at(pos) {
                return Some(found);
            }
        }
        Some(self)
    }
}

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

/// How symbols are sorted in the outline panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum OutlineSortOrder {
    #[default]
    Position,
    Alphabetical,
    Category,
}

// ---------------------------------------------------------------------------
// Outline panel state
// ---------------------------------------------------------------------------

/// State for the Outline panel in the sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct OutlinePanel {
    pub symbols: Vec<DocumentSymbol>,
    pub filter: String,
    pub sort_by: OutlineSortOrder,
    pub follow_cursor: bool,
    pub active_symbol: Option<String>,
    pub file_path: Option<PathBuf>,
    pub collapsed: std::collections::HashSet<String>,
}

impl Default for OutlinePanel {
    fn default() -> Self {
        Self {
            symbols: Vec::new(),
            filter: String::new(),
            sort_by: OutlineSortOrder::default(),
            follow_cursor: true,
            active_symbol: None,
            file_path: None,
            collapsed: std::collections::HashSet::new(),
        }
    }
}

impl OutlinePanel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace all symbols (e.g. after receiving a new LSP response).
    pub fn update_symbols(&mut self, symbols: Vec<DocumentSymbol>) {
        self.symbols = symbols;
        if self.sort_by != OutlineSortOrder::Position {
            self.apply_sort();
        }
    }

    /// Set the file that this outline panel is showing.
    pub fn set_file(&mut self, path: PathBuf) {
        if self.file_path.as_ref() != Some(&path) {
            self.file_path = Some(path);
            self.symbols.clear();
            self.active_symbol = None;
        }
    }

    /// Update the active symbol based on cursor position.
    pub fn update_cursor(&mut self, pos: Position) {
        if !self.follow_cursor {
            return;
        }
        self.active_symbol = self.find_symbol_at(pos).map(|s| s.name.clone());
    }

    /// Find the deepest symbol containing the cursor position.
    pub fn find_symbol_at(&self, pos: Position) -> Option<&DocumentSymbol> {
        for sym in &self.symbols {
            if let Some(found) = sym.symbol_at(pos) {
                return Some(found);
            }
        }
        None
    }

    /// Set the sort order and re-sort.
    pub fn set_sort_order(&mut self, order: OutlineSortOrder) {
        self.sort_by = order;
        self.apply_sort();
    }

    /// Filter symbols by name substring.
    pub fn set_filter(&mut self, filter: String) {
        self.filter = filter;
    }

    /// Return symbols matching the current filter.
    pub fn filtered_symbols(&self) -> Vec<&DocumentSymbol> {
        if self.filter.is_empty() {
            return self.symbols.iter().collect();
        }
        let lower = self.filter.to_lowercase();
        self.symbols
            .iter()
            .filter(|s| contains_matching_symbol(s, &lower))
            .collect()
    }

    /// Toggle collapsed state for a symbol identified by name.
    pub fn toggle_collapsed(&mut self, name: &str) {
        if !self.collapsed.remove(name) {
            self.collapsed.insert(name.to_string());
        }
    }

    pub fn is_collapsed(&self, name: &str) -> bool {
        self.collapsed.contains(name)
    }

    /// Build breadcrumb path from root to the active symbol.
    pub fn breadcrumbs(&self) -> Vec<String> {
        let Some(ref active) = self.active_symbol else {
            return Vec::new();
        };
        let mut path = Vec::new();
        for sym in &self.symbols {
            if find_breadcrumb_path(sym, active, &mut path) {
                return path;
            }
        }
        Vec::new()
    }

    /// Total symbol count across all roots.
    pub fn symbol_count(&self) -> usize {
        self.symbols.iter().map(DocumentSymbol::count).sum()
    }

    fn apply_sort(&mut self) {
        sort_symbols(&mut self.symbols, self.sort_by);
    }
}

fn sort_symbols(symbols: &mut [DocumentSymbol], order: OutlineSortOrder) {
    match order {
        OutlineSortOrder::Position => {
            symbols.sort_by_key(|s| (s.range.start.line, s.range.start.character));
        }
        OutlineSortOrder::Alphabetical => {
            symbols.sort_by_key(|a| a.name.to_lowercase());
        }
        OutlineSortOrder::Category => {
            symbols.sort_by(|a, b| {
                (a.kind as u8)
                    .cmp(&(b.kind as u8))
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
        }
    }
    for sym in symbols.iter_mut() {
        sort_symbols(&mut sym.children, order);
    }
}

fn contains_matching_symbol(sym: &DocumentSymbol, filter: &str) -> bool {
    if sym.name.to_lowercase().contains(filter) {
        return true;
    }
    sym.children
        .iter()
        .any(|c| contains_matching_symbol(c, filter))
}

fn find_breadcrumb_path(sym: &DocumentSymbol, target: &str, path: &mut Vec<String>) -> bool {
    path.push(sym.name.clone());
    if sym.name == target {
        return true;
    }
    for child in &sym.children {
        if find_breadcrumb_path(child, target, path) {
            return true;
        }
    }
    path.pop();
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_symbols() -> Vec<DocumentSymbol> {
        vec![
            DocumentSymbol {
                name: "MyStruct".into(),
                detail: None,
                kind: SymbolKind::Struct,
                range: Range {
                    start: Position {
                        line: 0,
                        character: 0,
                    },
                    end: Position {
                        line: 20,
                        character: 0,
                    },
                },
                selection_range: Range {
                    start: Position {
                        line: 0,
                        character: 4,
                    },
                    end: Position {
                        line: 0,
                        character: 12,
                    },
                },
                children: vec![
                    DocumentSymbol {
                        name: "new".into(),
                        detail: Some("fn() -> Self".into()),
                        kind: SymbolKind::Method,
                        range: Range {
                            start: Position {
                                line: 2,
                                character: 0,
                            },
                            end: Position {
                                line: 5,
                                character: 0,
                            },
                        },
                        selection_range: Range {
                            start: Position {
                                line: 2,
                                character: 7,
                            },
                            end: Position {
                                line: 2,
                                character: 10,
                            },
                        },
                        children: vec![],
                    },
                    DocumentSymbol {
                        name: "process".into(),
                        detail: Some("fn(&self)".into()),
                        kind: SymbolKind::Method,
                        range: Range {
                            start: Position {
                                line: 7,
                                character: 0,
                            },
                            end: Position {
                                line: 15,
                                character: 0,
                            },
                        },
                        selection_range: Range {
                            start: Position {
                                line: 7,
                                character: 7,
                            },
                            end: Position {
                                line: 7,
                                character: 14,
                            },
                        },
                        children: vec![],
                    },
                ],
            },
            DocumentSymbol {
                name: "main".into(),
                detail: None,
                kind: SymbolKind::Function,
                range: Range {
                    start: Position {
                        line: 22,
                        character: 0,
                    },
                    end: Position {
                        line: 30,
                        character: 0,
                    },
                },
                selection_range: Range {
                    start: Position {
                        line: 22,
                        character: 3,
                    },
                    end: Position {
                        line: 22,
                        character: 7,
                    },
                },
                children: vec![],
            },
        ]
    }

    #[test]
    fn symbol_count() {
        let panel = OutlinePanel {
            symbols: sample_symbols(),
            ..Default::default()
        };
        assert_eq!(panel.symbol_count(), 4);
    }

    #[test]
    fn find_symbol_at_cursor() {
        let panel = OutlinePanel {
            symbols: sample_symbols(),
            ..Default::default()
        };
        let sym = panel.find_symbol_at(Position {
            line: 3,
            character: 5,
        });
        assert!(sym.is_some());
        assert_eq!(sym.unwrap().name, "new");
    }

    #[test]
    fn follow_cursor_updates_active() {
        let mut panel = OutlinePanel {
            symbols: sample_symbols(),
            follow_cursor: true,
            ..Default::default()
        };
        panel.update_cursor(Position {
            line: 10,
            character: 0,
        });
        assert_eq!(panel.active_symbol.as_deref(), Some("process"));
    }

    #[test]
    fn breadcrumbs_path() {
        let mut panel = OutlinePanel {
            symbols: sample_symbols(),
            follow_cursor: true,
            ..Default::default()
        };
        panel.update_cursor(Position {
            line: 3,
            character: 0,
        });
        let crumbs = panel.breadcrumbs();
        assert_eq!(crumbs, vec!["MyStruct", "new"]);
    }

    #[test]
    fn sort_alphabetical() {
        let mut panel = OutlinePanel {
            symbols: sample_symbols(),
            ..Default::default()
        };
        panel.set_sort_order(OutlineSortOrder::Alphabetical);
        assert_eq!(panel.symbols[0].name, "main");
        assert_eq!(panel.symbols[1].name, "MyStruct");
    }

    #[test]
    fn filter_symbols() {
        let mut panel = OutlinePanel {
            symbols: sample_symbols(),
            ..Default::default()
        };
        panel.set_filter("proc".into());
        let filtered = panel.filtered_symbols();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "MyStruct");
    }

    #[test]
    fn collapsed_toggle() {
        let mut panel = OutlinePanel::new();
        assert!(!panel.is_collapsed("MyStruct"));
        panel.toggle_collapsed("MyStruct");
        assert!(panel.is_collapsed("MyStruct"));
        panel.toggle_collapsed("MyStruct");
        assert!(!panel.is_collapsed("MyStruct"));
    }

    #[test]
    fn range_contains() {
        let range = Range {
            start: Position {
                line: 5,
                character: 0,
            },
            end: Position {
                line: 10,
                character: 0,
            },
        };
        assert!(range.contains_position(Position {
            line: 7,
            character: 3
        }));
        assert!(!range.contains_position(Position {
            line: 3,
            character: 0
        }));
        assert!(!range.contains_position(Position {
            line: 12,
            character: 0
        }));
    }

    #[test]
    fn flatten_symbols() {
        let syms = sample_symbols();
        let flat = syms[0].flatten(0);
        assert_eq!(flat.len(), 3);
        assert_eq!(flat[0].0, 0);
        assert_eq!(flat[1].0, 1);
    }
}

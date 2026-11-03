use std::path::Path;

use anyhow::{Context, Result};
use ignore::WalkBuilder;
use sha2::{Digest, Sha256};
use tree_sitter::Parser;

use super::chunk::{Chunk, ChunkKind};

const MAX_FILE_SIZE: u64 = 1_024 * 1_024; // 1 MB

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

fn language_from_extension(ext: &str) -> Option<&'static str> {
    match ext {
        "rs" => Some("rust"),
        "py" | "pyi" => Some("python"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "ts" => Some("typescript"),
        "tsx" => Some("tsx"),
        "go" => Some("go"),
        "c" | "h" => Some("c"),
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => Some("cpp"),
        "java" => Some("java"),
        "rb" | "rake" | "gemspec" => Some("ruby"),
        "sh" | "bash" | "zsh" => Some("bash"),
        "json" => Some("json"),
        "toml" => Some("toml"),
        "html" | "htm" => Some("html"),
        "css" => Some("css"),
        _ => None,
    }
}

fn parser_for_language(lang: &str) -> Result<Parser> {
    let mut parser = Parser::new();
    let language = match lang {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "c" => tree_sitter_c::LANGUAGE.into(),
        "cpp" => tree_sitter_cpp::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "ruby" => tree_sitter_ruby::LANGUAGE.into(),
        "bash" => tree_sitter_bash::LANGUAGE.into(),
        "json" => tree_sitter_json::LANGUAGE.into(),
        "toml" => tree_sitter_toml_ng::LANGUAGE.into(),
        "html" => tree_sitter_html::LANGUAGE.into(),
        "css" => tree_sitter_css::LANGUAGE.into(),
        other => anyhow::bail!("unsupported language: {other}"),
    };
    parser
        .set_language(&language)
        .with_context(|| format!("failed to set language {lang}"))?;
    Ok(parser)
}

// ---------------------------------------------------------------------------
// Node-type → ChunkKind mapping (per language)
// ---------------------------------------------------------------------------

#[allow(clippy::match_same_arms)]
fn node_kind_to_chunk_kind(lang: &str, node_kind: &str) -> Option<ChunkKind> {
    match lang {
        "rust" => match node_kind {
            "function_item" => Some(ChunkKind::Function),
            "impl_item" => Some(ChunkKind::Impl),
            "struct_item" => Some(ChunkKind::Struct),
            "enum_item" => Some(ChunkKind::Enum),
            "trait_item" => Some(ChunkKind::Trait),
            "mod_item" => Some(ChunkKind::Module),
            "use_declaration" => Some(ChunkKind::Import),
            "const_item" | "static_item" => Some(ChunkKind::Constant),
            "type_item" => Some(ChunkKind::TypeAlias),
            _ => None,
        },
        "python" => match node_kind {
            "function_definition" => Some(ChunkKind::Function),
            "class_definition" => Some(ChunkKind::Class),
            "import_statement" | "import_from_statement" => Some(ChunkKind::Import),
            _ => None,
        },
        "javascript" | "tsx" => match node_kind {
            "function_declaration" | "export_statement" => Some(ChunkKind::Function),
            "class_declaration" => Some(ChunkKind::Class),
            "method_definition" => Some(ChunkKind::Method),
            "import_statement" => Some(ChunkKind::Import),
            "lexical_declaration" => Some(ChunkKind::Constant),
            _ => None,
        },
        "typescript" => match node_kind {
            "function_declaration" | "export_statement" => Some(ChunkKind::Function),
            "class_declaration" => Some(ChunkKind::Class),
            "method_definition" => Some(ChunkKind::Method),
            "import_statement" => Some(ChunkKind::Import),
            "interface_declaration" => Some(ChunkKind::Interface),
            "type_alias_declaration" => Some(ChunkKind::TypeAlias),
            "lexical_declaration" => Some(ChunkKind::Constant),
            _ => None,
        },
        "go" => match node_kind {
            "function_declaration" => Some(ChunkKind::Function),
            "method_declaration" => Some(ChunkKind::Method),
            "type_declaration" => Some(ChunkKind::Struct),
            "import_declaration" => Some(ChunkKind::Import),
            "const_declaration" | "var_declaration" => Some(ChunkKind::Constant),
            _ => None,
        },
        "java" => match node_kind {
            "method_declaration" | "constructor_declaration" => Some(ChunkKind::Method),
            "class_declaration" => Some(ChunkKind::Class),
            "interface_declaration" => Some(ChunkKind::Interface),
            "enum_declaration" => Some(ChunkKind::Enum),
            "import_declaration" => Some(ChunkKind::Import),
            "field_declaration" | "constant_declaration" => Some(ChunkKind::Constant),
            _ => None,
        },
        "c" => match node_kind {
            "function_definition" => Some(ChunkKind::Function),
            "struct_specifier" => Some(ChunkKind::Struct),
            "enum_specifier" => Some(ChunkKind::Enum),
            "preproc_include" | "preproc_import" => Some(ChunkKind::Import),
            "declaration" => Some(ChunkKind::Constant),
            _ => None,
        },
        "cpp" => match node_kind {
            "function_definition" => Some(ChunkKind::Function),
            "struct_specifier" => Some(ChunkKind::Struct),
            "class_specifier" => Some(ChunkKind::Class),
            "enum_specifier" => Some(ChunkKind::Enum),
            "namespace_definition" => Some(ChunkKind::Module),
            "preproc_include" | "preproc_import" => Some(ChunkKind::Import),
            "type_definition" => Some(ChunkKind::TypeAlias),
            _ => None,
        },
        "ruby" => match node_kind {
            "method" | "singleton_method" => Some(ChunkKind::Method),
            "class" => Some(ChunkKind::Class),
            "module" => Some(ChunkKind::Module),
            _ => None,
        },
        "bash" => match node_kind {
            "function_definition" => Some(ChunkKind::Function),
            _ => None,
        },
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Name extraction helpers
// ---------------------------------------------------------------------------

fn extract_name(node: &tree_sitter::Node, source: &[u8], lang: &str) -> Option<String> {
    let name_field = match lang {
        "rust" => match node.kind() {
            "use_declaration" => return node_text(node, source),
            "impl_item" => {
                return node
                    .child_by_field_name("type")
                    .and_then(|n| n.utf8_text(source).ok())
                    .map(str::to_string);
            }
            _ => "name",
        },
        "javascript" | "typescript" | "tsx" => match node.kind() {
            "export_statement" => {
                return find_named_child_name(node, source);
            }
            "lexical_declaration" => {
                return find_declarator_name(node, source);
            }
            _ => "name",
        },
        "go" => match node.kind() {
            "type_declaration" => {
                return node
                    .named_child(0)
                    .and_then(|spec| spec.child_by_field_name("name"))
                    .and_then(|n| n.utf8_text(source).ok())
                    .map(str::to_string);
            }
            _ => "name",
        },
        "c" | "cpp" => match node.kind() {
            "function_definition" => "declarator",
            _ => "name",
        },
        _ => "name",
    };

    let name_node = node.child_by_field_name(name_field)?;
    if (lang == "c" || lang == "cpp") && name_node.kind() == "function_declarator" {
        return name_node
            .child_by_field_name("declarator")
            .and_then(|n| n.utf8_text(source).ok())
            .map(str::to_string);
    }
    name_node.utf8_text(source).ok().map(str::to_string)
}

fn find_named_child_name(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    for i in 0..node.named_child_count() {
        if let Some(child) = node.named_child(i) {
            match child.kind() {
                "function_declaration" | "class_declaration" | "lexical_declaration" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        return name.utf8_text(source).ok().map(str::to_string);
                    }
                    if child.kind() == "lexical_declaration" {
                        return find_declarator_name(&child, source);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn find_declarator_name(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    for i in 0..node.named_child_count() {
        if let Some(child) = node.named_child(i) {
            if child.kind() == "variable_declarator" {
                return child
                    .child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source).ok())
                    .map(str::to_string);
            }
        }
    }
    None
}

fn node_text(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    node.utf8_text(source).ok().map(str::to_string)
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

fn extract_signature(content: &str) -> Option<String> {
    let first_line = content.lines().next()?;
    let trimmed = first_line.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn compute_content_hash(content: &str) -> String {
    sha256_hex(content.as_bytes())
}

fn compute_chunk_id(file_path: &str, content_hash: &str) -> String {
    let input = format!("{file_path}:{content_hash}");
    sha256_hex(input.as_bytes())
}

// ---------------------------------------------------------------------------
// Core: chunk a single file
// ---------------------------------------------------------------------------

/// Parse a single file into semantic chunks using tree-sitter.
///
/// `path` is the absolute path to the file.
/// `workspace_root` is the workspace root, used to compute relative paths.
pub fn chunk_file(path: &Path, workspace_root: &Path) -> Result<Vec<Chunk>> {
    let rel_path = path
        .strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();

    let source = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let Some(lang) = language_from_extension(ext) else {
        return Ok(make_block_chunk(&rel_path, &source, "unknown"));
    };

    let Ok(mut parser) = parser_for_language(lang) else {
        return Ok(make_block_chunk(&rel_path, &source, lang));
    };

    let tree = parser
        .parse(&source, None)
        .with_context(|| format!("tree-sitter parse failed for {}", path.display()))?;

    let root = tree.root_node();
    let mut chunks = Vec::new();

    collect_chunks(root, &source, &rel_path, lang, &mut chunks);

    if chunks.is_empty() {
        return Ok(make_block_chunk(&rel_path, &source, lang));
    }

    Ok(chunks)
}

fn make_block_chunk(rel_path: &str, source: &[u8], lang: &str) -> Vec<Chunk> {
    let content = String::from_utf8_lossy(source).to_string();
    if content.trim().is_empty() {
        return Vec::new();
    }
    let line_count = content.lines().count().max(1);
    let content_hash = compute_content_hash(&content);
    let id = compute_chunk_id(rel_path, &content_hash);
    vec![Chunk {
        id,
        file_path: rel_path.to_string(),
        start_line: 1,
        end_line: line_count,
        kind: ChunkKind::Block,
        name: None,
        language: lang.to_string(),
        content: content.clone(),
        content_hash,
        parent_name: None,
        signature: extract_signature(&content),
    }]
}

/// Walk the tree-sitter AST iteratively using a heap-allocated work stack.
///
/// This avoids stack overflows on pathologically deep ASTs (minified files,
/// generated code, etc.) — the "stack" lives on the heap so depth is unlimited.
fn collect_chunks(
    root: tree_sitter::Node,
    source: &[u8],
    rel_path: &str,
    lang: &str,
    out: &mut Vec<Chunk>,
) {
    // Work stack entries: (node, parent_name_for_this_node)
    let mut work: Vec<(tree_sitter::Node, Option<String>)> = vec![(root, None)];

    while let Some((node, parent_name)) = work.pop() {
        // Determine what parent_name to propagate to this node's children.
        let child_parent: Option<String>;

        if let Some(kind) = node_kind_to_chunk_kind(lang, node.kind()) {
            let content = node.utf8_text(source).unwrap_or("").to_string();
            let signature = extract_signature(&content);
            let name = extract_name(&node, source, lang);
            let start_line = node.start_position().row + 1;
            let end_line = node.end_position().row + 1;
            let content_hash = compute_content_hash(&content);
            let id = compute_chunk_id(&format!("{rel_path}:{start_line}"), &content_hash);

            out.push(Chunk {
                id,
                file_path: rel_path.to_string(),
                start_line,
                end_line,
                kind: kind.clone(),
                name: name.clone(),
                language: lang.to_string(),
                content,
                content_hash,
                parent_name: parent_name.clone(),
                signature,
            });

            let is_container = matches!(
                kind,
                ChunkKind::Class
                    | ChunkKind::Struct
                    | ChunkKind::Impl
                    | ChunkKind::Trait
                    | ChunkKind::Interface
                    | ChunkKind::Module
                    | ChunkKind::Enum
            );

            // Container nodes (class, impl, etc.) set themselves as the parent
            // for their children. Non-containers pass their own parent down.
            child_parent = if is_container {
                name.or(parent_name)
            } else {
                parent_name
            };
        } else {
            // Unrecognized node — don't emit, just pass parent through.
            child_parent = parent_name;
        }

        // Push named children onto the work stack in reverse order so that
        // the first child is processed next (LIFO stack = left-to-right order).
        let mut cursor = node.walk();
        let children: Vec<tree_sitter::Node> = node.named_children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            work.push((child, child_parent.clone()));
        }
    }
}

// ---------------------------------------------------------------------------
// Chunk a directory recursively
// ---------------------------------------------------------------------------

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "vendor",
    ".next",
];

/// Recursively chunk all supported files under `dir`, respecting `.gitignore`.
pub fn chunk_directory(dir: &Path, workspace_root: &Path) -> Result<Vec<Chunk>> {
    let walker = WalkBuilder::new(dir)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !SKIP_DIRS.iter().any(|s| name == *s)
        })
        .build();

    let mut all_chunks = Vec::new();

    for entry in walker {
        let Ok(entry) = entry else { continue };

        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }

        let path = entry.path();

        if let Ok(meta) = path.metadata() {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }

        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if language_from_extension(ext).is_none() {
            continue;
        }

        if let Ok(chunks) = chunk_file(path, workspace_root) {
            all_chunks.extend(chunks);
        }
    }

    Ok(all_chunks)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn chunk_source(source: &str, lang: &str) -> Vec<Chunk> {
        let dir = tempfile::tempdir().unwrap();
        let ext = match lang {
            "rust" => "rs",
            "python" => "py",
            "javascript" => "js",
            "typescript" => "ts",
            "go" => "go",
            "java" => "java",
            "c" => "c",
            "cpp" => "cpp",
            "ruby" => "rb",
            _ => "txt",
        };
        let file_path = dir.path().join(format!("test.{ext}"));
        let mut f = std::fs::File::create(&file_path).unwrap();
        f.write_all(source.as_bytes()).unwrap();
        chunk_file(&file_path, dir.path()).unwrap()
    }

    #[test]
    fn test_rust_chunks() {
        let source = r#"
use std::collections::HashMap;

const MAX: usize = 100;

struct Point {
    x: f64,
    y: f64,
}

enum Color {
    Red,
    Green,
    Blue,
}

trait Drawable {
    fn draw(&self);
}

impl Point {
    fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    fn distance(&self, other: &Point) -> f64 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2)).sqrt()
    }
}

fn main() {
    let p = Point::new(1.0, 2.0);
    println!("{}", p.distance(&Point::new(0.0, 0.0)));
}
"#;
        let chunks = chunk_source(source, "rust");

        let kinds: Vec<&ChunkKind> = chunks.iter().map(|c| &c.kind).collect();
        assert!(
            kinds.contains(&&ChunkKind::Import),
            "should find use_declaration"
        );
        assert!(kinds.contains(&&ChunkKind::Constant), "should find const");
        assert!(kinds.contains(&&ChunkKind::Struct), "should find struct");
        assert!(kinds.contains(&&ChunkKind::Enum), "should find enum");
        assert!(kinds.contains(&&ChunkKind::Trait), "should find trait");
        assert!(kinds.contains(&&ChunkKind::Impl), "should find impl");
        assert!(kinds.contains(&&ChunkKind::Function), "should find fn main");

        let impl_chunk = chunks.iter().find(|c| c.kind == ChunkKind::Impl).unwrap();
        assert_eq!(impl_chunk.name.as_deref(), Some("Point"));

        let methods: Vec<&Chunk> = chunks
            .iter()
            .filter(|c| c.kind == ChunkKind::Function && c.parent_name.is_some())
            .collect();
        assert!(methods.len() >= 2, "impl should contain methods");
        assert_eq!(methods[0].parent_name.as_deref(), Some("Point"));
    }

    #[test]
    fn test_python_chunks() {
        let source = r#"
import os
from pathlib import Path

class Calculator:
    def __init__(self, value=0):
        self.value = value

    def add(self, n):
        self.value += n
        return self

def standalone_function(x, y):
    return x + y
"#;
        let chunks = chunk_source(source, "python");

        let kinds: Vec<&ChunkKind> = chunks.iter().map(|c| &c.kind).collect();
        assert!(kinds.contains(&&ChunkKind::Import), "should find import");
        assert!(kinds.contains(&&ChunkKind::Class), "should find class");
        assert!(
            kinds.contains(&&ChunkKind::Function),
            "should find function"
        );

        let class_chunk = chunks.iter().find(|c| c.kind == ChunkKind::Class).unwrap();
        assert_eq!(class_chunk.name.as_deref(), Some("Calculator"));

        let methods: Vec<&Chunk> = chunks
            .iter()
            .filter(|c| {
                c.kind == ChunkKind::Function && c.parent_name.as_deref() == Some("Calculator")
            })
            .collect();
        assert!(methods.len() >= 2, "class should contain __init__ and add");
    }

    #[test]
    fn test_javascript_chunks() {
        let source = r#"
import { foo } from './foo';

class Animal {
    constructor(name) {
        this.name = name;
    }

    speak() {
        return `${this.name} makes a noise.`;
    }
}

function greet(name) {
    return `Hello, ${name}!`;
}

const PI = 3.14159;
"#;
        let chunks = chunk_source(source, "javascript");

        let kinds: Vec<&ChunkKind> = chunks.iter().map(|c| &c.kind).collect();
        assert!(kinds.contains(&&ChunkKind::Import), "should find import");
        assert!(kinds.contains(&&ChunkKind::Class), "should find class");
        assert!(
            kinds.contains(&&ChunkKind::Function),
            "should find function"
        );

        let class_chunk = chunks.iter().find(|c| c.kind == ChunkKind::Class).unwrap();
        assert_eq!(class_chunk.name.as_deref(), Some("Animal"));

        let methods: Vec<&Chunk> = chunks
            .iter()
            .filter(|c| c.kind == ChunkKind::Method && c.parent_name.as_deref() == Some("Animal"))
            .collect();
        assert!(!methods.is_empty(), "class should contain methods");
    }

    #[test]
    fn test_content_hash_changes() {
        let source_a = "fn foo() { 1 }";
        let source_b = "fn foo() { 2 }";

        let chunks_a = chunk_source(source_a, "rust");
        let chunks_b = chunk_source(source_b, "rust");

        assert!(!chunks_a.is_empty());
        assert!(!chunks_b.is_empty());
        assert_ne!(
            chunks_a[0].content_hash, chunks_b[0].content_hash,
            "different content should produce different hashes"
        );
    }

    #[test]
    fn test_chunk_directory_skips_gitignored() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::process::Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .unwrap();

        std::fs::write(root.join(".gitignore"), "ignored_dir/\n").unwrap();
        std::fs::write(root.join("visible.rs"), "fn visible() {}").unwrap();

        std::fs::create_dir_all(root.join("ignored_dir")).unwrap();
        std::fs::write(root.join("ignored_dir/hidden.rs"), "fn hidden() {}").unwrap();

        let chunks = chunk_directory(root, root).unwrap();

        let files: Vec<&str> = chunks.iter().map(|c| c.file_path.as_str()).collect();
        assert!(
            files.iter().any(|f| f.contains("visible")),
            "should include visible.rs"
        );
        assert!(
            !files.iter().any(|f| f.contains("hidden")),
            "should skip gitignored files"
        );
    }

    #[test]
    fn test_empty_file_produces_no_chunks() {
        let chunks = chunk_source("", "rust");
        assert!(chunks.is_empty(), "empty file should produce no chunks");
    }

    #[test]
    fn test_unparseable_file_falls_back_to_block() {
        let source = "some random text that is not code\nbut has content\n";
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("readme.txt");
        std::fs::write(&file_path, source).unwrap();
        let chunks = chunk_file(&file_path, dir.path()).unwrap();

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].kind, ChunkKind::Block);
        assert_eq!(chunks[0].language, "unknown");
    }

    #[test]
    fn test_go_chunks() {
        let source = r#"
package main

import "fmt"

type Point struct {
	X float64
	Y float64
}

func (p Point) Distance(other Point) float64 {
	return 0.0
}

func main() {
	fmt.Println("hello")
}
"#;
        let chunks = chunk_source(source, "go");

        let kinds: Vec<&ChunkKind> = chunks.iter().map(|c| &c.kind).collect();
        assert!(kinds.contains(&&ChunkKind::Import), "should find import");
        assert!(kinds.contains(&&ChunkKind::Struct), "should find type decl");
        assert!(kinds.contains(&&ChunkKind::Method), "should find method");
        assert!(
            kinds.contains(&&ChunkKind::Function),
            "should find function"
        );
    }

    #[test]
    fn test_chunk_id_is_deterministic() {
        let source = "fn hello() { 42 }";
        let chunks_1 = chunk_source(source, "rust");
        let chunks_2 = chunk_source(source, "rust");
        assert_eq!(chunks_1[0].content_hash, chunks_2[0].content_hash);
    }

    #[test]
    fn test_signature_extracted() {
        let source = "fn complex_function(a: i32, b: String) -> Result<(), Error> {\n    Ok(())\n}";
        let chunks = chunk_source(source, "rust");
        assert!(!chunks.is_empty());
        let sig = chunks[0].signature.as_deref().unwrap();
        assert!(
            sig.contains("fn complex_function"),
            "signature should contain the function declaration"
        );
    }
}

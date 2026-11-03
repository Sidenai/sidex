use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// A node in the Merkle tree — either a file leaf or a directory interior node.
#[derive(Debug, Clone)]
pub struct MerkleNode {
    pub path: PathBuf,
    pub hash: [u8; 32],
    pub is_dir: bool,
    pub children: Vec<MerkleNode>,
}

/// Result of comparing two Merkle trees.
#[derive(Debug, Default)]
pub struct MerkleDiff {
    /// Files that are new or whose content hash changed.
    pub changed: Vec<PathBuf>,
    /// Files that were deleted (present in old, not in new).
    pub deleted: Vec<PathBuf>,
}

impl MerkleDiff {
    pub fn has_changes(&self) -> bool {
        !self.changed.is_empty() || !self.deleted.is_empty()
    }
}

/// Build a Merkle tree for a directory. Each file leaf is hashed by content;
/// each directory node is the hash of its sorted children hashes.
pub fn build_tree(root: &Path) -> anyhow::Result<MerkleNode> {
    build_node(root, root)
}

fn build_node(path: &Path, root: &Path) -> anyhow::Result<MerkleNode> {
    if path.is_file() {
        let content = std::fs::read(path)?;
        let hash = sha256_bytes(&content);
        return Ok(MerkleNode {
            path: path.strip_prefix(root).unwrap_or(path).to_path_buf(),
            hash,
            is_dir: false,
            children: vec![],
        });
    }

    let mut children = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(path)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip(&name) {
            continue;
        }
        let entry_path = entry.path();

        if entry_path.is_symlink() {
            continue;
        }

        if entry_path.is_file() {
            if let Some(ext) = entry_path.extension().and_then(|e| e.to_str()) {
                if !is_indexable_ext(ext) {
                    continue;
                }
            } else {
                continue;
            }
            if let Ok(meta) = entry_path.metadata() {
                if meta.len() > 1_048_576 {
                    continue;
                }
            }
        }

        if let Ok(child) = build_node(&entry_path, root) {
            children.push(child);
        }
    }

    let mut hasher = Sha256::new();
    for child in &children {
        hasher.update(child.hash);
    }
    let hash = hasher.finalize().into();

    Ok(MerkleNode {
        path: path.strip_prefix(root).unwrap_or(path).to_path_buf(),
        hash,
        is_dir: true,
        children,
    })
}

/// Compare two Merkle trees and return the diff.
pub fn diff_trees(old: &MerkleNode, new: &MerkleNode) -> MerkleDiff {
    let mut result = MerkleDiff::default();

    if old.hash == new.hash {
        return result;
    }

    let old_map = children_map(old);
    let new_map = children_map(new);

    for (name, new_child) in &new_map {
        match old_map.get(name) {
            Some(old_child) => {
                if old_child.hash != new_child.hash {
                    if new_child.is_dir && old_child.is_dir {
                        let sub = diff_trees(old_child, new_child);
                        result.changed.extend(sub.changed);
                        result.deleted.extend(sub.deleted);
                    } else {
                        result.changed.push(new_child.path.clone());
                    }
                }
            }
            None => {
                collect_all_files(new_child, &mut result.changed);
            }
        }
    }

    for (name, old_child) in &old_map {
        if !new_map.contains_key(name) {
            collect_all_files(old_child, &mut result.deleted);
        }
    }

    result
}

/// Flatten a tree into a hash map of file_path → content_hash for fast lookup.
pub fn flatten(node: &MerkleNode) -> HashMap<PathBuf, [u8; 32]> {
    let mut map = HashMap::new();
    flatten_inner(node, &mut map);
    map
}

fn flatten_inner(node: &MerkleNode, map: &mut HashMap<PathBuf, [u8; 32]>) {
    if !node.is_dir {
        map.insert(node.path.clone(), node.hash);
    }
    for child in &node.children {
        flatten_inner(child, map);
    }
}

fn children_map(node: &MerkleNode) -> HashMap<String, &MerkleNode> {
    node.children
        .iter()
        .map(|c| {
            let name = c
                .path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            (name, c)
        })
        .collect()
}

fn collect_all_files(node: &MerkleNode, out: &mut Vec<PathBuf>) {
    if !node.is_dir {
        out.push(node.path.clone());
    }
    for child in &node.children {
        collect_all_files(child, out);
    }
}

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

fn should_skip(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "__pycache__"
            | ".venv"
            | "vendor"
            | ".next"
            | ".DS_Store"
    ) || name.starts_with('.')
}

fn is_indexable_ext(ext: &str) -> bool {
    matches!(
        ext,
        "rs" | "py"
            | "pyi"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "ts"
            | "tsx"
            | "go"
            | "c"
            | "h"
            | "cpp"
            | "cc"
            | "cxx"
            | "hpp"
            | "java"
            | "rb"
            | "rake"
            | "sh"
            | "bash"
            | "json"
            | "toml"
            | "html"
            | "htm"
            | "css"
            | "md"
            | "yaml"
            | "yml"
            | "xml"
            | "sql"
            | "graphql"
            | "proto"
            | "swift"
            | "kt"
            | "kts"
            | "scala"
            | "lua"
            | "zig"
            | "ex"
            | "exs"
            | "erl"
            | "hrl"
            | "clj"
            | "php"
            | "dart"
            | "r"
            | "R"
            | "vue"
            | "svelte"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_build_and_diff_no_changes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();
        fs::write(dir.path().join("lib.rs"), "pub fn hello() {}").unwrap();

        let tree1 = build_tree(dir.path()).unwrap();
        let tree2 = build_tree(dir.path()).unwrap();

        assert_eq!(tree1.hash, tree2.hash);
        let diff = diff_trees(&tree1, &tree2);
        assert!(!diff.has_changes());
    }

    #[test]
    fn test_diff_detects_change() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() { 1 }").unwrap();

        let tree1 = build_tree(dir.path()).unwrap();

        fs::write(dir.path().join("main.rs"), "fn main() { 2 }").unwrap();
        let tree2 = build_tree(dir.path()).unwrap();

        assert_ne!(tree1.hash, tree2.hash);
        let diff = diff_trees(&tree1, &tree2);
        assert!(diff.has_changes());
        assert_eq!(diff.changed.len(), 1);
        assert!(diff.changed[0].to_string_lossy().contains("main.rs"));
    }

    #[test]
    fn test_diff_detects_new_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();
        let tree1 = build_tree(dir.path()).unwrap();

        fs::write(dir.path().join("new.rs"), "fn new() {}").unwrap();
        let tree2 = build_tree(dir.path()).unwrap();

        let diff = diff_trees(&tree1, &tree2);
        assert!(diff.has_changes());
        assert!(diff
            .changed
            .iter()
            .any(|p| p.to_string_lossy().contains("new.rs")));
    }

    #[test]
    fn test_diff_detects_deleted_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();
        fs::write(dir.path().join("old.rs"), "fn old() {}").unwrap();
        let tree1 = build_tree(dir.path()).unwrap();

        fs::remove_file(dir.path().join("old.rs")).unwrap();
        let tree2 = build_tree(dir.path()).unwrap();

        let diff = diff_trees(&tree1, &tree2);
        assert!(diff.has_changes());
        assert!(diff
            .deleted
            .iter()
            .any(|p| p.to_string_lossy().contains("old.rs")));
    }

    #[test]
    fn test_flatten() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.rs"), "fn a() {}").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/b.rs"), "fn b() {}").unwrap();

        let tree = build_tree(dir.path()).unwrap();
        let flat = flatten(&tree);
        assert_eq!(flat.len(), 2);
    }

    #[test]
    fn test_skips_hidden_and_node_modules() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("visible.rs"), "fn v() {}").unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("node_modules/junk.js"), "x").unwrap();

        let tree = build_tree(dir.path()).unwrap();
        let flat = flatten(&tree);
        assert_eq!(flat.len(), 1);
        assert!(flat.keys().any(|p| p.to_string_lossy().contains("visible")));
    }
}

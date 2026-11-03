use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    /// SHA-256 of `file_path:content_hash`
    pub id: String,
    /// Relative to workspace root
    pub file_path: String,
    /// 1-indexed
    pub start_line: usize,
    /// 1-indexed, inclusive
    pub end_line: usize,
    pub kind: ChunkKind,
    /// Symbol name if applicable (fn name, class name, etc.)
    pub name: Option<String>,
    /// e.g. "rust", "python"
    pub language: String,
    pub content: String,
    /// SHA-256 of content bytes — for change detection / cache invalidation
    pub content_hash: String,
    /// Enclosing class/module/impl name
    pub parent_name: Option<String>,
    /// Just the signature line for compact display
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum ChunkKind {
    Function,
    Method,
    Class,
    Struct,
    Enum,
    Interface,
    Trait,
    Impl,
    Module,
    Import,
    Constant,
    TypeAlias,
    Block,
}

impl fmt::Display for ChunkKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Function => write!(f, "function"),
            Self::Method => write!(f, "method"),
            Self::Class => write!(f, "class"),
            Self::Struct => write!(f, "struct"),
            Self::Enum => write!(f, "enum"),
            Self::Interface => write!(f, "interface"),
            Self::Trait => write!(f, "trait"),
            Self::Impl => write!(f, "impl"),
            Self::Module => write!(f, "module"),
            Self::Import => write!(f, "import"),
            Self::Constant => write!(f, "constant"),
            Self::TypeAlias => write!(f, "type_alias"),
            Self::Block => write!(f, "block"),
        }
    }
}

pub mod reflexion;
pub mod sqlite;

use anyhow::Result;

use crate::chunker::Chunk;

/// Trait for persisting and querying chunks.
///
/// Implementations might use `SQLite`, in-memory maps, or a vector DB.
pub trait ChunkStore: Send + Sync {
    fn upsert(&self, chunks: &[Chunk]) -> Result<()>;
    fn remove_by_file(&self, file_path: &str) -> Result<()>;
    fn get_all(&self) -> Result<Vec<Chunk>>;
    fn get_by_file(&self, file_path: &str) -> Result<Vec<Chunk>>;
}

pub use reflexion::ReflexionStore;
pub use sqlite::SqliteChunkStore;

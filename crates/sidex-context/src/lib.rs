pub mod chunker;
pub mod embeddings;
pub mod format;
pub mod graph;
pub mod index;
pub mod predict;
pub mod search;
pub mod store;

pub use chunker::{chunk_directory, chunk_file, Chunk, ChunkKind};
pub use embeddings::EmbeddingProvider;
pub use format::{
    ContextRegion, HybridAssembler, MarkdownFormatter, ToonSerializable, ToonSerializer,
};
pub use graph::{builder::build_graph, CodeGraph};
pub use index::incremental::IncrementalIndexer;
pub use index::merkle;
pub use predict::{ContextPredictor, FileCache, PredictedFile, PredictionReason};
pub use search::bm25;
pub use search::{assemble_context, HybridSearcher, SearchResult};
pub use store::{ChunkStore, SqliteChunkStore};

/// Build a code graph reusing the chunks already held by an `IncrementalIndexer`,
/// avoiding a second pass over the file system.
pub fn build_graph_from_indexer(indexer: &IncrementalIndexer) -> CodeGraph {
    build_graph(indexer.chunks())
}

pub mod local;
pub mod voyage;

use anyhow::Result;

/// Trait for embedding providers that convert text to dense vectors.
pub trait EmbeddingProvider: Send + Sync {
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    fn embed_query(&self, query: &str) -> Result<Vec<f32>>;
    fn dimensions(&self) -> usize;
}

/// Returns the best available embedding provider.
/// Tries local Ollama first, falls back to the Voyage API.
pub fn default_provider() -> Box<dyn EmbeddingProvider> {
    if let Ok(provider) = local::OllamaEmbedder::new("nomic-embed-code") {
        Box::new(provider)
    } else {
        Box::new(voyage::VoyageEmbedder::new_from_env())
    }
}

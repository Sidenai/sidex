use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::EmbeddingProvider;

const DEFAULT_BASE_URL: &str = "http://localhost:11434";
const BATCH_SIZE: usize = 32;

pub struct OllamaEmbedder {
    model: String,
    base_url: String,
    client: reqwest::blocking::Client,
    dims: usize,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagModel>,
}

#[derive(Deserialize)]
struct TagModel {
    name: String,
}

impl OllamaEmbedder {
    pub fn new(model: &str) -> Result<Self> {
        let base_url =
            std::env::var("OLLAMA_HOST").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .context("failed to build HTTP client")?;

        let resp = client
            .get(format!("{base_url}/api/tags"))
            .send()
            .context("Ollama is not running or unreachable")?;

        if !resp.status().is_success() {
            bail!("Ollama /api/tags returned status {}", resp.status());
        }

        let tags: TagsResponse = resp.json().context("failed to parse /api/tags response")?;

        let model_available = tags
            .models
            .iter()
            .any(|m| m.name == model || m.name.starts_with(&format!("{model}:")));

        if !model_available {
            bail!(
                "model {model} not found in Ollama (available: {:?})",
                tags.models.iter().map(|m| &m.name).collect::<Vec<_>>()
            );
        }

        let dims = match model {
            m if m.contains("nomic-embed") => 768,
            m if m.contains("mxbai-embed") => 1024,
            m if m.contains("all-minilm") => 384,
            _ => 768,
        };

        Ok(Self {
            model: model.to_string(),
            base_url,
            client,
            dims,
        })
    }
}

impl EmbeddingProvider for OllamaEmbedder {
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let mut all_embeddings = Vec::with_capacity(texts.len());

        for batch in texts.chunks(BATCH_SIZE) {
            let batch_vec: Vec<String> = batch.to_vec();
            let body = EmbedRequest {
                model: &self.model,
                input: &batch_vec,
            };

            let resp = self
                .client
                .post(format!("{}/api/embed", self.base_url))
                .json(&body)
                .send()
                .context("Ollama embed request failed")?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().unwrap_or_default();
                bail!("Ollama /api/embed returned {status}: {text}");
            }

            let parsed: EmbedResponse = resp.json().context("failed to parse embed response")?;
            all_embeddings.extend(parsed.embeddings);
        }

        Ok(all_embeddings)
    }

    fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
        let prefixed = if self.model.contains("nomic") {
            format!("search_query: {query}")
        } else {
            query.to_string()
        };

        let input = vec![prefixed];
        let body = EmbedRequest {
            model: &self.model,
            input: &input,
        };

        let resp = self
            .client
            .post(format!("{}/api/embed", self.base_url))
            .json(&body)
            .send()
            .context("Ollama embed query request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().unwrap_or_default();
            bail!("Ollama /api/embed returned {status}: {text}");
        }

        let mut parsed: EmbedResponse = resp.json().context("failed to parse embed response")?;
        parsed
            .embeddings
            .pop()
            .context("Ollama returned empty embeddings array")
    }

    fn dimensions(&self) -> usize {
        self.dims
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_fails_gracefully_when_ollama_not_running() {
        // Point at a port that is almost certainly not running Ollama
        std::env::set_var("OLLAMA_HOST", "http://127.0.0.1:19999");
        let result = OllamaEmbedder::new("nomic-embed-code");
        assert!(result.is_err());
        std::env::remove_var("OLLAMA_HOST");
    }
}

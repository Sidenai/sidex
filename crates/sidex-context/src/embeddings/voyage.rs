use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::EmbeddingProvider;

const VOYAGE_API_URL: &str = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL: &str = "voyage-code-3";
const BATCH_SIZE: usize = 128;

pub struct VoyageEmbedder {
    api_key: String,
    model: String,
    client: reqwest::blocking::Client,
    dims: usize,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
    input_type: &'a str,
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedData>,
}

#[derive(Deserialize)]
struct EmbedData {
    embedding: Vec<f32>,
}

impl VoyageEmbedder {
    pub fn new_from_env() -> Self {
        let api_key =
            std::env::var("VOYAGE_API_KEY").unwrap_or_else(|_| String::from("missing-key"));
        Self::new(&api_key)
    }

    pub fn new(api_key: &str) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("failed to build HTTP client");

        Self {
            api_key: api_key.to_string(),
            model: DEFAULT_MODEL.to_string(),
            client,
            dims: 1024,
        }
    }

    fn call_api(&self, texts: &[String], input_type: &str) -> Result<Vec<Vec<f32>>> {
        let body = EmbedRequest {
            model: &self.model,
            input: texts,
            input_type,
        };

        let resp = self
            .client
            .post(VOYAGE_API_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .context("Voyage API request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().unwrap_or_default();
            bail!("Voyage API returned {status}: {text}");
        }

        let parsed: EmbedResponse = resp.json().context("failed to parse Voyage response")?;
        Ok(parsed.data.into_iter().map(|d| d.embedding).collect())
    }
}

impl EmbeddingProvider for VoyageEmbedder {
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let mut all_embeddings = Vec::with_capacity(texts.len());

        for batch in texts.chunks(BATCH_SIZE) {
            let batch_vec: Vec<String> = batch.to_vec();
            let embeddings = self.call_api(&batch_vec, "document")?;
            all_embeddings.extend(embeddings);
        }

        Ok(all_embeddings)
    }

    fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
        let input = vec![query.to_string()];
        let mut embeddings = self.call_api(&input, "query")?;
        embeddings
            .pop()
            .context("Voyage API returned empty embeddings")
    }

    fn dimensions(&self) -> usize {
        self.dims
    }
}

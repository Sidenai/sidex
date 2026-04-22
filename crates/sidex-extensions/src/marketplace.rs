//! Marketplace API client for browsing and downloading extensions.
//!
//! Targets the Open VSX registry by default, with the base URL
//! configurable for alternative marketplaces. Supports search with
//! filtering, category browsing, trending/recommended queries, VSIX
//! download, and response caching.

use std::collections::HashMap;
use std::fmt::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Default marketplace base URL. Points at the `SideX` Cloudflare
/// Worker, which merges Microsoft Marketplace + Open VSX and exposes
/// them under an Open-VSX-compatible `/api/-/search` endpoint so this
/// client can keep using its existing JSON schema.
///
/// Override via `MarketplaceClient::with_base_url` (e.g. tests, or
/// users who want to point at a self-hosted proxy or at
/// `https://open-vsx.org/api` directly).
const DEFAULT_BASE_URL: &str = "https://marketplace.siden.ai/api";
const DEFAULT_PAGE_SIZE: u32 = 20;
const CACHE_TTL_SECS: u64 = 300;

/// Builds a [`reqwest::Client`] tuned for marketplace traffic. Keeps a
/// long-lived connection pool with TCP keep-alive, request-level
/// gzip/brotli, HTTP/2 adaptive windowing, and a generous
/// connect+request timeout. The client is meant to be constructed
/// **once per process** — repeated `reqwest::Client::new()` calls in
/// earlier revisions were the main source of search latency because
/// every call re-did DNS + TCP + TLS.
///
/// Keep-alive is intentionally aggressive so a user who does
/// `search → click extension → install` reuses the same TCP + TLS
/// session for all three requests. With the Worker on Cloudflare, the
/// RTT from a warm connection to cache hit is a single HTTP/2 frame.
fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!(
            "SideX/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/sidenai/sidex)"
        ))
        .tcp_keepalive(Some(std::time::Duration::from_mins(1)))
        .http2_keep_alive_interval(Some(std::time::Duration::from_secs(30)))
        .http2_keep_alive_timeout(std::time::Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        .http2_adaptive_window(true)
        .pool_idle_timeout(Some(std::time::Duration::from_secs(90)))
        .pool_max_idle_per_host(8)
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .gzip(true)
        .brotli(true)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Metadata about an extension as returned by the marketplace.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceExtension {
    /// Canonical `publisher.name` id.
    #[serde(alias = "namespace_name")]
    pub id: String,
    /// Human-readable display name.
    #[serde(default)]
    pub display_name: String,
    /// Extension name.
    pub name: String,
    /// Short description.
    #[serde(default)]
    pub short_description: String,
    /// Legacy description field (used when `short_description` is absent).
    #[serde(default)]
    pub description: String,
    /// Publisher information.
    #[serde(default)]
    pub publisher: PublisherInfo,
    /// Latest version.
    pub version: String,
    /// All available versions.
    #[serde(default)]
    pub versions: Vec<ExtensionVersion>,
    /// Number of installs.
    #[serde(default)]
    pub install_count: u64,
    /// Average rating (0.0–5.0).
    #[serde(default)]
    pub rating: f32,
    /// Number of ratings.
    #[serde(default)]
    pub rating_count: u32,
    /// Extension categories.
    #[serde(default)]
    pub categories: Vec<String>,
    /// Freeform tags.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Icon URL.
    #[serde(default)]
    pub icon_url: Option<String>,
    /// Source repository URL.
    #[serde(default)]
    pub repository_url: Option<String>,
    /// License identifier (e.g. "MIT").
    #[serde(default)]
    pub license: Option<String>,
    /// Direct download URL for the `.vsix`.
    #[serde(default)]
    pub download_url: String,
    /// ISO 8601 timestamp of last update.
    #[serde(default)]
    pub last_updated: String,
}

/// Publisher / namespace information.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherInfo {
    /// Internal publisher id.
    #[serde(default)]
    pub publisher_id: String,
    /// Machine-readable name (namespace).
    #[serde(default)]
    pub publisher_name: String,
    /// Human-readable name.
    #[serde(default)]
    pub display_name: String,
    /// Whether the publisher is verified.
    #[serde(default)]
    pub is_verified: bool,
}

/// A single published version of an extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionVersion {
    pub version: String,
    #[serde(default)]
    pub target_platform: Option<String>,
    #[serde(default)]
    pub engine_version: String,
    #[serde(default)]
    pub asset_uri: String,
    #[serde(default)]
    pub fallback_asset_uri: String,
}

/// Result of a marketplace search query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub results: Vec<MarketplaceExtension>,
    pub total_count: u32,
}

/// Sort order for search results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SortOrder {
    Relevance,
    InstallCount,
    Rating,
    Name,
    Updated,
}

impl SortOrder {
    fn as_query_value(self) -> &'static str {
        match self {
            Self::Relevance => "relevance",
            Self::InstallCount => "downloadCount",
            Self::Rating => "averageRating",
            Self::Name => "name",
            Self::Updated => "timestamp",
        }
    }
}

/// Well-known extension categories.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ExtensionCategory {
    Languages,
    Themes,
    Snippets,
    Formatters,
    Linters,
    Debuggers,
    Testing,
    Visualization,
    SCMProviders,
    Keymaps,
    NotebookRenderers,
    MachineLearning,
    Education,
    Other,
    Custom(String),
}

impl ExtensionCategory {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Languages => "Programming Languages",
            Self::Themes => "Themes",
            Self::Snippets => "Snippets",
            Self::Formatters => "Formatters",
            Self::Linters => "Linters",
            Self::Debuggers => "Debuggers",
            Self::Testing => "Testing",
            Self::Visualization => "Visualization",
            Self::SCMProviders => "SCM Providers",
            Self::Keymaps => "Keymaps",
            Self::NotebookRenderers => "Notebook Renderers",
            Self::MachineLearning => "Machine Learning",
            Self::Education => "Education",
            Self::Other => "Other",
            Self::Custom(s) => s.as_str(),
        }
    }

    pub fn all_builtin() -> &'static [ExtensionCategory] {
        &[
            Self::Languages,
            Self::Themes,
            Self::Snippets,
            Self::Formatters,
            Self::Linters,
            Self::Debuggers,
            Self::Testing,
            Self::Visualization,
            Self::SCMProviders,
            Self::Keymaps,
            Self::NotebookRenderers,
            Self::MachineLearning,
            Self::Education,
            Self::Other,
        ]
    }
}

/// Filters applied to a marketplace search.
#[derive(Debug, Clone, Default)]
pub struct SearchFilters {
    pub category: Option<String>,
    pub tag: Option<String>,
    pub sort_order: Option<SortOrder>,
}

/// Entry in the response cache.
struct CachedQuery {
    result: SearchResult,
    fetched_at: Instant,
    /// `ETag` returned by the upstream (or our Cloudflare Worker). Used
    /// for conditional revalidation so stale entries cost a 304
    /// round-trip instead of the full JSON body.
    etag: Option<String>,
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// Client for querying an Open VSX-compatible marketplace.
pub struct MarketplaceClient {
    pub base_url: String,
    pub cache_dir: PathBuf,
    cached_queries: HashMap<String, CachedQuery>,
    http: reqwest::Client,
}

impl MarketplaceClient {
    /// Creates a client pointing at the default Open VSX registry.
    pub fn new() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_owned(),
            cache_dir: std::env::temp_dir().join("sidex-marketplace-cache"),
            cached_queries: HashMap::new(),
            http: build_http_client(),
        }
    }

    /// Creates a client pointing at a custom marketplace URL.
    pub fn with_base_url(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            cache_dir: std::env::temp_dir().join("sidex-marketplace-cache"),
            cached_queries: HashMap::new(),
            http: build_http_client(),
        }
    }

    // -- Search -----------------------------------------------------------

    /// Searches for extensions matching `query` with pagination.
    pub async fn search(&mut self, query: &str, page: u32, page_size: u32) -> Result<SearchResult> {
        self.search_with_filters(query, page, page_size, &SearchFilters::default())
            .await
    }

    /// Searches with additional filters.
    pub async fn search_with_filters(
        &mut self,
        query: &str,
        page: u32,
        page_size: u32,
        filters: &SearchFilters,
    ) -> Result<SearchResult> {
        let size = if page_size == 0 {
            DEFAULT_PAGE_SIZE
        } else {
            page_size
        };
        let offset = page * size;

        let mut url = format!(
            "{base}/-/search?query={query}&offset={offset}&size={size}",
            base = self.base_url,
        );

        if let Some(ref cat) = filters.category {
            let _ = write!(url, "&category={cat}");
        }
        if let Some(ref tag) = filters.tag {
            let _ = write!(url, "&tag={tag}");
        }
        if let Some(sort) = filters.sort_order {
            let _ = write!(url, "&sortBy={}", sort.as_query_value());
        }

        let cache_key = url.clone();
        let cached_etag = self
            .cached_queries
            .get(&cache_key)
            .and_then(|entry| entry.etag.clone());

        if let Some(entry) = self.cached_queries.get(&cache_key) {
            if entry.fetched_at.elapsed().as_secs() < CACHE_TTL_SECS {
                return Ok(entry.result.clone());
            }
        }

        let mut request = self.http.get(&url);
        if let Some(ref etag) = cached_etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        let response = request
            .send()
            .await
            .context("marketplace search request failed")?;

        // 304 Not Modified: our cached body is still fresh. Bump the
        // fetched_at timestamp so we don't re-validate on every call
        // and return the cached result directly.
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            if let Some(entry) = self.cached_queries.get_mut(&cache_key) {
                entry.fetched_at = Instant::now();
                return Ok(entry.result.clone());
            }
        }

        let response_etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(ToOwned::to_owned);

        let resp: OpenVsxSearchResponse = response
            .json()
            .await
            .context("failed to parse marketplace search response")?;

        let result = SearchResult {
            results: resp.extensions,
            total_count: resp.total_size.unwrap_or(0),
        };

        // Cap the cache so long-lived sessions don't accumulate unbounded
        // query keys. 256 entries × ~20 extensions each ≈ still well
        // under a MB, but new entries evict the oldest once full.
        if self.cached_queries.len() >= 256 {
            if let Some(oldest) = self
                .cached_queries
                .iter()
                .min_by_key(|(_, v)| v.fetched_at)
                .map(|(k, _)| k.clone())
            {
                self.cached_queries.remove(&oldest);
            }
        }
        self.cached_queries.insert(
            cache_key,
            CachedQuery {
                result: result.clone(),
                fetched_at: Instant::now(),
                etag: response_etag,
            },
        );

        Ok(result)
    }

    // -- Single extension -------------------------------------------------

    /// Fetches metadata for a single extension by its id (`namespace.name`).
    pub async fn get_extension(&self, id: &str) -> Result<MarketplaceExtension> {
        let (namespace, name) = id.split_once('.').unwrap_or(("unknown", id));

        let url = format!("{base}/{namespace}/{name}", base = self.base_url);

        let resp: MarketplaceExtension = self
            .http
            .get(&url)
            .send()
            .await
            .context("marketplace get_extension request failed")?
            .json()
            .await
            .context("failed to parse extension metadata")?;

        Ok(resp)
    }

    // -- Download ---------------------------------------------------------

    /// Downloads a `.vsix` for the given extension and version, saving it to
    /// `target_dir`. Returns the path to the downloaded file.
    pub async fn download_vsix(
        &self,
        id: &str,
        version: &str,
        target_dir: &Path,
    ) -> Result<PathBuf> {
        let bytes = self.download_vsix_bytes(id, version).await?;
        std::fs::create_dir_all(target_dir)?;
        let filename = format!("{id}-{version}.vsix");
        let path = target_dir.join(&filename);
        std::fs::write(&path, &bytes)?;
        Ok(path)
    }

    /// Downloads raw VSIX bytes.
    pub async fn download_vsix_bytes(&self, id: &str, version: &str) -> Result<Vec<u8>> {
        let (namespace, name) = id.split_once('.').unwrap_or(("unknown", id));

        let url = format!(
            "{base}/{namespace}/{name}/{version}/file/{namespace}.{name}-{version}.vsix",
            base = self.base_url,
        );

        let bytes = self
            .http
            .get(&url)
            .send()
            .await
            .context("vsix download request failed")?
            .bytes()
            .await
            .context("failed to read vsix bytes")?;

        Ok(bytes.to_vec())
    }

    // -- Recommended / Trending ------------------------------------------

    /// Fetches recommended extensions (popular + high rating).
    pub async fn get_recommended(&mut self, count: u32) -> Result<SearchResult> {
        self.search_with_filters(
            "",
            0,
            count,
            &SearchFilters {
                sort_order: Some(SortOrder::Rating),
                ..Default::default()
            },
        )
        .await
    }

    /// Fetches trending extensions (recently updated with high install count).
    pub async fn get_trending(&mut self, count: u32) -> Result<SearchResult> {
        self.search_with_filters(
            "",
            0,
            count,
            &SearchFilters {
                sort_order: Some(SortOrder::InstallCount),
                ..Default::default()
            },
        )
        .await
    }

    // -- Category browsing ------------------------------------------------

    /// Browse extensions by category.
    pub async fn browse_category(
        &mut self,
        category: &ExtensionCategory,
        page: u32,
        page_size: u32,
        sort_order: Option<SortOrder>,
    ) -> Result<SearchResult> {
        self.search_with_filters(
            "",
            page,
            page_size,
            &SearchFilters {
                category: Some(category.as_str().to_owned()),
                sort_order,
                ..Default::default()
            },
        )
        .await
    }

    /// Browse extensions by tag.
    pub async fn browse_tag(
        &mut self,
        tag: &str,
        page: u32,
        page_size: u32,
    ) -> Result<SearchResult> {
        self.search_with_filters(
            "",
            page,
            page_size,
            &SearchFilters {
                tag: Some(tag.to_owned()),
                ..Default::default()
            },
        )
        .await
    }

    // -- Cache management -------------------------------------------------

    /// Evicts expired entries from the in-memory query cache.
    pub fn evict_stale_cache(&mut self) {
        self.cached_queries
            .retain(|_, v| v.fetched_at.elapsed().as_secs() < CACHE_TTL_SECS);
    }

    /// Clears the entire in-memory query cache.
    pub fn clear_cache(&mut self) {
        self.cached_queries.clear();
    }
}

impl Default for MarketplaceClient {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Internal response shapes
// ---------------------------------------------------------------------------

/// Internal response shape for the Open VSX search endpoint.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenVsxSearchResponse {
    #[serde(default)]
    extensions: Vec<MarketplaceExtension>,
    #[serde(default)]
    total_size: Option<u32>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_base_url() {
        let client = MarketplaceClient::new();
        assert_eq!(client.base_url, DEFAULT_BASE_URL);
    }

    #[test]
    fn custom_base_url_strips_trailing_slash() {
        let client = MarketplaceClient::with_base_url("https://example.com/api/");
        assert_eq!(client.base_url, "https://example.com/api");
    }

    #[test]
    fn marketplace_extension_deserialize() {
        let json = r#"{
            "id": "rust-lang.rust-analyzer",
            "name": "rust-analyzer",
            "displayName": "rust-analyzer",
            "shortDescription": "Rust language support",
            "version": "0.4.1234",
            "downloadUrl": "https://example.com/file.vsix",
            "iconUrl": "https://example.com/icon.png",
            "installCount": 5000000,
            "rating": 4.8,
            "ratingCount": 1200,
            "categories": ["Programming Languages"],
            "tags": ["rust"],
            "lastUpdated": "2025-01-01T00:00:00Z"
        }"#;
        let ext: MarketplaceExtension = serde_json::from_str(json).unwrap();
        assert_eq!(ext.id, "rust-lang.rust-analyzer");
        assert_eq!(ext.display_name, "rust-analyzer");
        assert_eq!(ext.install_count, 5_000_000);
        assert!((ext.rating - 4.8).abs() < f32::EPSILON);
        assert_eq!(ext.rating_count, 1200);
        assert_eq!(ext.categories, vec!["Programming Languages"]);
    }

    #[test]
    fn marketplace_extension_minimal() {
        let json = r#"{ "id": "a.b", "name": "b", "version": "1.0.0" }"#;
        let ext: MarketplaceExtension = serde_json::from_str(json).unwrap();
        assert_eq!(ext.id, "a.b");
        assert!(ext.short_description.is_empty());
        assert_eq!(ext.install_count, 0);
        assert_eq!(ext.rating_count, 0);
        assert!(ext.categories.is_empty());
    }

    #[test]
    fn publisher_info_default() {
        let p = PublisherInfo::default();
        assert!(p.publisher_name.is_empty());
        assert!(!p.is_verified);
    }

    #[test]
    fn search_result_deserialize() {
        let json = r#"{ "results": [], "totalCount": 42 }"#;
        let r: SearchResult = serde_json::from_str(json).unwrap();
        assert!(r.results.is_empty());
        assert_eq!(r.total_count, 42);
    }

    #[test]
    fn sort_order_query_values() {
        assert_eq!(SortOrder::Relevance.as_query_value(), "relevance");
        assert_eq!(SortOrder::InstallCount.as_query_value(), "downloadCount");
        assert_eq!(SortOrder::Rating.as_query_value(), "averageRating");
        assert_eq!(SortOrder::Name.as_query_value(), "name");
        assert_eq!(SortOrder::Updated.as_query_value(), "timestamp");
    }

    #[test]
    fn extension_category_all_builtin() {
        let cats = ExtensionCategory::all_builtin();
        assert!(cats.len() >= 10);
        assert_eq!(cats[0].as_str(), "Programming Languages");
    }

    #[test]
    fn cache_eviction() {
        let mut client = MarketplaceClient::new();
        client.cached_queries.insert(
            "test".to_string(),
            CachedQuery {
                result: SearchResult {
                    results: vec![],
                    total_count: 0,
                },
                fetched_at: Instant::now(),
                etag: None,
            },
        );
        assert_eq!(client.cached_queries.len(), 1);
        client.evict_stale_cache();
        assert_eq!(client.cached_queries.len(), 1);
        client.clear_cache();
        assert!(client.cached_queries.is_empty());
    }
}

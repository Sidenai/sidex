use crate::ToolContext;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use sidex_context::{ContextPredictor, FileCache, IncrementalIndexer};

use super::{get_int, get_str, resolve_path, Args};

static INDEX: OnceLock<Mutex<Option<IndexState>>> = OnceLock::new();

const MIN_UPDATE_INTERVAL: Duration = Duration::from_secs(2);

struct IndexState {
    indexer: IncrementalIndexer,
    predictor: ContextPredictor,
    file_cache: FileCache,
    last_indexed: Instant,
    last_updated: Instant,
    workspace_root: String,
}

fn index_lock() -> &'static Mutex<Option<IndexState>> {
    INDEX.get_or_init(|| Mutex::new(None))
}

/// Shared HTTP client for cloud semantic search — reuses connections/TLS
/// sessions instead of building a new client per search.
static CLOUD_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

fn cloud_client() -> &'static reqwest::blocking::Client {
    CLOUD_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

/// Called by `file_ops::read_file` to check the predictive cache before disk I/O.
pub fn cache_get(path: &str) -> Option<String> {
    let mut guard = index_lock().lock().ok()?;
    let state = guard.as_mut()?;
    state.file_cache.get(path).map(str::to_string)
}

/// Called by `file_ops::read_file` after a successful read to record the access,
/// generate predictions, and pre-fetch into the cache on a background thread.
pub fn notify_file_read(abs_path: &str, content: &str) {
    let Ok(mut guard) = index_lock().lock() else {
        return;
    };
    let Some(state) = guard.as_mut() else {
        return;
    };

    state
        .file_cache
        .insert(abs_path.to_string(), content.to_string());

    state.predictor.record_access(abs_path);
    let predicted = state.predictor.predict_next(abs_path, 8);
    let paths_to_fetch: Vec<String> = predicted
        .into_iter()
        .filter(|p| !state.file_cache.contains(&p.file_path))
        .map(|p| p.file_path)
        .collect();

    if !paths_to_fetch.is_empty() {
        state.file_cache.prefetch(&paths_to_fetch);
    }
}

fn ensure_indexed(guard: &mut Option<IndexState>, ctx: &ToolContext) -> Result<()> {
    if guard.is_some() {
        return Ok(());
    }

    let root = ctx.cwd.clone();
    let root_path = std::path::Path::new(&root);
    if !root_path.is_dir() {
        anyhow::bail!("workspace root does not exist: {root}");
    }

    let mut indexer = IncrementalIndexer::new(root_path);
    let _stats = indexer.full_index().context("failed to index workspace")?;

    let graph = sidex_context::build_graph_from_indexer(&indexer);
    let predictor = ContextPredictor::new(graph);
    let file_cache = FileCache::new(50);

    *guard = Some(IndexState {
        indexer,
        predictor,
        file_cache,
        last_indexed: Instant::now(),
        last_updated: Instant::now(),
        workspace_root: root,
    });

    Ok(())
}

pub fn index(args: &Args, ctx: &ToolContext) -> Result<String> {
    let root_arg = get_str(args, "path");
    let root = if root_arg.is_empty() {
        ctx.cwd.clone()
    } else {
        resolve_path(ctx, root_arg)
    };

    let root_path = std::path::Path::new(&root);
    if !root_path.is_dir() {
        anyhow::bail!("workspace root does not exist: {root}");
    }

    let mut guard = index_lock().lock().unwrap();

    // If already indexed for the same workspace, do an incremental update instead
    // of rebuilding everything from scratch.
    if let Some(state) = guard.as_mut() {
        if state.workspace_root == root {
            let start = Instant::now();
            let stats = state.indexer.update().context("failed to update index")?;
            let elapsed = start.elapsed();

            // Only rebuild the graph if files actually changed
            if stats.files_updated > 0 || stats.files_removed > 0 {
                let graph = sidex_context::build_graph_from_indexer(&state.indexer);
                state.predictor = ContextPredictor::new(graph);
            }

            state.last_indexed = Instant::now();
            state.last_updated = Instant::now();

            let chunk_count = state.indexer.chunk_count();
            let file_count = state.indexer.file_count();
            return Ok(format!(
                "Index updated: {chunk_count} chunks from {file_count} files in {:.1}s (incremental, {} files changed)",
                elapsed.as_secs_f64(),
                stats.files_updated + stats.files_removed,
            ));
        }

        // Different workspace — stop the old watcher before replacing
        state.indexer.stop_watching();
    }

    // Drop existing state to free memory before building new one
    *guard = None;

    let start = Instant::now();
    let mut indexer = IncrementalIndexer::new(root_path);
    let stats = indexer.full_index().context("failed to index workspace")?;

    let graph = sidex_context::build_graph_from_indexer(&indexer);
    let predictor = ContextPredictor::new(graph);
    let file_cache = FileCache::new(50);
    let elapsed = start.elapsed();

    let chunk_count = stats.chunks_indexed;
    let file_count = stats.files_indexed;

    *guard = Some(IndexState {
        indexer,
        predictor,
        file_cache,
        last_indexed: Instant::now(),
        last_updated: Instant::now(),
        workspace_root: root,
    });

    Ok(format!(
        "Indexed {chunk_count} chunks from {file_count} files in {:.1}s (predictive cache ready)",
        elapsed.as_secs_f64()
    ))
}

pub fn search(args: &Args, ctx: &ToolContext) -> Result<String> {
    let query = get_str(args, "query");
    if query.is_empty() {
        anyhow::bail!("query is required");
    }
    let limit = get_int(args, "limit", 20) as usize;
    let budget = get_int(args, "budget", 8000) as usize;

    // 1. Search local BM25 index. Scope the global index lock to this block:
    // holding it across the cloud request below would serialize every
    // concurrent context tool behind a 10s network timeout.
    let mut search_results: Vec<sidex_context::SearchResult> = {
        let mut guard = index_lock().lock().unwrap();

        if guard.is_none() {
            ensure_indexed(&mut guard, ctx)?;
        }

        let state = guard.as_mut().ok_or_else(|| {
            anyhow::anyhow!("workspace not indexed yet — call context_index first")
        })?;

        if state.last_updated.elapsed() >= MIN_UPDATE_INTERVAL {
            state.indexer.update().ok();
            state.last_updated = Instant::now();
        }

        let bm25_results = state.indexer.search(query, limit);

        bm25_results
            .into_iter()
            .enumerate()
            .map(|(i, (chunk, score))| sidex_context::SearchResult {
                chunk: chunk.clone(),
                score,
                bm25_rank: Some(i),
                vector_rank: None,
            })
            .collect()
    };

    // 2. Optionally augment with a remote semantic index.
    //
    // SideX is local-first: this runs only when the user has pointed
    // SIDEX_CLOUD_API at a service of their own AND a token is present.
    // With neither set — the default — search is purely on-device BM25.
    let cloud_api = std::env::var("SIDEX_CLOUD_API").unwrap_or_default();
    if !cloud_api.is_empty() && !ctx.token.is_empty() {
        let client = cloud_client();

        let payload = serde_json::json!({
            "namespace": ctx.cwd,
            "query": query,
            "limit": limit
        });

        if let Ok(resp) = client
            .post(format!("{}/v1/index/search", cloud_api.trim_end_matches('/')))
            .bearer_auth(&ctx.token)
            .json(&payload)
            .send()
        {
            if resp.status().is_success() {
                #[derive(serde::Deserialize)]
                struct CloudResult {
                    file: String,
                    start_line: usize,
                    end_line: usize,
                    symbol: String,
                    score: f32,
                    snippet: String,
                }

                #[derive(serde::Deserialize)]
                struct CloudResponse {
                    results: Vec<CloudResult>,
                }

                if let Ok(cloud_resp) = resp.json::<CloudResponse>() {
                    for (i, cr) in cloud_resp.results.into_iter().enumerate() {
                        // Avoid duplicates if BM25 already found this exact chunk
                        let is_dup = search_results.iter().any(|r| {
                            r.chunk.file_path == cr.file && r.chunk.start_line == cr.start_line
                        });

                        if !is_dup {
                            search_results.push(sidex_context::SearchResult {
                                chunk: sidex_context::Chunk {
                                    file_path: cr.file,
                                    start_line: cr.start_line,
                                    end_line: cr.end_line,
                                    content: cr.snippet,
                                    name: if cr.symbol.is_empty() {
                                        None
                                    } else {
                                        Some(cr.symbol)
                                    },
                                    kind: sidex_context::ChunkKind::Module,
                                    id: String::new(),
                                    content_hash: String::new(),
                                    language: "text".to_string(),
                                    signature: None,
                                    parent_name: None,
                                },
                                score: cr.score as f64,
                                bm25_rank: None,
                                vector_rank: Some(i),
                            });
                        }
                    }
                }
            }
        }
    }

    search_results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let selected = sidex_context::assemble_context(&search_results, budget);

    if selected.is_empty() {
        return Ok("No results found.".to_string());
    }

    let mut out = String::new();
    for (i, chunk) in selected.iter().enumerate() {
        let name_str = chunk
            .name
            .as_deref()
            .map_or(String::new(), |n| format!(" ({n})"));
        out.push_str(&format!(
            "--- result {} ---\nfile: {}  L{}-{} [{}]{}\n{}\n\n",
            i + 1,
            chunk.file_path,
            chunk.start_line,
            chunk.end_line,
            chunk.kind,
            name_str,
            chunk.content,
        ));
    }

    Ok(out)
}

pub fn watch(_args: &Args, ctx: &ToolContext) -> Result<String> {
    let mut guard = index_lock().lock().unwrap();

    if guard.is_none() {
        ensure_indexed(&mut guard, ctx)?;
    }

    let state = guard
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("workspace not indexed — call context_index first"))?;

    if state.indexer.is_watching() {
        return Ok("File watcher already running.".to_string());
    }

    state.indexer.start_watching()?;
    Ok("File watcher started — index will update on file changes.".to_string())
}

pub fn status(_args: &Args, _ctx: &ToolContext) -> Result<String> {
    let guard = index_lock().lock().unwrap();
    match guard.as_ref() {
        Some(state) => {
            let ago = state.last_indexed.elapsed();
            let cache_stats = state.file_cache.stats();
            let mut result = HashMap::new();
            result.insert("indexed", serde_json::json!(true));
            result.insert(
                "chunk_count",
                serde_json::json!(state.indexer.chunk_count()),
            );
            result.insert("file_count", serde_json::json!(state.indexer.file_count()));
            result.insert("watching", serde_json::json!(state.indexer.is_watching()));
            result.insert("last_indexed_ago_secs", serde_json::json!(ago.as_secs()));
            result.insert(
                "predict_cache_entries",
                serde_json::json!(cache_stats.entry_count),
            );
            result.insert(
                "predict_cache_size_bytes",
                serde_json::json!(cache_stats.current_size_bytes),
            );
            result.insert(
                "predict_cache_max_bytes",
                serde_json::json!(cache_stats.max_size_bytes),
            );
            Ok(serde_json::to_string_pretty(&result)?)
        }
        None => {
            let mut result = HashMap::new();
            result.insert("indexed", serde_json::json!(false));
            Ok(serde_json::to_string_pretty(&result)?)
        }
    }
}

# Performance & Memory Optimization Plan

This branch contains comprehensive performance and memory optimizations for SideX.

## 🎯 Goals

1. **Reduce memory footprint** - Target under 150MB at idle (from ~200MB)
2. **Improve responsiveness** - Faster file loading, search, and UI interactions
3. **Better resource management** - Lazy loading, caching, efficient cleanup

---

## 📋 Implementation Checklist

### Phase 1: Quick Wins (Low Effort, High Impact)

- [x] 1.1 LRU Cache for File Metadata (Rust) - ✅ DONE
- [ ] 1.2 Lazy Import for Terminal Module (TypeScript)
- [x] 1.3 Debounce File Watcher Events (Rust) - Already exists in watch.rs

### Phase 2: Web Workers (Medium Effort, High Impact)

- [ ] 2.1 Search Index in Web Worker
- [ ] 2.2 Regex Processing in Web Worker
- [ ] 2.3 File Hashing in Web Worker

### Phase 3: Advanced Optimizations (Higher Effort)

- [ ] 3.1 Incremental Index Building
- [ ] 3.2 Memory-Mapped File Reading for Large Files
- [ ] 3.3 Virtual Scrolling for Large Files
- [ ] 3.4 Background Indexing During Idle

### Phase 4: Architecture Improvements

- [ ] 4.1 Extension Process Isolation
- [ ] 4.2 Efficient IPC for Multi-Window
- [ ] 4.3 Streaming File Operations

---

## 📝 Detailed Implementation Notes

### 1.1 LRU Cache for File Metadata

```rust
// Add to lib.rs or new cache module
use lru::LruCache;
use std::sync::Arc;
use tokio::sync::Mutex;

struct FileMetadataCache {
    cache: LruCache<String, FileStat>,
}

impl FileMetadataCache {
    fn new(capacity: usize) -> Self {
        Self {
            cache: LruCache::new(capacity),
        }
    }
}
```

### 1.2 Lazy Import for Terminal

```typescript
// Instead of static import at top
import { TerminalService } from 'vs/workbench/contrib/terminal/';

// Use dynamic import when terminal tab is opened
async function openTerminal() {
	const { TerminalService } = await import('vs/workbench/contrib/terminal/');
	return new TerminalService();
}
```

### 1.3 Debounce File Watcher

```rust
// In watch.rs, add debouncing
use std::time::Duration;
use tokio::sync::mpsc;

async fn watch_with_debounce(path: String, debounce_ms: u64) {
    // Batch events and emit after debounce period
}
```

### 2.1 Search in Web Worker

```typescript
// src/workers/search.worker.ts
self.onmessage = async e => {
	const results = await searchIndex.search(e.data.query);
	postMessage(results);
};
```

---

## 🔧 Testing Plan

1. Memory profiling with `memory_profiler` crate
2. Benchmark file open times
3. Search performance tests
4. UI responsiveness testing

---

## 📊 Expected Improvements

| Metric             | Before | After  |
| ------------------ | ------ | ------ |
| Idle Memory        | ~200MB | ~150MB |
| File Open (1MB)    | ~500ms | ~200ms |
| Search (10K files) | ~2s    | ~500ms |
| UI Frame Rate      | 30fps  | 60fps  |

---

## 📅 Timeline

- **Phase 1**: 1-2 weeks
- **Phase 2**: 2-3 weeks
- **Phase 3**: 3-4 weeks
- **Phase 4**: 4-6 weeks

---

## 🤝 Contributing

This is a major feature branch. Please:

1. Create sub-branches for each feature
2. Write tests for new functionality
3. Document changes in this file
4. Run benchmarks before/after changes

---

_Last Updated: 2026-04-13_
_Created by: Akarsh Bandi_

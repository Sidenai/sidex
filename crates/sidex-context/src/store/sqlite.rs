use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::chunker::{Chunk, ChunkKind};

use super::ChunkStore;

/// SQLite-backed chunk store for persistent context indexing.
///
/// Stores chunks in a single `chunks` table with full-text search on content
/// and fast lookups by file path. Thread-safe via internal `Mutex<Connection>`.
pub struct SqliteChunkStore {
    conn: Mutex<Connection>,
}

impl SqliteChunkStore {
    /// Open (or create) a chunk store at `path`.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).context("open chunk store database")?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = -16000;",
        )
        .context("set chunk store pragmas")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chunks (
                id            TEXT PRIMARY KEY,
                file_path     TEXT NOT NULL,
                start_line    INTEGER NOT NULL,
                end_line      INTEGER NOT NULL,
                kind          TEXT NOT NULL,
                name          TEXT,
                language      TEXT NOT NULL,
                content       TEXT NOT NULL,
                content_hash  TEXT NOT NULL,
                parent_name   TEXT,
                signature     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
            CREATE INDEX IF NOT EXISTS idx_chunks_kind ON chunks(kind);
            CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name) WHERE name IS NOT NULL;",
        )
        .context("create chunks table")?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an in-memory store (useful for tests).
    pub fn in_memory() -> Result<Self> {
        Self::open(Path::new(":memory:"))
    }

    /// Return the total number of stored chunks.
    pub fn count(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
            .context("count chunks")?;
        Ok(n as usize)
    }

    /// Get chunks matching a name prefix (e.g. function name search).
    pub fn get_by_name(&self, name: &str) -> Result<Vec<Chunk>> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("{name}%");
        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, start_line, end_line, kind, name, language,
                        content, content_hash, parent_name, signature
                 FROM chunks WHERE name LIKE ?1",
            )
            .context("prepare get_by_name")?;
        Self::collect_rows(&mut stmt, params![pattern])
    }

    /// Get chunks by kind (e.g. all functions, all structs).
    pub fn get_by_kind(&self, kind: &ChunkKind) -> Result<Vec<Chunk>> {
        let conn = self.conn.lock().unwrap();
        let kind_str = kind.to_string();
        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, start_line, end_line, kind, name, language,
                        content, content_hash, parent_name, signature
                 FROM chunks WHERE kind = ?1",
            )
            .context("prepare get_by_kind")?;
        Self::collect_rows(&mut stmt, params![kind_str])
    }

    fn collect_rows(
        stmt: &mut rusqlite::Statement<'_>,
        params: impl rusqlite::Params,
    ) -> Result<Vec<Chunk>> {
        let rows = stmt
            .query_map(params, |row| {
                Ok(Chunk {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    start_line: row.get::<_, i64>(2)? as usize,
                    end_line: row.get::<_, i64>(3)? as usize,
                    kind: parse_chunk_kind(&row.get::<_, String>(4)?),
                    name: row.get(5)?,
                    language: row.get(6)?,
                    content: row.get(7)?,
                    content_hash: row.get(8)?,
                    parent_name: row.get(9)?,
                    signature: row.get(10)?,
                })
            })
            .context("query chunks")?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.context("read chunk row")?);
        }
        Ok(entries)
    }
}

impl ChunkStore for SqliteChunkStore {
    fn upsert(&self, chunks: &[Chunk]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().context("begin transaction")?;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO chunks (id, file_path, start_line, end_line, kind, name,
                                         language, content, content_hash, parent_name, signature)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                     ON CONFLICT(id) DO UPDATE SET
                         start_line   = excluded.start_line,
                         end_line     = excluded.end_line,
                         kind         = excluded.kind,
                         name         = excluded.name,
                         content      = excluded.content,
                         content_hash = excluded.content_hash,
                         parent_name  = excluded.parent_name,
                         signature    = excluded.signature",
                )
                .context("prepare upsert")?;

            for c in chunks {
                stmt.execute(params![
                    c.id,
                    c.file_path,
                    c.start_line as i64,
                    c.end_line as i64,
                    c.kind.to_string(),
                    c.name,
                    c.language,
                    c.content,
                    c.content_hash,
                    c.parent_name,
                    c.signature,
                ])
                .context("upsert chunk")?;
            }
        }
        tx.commit().context("commit upsert")?;
        Ok(())
    }

    fn remove_by_file(&self, file_path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM chunks WHERE file_path = ?1",
            params![file_path],
        )
        .context("remove chunks by file")?;
        Ok(())
    }

    fn get_all(&self) -> Result<Vec<Chunk>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, start_line, end_line, kind, name, language,
                        content, content_hash, parent_name, signature
                 FROM chunks ORDER BY file_path, start_line",
            )
            .context("prepare get_all")?;
        Self::collect_rows(&mut stmt, [])
    }

    fn get_by_file(&self, file_path: &str) -> Result<Vec<Chunk>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, start_line, end_line, kind, name, language,
                        content, content_hash, parent_name, signature
                 FROM chunks WHERE file_path = ?1 ORDER BY start_line",
            )
            .context("prepare get_by_file")?;
        Self::collect_rows(&mut stmt, params![file_path])
    }
}

fn parse_chunk_kind(s: &str) -> ChunkKind {
    match s {
        "function" => ChunkKind::Function,
        "method" => ChunkKind::Method,
        "class" => ChunkKind::Class,
        "struct" => ChunkKind::Struct,
        "enum" => ChunkKind::Enum,
        "interface" => ChunkKind::Interface,
        "trait" => ChunkKind::Trait,
        "impl" => ChunkKind::Impl,
        "module" => ChunkKind::Module,
        "import" => ChunkKind::Import,
        "constant" => ChunkKind::Constant,
        "type_alias" => ChunkKind::TypeAlias,
        _ => ChunkKind::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_chunk(id: &str, file: &str, name: &str, kind: ChunkKind) -> Chunk {
        Chunk {
            id: id.to_string(),
            file_path: file.to_string(),
            start_line: 1,
            end_line: 10,
            kind,
            name: Some(name.to_string()),
            language: "rust".to_string(),
            content: format!("fn {}() {{}}", name),
            content_hash: format!("hash_{}", id),
            parent_name: None,
            signature: Some(format!("fn {}()", name)),
        }
    }

    #[test]
    fn upsert_and_retrieve() {
        let store = SqliteChunkStore::in_memory().unwrap();
        let chunks = vec![
            make_chunk("c1", "src/main.rs", "main", ChunkKind::Function),
            make_chunk("c2", "src/main.rs", "helper", ChunkKind::Function),
            make_chunk("c3", "src/lib.rs", "init", ChunkKind::Function),
        ];
        store.upsert(&chunks).unwrap();

        assert_eq!(store.count().unwrap(), 3);

        let all = store.get_all().unwrap();
        assert_eq!(all.len(), 3);

        let by_file = store.get_by_file("src/main.rs").unwrap();
        assert_eq!(by_file.len(), 2);
    }

    #[test]
    fn upsert_overwrites() {
        let store = SqliteChunkStore::in_memory().unwrap();
        let mut chunk = make_chunk("c1", "src/main.rs", "main", ChunkKind::Function);
        store.upsert(&[chunk.clone()]).unwrap();

        chunk.content = "fn main() { println!(\"updated\"); }".to_string();
        chunk.content_hash = "new_hash".to_string();
        store.upsert(&[chunk]).unwrap();

        assert_eq!(store.count().unwrap(), 1);
        let loaded = store.get_by_file("src/main.rs").unwrap();
        assert!(loaded[0].content.contains("updated"));
    }

    #[test]
    fn remove_by_file_clears_only_target() {
        let store = SqliteChunkStore::in_memory().unwrap();
        store
            .upsert(&[
                make_chunk("c1", "src/a.rs", "a_fn", ChunkKind::Function),
                make_chunk("c2", "src/b.rs", "b_fn", ChunkKind::Function),
            ])
            .unwrap();

        store.remove_by_file("src/a.rs").unwrap();
        assert_eq!(store.count().unwrap(), 1);
        assert_eq!(store.get_by_file("src/a.rs").unwrap().len(), 0);
        assert_eq!(store.get_by_file("src/b.rs").unwrap().len(), 1);
    }

    #[test]
    fn get_by_name() {
        let store = SqliteChunkStore::in_memory().unwrap();
        store
            .upsert(&[
                make_chunk("c1", "src/main.rs", "process_data", ChunkKind::Function),
                make_chunk("c2", "src/main.rs", "process_request", ChunkKind::Function),
                make_chunk("c3", "src/main.rs", "handle_error", ChunkKind::Function),
            ])
            .unwrap();

        let results = store.get_by_name("process").unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn get_by_kind() {
        let store = SqliteChunkStore::in_memory().unwrap();
        store
            .upsert(&[
                make_chunk("c1", "src/main.rs", "MyStruct", ChunkKind::Struct),
                make_chunk("c2", "src/main.rs", "my_fn", ChunkKind::Function),
                make_chunk("c3", "src/main.rs", "OtherStruct", ChunkKind::Struct),
            ])
            .unwrap();

        let structs = store.get_by_kind(&ChunkKind::Struct).unwrap();
        assert_eq!(structs.len(), 2);

        let fns = store.get_by_kind(&ChunkKind::Function).unwrap();
        assert_eq!(fns.len(), 1);
    }

    #[test]
    fn persistent_storage() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("chunks.db");

        {
            let store = SqliteChunkStore::open(&db_path).unwrap();
            store
                .upsert(&[make_chunk("c1", "src/main.rs", "main", ChunkKind::Function)])
                .unwrap();
        }

        {
            let store = SqliteChunkStore::open(&db_path).unwrap();
            assert_eq!(store.count().unwrap(), 1);
            let chunks = store.get_all().unwrap();
            assert_eq!(chunks[0].name.as_deref(), Some("main"));
        }
    }

    #[test]
    fn batch_upsert_performance() {
        let store = SqliteChunkStore::in_memory().unwrap();
        let chunks: Vec<Chunk> = (0..1000)
            .map(|i| {
                make_chunk(
                    &format!("c{i}"),
                    "src/big.rs",
                    &format!("fn_{i}"),
                    ChunkKind::Function,
                )
            })
            .collect();

        store.upsert(&chunks).unwrap();
        assert_eq!(store.count().unwrap(), 1000);
    }
}

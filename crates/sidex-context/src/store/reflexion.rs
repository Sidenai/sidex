use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

/// SQLite-backed store for Reflexion memory entries with FTS5 full-text search.
///
/// Stores reflexion entries (verbal reflections from agent successes/failures)
/// and provides full-text search over task descriptions, reflections, and code context
/// for efficient retrieval of relevant past lessons.
pub struct ReflexionStore {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone)]
pub struct ReflexionEntry {
    pub id: String,
    pub task_description: String,
    pub attempt: i32,
    pub succeeded: bool,
    pub reflection: String,
    pub code_context: String,
    pub error_type: Option<String>,
    pub timestamp: i64,
    pub confidence: f64,
    pub usage_count: i32,
    pub helped_count: i32,
}

impl ReflexionStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).context("open reflexion store database")?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )
        .context("set reflexion store pragmas")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS reflexion_entries (
                id               TEXT PRIMARY KEY,
                task_description TEXT NOT NULL,
                attempt          INTEGER NOT NULL,
                succeeded        INTEGER NOT NULL,
                reflection       TEXT NOT NULL,
                code_context     TEXT NOT NULL,
                error_type       TEXT,
                timestamp        INTEGER NOT NULL,
                confidence       REAL NOT NULL DEFAULT 0.6,
                usage_count      INTEGER NOT NULL DEFAULT 0,
                helped_count     INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_reflexion_confidence
                ON reflexion_entries(confidence DESC);
            CREATE INDEX IF NOT EXISTS idx_reflexion_timestamp
                ON reflexion_entries(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_reflexion_error_type
                ON reflexion_entries(error_type) WHERE error_type IS NOT NULL;",
        )
        .context("create reflexion_entries table")?;

        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS reflexion_fts USING fts5(
                id UNINDEXED,
                task_description,
                reflection,
                code_context,
                content='reflexion_entries',
                content_rowid='rowid',
                tokenize='porter unicode61'
            );

            CREATE TRIGGER IF NOT EXISTS reflexion_ai AFTER INSERT ON reflexion_entries BEGIN
                INSERT INTO reflexion_fts(rowid, id, task_description, reflection, code_context)
                VALUES (new.rowid, new.id, new.task_description, new.reflection, new.code_context);
            END;

            CREATE TRIGGER IF NOT EXISTS reflexion_ad AFTER DELETE ON reflexion_entries BEGIN
                INSERT INTO reflexion_fts(reflexion_fts, rowid, id, task_description, reflection, code_context)
                VALUES ('delete', old.rowid, old.id, old.task_description, old.reflection, old.code_context);
            END;

            CREATE TRIGGER IF NOT EXISTS reflexion_au AFTER UPDATE ON reflexion_entries BEGIN
                INSERT INTO reflexion_fts(reflexion_fts, rowid, id, task_description, reflection, code_context)
                VALUES ('delete', old.rowid, old.id, old.task_description, old.reflection, old.code_context);
                INSERT INTO reflexion_fts(rowid, id, task_description, reflection, code_context)
                VALUES (new.rowid, new.id, new.task_description, new.reflection, new.code_context);
            END;",
        )
        .context("create reflexion FTS index")?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn in_memory() -> Result<Self> {
        Self::open(Path::new(":memory:"))
    }

    /// Insert or update a reflexion entry.
    pub fn upsert(&self, entry: &ReflexionEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reflexion_entries
                (id, task_description, attempt, succeeded, reflection, code_context,
                 error_type, timestamp, confidence, usage_count, helped_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                 reflection   = excluded.reflection,
                 confidence   = excluded.confidence,
                 usage_count  = excluded.usage_count,
                 helped_count = excluded.helped_count",
            params![
                entry.id,
                entry.task_description,
                entry.attempt,
                entry.succeeded as i32,
                entry.reflection,
                entry.code_context,
                entry.error_type,
                entry.timestamp,
                entry.confidence,
                entry.usage_count,
                entry.helped_count,
            ],
        )
        .context("upsert reflexion entry")?;
        Ok(())
    }

    /// Batch upsert multiple entries within a transaction.
    pub fn upsert_batch(&self, entries: &[ReflexionEntry]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn
            .unchecked_transaction()
            .context("begin reflexion transaction")?;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO reflexion_entries
                        (id, task_description, attempt, succeeded, reflection, code_context,
                         error_type, timestamp, confidence, usage_count, helped_count)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                     ON CONFLICT(id) DO UPDATE SET
                         reflection   = excluded.reflection,
                         confidence   = excluded.confidence,
                         usage_count  = excluded.usage_count,
                         helped_count = excluded.helped_count",
                )
                .context("prepare reflexion upsert")?;

            for entry in entries {
                stmt.execute(params![
                    entry.id,
                    entry.task_description,
                    entry.attempt,
                    entry.succeeded as i32,
                    entry.reflection,
                    entry.code_context,
                    entry.error_type,
                    entry.timestamp,
                    entry.confidence,
                    entry.usage_count,
                    entry.helped_count,
                ])
                .context("upsert reflexion entry in batch")?;
            }
        }
        tx.commit().context("commit reflexion batch")?;
        Ok(())
    }

    /// Full-text search for relevant reflexion entries.
    /// Returns entries ranked by FTS5 relevance, filtered by minimum confidence.
    pub fn search(
        &self,
        query: &str,
        min_confidence: f64,
        limit: usize,
    ) -> Result<Vec<ReflexionEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT e.id, e.task_description, e.attempt, e.succeeded, e.reflection,
                        e.code_context, e.error_type, e.timestamp, e.confidence,
                        e.usage_count, e.helped_count
                 FROM reflexion_entries e
                 JOIN reflexion_fts f ON e.id = f.id
                 WHERE reflexion_fts MATCH ?1
                   AND e.confidence >= ?2
                 ORDER BY rank
                 LIMIT ?3",
            )
            .context("prepare reflexion search")?;

        let rows = stmt
            .query_map(params![query, min_confidence, limit as i64], |row| {
                Ok(ReflexionEntry {
                    id: row.get(0)?,
                    task_description: row.get(1)?,
                    attempt: row.get(2)?,
                    succeeded: row.get::<_, i32>(3)? != 0,
                    reflection: row.get(4)?,
                    code_context: row.get(5)?,
                    error_type: row.get(6)?,
                    timestamp: row.get(7)?,
                    confidence: row.get(8)?,
                    usage_count: row.get(9)?,
                    helped_count: row.get(10)?,
                })
            })
            .context("search reflexion entries")?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.context("read reflexion search row")?);
        }
        Ok(entries)
    }

    /// Get all entries above a confidence threshold, ordered by confidence descending.
    pub fn get_above_confidence(
        &self,
        min_confidence: f64,
        limit: usize,
    ) -> Result<Vec<ReflexionEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, task_description, attempt, succeeded, reflection,
                        code_context, error_type, timestamp, confidence,
                        usage_count, helped_count
                 FROM reflexion_entries
                 WHERE confidence >= ?1
                 ORDER BY confidence DESC
                 LIMIT ?2",
            )
            .context("prepare get_above_confidence")?;

        Self::collect_rows(&mut stmt, params![min_confidence, limit as i64])
    }

    /// Get entries by error type.
    pub fn get_by_error_type(&self, error_type: &str, limit: usize) -> Result<Vec<ReflexionEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, task_description, attempt, succeeded, reflection,
                        code_context, error_type, timestamp, confidence,
                        usage_count, helped_count
                 FROM reflexion_entries
                 WHERE error_type = ?1
                 ORDER BY confidence DESC
                 LIMIT ?2",
            )
            .context("prepare get_by_error_type")?;

        Self::collect_rows(&mut stmt, params![error_type, limit as i64])
    }

    /// Update the confidence score for an entry.
    pub fn update_confidence(&self, id: &str, confidence: f64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE reflexion_entries SET confidence = ?1 WHERE id = ?2",
            params![confidence, id],
        )
        .context("update reflexion confidence")?;
        Ok(())
    }

    /// Increment usage and optionally helped counters.
    pub fn record_usage(&self, id: &str, helped: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        if helped {
            conn.execute(
                "UPDATE reflexion_entries SET usage_count = usage_count + 1, helped_count = helped_count + 1 WHERE id = ?1",
                params![id],
            )
            .context("record reflexion usage (helped)")?;
        } else {
            conn.execute(
                "UPDATE reflexion_entries SET usage_count = usage_count + 1 WHERE id = ?1",
                params![id],
            )
            .context("record reflexion usage")?;
        }
        Ok(())
    }

    /// Remove entries below the confidence threshold.
    pub fn prune(&self, min_confidence: f64) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let removed = conn
            .execute(
                "DELETE FROM reflexion_entries WHERE confidence < ?1",
                params![min_confidence],
            )
            .context("prune reflexion entries")?;
        Ok(removed)
    }

    /// Total number of stored entries.
    pub fn count(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM reflexion_entries", [], |r| r.get(0))
            .context("count reflexion entries")?;
        Ok(n as usize)
    }

    /// Delete a specific entry by ID.
    pub fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn
            .execute("DELETE FROM reflexion_entries WHERE id = ?1", params![id])
            .context("delete reflexion entry")?;
        Ok(affected > 0)
    }

    fn collect_rows(
        stmt: &mut rusqlite::Statement<'_>,
        params: impl rusqlite::Params,
    ) -> Result<Vec<ReflexionEntry>> {
        let rows = stmt
            .query_map(params, |row| {
                Ok(ReflexionEntry {
                    id: row.get(0)?,
                    task_description: row.get(1)?,
                    attempt: row.get(2)?,
                    succeeded: row.get::<_, i32>(3)? != 0,
                    reflection: row.get(4)?,
                    code_context: row.get(5)?,
                    error_type: row.get(6)?,
                    timestamp: row.get(7)?,
                    confidence: row.get(8)?,
                    usage_count: row.get(9)?,
                    helped_count: row.get(10)?,
                })
            })
            .context("query reflexion entries")?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.context("read reflexion row")?);
        }
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(id: &str, task: &str, reflection: &str, succeeded: bool) -> ReflexionEntry {
        ReflexionEntry {
            id: id.to_string(),
            task_description: task.to_string(),
            attempt: 1,
            succeeded,
            reflection: reflection.to_string(),
            code_context: "src/main.rs | function:main".to_string(),
            error_type: if succeeded {
                None
            } else {
                Some("logic".to_string())
            },
            timestamp: 1700000000,
            confidence: 0.7,
            usage_count: 0,
            helped_count: 0,
        }
    }

    #[test]
    fn upsert_and_count() {
        let store = ReflexionStore::in_memory().unwrap();
        let entry = make_entry(
            "r1",
            "fix the parser",
            "I failed because I forgot the semicolon",
            false,
        );
        store.upsert(&entry).unwrap();
        assert_eq!(store.count().unwrap(), 1);
    }

    #[test]
    fn batch_upsert() {
        let store = ReflexionStore::in_memory().unwrap();
        let entries = vec![
            make_entry("r1", "fix parser", "missed semicolon", false),
            make_entry("r2", "add tests", "succeeded with TDD approach", true),
            make_entry("r3", "refactor module", "broke imports", false),
        ];
        store.upsert_batch(&entries).unwrap();
        assert_eq!(store.count().unwrap(), 3);
    }

    #[test]
    fn full_text_search() {
        let store = ReflexionStore::in_memory().unwrap();
        store
            .upsert_batch(&[
                make_entry(
                    "r1",
                    "fix the parser bug",
                    "I failed because I forgot a semicolon in the grammar",
                    false,
                ),
                make_entry(
                    "r2",
                    "add unit tests for auth",
                    "succeeded by mocking the HTTP client",
                    true,
                ),
                make_entry(
                    "r3",
                    "fix parser edge case",
                    "the tokenizer needed a lookahead buffer",
                    false,
                ),
            ])
            .unwrap();

        let results = store.search("parser", 0.0, 10).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn confidence_filtering() {
        let store = ReflexionStore::in_memory().unwrap();
        let mut low = make_entry("r1", "task a", "low confidence", false);
        low.confidence = 0.1;
        let mut high = make_entry("r2", "task b", "high confidence", true);
        high.confidence = 0.9;

        store.upsert_batch(&[low, high]).unwrap();

        let above = store.get_above_confidence(0.5, 10).unwrap();
        assert_eq!(above.len(), 1);
        assert_eq!(above[0].id, "r2");
    }

    #[test]
    fn update_confidence_and_prune() {
        let store = ReflexionStore::in_memory().unwrap();
        let entry = make_entry("r1", "task", "reflection", false);
        store.upsert(&entry).unwrap();

        store.update_confidence("r1", 0.05).unwrap();
        let pruned = store.prune(0.2).unwrap();
        assert_eq!(pruned, 1);
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn record_usage() {
        let store = ReflexionStore::in_memory().unwrap();
        let entry = make_entry("r1", "task", "reflection", false);
        store.upsert(&entry).unwrap();

        store.record_usage("r1", true).unwrap();
        store.record_usage("r1", false).unwrap();

        let results = store.get_above_confidence(0.0, 10).unwrap();
        assert_eq!(results[0].usage_count, 2);
        assert_eq!(results[0].helped_count, 1);
    }

    #[test]
    fn get_by_error_type() {
        let store = ReflexionStore::in_memory().unwrap();
        let mut e1 = make_entry("r1", "task a", "type error reflection", false);
        e1.error_type = Some("type".to_string());
        let mut e2 = make_entry("r2", "task b", "syntax error reflection", false);
        e2.error_type = Some("syntax".to_string());
        let mut e3 = make_entry("r3", "task c", "another type error", false);
        e3.error_type = Some("type".to_string());

        store.upsert_batch(&[e1, e2, e3]).unwrap();

        let type_errors = store.get_by_error_type("type", 10).unwrap();
        assert_eq!(type_errors.len(), 2);
    }

    #[test]
    fn delete_entry() {
        let store = ReflexionStore::in_memory().unwrap();
        store
            .upsert(&make_entry("r1", "task", "reflection", false))
            .unwrap();
        assert!(store.delete("r1").unwrap());
        assert_eq!(store.count().unwrap(), 0);
        assert!(!store.delete("nonexistent").unwrap());
    }
}

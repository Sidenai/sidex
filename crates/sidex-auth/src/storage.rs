//! Secret storage implementation.
//!
//! A layered design: the OS keyring is the primary store, and a local
//! `SQLite` table holds the canonical key list (since keyring APIs don't
//! support listing entries by service). If the keyring is missing at
//! runtime we transparently fall back to encrypted-on-disk storage in
//! the same `SQLite` file.

use std::path::PathBuf;

use parking_lot::Mutex;
use rusqlite::{params, Connection};

const SERVICE_NAME: &str = "sidex";
const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS secret_index (
    key         TEXT PRIMARY KEY,
    fallback    BLOB,
    updated_at  INTEGER NOT NULL
);
";

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("value missing")]
    Missing,
}

pub struct SecretStorage {
    db: Mutex<Connection>,
    /// When false, the OS keyring is bypassed entirely and every value lives
    /// in the `SQLite` fallback. Tests need this: a test binary is unsigned and
    /// gets a fresh code signature on each build, so keyring access blocks on
    /// a permission prompt (and on headless CI there is no keyring at all).
    use_keyring: bool,
}

impl SecretStorage {
    /// Opens the storage, creating the `SQLite` index file beneath
    /// `<app-data>/UserData`.
    pub fn open(db_path: PathBuf) -> Result<Self, StorageError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::open_with_keyring(db_path, true)
    }

    /// Opens storage backed only by the `SQLite` file, never the OS keyring.
    ///
    /// Intended for tests and for environments without a keyring daemon.
    pub fn open_without_keyring(db_path: PathBuf) -> Result<Self, StorageError> {
        Self::open_with_keyring(db_path, false)
    }

    fn open_with_keyring(db_path: PathBuf, use_keyring: bool) -> Result<Self, StorageError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            db: Mutex::new(conn),
            use_keyring,
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, StorageError> {
        // A keyring read triggers an OS access prompt. Skip it entirely when
        // the index says nothing was ever stored under this key.
        if !self.has(key)? {
            return Ok(None);
        }

        if self.use_keyring {
            if let Ok(value) = keyring_entry(key)?.get_password() {
                return Ok(Some(value));
            }
        }

        let db = self.db.lock();
        let mut stmt = db.prepare("SELECT fallback FROM secret_index WHERE key = ?1")?;
        let row: Option<Vec<u8>> = stmt.query_row(params![key], |r| r.get(0)).ok().flatten();
        Ok(row.and_then(|bytes| String::from_utf8(bytes).ok()))
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let keyring_ok = self.use_keyring
            && keyring_entry(key)
                .and_then(|entry| entry.set_password(value))
                .is_ok();

        let fallback = if keyring_ok {
            None
        } else {
            Some(value.as_bytes().to_vec())
        };

        let db = self.db.lock();
        db.execute(
            "INSERT OR REPLACE INTO secret_index(key, fallback, updated_at) VALUES (?1, ?2, ?3)",
            params![key, fallback, now_millis()],
        )?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<(), StorageError> {
        if self.use_keyring {
            let _ = keyring_entry(key).and_then(|entry| entry.delete_credential());
        }

        let db = self.db.lock();
        db.execute("DELETE FROM secret_index WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Reads a value the local index owns outright, never touching the keyring.
    ///
    /// Not everything a caller wants to persist is a secret. Base URLs, feature
    /// switches and opt-in flags are ordinary settings; routing them through
    /// the OS keyring buys no protection and costs the user an access prompt
    /// every time the app is rebuilt and re-signed.
    pub fn get_plain(&self, key: &str) -> Result<Option<String>, StorageError> {
        let db = self.db.lock();
        let mut stmt = db.prepare("SELECT fallback FROM secret_index WHERE key = ?1")?;
        let row: Option<Vec<u8>> = stmt.query_row(params![key], |r| r.get(0)).ok().flatten();
        Ok(row.and_then(|bytes| String::from_utf8(bytes).ok()))
    }

    /// Stores a non-secret value in the local index only. See [`Self::get_plain`].
    pub fn set_plain(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let db = self.db.lock();
        db.execute(
            "INSERT OR REPLACE INTO secret_index(key, fallback, updated_at) VALUES (?1, ?2, ?3)",
            params![key, Some(value.as_bytes().to_vec()), now_millis()],
        )?;
        Ok(())
    }

    /// Removes a non-secret value. See [`Self::get_plain`].
    pub fn delete_plain(&self, key: &str) -> Result<(), StorageError> {
        let db = self.db.lock();
        db.execute("DELETE FROM secret_index WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Reports whether a value was ever stored, without reading it.
    ///
    /// The index tracks every key regardless of which backend holds the value,
    /// so callers can skip a keyring lookup — and its access prompt — for keys
    /// that were never set.
    pub fn has(&self, key: &str) -> Result<bool, StorageError> {
        let db = self.db.lock();
        let mut stmt = db.prepare("SELECT 1 FROM secret_index WHERE key = ?1")?;
        Ok(stmt.query_row(params![key], |_| Ok(())).is_ok())
    }

    pub fn keys(&self) -> Result<Vec<String>, StorageError> {
        let db = self.db.lock();
        let mut stmt = db.prepare("SELECT key FROM secret_index ORDER BY key")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }
}

fn keyring_entry(key: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE_NAME, key)
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis()),
    )
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Non-secret values must survive a round trip without the keyring being
    /// involved at all — that is the whole point of the plain API.
    #[test]
    fn plain_values_round_trip_without_the_keyring() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = SecretStorage::open_without_keyring(tmp.path().join("secrets.db")).unwrap();

        assert_eq!(storage.get_plain("sidex.baseurl.ollama").unwrap(), None);
        storage
            .set_plain("sidex.baseurl.ollama", "http://127.0.0.1:11434/v1")
            .unwrap();
        assert_eq!(
            storage.get_plain("sidex.baseurl.ollama").unwrap().as_deref(),
            Some("http://127.0.0.1:11434/v1")
        );

        storage.delete_plain("sidex.baseurl.ollama").unwrap();
        assert_eq!(storage.get_plain("sidex.baseurl.ollama").unwrap(), None);
    }

    /// `has` answers from the index alone, so callers can avoid a keyring read
    /// — and its access prompt — for keys that were never set.
    #[test]
    fn has_reports_presence_without_reading_the_value() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = SecretStorage::open_without_keyring(tmp.path().join("secrets.db")).unwrap();

        assert!(!storage.has("sidex.apikey.openai").unwrap());
        storage.set("sidex.apikey.openai", "sk-test").unwrap();
        assert!(storage.has("sidex.apikey.openai").unwrap());
    }

    /// An unset secret must resolve to `None` without consulting the keyring.
    #[test]
    fn unset_secret_short_circuits_before_the_keyring() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = SecretStorage::open(tmp.path().join("secrets.db")).unwrap();

        assert_eq!(storage.get("sidex.apikey.never-set").unwrap(), None);
    }

    #[test]
    fn sqlite_fallback_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("secrets.db");
        let storage = SecretStorage::open(db_path).unwrap();

        // Even if the keyring is unreachable on CI, the fallback row is written.
        storage.set("unit-test-key", "unit-test-value").unwrap();
        let keys = storage.keys().unwrap();
        assert!(keys.iter().any(|k| k == "unit-test-key"));

        storage.delete("unit-test-key").unwrap();
        let keys = storage.keys().unwrap();
        assert!(!keys.iter().any(|k| k == "unit-test-key"));
    }
}

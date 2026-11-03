//! Chat session and message persistence for Sidex AI chat.

use anyhow::{Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Database;

/// A persisted chat session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub model: String,
    pub mode: String,
    pub workspace: String,
    pub message_count: i32,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
}

/// A persisted chat message within a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub created_at: i64,
}

/// Create a new chat session.
pub fn create_session(db: &Database, session: &ChatSession) -> Result<()> {
    db.conn()
        .execute(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at, model, mode, workspace, message_count, pinned, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                session.id,
                session.title,
                session.created_at,
                session.updated_at,
                session.model,
                session.mode,
                session.workspace,
                session.message_count,
                session.pinned as i32,
                session.archived as i32,
            ],
        )
        .context("create chat session")?;
    Ok(())
}

/// Upsert a chat session (insert or update on conflict).
pub fn save_session(db: &Database, session: &ChatSession) -> Result<()> {
    db.conn()
        .execute(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at, model, mode, workspace, message_count, pinned, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                updated_at = excluded.updated_at,
                model = excluded.model,
                mode = excluded.mode,
                message_count = excluded.message_count,
                pinned = excluded.pinned,
                archived = excluded.archived",
            params![
                session.id,
                session.title,
                session.created_at,
                session.updated_at,
                session.model,
                session.mode,
                session.workspace,
                session.message_count,
                session.pinned as i32,
                session.archived as i32,
            ],
        )
        .context("save chat session")?;
    Ok(())
}

/// Save a chat message, updating the parent session's `message_count` and `updated_at`.
pub fn save_message(db: &Database, msg: &ChatMessage) -> Result<()> {
    db.conn()
        .execute(
            "INSERT INTO chat_messages (id, session_id, role, content, tool_calls, tool_call_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                content = excluded.content,
                tool_calls = excluded.tool_calls",
            params![
                msg.id,
                msg.session_id,
                msg.role,
                msg.content,
                msg.tool_calls,
                msg.tool_call_id,
                msg.created_at,
            ],
        )
        .context("save chat message")?;

    db.conn()
        .execute(
            "UPDATE chat_sessions
             SET message_count = (SELECT COUNT(*) FROM chat_messages WHERE session_id = ?1),
                 updated_at = ?2
             WHERE id = ?1",
            params![msg.session_id, msg.created_at],
        )
        .context("update session message_count")?;
    Ok(())
}

/// List recent sessions for a workspace, newest first.
pub fn list_sessions(db: &Database, workspace: &str, limit: usize) -> Result<Vec<ChatSession>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, title, created_at, updated_at, model, mode, workspace, message_count, pinned, archived
             FROM chat_sessions
             WHERE workspace = ?1
             ORDER BY pinned DESC, updated_at DESC
             LIMIT ?2",
        )
        .context("prepare list_sessions")?;

    #[allow(clippy::cast_possible_wrap)]
    let rows = stmt
        .query_map(params![workspace, limit as i64], |row| {
            let pinned_int: i32 = row.get(8)?;
            let archived_int: i32 = row.get(9)?;
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                model: row.get(4)?,
                mode: row.get(5)?,
                workspace: row.get(6)?,
                message_count: row.get(7)?,
                pinned: pinned_int != 0,
                archived: archived_int != 0,
            })
        })
        .context("query list_sessions")?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.context("read chat_session row")?);
    }
    Ok(entries)
}

/// Load all messages for a session, ordered chronologically.
pub fn load_messages(db: &Database, session_id: &str) -> Result<Vec<ChatMessage>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, session_id, role, content, tool_calls, tool_call_id, created_at
             FROM chat_messages
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )
        .context("prepare load_messages")?;

    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                tool_calls: row.get(4)?,
                tool_call_id: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .context("query load_messages")?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.context("read chat_message row")?);
    }
    Ok(entries)
}

/// Delete a session and all its messages.
pub fn delete_session(db: &Database, session_id: &str) -> Result<()> {
    db.conn()
        .execute(
            "DELETE FROM chat_messages WHERE session_id = ?1",
            params![session_id],
        )
        .context("delete session messages")?;
    db.conn()
        .execute(
            "DELETE FROM chat_sessions WHERE id = ?1",
            params![session_id],
        )
        .context("delete chat session")?;
    Ok(())
}

/// Full-text search across session titles and message content.
pub fn search_sessions(db: &Database, query: &str, workspace: &str) -> Result<Vec<ChatSession>> {
    let pattern = format!("%{query}%");
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT DISTINCT s.id, s.title, s.created_at, s.updated_at,
                    s.model, s.mode, s.workspace, s.message_count, s.pinned, s.archived
             FROM chat_sessions s
             LEFT JOIN chat_messages m ON m.session_id = s.id
             WHERE s.workspace = ?1
               AND (s.title LIKE ?2 OR m.content LIKE ?2)
             ORDER BY s.pinned DESC, s.updated_at DESC
             LIMIT 50",
        )
        .context("prepare search_sessions")?;

    let rows = stmt
        .query_map(params![workspace, pattern], |row| {
            let pinned_int: i32 = row.get(8)?;
            let archived_int: i32 = row.get(9)?;
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                model: row.get(4)?,
                mode: row.get(5)?,
                workspace: row.get(6)?,
                message_count: row.get(7)?,
                pinned: pinned_int != 0,
                archived: archived_int != 0,
            })
        })
        .context("query search_sessions")?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.context("read search_sessions row")?);
    }
    Ok(entries)
}

/// Update only the session title.
pub fn update_session_title(db: &Database, session_id: &str, title: &str) -> Result<()> {
    db.conn()
        .execute(
            "UPDATE chat_sessions SET title = ?2 WHERE id = ?1",
            params![session_id, title],
        )
        .context("update session title")?;
    Ok(())
}

/// Update only the session pinned state.
pub fn update_session_pin(db: &Database, session_id: &str, pinned: bool) -> Result<()> {
    db.conn()
        .execute(
            "UPDATE chat_sessions SET pinned = ?2 WHERE id = ?1",
            params![session_id, pinned as i32],
        )
        .context("update session pin")?;
    Ok(())
}

/// Update only the session archived state.
pub fn update_session_archive(db: &Database, session_id: &str, archived: bool) -> Result<()> {
    db.conn()
        .execute(
            "UPDATE chat_sessions SET archived = ?2 WHERE id = ?1",
            params![session_id, archived as i32],
        )
        .context("update session archive")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        let tmp = tempfile::TempDir::new().unwrap();
        Database::open(&tmp.path().join("test.db")).unwrap()
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    #[test]
    fn create_and_list_sessions() {
        let db = test_db();
        let ts = now();
        create_session(
            &db,
            &ChatSession {
                id: "s1".into(),
                title: "First session".into(),
                created_at: ts,
                updated_at: ts,
                model: "claude-sonnet".into(),
                mode: "agent".into(),
                workspace: "/home/user/project".into(),
                message_count: 0, pinned: false, archived: false,
            },
        )
        .unwrap();

        let sessions = list_sessions(&db, "/home/user/project", 10).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "First session");
    }

    #[test]
    fn save_and_load_messages() {
        let db = test_db();
        let ts = now();
        create_session(
            &db,
            &ChatSession {
                id: "s1".into(),
                title: "Test".into(),
                created_at: ts,
                updated_at: ts,
                model: "claude-sonnet".into(),
                mode: "agent".into(),
                workspace: "/ws".into(),
                message_count: 0, pinned: false, archived: false,
            },
        )
        .unwrap();

        save_message(
            &db,
            &ChatMessage {
                id: "m1".into(),
                session_id: "s1".into(),
                role: "user".into(),
                content: "Hello".into(),
                tool_calls: None,
                tool_call_id: None,
                created_at: ts,
            },
        )
        .unwrap();

        save_message(
            &db,
            &ChatMessage {
                id: "m2".into(),
                session_id: "s1".into(),
                role: "assistant".into(),
                content: "Hi there!".into(),
                tool_calls: None,
                tool_call_id: None,
                created_at: ts + 1,
            },
        )
        .unwrap();

        let msgs = load_messages(&db, "s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].role, "assistant");

        let sessions = list_sessions(&db, "/ws", 10).unwrap();
        assert_eq!(sessions[0].message_count, 2);
    }

    #[test]
    fn delete_session_removes_messages() {
        let db = test_db();
        let ts = now();
        create_session(
            &db,
            &ChatSession {
                id: "s1".into(),
                title: "Doomed".into(),
                created_at: ts,
                updated_at: ts,
                model: "claude-sonnet".into(),
                mode: "agent".into(),
                workspace: "/ws".into(),
                message_count: 0, pinned: false, archived: false,
            },
        )
        .unwrap();
        save_message(
            &db,
            &ChatMessage {
                id: "m1".into(),
                session_id: "s1".into(),
                role: "user".into(),
                content: "bye".into(),
                tool_calls: None,
                tool_call_id: None,
                created_at: ts,
            },
        )
        .unwrap();

        delete_session(&db, "s1").unwrap();
        assert!(list_sessions(&db, "/ws", 10).unwrap().is_empty());
        assert!(load_messages(&db, "s1").unwrap().is_empty());
    }

    #[test]
    fn search_finds_by_title_and_content() {
        let db = test_db();
        let ts = now();
        create_session(
            &db,
            &ChatSession {
                id: "s1".into(),
                title: "Rust debugging".into(),
                created_at: ts,
                updated_at: ts,
                model: "claude-sonnet".into(),
                mode: "agent".into(),
                workspace: "/ws".into(),
                message_count: 0, pinned: false, archived: false,
            },
        )
        .unwrap();
        create_session(
            &db,
            &ChatSession {
                id: "s2".into(),
                title: "Python scripting".into(),
                created_at: ts,
                updated_at: ts,
                model: "claude-sonnet".into(),
                mode: "agent".into(),
                workspace: "/ws".into(),
                message_count: 0, pinned: false, archived: false,
            },
        )
        .unwrap();
        save_message(
            &db,
            &ChatMessage {
                id: "m1".into(),
                session_id: "s2".into(),
                role: "user".into(),
                content: "Help me with Rust lifetimes".into(),
                tool_calls: None,
                tool_call_id: None,
                created_at: ts,
            },
        )
        .unwrap();

        let results = search_sessions(&db, "Rust", "/ws").unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn save_session_upserts() {
        let db = test_db();
        let ts = now();
        let mut session = ChatSession {
            id: "s1".into(),
            title: "Original".into(),
            created_at: ts,
            updated_at: ts,
            model: "claude-sonnet".into(),
            mode: "agent".into(),
            workspace: "/ws".into(),
            message_count: 0, pinned: false, archived: false,
        };
        save_session(&db, &session).unwrap();

        session.title = "Updated title".into();
        session.updated_at = ts + 100;
        save_session(&db, &session).unwrap();

        let sessions = list_sessions(&db, "/ws", 10).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "Updated title");
    }

    #[test]
    fn workspace_scoping() {
        let db = test_db();
        let ts = now();
        create_session(
            &db,
            &ChatSession {
                id: "s1".into(),
                title: "WS A".into(),
                created_at: ts,
                updated_at: ts,
                model: "claude-sonnet".into(),
                mode: "agent".into(),
                workspace: "/workspace-a".into(),
                message_count: 0, pinned: false, archived: false,
            },
        )
        .unwrap();
        create_session(
            &db,
            &ChatSession {
                id: "s2".into(),
                title: "WS B".into(),
                created_at: ts,
                updated_at: ts,
                model: "claude-sonnet".into(),
                mode: "agent".into(),
                workspace: "/workspace-b".into(),
                message_count: 0, pinned: false, archived: false,
            },
        )
        .unwrap();

        assert_eq!(list_sessions(&db, "/workspace-a", 10).unwrap().len(), 1);
        assert_eq!(list_sessions(&db, "/workspace-b", 10).unwrap().len(), 1);
    }

    #[test]
    fn update_title() {
        let db = test_db();
        let ts = now();
        create_session(
            &db,
            &ChatSession {
                id: "s1".into(),
                title: "Old".into(),
                created_at: ts,
                updated_at: ts,
                model: "claude-sonnet".into(),
                mode: "agent".into(),
                workspace: "/ws".into(),
                message_count: 0, pinned: false, archived: false,
            },
        )
        .unwrap();

        update_session_title(&db, "s1", "New title").unwrap();
        let sessions = list_sessions(&db, "/ws", 10).unwrap();
        assert_eq!(sessions[0].title, "New title");
    }
}

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::db_state::SidexDbState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSessionInfo {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub model: String,
    pub mode: String,
    pub workspace: String,
    pub message_count: i32,
    pub pinned: bool,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageInfo {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub created_at: i64,
}

impl From<sidex_db::ChatSession> for ChatSessionInfo {
    fn from(s: sidex_db::ChatSession) -> Self {
        Self {
            id: s.id,
            title: s.title,
            created_at: s.created_at,
            updated_at: s.updated_at,
            model: s.model,
            mode: s.mode,
            workspace: s.workspace,
            message_count: s.message_count,
            pinned: s.pinned,
            archived: s.archived,
        }
    }
}

impl From<sidex_db::ChatMessage> for ChatMessageInfo {
    fn from(m: sidex_db::ChatMessage) -> Self {
        Self {
            id: m.id,
            session_id: m.session_id,
            role: m.role,
            content: m.content,
            tool_calls: m.tool_calls,
            tool_call_id: m.tool_call_id,
            created_at: m.created_at,
        }
    }
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_create(
    state: State<'_, Arc<SidexDbState>>,
    id: String,
    title: String,
    model: String,
    mode: String,
    workspace: String,
) -> Result<(), String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    sidex_db::create_session(
        &db,
        &sidex_db::ChatSession {
            id,
            title,
            created_at: now,
            updated_at: now,
            model,
            mode,
            workspace,
            message_count: 0,
            pinned: false,
            archived: false,
        },
    )
    .map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_list(
    state: State<'_, Arc<SidexDbState>>,
    workspace: String,
    limit: Option<u32>,
) -> Result<Vec<ChatSessionInfo>, String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    sidex_db::list_sessions(&db, &workspace, limit.unwrap_or(50) as usize)
        .map(|v| v.into_iter().map(ChatSessionInfo::from).collect())
        .map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_load(
    state: State<'_, Arc<SidexDbState>>,
    session_id: String,
) -> Result<Vec<ChatMessageInfo>, String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    sidex_db::load_messages(&db, &session_id)
        .map(|v| v.into_iter().map(ChatMessageInfo::from).collect())
        .map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_save_message(
    state: State<'_, Arc<SidexDbState>>,
    id: String,
    session_id: String,
    role: String,
    content: String,
    tool_calls: Option<String>,
    tool_call_id: Option<String>,
    created_at: Option<i64>,
) -> Result<(), String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    let ts = created_at.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    });

    sidex_db::save_message(
        &db,
        &sidex_db::ChatMessage {
            id,
            session_id,
            role,
            content,
            tool_calls,
            tool_call_id,
            created_at: ts,
        },
    )
    .map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_delete(
    state: State<'_, Arc<SidexDbState>>,
    session_id: String,
) -> Result<(), String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    sidex_db::delete_session(&db, &session_id).map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_search(
    state: State<'_, Arc<SidexDbState>>,
    query: String,
    workspace: String,
) -> Result<Vec<ChatSessionInfo>, String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    sidex_db::search_sessions(&db, &query, &workspace)
        .map(|v| v.into_iter().map(ChatSessionInfo::from).collect())
        .map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_update_title(
    state: State<'_, Arc<SidexDbState>>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    sidex_db::update_session_title(&db, &session_id, &title).map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_pin(
    state: State<'_, Arc<SidexDbState>>,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    sidex_db::update_session_pin(&db, &session_id, pinned).map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn session_archive(
    state: State<'_, Arc<SidexDbState>>,
    session_id: String,
    archived: bool,
) -> Result<(), String> {
    let db = state.lock_db().map_err(|e| e.to_string())?;
    sidex_db::update_session_archive(&db, &session_id, archived).map_err(|e| e.to_string())
}

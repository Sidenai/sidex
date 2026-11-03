//! # sidex-db
//!
//! `SQLite` state persistence for the `SideX` editor.
//!
//! This crate provides durable storage for application state using an
//! embedded `SQLite` database.  It includes:
//!
//! - [`Database`] — connection wrapper with versioned schema migrations,
//!   vacuum, and backup support.
//! - [`StateStore`] — scoped key-value store (`global`, `workspace:<path>`,
//!   `extension:<id>`).
//! - [`StorageKv`] — flat (unscoped) key-value store for backward
//!   compatibility with the legacy Tauri `StorageDb`.
//! - Workspace state, global state, and extension state functions.
//! - [`recent`] — recently opened files and workspaces.
//! - [`window_state`] — OS window frame geometry (workbench layout uses `kv_store`).
//! - [`history`] — search history, terminal sessions, clipboard history,
//!   breakpoints, and bookmarks.
//! - [`validation`] — security-critical input validation (path traversal,
//!   NUL byte detection).

pub mod chat_sessions;
pub mod db;
pub mod history;
pub mod recent;
pub mod state;
pub mod storage_kv;
pub mod validation;
pub mod window_state;

pub use chat_sessions::{
    create_session, delete_session, list_sessions, load_messages, save_message, save_session,
    search_sessions, update_session_title, update_session_pin, update_session_archive,
    ChatMessage, ChatSession,
};
pub use db::{Database, CURRENT_SCHEMA_VERSION};
pub use history::{
    add_clipboard_entry, add_search_history, add_terminal_session, all_breakpoints,
    bookmarks_for_file, breakpoints_for_file, clear_breakpoints, clear_clipboard_history,
    clear_search_history, clipboard_history, close_terminal_session, remove_breakpoint,
    search_history, terminal_sessions, toggle_bookmark, upsert_breakpoint, Bookmark, Breakpoint,
    ClipboardEntry, SearchHistoryEntry, TerminalSession,
};
pub use recent::{
    add_recent_file, add_recent_workspace, clear_recent, recent_files, recent_workspaces,
    RecentEntry,
};
pub use state::{
    delete_extension_state, delete_global_state, delete_workspace_state, extension_state_keys,
    get_extension_state, get_global_state, get_workspace_state, set_extension_state,
    set_global_state, set_workspace_state, StateScope, StateStore,
};
pub use storage_kv::StorageKv;
pub use validation::{validate_args, validate_path};
pub use window_state::{load_window_state, save_window_state, WindowState};

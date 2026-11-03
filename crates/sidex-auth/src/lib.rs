//! Generic secret storage for SideX.
//!
//! Despite the crate name, this has nothing to do with authentication —
//! SideX has no sign-in, so there are no tokens to manage. It's a plain
//! key-value secret store used for things like provider API keys and
//! base-URL overrides (see `commands::providers` and `commands::secrets`
//! in the `sidex` crate); callers pick their own keys, there's no fixed
//! namespace.
//!
//! See `storage` for the keyring-backed implementation and its `SQLite`
//! fallback.

pub mod storage;

pub use storage::{SecretStorage, StorageError};

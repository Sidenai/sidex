//! LSP `$/progress` notification tracking.
//!
//! Language servers send `WorkDoneProgress` notifications to report long-running
//! tasks (indexing, building, etc.). This module parses those notifications and
//! maintains a map of active progress tokens so the editor can display them in
//! the status bar.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A unique progress token — either a number or a string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProgressToken {
    Number(i64),
    String(String),
}

impl std::fmt::Display for ProgressToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Number(n) => write!(f, "{n}"),
            Self::String(s) => f.write_str(s),
        }
    }
}

/// One of the three `WorkDoneProgress` messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkDoneProgress {
    Begin {
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cancellable: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        percentage: Option<u32>,
    },
    Report {
        #[serde(skip_serializing_if = "Option::is_none")]
        cancellable: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        percentage: Option<u32>,
    },
    End {
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

/// Current state of a single progress task visible to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressState {
    pub token: ProgressToken,
    pub title: String,
    pub message: Option<String>,
    pub percentage: Option<u32>,
    pub cancellable: bool,
}

/// Tracks all active progress tasks reported by a language server.
#[derive(Debug, Clone)]
pub struct ProgressTracker {
    active: Arc<Mutex<HashMap<ProgressToken, ProgressState>>>,
}

impl Default for ProgressTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ProgressTracker {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Handle a `$/progress` notification. Returns the updated state, or `None`
    /// if the progress ended.
    pub fn handle_notification(&self, params: &Value) -> Option<ProgressState> {
        let token: ProgressToken = serde_json::from_value(params.get("token")?.clone()).ok()?;
        let value = params.get("value")?;
        let progress: WorkDoneProgress = serde_json::from_value(value.clone()).ok()?;

        let mut active = self.active.lock().ok()?;

        match progress {
            WorkDoneProgress::Begin {
                title,
                cancellable,
                message,
                percentage,
            } => {
                let state = ProgressState {
                    token: token.clone(),
                    title,
                    message,
                    percentage,
                    cancellable: cancellable.unwrap_or(false),
                };
                active.insert(token, state.clone());
                Some(state)
            }
            WorkDoneProgress::Report {
                cancellable,
                message,
                percentage,
            } => {
                let state = active.get_mut(&token)?;
                if let Some(msg) = message {
                    state.message = Some(msg);
                }
                if let Some(pct) = percentage {
                    state.percentage = Some(pct);
                }
                if let Some(c) = cancellable {
                    state.cancellable = c;
                }
                Some(state.clone())
            }
            WorkDoneProgress::End { .. } => {
                active.remove(&token);
                None
            }
        }
    }

    /// Returns a snapshot of all active progress tasks.
    pub fn active_tasks(&self) -> Vec<ProgressState> {
        self.active
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Returns whether there is at least one active progress task.
    pub fn has_active_tasks(&self) -> bool {
        self.active.lock().is_ok_and(|map| !map.is_empty())
    }

    /// Clears all tracked progress state.
    pub fn clear(&self) {
        if let Ok(mut map) = self.active.lock() {
            map.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn begin_params(token: &str, title: &str) -> Value {
        json!({
            "token": token,
            "value": {
                "kind": "begin",
                "title": title,
                "percentage": 0
            }
        })
    }

    fn report_params(token: &str, message: &str, pct: u32) -> Value {
        json!({
            "token": token,
            "value": {
                "kind": "report",
                "message": message,
                "percentage": pct
            }
        })
    }

    fn end_params(token: &str) -> Value {
        json!({
            "token": token,
            "value": {
                "kind": "end",
                "message": "Done"
            }
        })
    }

    #[test]
    fn begin_creates_state() {
        let tracker = ProgressTracker::new();
        let state = tracker
            .handle_notification(&begin_params("tok1", "Indexing"))
            .unwrap();
        assert_eq!(state.title, "Indexing");
        assert_eq!(state.percentage, Some(0));
        assert!(tracker.has_active_tasks());
        assert_eq!(tracker.active_tasks().len(), 1);
    }

    #[test]
    fn report_updates_state() {
        let tracker = ProgressTracker::new();
        tracker.handle_notification(&begin_params("tok1", "Building"));
        let state = tracker
            .handle_notification(&report_params("tok1", "50% done", 50))
            .unwrap();
        assert_eq!(state.message.as_deref(), Some("50% done"));
        assert_eq!(state.percentage, Some(50));
    }

    #[test]
    fn end_removes_state() {
        let tracker = ProgressTracker::new();
        tracker.handle_notification(&begin_params("tok1", "Lint"));
        assert!(tracker.has_active_tasks());
        let result = tracker.handle_notification(&end_params("tok1"));
        assert!(result.is_none());
        assert!(!tracker.has_active_tasks());
    }

    #[test]
    fn report_on_unknown_token_returns_none() {
        let tracker = ProgressTracker::new();
        let result = tracker.handle_notification(&report_params("unknown", "msg", 10));
        assert!(result.is_none());
    }

    #[test]
    fn numeric_token() {
        let tracker = ProgressTracker::new();
        let params = json!({
            "token": 42,
            "value": {
                "kind": "begin",
                "title": "Loading"
            }
        });
        let state = tracker.handle_notification(&params).unwrap();
        assert_eq!(state.title, "Loading");
        assert_eq!(state.token, ProgressToken::Number(42));
    }

    #[test]
    fn clear_removes_all() {
        let tracker = ProgressTracker::new();
        tracker.handle_notification(&begin_params("a", "Task A"));
        tracker.handle_notification(&begin_params("b", "Task B"));
        assert_eq!(tracker.active_tasks().len(), 2);
        tracker.clear();
        assert!(!tracker.has_active_tasks());
    }

    #[test]
    fn progress_token_display() {
        assert_eq!(ProgressToken::Number(7).to_string(), "7");
        assert_eq!(ProgressToken::String("abc".into()).to_string(), "abc");
    }

    #[test]
    fn work_done_progress_serde_roundtrip() {
        let begin = WorkDoneProgress::Begin {
            title: "Test".into(),
            cancellable: Some(true),
            message: None,
            percentage: Some(0),
        };
        let json = serde_json::to_string(&begin).unwrap();
        let back: WorkDoneProgress = serde_json::from_str(&json).unwrap();
        match back {
            WorkDoneProgress::Begin { title, .. } => assert_eq!(title, "Test"),
            _ => panic!("expected Begin"),
        }
    }

    #[test]
    fn multiple_concurrent_tasks() {
        let tracker = ProgressTracker::new();
        tracker.handle_notification(&begin_params("t1", "Task 1"));
        tracker.handle_notification(&begin_params("t2", "Task 2"));
        tracker.handle_notification(&begin_params("t3", "Task 3"));
        assert_eq!(tracker.active_tasks().len(), 3);
        tracker.handle_notification(&end_params("t2"));
        assert_eq!(tracker.active_tasks().len(), 2);
    }
}

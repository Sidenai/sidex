//! # sidex-agent
//!
//! AI coding agent tool executor for Sidex. Provides local tool execution
//! (read files, edit files, run commands, search, git) that the Sidex AI
//! server delegates to via the local-exec WebSocket protocol.
//!
//! This crate is Tauri-independent — it uses std and lightweight deps only.
//! The Tauri app wraps its functions as IPC commands.

pub mod skills;
pub mod tools;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A tool execution request from the AI server.
/// Workspace root and auth token travel in [`ToolContext`], not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRequest {
    pub tool_call_id: String,
    pub name: String,
    pub arguments: String,
}

/// The result sent back to the AI server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResponse {
    #[serde(rename = "type")]
    pub response_type: String,
    pub tool_call_id: String,
    pub output: String,
    pub error: String,
}

impl ToolResponse {
    pub fn ok(id: &str, output: String) -> Self {
        Self {
            response_type: "tool_response".into(),
            tool_call_id: id.into(),
            output,
            error: String::new(),
        }
    }

    pub fn err(id: &str, error: String) -> Self {
        Self {
            response_type: "tool_response".into(),
            tool_call_id: id.into(),
            output: String::new(),
            error,
        }
    }
}

/// Context for tool execution — workspace root, etc.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub cwd: String,
    pub token: String,
}

/// Execute a tool request and return a response.
pub fn execute(req: &ToolRequest, ctx: &ToolContext) -> ToolResponse {
    let args: HashMap<String, serde_json::Value> = {
        let s = req.arguments.trim();
        if s.is_empty() || s == "{}" {
            HashMap::new()
        } else {
            match serde_json::from_str(s) {
                Ok(v) => v,
                Err(e) => {
                    return ToolResponse::err(&req.tool_call_id, format!("invalid arguments: {e}"))
                }
            }
        }
    };

    let result = tools::dispatch(&req.name, &args, ctx);
    match result {
        Ok(output) => ToolResponse::ok(&req.tool_call_id, output),
        Err(e) => ToolResponse::err(&req.tool_call_id, e.to_string()),
    }
}

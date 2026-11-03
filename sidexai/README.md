# Sidex AI

Local agent server used by the SideX desktop app (`sidexai/sidex-server`). Go process on loopback: tools, MCP, memory, and provider calls.

The desktop app builds and supervises this server. You only need this README if you are running the server by hand.

## Architecture

## Architecture

```
┌─────────────────┐         WebSocket          ┌──────────────────────┐
│   sidex (Rust)   │ ◄──────────────────────► │   sidex-server (Go)   │
│                  │                           │                       │
│  • Interactive   │                           │  • Anthropic API      │
│  • Syntax HL     │                           │  • Context Compress   │
│  • Tool Display  │                           │  • Memory (BoltDB)    │
│  • Streaming     │                           │  • Tool Execution     │
└─────────────────┘                            │  • Session Mgmt       │
                                               └──────────────────────┘
```

## Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read files with line numbers, auto-compress large files |
| `write_file` | Create/overwrite files, auto-create directories |
| `edit_file` | Find-and-replace with uniqueness checks |
| `list_dir` | List directory contents with sizes |
| `search_files` | Glob-based recursive file search |
| `grep` | Ripgrep-powered content search |
| `shell` | Execute shell commands |
| `glob` | Find files by pattern |
| `tree` | Directory tree visualization |
| `diff` | Git diff output |
| `batch_read` | Read multiple files at once |
| `file_info` | File metadata (size, permissions, timestamps) |

## Features

- **Context Compression** — Automatically compresses conversation history when it gets large, prioritizing code-significant lines (function defs, imports, error handling) and dropping filler
- **Persistent Memory** — BoltDB-backed key-value memory store with tags and search, injected into system prompts so the AI remembers your project
- **Streaming** — Real-time WebSocket streaming with tool call display
- **Syntax Highlighting** — Code blocks highlighted in the terminal via syntect
- **Session Management** — Resume previous conversations
- **Tool Output Compression** — Large shell/file outputs are automatically truncated with head+tail preservation

## Setup

### Prerequisites

- Go 1.26+
- Rust 1.75+ (CLI only)
- `rg` (ripgrep) installed and on PATH
- A model provider: API key, Claude Code / Codex login, or a local server — **Bedrock is optional**, not required

### Server

```bash
cd sidex-server
go mod tidy

# Set your AWS credentials (Bedrock access required)
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# If using temporary credentials:
# export AWS_SESSION_TOKEN="..."

go run cmd/server/main.go
```

Server starts on port 7433 by default. Override with `SIDEX_PORT`.

### CLI

```bash
cd sidex-cli
cargo build --release
```

Binary lands at `target/release/sidex.exe` (Windows) or `target/release/sidex` (Unix).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_ACCESS_KEY_ID` | — | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | — | AWS secret key |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock |
| `AWS_SESSION_TOKEN` | — | Optional session token for temp creds |
| `SIDEX_PORT` | `7433` | Server port |
| `SIDEX_SERVER` | `ws://localhost:7433` | Server URL (CLI) |
| `SIDEX_MODEL` | `us.anthropic.claude-opus-4-6-v1` | Bedrock model ID |

## Usage

```bash
# Interactive mode (default)
sidex

# One-shot question
sidex ask "explain this codebase"

# List sessions
sidex sessions

# Search memories
sidex memory "database schema"

# Check server
sidex status

# Resume session
sidex chat --session <id>

# Custom server
sidex --server ws://myserver:7433
```

### In-Session Commands

| Command | Action |
|---------|--------|
| `/quit` | Exit |
| `/clear` | Clear screen |
| `/memory` | Show stored memories |
| `/sessions` | List sessions |
| `/status` | Server health check |

## Project Structure

```
sidex-server/
├── cmd/server/main.go        # Entry point
├── internal/
│   ├── ai/client.go          # Anthropic streaming client + compression
│   ├── api/handler.go         # HTTP/WebSocket API handlers
│   ├── compress/compress.go   # Context compression engine
│   ├── memory/store.go        # BoltDB persistence layer
│   ├── session/session.go     # Session management
│   └── tools/
│       ├── tools.go           # Tool execution engine
│       └── registry.go        # Tool definitions
└── go.mod

sidex-cli/
├── src/
│   ├── main.rs               # CLI entry + arg parsing
│   ├── ui.rs                  # Interactive terminal UI
│   ├── client.rs              # WebSocket/HTTP client
│   ├── config.rs              # Configuration
│   └── highlight.rs           # Syntax highlighting
└── Cargo.toml
```

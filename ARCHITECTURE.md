# SideX Architecture

A technical reference for how SideX maps to VSCode's architecture.

The VSCode source (MIT License) is the architectural reference. No proprietary code is used.

## Process Model

```
VSCode (Electron)                    SideX (Tauri)
─────────────────                    ─────────────
Electron Main Process        →       Tauri Rust Backend
  ├─ BrowserWindow           →       WebviewWindow
  ├─ ipcMain                 →       Tauri Commands + Events
  ├─ Menu/Dialog/Shell       →       Tauri Plugins
  └─ UtilityProcess          →       Rust async tasks / sidecars

Renderer Process             →       Tauri Webview (frontend TS)
  ├─ Workbench               →       Workbench (same TS)
  ├─ Monaco Editor           →       Monaco Editor (same)
  └─ Extension Host API      →       Extension Host API (ported)

Shared Process               →       Rust service layer
Extension Host               →       Sidecar process (in progress)
(none in VSCode)             →       Agent server (Go), sidecar on loopback
```

## VSCode Layering (Preserved)

```
┌─────────────────────────────────────────────┐
│  code/        → Application entry (Tauri)   │
├─────────────────────────────────────────────┤
│  workbench/   → IDE shell                   │
│    ├── Feature contributions (contrib/)     │
│    ├── Services (services/)                 │
│    ├── Visual Parts (browser/parts/)        │
│    ├── Extension host API (api/)            │
│    └── Layout engine (browser/layout.ts)    │
├─────────────────────────────────────────────┤
│  editor/      → Monaco text editor core     │
├─────────────────────────────────────────────┤
│  platform/    → Platform services (DI)      │
├─────────────────────────────────────────────┤
│  base/        → Foundation utilities        │
└─────────────────────────────────────────────┘
```

## Electron API Replacement Map

| Electron API | Tauri Replacement | Status |
|---|---|---|
| `BrowserWindow` | `WebviewWindow` | Ported |
| `ipcMain/ipcRenderer` | `invoke()` / `emit()` / `listen()` | Ported |
| `Menu/MenuItem` | `tauri::menu::Menu` | Ported |
| `dialog.*` | `@tauri-apps/plugin-dialog` | Ported |
| `clipboard` | `@tauri-apps/plugin-clipboard-manager` | Ported |
| `shell.openExternal` | `@tauri-apps/plugin-opener` | Ported |
| `Notification` | `@tauri-apps/plugin-notification` | Ported |
| `safeStorage` | Rust keyring crate | Partial |
| `protocol.*` | Tauri custom protocol | Ported |
| `screen/Display` | Tauri monitor API | Ported |
| `contextBridge` | `@tauri-apps/api` (direct) | Ported |
| `node-pty` | `portable-pty` (Rust) | Ported |
| `@parcel/watcher` | `notify` (Rust) | Ported |
| `child_process` | `std::process::Command` | Ported |
| `fs/fs.promises` | `@tauri-apps/plugin-fs` + Rust fs | Ported |
| `net/http` | `reqwest` (Rust) | Ported |
| `crypto` | Web Crypto API | Partial |
| `os.*` | `sysinfo` (Rust) | Ported |
| `@vscode/sqlite3` | `rusqlite` | Ported |
| `@vscode/spdlog` | `tracing` + `tracing-subscriber` | Partial |
| `autoUpdater` | `sidex-update` (native Rust) | Complete |
| `powerMonitor` | Rust system-info crates | Not started |
| `contentTracing` | Rust tracing crate | Not started |
| `native-keymap` | Rust keyboard crate | Not started |

## Porting Status by Layer

### base/ (Foundation)
| Sublayer | Strategy | Status |
|---|---|---|
| `common/` | Reuse directly (pure TS) | Done |
| `browser/` | Reuse directly (DOM only) | Done |
| `worker/` | Reuse directly (Web Workers) | Done |
| `node/` | Rewrite → Tauri invoke() | Done |
| `parts/ipc` | Rewrite for Tauri IPC | Done |
| `parts/storage` | Rewrite → Rust SQLite | Done |

### platform/ (Services)
| Service | Strategy | Status |
|---|---|---|
| `instantiation` (DI) | Reuse directly | Done |
| `files` | Tauri fs plugin + Rust | Done |
| `windows` | Tauri window API | Done |
| `configuration` | Mostly reuse | Done |
| `storage` | Rust SQLite backend | Done |
| `keybinding` | Mostly reuse | Done |
| `commands` | Reuse directly | Done |
| `contextkey` | Reuse directly | Done |
| `theme` | Reuse directly | Done |
| `log` | Rust tracing backend | Partial |
| `terminal` | Rust portable-pty | Done |
| `dialogs` | Tauri dialog plugin | Done |
| `clipboard` | Tauri clipboard plugin | Done |
| `native` | Rust OS integration | Partial |
| `encryption` | Rust keyring | Partial |

### editor/ (Monaco)
| Sublayer | Strategy | Status |
|---|---|---|
| `common/` | Reuse directly | Done |
| `browser/` | Reuse directly (DOM) | Done |
| `contrib/` (57 contributions) | Reuse directly | Done |
| `standalone/` | Removed (not needed in Tauri) | Deleted |

### workbench/ (IDE Shell)
| Sublayer | Strategy | Status |
|---|---|---|
| `browser/layout` | Reuse with mods | Done |
| `browser/parts` (8 Parts) | Reuse with mods | Done |
| `contrib/` (92 features) | Incremental port | Partial |
| `services/` (90 services) | Incremental port | Partial |
| `api/` (Extension host) | Port | In progress |

### code/ (Application Entry)
| Sublayer | Strategy | Status |
|---|---|---|
| `electron-main/` | Full rewrite → Tauri Rust | Done |
| `electron-browser/` | Rewrite → Tauri webview | Done |

## Rust Backend Commands

All Tauri commands are registered in `src-tauri/src/lib.rs`. The table below
covers the modules most central to this doc's architecture story — the
command surface has grown well past what fits here (MCP client, hooks, LSP
management, WASM extensions, remote development, browser automation, DAP,
orchestration, and more all live in `src-tauri/src/commands/` too). `lib.rs`
is the source of truth for the full, current list.

| Module | Commands |
|---|---|
| **fs** | `read_file`, `read_file_bytes`, `write_file`, `write_file_bytes`, `read_dir`, `stat`, `mkdir`, `remove`, `rename`, `exists` |
| **terminal** | `terminal_spawn`, `terminal_write`, `terminal_resize`, `terminal_kill`, `terminal_get_pid`, `get_default_shell`, `check_shell_exists`, `get_available_shells` |
| **search** | `search_files`, `search_text` |
| **window** | `create_window`, `close_window`, `set_window_title`, `get_monitors` |
| **os** | `get_os_info`, `get_env`, `get_all_env`, `get_shell` |
| **storage** | `storage_get`, `storage_set`, `storage_delete` |
| **git** | `git_status`, `git_diff`, `git_log`, `git_log_graph`, `git_add`, `git_commit`, `git_checkout`, `git_branches`, `git_create_branch`, `git_delete_branch`, `git_push`, `git_pull`, `git_fetch`, `git_stash`, `git_reset`, `git_show`, `git_init`, `git_is_repo`, `git_clone`, `git_remote_list`, `git_run` |
| **extension_platform** | `extension_platform_bootstrap`, `extension_platform_status`, `extension_platform_restart`, `extension_platform_stop`, `extension_platform_init_data` |
| **network** | `proxy_request`, `proxy_request_full` |
| **debug** | `debug_spawn_adapter`, `debug_send`, `debug_kill`, `debug_list_adapters` |
| **tasks** | `task_spawn`, `task_kill`, `task_list` |
| **server** | `server_endpoint`, `server_restart` |
| **providers** | `providers_catalog`, `providers_status`, `providers_save`, `providers_delete`, `providers_set_cli_auth`, `providers_set_enabled`, `providers_detect_cli`, `providers_detect_local`, `providers_list_models`, `accounts_list`, `accounts_connect`, `accounts_disconnect` |
| **auth** | `auth_get_session`, `auth_get_usage` — all local-only; see [Agent Server](#agent-server) |

## Agent Server

SideX has no account system and no hosted backend. The AI agent runs against
a second process, `sidexai/sidex-server` (Go), that the Tauri backend spawns
as a child on launch and stops on exit (`src-tauri/src/server.rs`):

- Bound to `127.0.0.1` on a random free port, chosen with
  `TcpListener::bind("127.0.0.1:0")` and released for the child to claim.
  There is no auth provider to talk to — every request is handled as the
  local user (`internal/auth.DevUserMiddleware`) — so the server refuses to
  serve a non-loopback `SIDEX_BIND_ADDR` unless `SIDEX_ALLOW_UNAUTHENTICATED=1`
  is set explicitly, since it executes shell commands and edits files on the
  caller's behalf. Started with `SIDEX_NO_AUTH=1`, which separately disables
  plan/credit metering (`internal/plan.Metered`) since the user is paying
  their provider directly.
- Provider credentials are resolved by `src-tauri/src/commands/providers.rs`
  — a key from Settings, then an environment variable, then an opt-in
  Claude Code / Codex CLI login, then a keyless local model server — and
  passed to the child through its process environment as
  `SIDEX_PROVIDER_<PROVIDER>_KEY` / `_BASE_URL` / `_AUTH`. Credentials are
  never written to a config file and never sent to the webview.
- A connected Claude Code login does not currently give working Claude
  access: Anthropic authenticates the token but has been observed to decline
  the request with a contentless `429` (no `retry-after`, no
  `anthropic-ratelimit-*` headers) because the credential is issued for the
  Claude Code CLI and Anthropic does not appear to accept it from other
  clients. See `subscriptionAuthHint` in `internal/ai/anthropic.go`. An
  Anthropic API key, OpenRouter, or a local model works reliably instead.
- The workbench talks to it over HTTP/WebSocket on loopback; `server_endpoint`
  reports the resolved `ws://`/`http://` URLs, `server_restart` restarts it
  after credentials change.
- Anthropic is called through its native Messages API
  (`sidexai/sidex-server/internal/ai/anthropic.go`, `/v1/messages`); every
  other configured provider is treated as OpenAI-compatible
  (`internal/ai/client.go`, `/chat/completions`).
- `auth.rs` on the Rust side hands the workbench a synthetic local session
  (no token, no remote identity) so chat UI written against a login flow
  needs no special "logged out" case.

Two Rust crates support the agent rather than running inside the Go process:
`crates/sidex-agent` is the local tool executor (file edits, shell commands,
git, search), and `crates/sidex-context` is the context/indexing engine
(chunking, embeddings, BM25 search) used to build what gets sent to the
model — on-device by default, with an optional remote index behind
`SIDEX_CLOUD_API` when the user points it at a service they run.

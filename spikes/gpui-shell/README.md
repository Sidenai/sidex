# gpui-shell — throwaway spike

Not a product. Not in CI. Not in the native Cargo workspace (see `exclude` in
the root `Cargo.toml`). Exists to answer two questions:

1. How much of the Rust backend (`crates/*`) is reusable in-process from a
   GPUI app, without Tauri or a webview?
2. Can GPUI be made to look like VSCode's workbench (not like gpui-kit)?

Run: `cargo run -- /path/to/a/repo` (defaults to the cwd). Needs Rust 1.98
(pinned in `rust-toolchain.toml`; gpui-pre's macOS backend uses std APIs
that are unstable on the repo's 1.97) and the repo's `node_modules`
(codicon SVGs are read from `@vscode/codicons`).

It reads your real VSCode setup (settings.json, the active colour theme with
its `include` chain, the active SVG icon theme, fonts, `window.zoomLevel`)
from `~/Library/Application Support/Code/User` and the installed
extensions, so it can be compared side by side with VSCode. Falls back to
Dark Modern.

Editor highlighting is a custom gpui-kit `InputHighlighter`: syntect
TextMate scopes coloured by the theme's `tokenColors` with VSCode-style
selector matching.

Layout: title bar with command center, activity bar, Explorer
(`sidex-workspace`), editor group with tabs + breadcrumbs (gpui-kit
`Editor`, syntect highlighting), bottom panel with a terminal
(`sidex-terminal` PTY + emulator, drawn by hand because gpui-kit has no
terminal widget), status bar. Colours come from `sidex-theme`'s Dark Modern.

Lessons so far are in the brainstorm transcript / design doc, not here.

## What works

| Keys | Action |
|---|---|
| ⌘P | Quick Open (sidex-workspace fuzzy index, recent files boosted) |
| ⇧⌘P, or `>` in Quick Open | Command palette |
| ⌘S / ⌘W | Save / close tab (a dirty tab needs a second close to discard) |
| ⌃Tab / ⌃⇧Tab | Next / previous tab |
| ⌘B / ⌘J | Toggle side bar / panel (also the title-bar layout buttons) |
| ⌃` | Focus terminal |
| ⌘C / ⌘V in terminal | Copy selection / paste (bracketed when the shell asks) |

Explorer follows the disk via sidex-workspace's `FileWatcher`. Terminal has
scrollback on the wheel (arrow keys in full-screen apps) and mouse selection.

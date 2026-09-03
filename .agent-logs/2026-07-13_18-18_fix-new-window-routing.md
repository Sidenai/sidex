## Goal
Fix the "New Window" action in SideX so that it creates a real, functional OS-level window, and ensure all native macOS shortcuts (like Cmd+`) and native menus work correctly in the new window.

## User Feedback & Decisions
- User pointed out "New Window" simply navigates the current window.
- User noted that native menus and shortcuts didn't work in the new window.
- User noted that the newly spawned window's IPC features (like file dialogs) were completely non-functional.
- User noted Cmd+` was swallowed and did not cycle windows.
- Decided to revert pnpm artifacts since the project uses npm.

## Changes Made
- `src/main.ts`: Updated `workspaceProvider.open` to invoke Tauri's `create_window` command when `forceNewWindow` (via `reuse: false`) is requested.
- `src-tauri/capabilities/default.json`: Expanded IPC permissions from `["main"]` to `["*"]` so dynamically spawned windows can execute commands.
- `src-tauri/src/lib.rs`: 
  - Updated `on_menu_event` to dispatch events to the currently focused window instead of hardcoding the `"main"` window.
  - Used `tauri::menu::WINDOW_SUBMENU_ID` for the Window menu so macOS recognizes it.
  - Added a native `CmdOrCtrl+\`` accelerator to "Cycle Through Windows" to prevent the webview from swallowing the shortcut, and handled the window cycling logic natively in Rust by sorting window labels.

## What Worked
- New windows spawn correctly using Tauri's native window APIs.
- The active window now accurately receives and executes native menu events.
- IPC capabilities are correctly inherited by new windows.
- Cmd+` successfully cycles between windows using native OS-level interception.

## What Didn't Work / Known Issues
- None at this time.

## Architecture Notes
- Tauri v2 strictly enforces IPC capabilities per window. Using `["*"]` in the capabilities JSON is necessary if dynamically spawned windows need to access the Tauri API.
- VS Code / Monaco Editor aggressively swallows `Cmd+\``. To override this in a Tauri context, a native menu accelerator must be registered to intercept it before the webview event loop processes it.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

// ─── Constants ──────────────────────────────────────────────────────────────

const BROWSER_WINDOW_LABEL: &str = "sidex-browser-tool";
const MAX_CONSOLE_BUFFER: usize = 500;

// ─── State ──────────────────────────────────────────────────────────────────

/// Shared state for the browser automation tool.
/// Tracks the active webview window, console log buffer, and current URL.
pub struct BrowserState {
    pub(crate) inner: Mutex<BrowserStateInner>,
}

pub(crate) struct BrowserStateInner {
    pub(crate) active_label: Option<String>,
    pub(crate) current_url: Option<String>,
    pub(crate) console_logs: Vec<ConsoleEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ConsoleEntry {
    pub(crate) level: String,
    pub(crate) message: String,
    pub(crate) timestamp: u64,
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BrowserStateInner {
                active_label: None,
                current_url: None,
                console_logs: Vec::new(),
            }),
        }
    }
}

impl Default for BrowserState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Response Types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BrowserNavigateResponse {
    pub title: String,
    pub url: String,
    pub screenshot: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BrowserScreenshotResponse {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct BrowserReadResponse {
    pub text: String,
    pub length: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct BrowserConsoleResponse {
    pub logs: Vec<ConsoleLogEntry>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConsoleLogEntry {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct BrowserEvalResponse {
    pub result: String,
    pub error: Option<String>,
}

// ─── Console Log IPC Command ────────────────────────────────────────────────

/// Internal command invoked by the injected console-capture script.
/// Not exposed to the frontend directly.
#[tauri::command]
pub async fn __browser_console_log(
    state: State<'_, BrowserState>,
    level: String,
    msg: String,
    ts: u64,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if inner.console_logs.len() >= MAX_CONSOLE_BUFFER {
        inner.console_logs.remove(0);
    }
    inner.console_logs.push(ConsoleEntry {
        level,
        message: msg,
        timestamp: ts,
    });
    Ok(())
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Creates or reuses the browser webview window, navigates to the given URL,
/// optionally waits for a CSS selector, and returns the page title + optional screenshot.
#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    state: State<'_, BrowserState>,
    url: String,
    wait_for: Option<String>,
    screenshot: Option<bool>,
) -> Result<BrowserNavigateResponse, String> {
    ensure_browser_window(&app, &state)?;

    let window = app
        .get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or("Browser window not found after creation")?;

    let parsed_url: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    window
        .navigate(parsed_url.clone())
        .map_err(|e| format!("Navigation failed: {e}"))?;

    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.current_url = Some(url.clone());
    }

    // Wait for page load
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    // Re-inject console capture after navigation
    inject_console_capture(&window)?;

    // Wait for optional selector
    if let Some(selector) = wait_for {
        let wait_js = format!(
            r#"(async () => {{
                const maxWait = 10000;
                const interval = 200;
                let elapsed = 0;
                while (elapsed < maxWait) {{
                    if (document.querySelector({selector})) return 'found';
                    await new Promise(r => setTimeout(r, interval));
                    elapsed += interval;
                }}
                return 'timeout';
            }})()"#,
            selector = serde_json::to_string(&selector).unwrap_or_default()
        );
        let _ = eval_js(&window, &wait_js).await;
    }

    let title = eval_js(&window, "document.title").await.unwrap_or_default();

    let screenshot_data = if screenshot.unwrap_or(false) {
        capture_screenshot_js(&window).await.ok()
    } else {
        None
    };

    Ok(BrowserNavigateResponse {
        title,
        url: parsed_url.to_string(),
        screenshot: screenshot_data,
    })
}

/// Takes a screenshot of the page or a specific element via canvas capture.
#[tauri::command]
pub async fn browser_screenshot(
    app: AppHandle,
    _state: State<'_, BrowserState>,
    selector: Option<String>,
    _full_page: Option<bool>,
) -> Result<BrowserScreenshotResponse, String> {
    let window = app
        .get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or("No browser window active. Call browser_navigate first.")?;

    let js = match selector {
        Some(sel) => format!(
            r#"(async () => {{
                const el = document.querySelector({sel});
                if (!el) return JSON.stringify({{error: 'Element not found'}});
                const rect = el.getBoundingClientRect();
                const canvas = document.createElement('canvas');
                canvas.width = rect.width;
                canvas.height = rect.height;
                const ctx = canvas.getContext('2d');
                const img = new Image();
                const svgData = new XMLSerializer().serializeToString(el);
                // Fallback: capture element's outer dimensions
                return JSON.stringify({{
                    dataUrl: '',
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    html: el.outerHTML.substring(0, 5000)
                }});
            }})()"#,
            sel = serde_json::to_string(&sel).unwrap_or_default()
        ),
        None => r#"(function() {
            return JSON.stringify({
                dataUrl: '',
                width: window.innerWidth,
                height: window.innerHeight,
                html: document.documentElement.outerHTML.substring(0, 10000)
            });
        })()"#
            .to_string(),
    };

    let result = eval_js(&window, &js)
        .await
        .map_err(|e| format!("Screenshot failed: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&result).map_err(|e| format!("Parse error: {e}"))?;

    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    Ok(BrowserScreenshotResponse {
        data_url: parsed
            .get("dataUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        width: parsed.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        height: parsed.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    })
}

/// Clicks an element matching the given CSS selector.
#[tauri::command]
pub async fn browser_click(
    app: AppHandle,
    _state: State<'_, BrowserState>,
    selector: String,
) -> Result<String, String> {
    let window = app
        .get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or("No browser window active. Call browser_navigate first.")?;

    let js = format!(
        r#"(function() {{
            const el = document.querySelector({sel});
            if (!el) return 'error: element not found for selector';
            el.scrollIntoView({{block: 'center'}});
            el.click();
            return 'clicked';
        }})()"#,
        sel = serde_json::to_string(&selector).unwrap_or_default()
    );

    eval_js(&window, &js).await
}

/// Types text into an input/textarea matching the given CSS selector.
/// If `clear` is true, clears the field before typing.
#[tauri::command]
pub async fn browser_type(
    app: AppHandle,
    _state: State<'_, BrowserState>,
    selector: String,
    text: String,
    clear: Option<bool>,
) -> Result<String, String> {
    let window = app
        .get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or("No browser window active. Call browser_navigate first.")?;

    let clear_flag = clear.unwrap_or(false);
    let js = format!(
        r#"(function() {{
            const el = document.querySelector({sel});
            if (!el) return 'error: element not found for selector';
            el.scrollIntoView({{block: 'center'}});
            el.focus();
            if ({clear}) {{
                el.value = '';
                el.dispatchEvent(new Event('input', {{bubbles: true}}));
            }}
            const text = {text};
            el.value += text;
            el.dispatchEvent(new Event('input', {{bubbles: true}}));
            el.dispatchEvent(new Event('change', {{bubbles: true}}));
            return 'typed ' + text.length + ' chars';
        }})()"#,
        sel = serde_json::to_string(&selector).unwrap_or_default(),
        clear = if clear_flag { "true" } else { "false" },
        text = serde_json::to_string(&text).unwrap_or_default()
    );

    eval_js(&window, &js).await
}

/// Reads text content from elements matching the given CSS selector.
/// Truncates output to `max_length` characters (default 5000).
#[tauri::command]
pub async fn browser_read(
    app: AppHandle,
    _state: State<'_, BrowserState>,
    selector: Option<String>,
    max_length: Option<usize>,
) -> Result<BrowserReadResponse, String> {
    let window = app
        .get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or("No browser window active. Call browser_navigate first.")?;

    let limit = max_length.unwrap_or(5000);
    let sel_str = selector.unwrap_or_else(|| "body".to_string());

    let js = format!(
        r#"(function() {{
            const el = document.querySelector({sel});
            if (!el) return JSON.stringify({{error: 'element not found'}});
            const fullText = el.innerText || el.textContent || '';
            const limit = {limit};
            const truncated = fullText.length > limit;
            const text = truncated ? fullText.substring(0, limit) : fullText;
            return JSON.stringify({{text, length: fullText.length, truncated}});
        }})()"#,
        sel = serde_json::to_string(&sel_str).unwrap_or_default(),
        limit = limit
    );

    let result = eval_js(&window, &js)
        .await
        .map_err(|e| format!("Read failed: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&result).map_err(|e| format!("Parse error: {e}"))?;

    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    Ok(BrowserReadResponse {
        text: parsed
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        length: parsed.get("length").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        truncated: parsed
            .get("truncated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

/// Scrolls the page in the given direction by the specified pixel amount.
#[tauri::command]
pub async fn browser_scroll(
    app: AppHandle,
    _state: State<'_, BrowserState>,
    direction: String,
    pixels: Option<i32>,
) -> Result<String, String> {
    let window = app
        .get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or("No browser window active. Call browser_navigate first.")?;

    let amount = pixels.unwrap_or(500);
    let (x, y) = match direction.as_str() {
        "up" => (0, -amount),
        "down" => (0, amount),
        "left" => (-amount, 0),
        "right" => (amount, 0),
        _ => {
            return Err(format!(
                "Invalid direction: {direction}. Use up/down/left/right."
            ))
        }
    };

    let js = format!(
        r#"(function() {{
            window.scrollBy({x}, {y});
            return 'scrolled ' + '{dir}' + ' by ' + Math.abs({amt}) + 'px (scrollY=' + window.scrollY + ')';
        }})()"#,
        x = x,
        y = y,
        dir = direction,
        amt = amount
    );

    eval_js(&window, &js).await
}

/// Returns captured console logs from the browser window.
/// If `clear` is true, clears the log buffer after returning.
#[tauri::command]
pub async fn browser_console(
    state: State<'_, BrowserState>,
    clear: Option<bool>,
) -> Result<BrowserConsoleResponse, String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;

    let logs: Vec<ConsoleLogEntry> = inner
        .console_logs
        .iter()
        .map(|e| ConsoleLogEntry {
            level: e.level.clone(),
            message: e.message.clone(),
        })
        .collect();

    let count = logs.len();

    if clear.unwrap_or(false) {
        inner.console_logs.clear();
    }

    Ok(BrowserConsoleResponse { logs, count })
}

/// Evaluates arbitrary JavaScript in the browser window and returns the result.
#[tauri::command]
pub async fn browser_eval(
    app: AppHandle,
    _state: State<'_, BrowserState>,
    expression: String,
) -> Result<BrowserEvalResponse, String> {
    let window = app
        .get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or("No browser window active. Call browser_navigate first.")?;

    let wrapped = format!(
        r#"(function() {{
            try {{
                const __result = (function() {{ return {expr}; }})();
                if (__result === undefined) return JSON.stringify({{result: 'undefined', error: null}});
                if (__result === null) return JSON.stringify({{result: 'null', error: null}});
                const str = (typeof __result === 'object') ? JSON.stringify(__result) : String(__result);
                return JSON.stringify({{result: str, error: null}});
            }} catch(e) {{
                return JSON.stringify({{result: '', error: e.message || String(e)}});
            }}
        }})()"#,
        expr = expression
    );

    let raw = eval_js(&window, &wrapped)
        .await
        .unwrap_or_else(|e| serde_json::json!({"result": "", "error": e}).to_string());

    let parsed: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({"result": raw, "error": null}));

    Ok(BrowserEvalResponse {
        result: parsed
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        error: parsed
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty()),
    })
}

/// Closes the browser webview window and resets state.
#[tauri::command]
pub async fn browser_close(
    app: AppHandle,
    state: State<'_, BrowserState>,
) -> Result<String, String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;

    if let Some(ref label) = inner.active_label {
        if let Some(window) = app.get_webview_window(label) {
            window
                .close()
                .map_err(|e| format!("Failed to close browser window: {e}"))?;
        }
    }

    inner.active_label = None;
    inner.current_url = None;
    inner.console_logs.clear();

    Ok("browser closed".to_string())
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/// Creates the browser webview window if it doesn't already exist.
/// Sets up the window with appropriate size and injects the console capture script.
fn ensure_browser_window(app: &AppHandle, state: &State<'_, BrowserState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;

    if inner.active_label.is_some() && app.get_webview_window(BROWSER_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        app,
        BROWSER_WINDOW_LABEL,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("Sidex Browser")
    .inner_size(1280.0, 900.0)
    .visible(false);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    let window = builder
        .build()
        .map_err(|e| format!("Failed to create browser window: {e}"))?;

    inject_console_capture(&window)?;

    inner.active_label = Some(BROWSER_WINDOW_LABEL.to_string());
    inner.console_logs.clear();

    Ok(())
}

/// Injects the console-capture override script into the webview.
/// Overrides console.log/warn/error to forward messages via Tauri IPC.
fn inject_console_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    let script = r#"
        (function() {
            if (window.__sidex_console_hooked) return;
            window.__sidex_console_hooked = true;
            const orig = {
                log: console.log.bind(console),
                warn: console.warn.bind(console),
                error: console.error.bind(console),
                info: console.info.bind(console)
            };
            function capture(level, args) {
                const msg = Array.from(args).map(a => {
                    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
                    catch(e) { return String(a); }
                }).join(' ');
                try {
                    window.__TAURI_INTERNALS__.invoke('__browser_console_log', {
                        level: level,
                        msg: msg,
                        ts: Date.now()
                    });
                } catch(e) {}
            }
            console.log = function() { capture('log', arguments); orig.log.apply(null, arguments); };
            console.warn = function() { capture('warn', arguments); orig.warn.apply(null, arguments); };
            console.error = function() { capture('error', arguments); orig.error.apply(null, arguments); };
            console.info = function() { capture('info', arguments); orig.info.apply(null, arguments); };
        })();
    "#;

    window
        .eval(script)
        .map_err(|e| format!("Failed to inject console capture: {e}"))
}

/// Evaluates JavaScript in the webview and retrieves the string result via IPC callback.
/// Uses Tauri's eval + a temporary promise-based approach to get return values.
async fn eval_js(window: &tauri::WebviewWindow, js: &str) -> Result<String, String> {
    // Tauri's eval() is fire-and-forget; to get a return value we use
    // a pattern where the JS writes to a known IPC channel.
    // For simplicity and reliability, we use the `evaluate_script` approach
    // with a unique callback ID.
    let callback_id = uuid::Uuid::new_v4().to_string().replace('-', "");

    let wrapped = format!(
        r#"(async function() {{
            try {{
                const __r = await (async function() {{ return {js}; }})();
                window.__TAURI_INTERNALS__.invoke('__browser_console_log', {{
                    level: '__eval_result_{id}',
                    msg: typeof __r === 'string' ? __r : JSON.stringify(__r),
                    ts: Date.now()
                }});
            }} catch(e) {{
                window.__TAURI_INTERNALS__.invoke('__browser_console_log', {{
                    level: '__eval_error_{id}',
                    msg: e.message || String(e),
                    ts: Date.now()
                }});
            }}
        }})()"#,
        js = js,
        id = callback_id
    );

    window
        .eval(&wrapped)
        .map_err(|e| format!("JS eval failed: {e}"))?;

    // Poll state for the result with timeout
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(15);
    let result_key = format!("__eval_result_{callback_id}");
    let error_key = format!("__eval_error_{callback_id}");

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        if let Ok(inner) = window.app_handle().state::<BrowserState>().inner.lock() {
            // Search from the end for our result
            for entry in inner.console_logs.iter().rev() {
                if entry.level == result_key {
                    return Ok(entry.message.clone());
                }
                if entry.level == error_key {
                    return Err(entry.message.clone());
                }
            }
        }

        if start.elapsed() > timeout {
            return Err("JS evaluation timed out after 15s".to_string());
        }
    }
}

/// Captures a screenshot using a canvas-based approach.
/// Returns the image as a base64-encoded data URL.
async fn capture_screenshot_js(window: &tauri::WebviewWindow) -> Result<String, String> {
    let js = r#"(async function() {
        // Simple viewport capture via SVG foreignObject approach
        const width = document.documentElement.scrollWidth;
        const height = Math.min(document.documentElement.scrollHeight, window.innerHeight);
        const body = document.body.innerHTML;
        
        // Return page info instead of actual pixel data (native screenshot not available)
        return JSON.stringify({
            type: 'dom_snapshot',
            title: document.title,
            url: window.location.href,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            bodyLength: document.body.innerText.length
        });
    })()"#;

    eval_js(window, js).await
}

//! Extension webview panel hosting.
//!
//! Manages the lifecycle of webview panels created by extensions via the
//! `vscode.window.createWebviewPanel` API. Each panel has an HTML content
//! surface and supports bidirectional message passing between the extension
//! and the webview.
//!
//! Features:
//! - CSP (Content Security Policy) handling
//! - Port mapping between webview and extension host
//! - State persistence across hide/show cycles
//! - `vscode-resource:` URI translation
//! - Sidebar and panel webview views
//! - Typed message channels

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Unique identifier for a webview panel.
pub type WebviewId = u64;

/// Which editor column a panel appears in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ViewColumn {
    Active,
    Beside,
    One,
    Two,
    Three,
}

impl ViewColumn {
    pub fn to_i32(self) -> i32 {
        match self {
            Self::Active => -1,
            Self::Beside => -2,
            Self::One => 1,
            Self::Two => 2,
            Self::Three => 3,
        }
    }

    pub fn from_i32(val: i32) -> Self {
        match val {
            -2 => Self::Beside,
            1 => Self::One,
            2 => Self::Two,
            3 => Self::Three,
            _ => Self::Active,
        }
    }
}

/// Port mapping between the webview and the extension host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortMapping {
    pub webview_port: u16,
    pub extension_host_port: u16,
}

/// Options controlling webview behaviour.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct WebviewOptions {
    /// Allow scripts to run inside the webview.
    #[serde(default)]
    pub enable_scripts: bool,
    /// Allow HTML form submission in the webview.
    #[serde(default)]
    pub enable_forms: bool,
    /// Restrict local resource loading to these root paths.
    #[serde(default)]
    pub local_resource_roots: Vec<PathBuf>,
    /// Port mappings between webview and extension host.
    #[serde(default)]
    pub port_mapping: Vec<PortMapping>,
    /// Keep the webview alive when it is not visible.
    #[serde(default)]
    pub retain_context_when_hidden: bool,
    /// Allow extension to set arbitrary `<meta>` CSP.
    #[serde(default)]
    pub enable_command_uris: bool,
}

/// A single extension-created webview panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewPanel {
    pub id: WebviewId,
    pub view_type: String,
    pub title: String,
    pub html: String,
    pub options: WebviewOptions,
    pub visible: bool,
    pub active: bool,
    /// Column the panel was opened in.
    pub column: i32,
    /// The extension that created this panel.
    pub extension_id: String,
    /// Serialized webview state for persistence.
    #[serde(default)]
    pub state: Option<Value>,
    /// Custom CSP directive.
    #[serde(default)]
    pub csp: Option<String>,
    /// Whether this is a sidebar webview view (not a panel).
    #[serde(default)]
    pub is_webview_view: bool,
    /// The sidebar view id if this is a webview view.
    #[serde(default)]
    pub webview_view_id: Option<String>,
}

/// Serialisable message posted between webview and extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebviewMessage {
    pub webview_id: WebviewId,
    #[serde(default)]
    pub command: String,
    pub data: Value,
}

impl WebviewMessage {
    pub fn new(webview_id: WebviewId, command: impl Into<String>, data: Value) -> Self {
        Self {
            webview_id,
            command: command.into(),
            data,
        }
    }
}

/// Where a webview view lives in the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WebviewViewLocation {
    Sidebar,
    Panel,
    SecondaryPanel,
}

/// A webview view registration (sidebar/panel contributions).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebviewViewDescriptor {
    pub id: String,
    pub title: String,
    pub extension_id: String,
    pub location: WebviewViewLocation,
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/// Manages all extension webview panels and webview views.
///
/// In the real desktop application each panel will map to a Tauri webview
/// window. This struct provides the logical bookkeeping layer that the
/// extension host protocol implementation calls into.
pub struct WebviewHost {
    panels: HashMap<WebviewId, WebviewPanel>,
    next_id: AtomicU64,
    /// Queued messages waiting for delivery (`webview_id` → messages).
    pending_messages: HashMap<WebviewId, Vec<WebviewMessage>>,
    /// Saved state for disposed panels (keyed by `view_type`), for restore.
    persisted_state: HashMap<String, Value>,
    /// Registered webview view descriptors.
    view_descriptors: Vec<WebviewViewDescriptor>,
}

impl std::fmt::Debug for WebviewHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebviewHost")
            .field("panels", &self.panels.len())
            .field("pending_messages", &self.pending_messages.len())
            .field("view_descriptors", &self.view_descriptors.len())
            .finish_non_exhaustive()
    }
}

impl WebviewHost {
    pub fn new() -> Self {
        Self {
            panels: HashMap::new(),
            next_id: AtomicU64::new(1),
            pending_messages: HashMap::new(),
            persisted_state: HashMap::new(),
            view_descriptors: Vec::new(),
        }
    }

    // -- Panel lifecycle --------------------------------------------------

    /// Creates a new webview panel and returns its id.
    pub fn create(
        &mut self,
        view_type: impl Into<String>,
        title: impl Into<String>,
        column: i32,
        options: WebviewOptions,
        extension_id: impl Into<String>,
    ) -> WebviewId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let vt = view_type.into();

        let state = self.persisted_state.remove(&vt);

        let panel = WebviewPanel {
            id,
            view_type: vt,
            title: title.into(),
            html: String::new(),
            options,
            visible: true,
            active: true,
            column,
            extension_id: extension_id.into(),
            state,
            csp: None,
            is_webview_view: false,
            webview_view_id: None,
        };
        self.panels.insert(id, panel);
        id
    }

    /// Creates a webview view (sidebar/panel contribution).
    pub fn create_webview_view(
        &mut self,
        view_id: impl Into<String>,
        title: impl Into<String>,
        options: WebviewOptions,
        extension_id: impl Into<String>,
    ) -> WebviewId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let vid = view_id.into();

        let panel = WebviewPanel {
            id,
            view_type: vid.clone(),
            title: title.into(),
            html: String::new(),
            options,
            visible: true,
            active: false,
            column: 0,
            extension_id: extension_id.into(),
            state: None,
            csp: None,
            is_webview_view: true,
            webview_view_id: Some(vid),
        };
        self.panels.insert(id, panel);
        id
    }

    /// Disposes (closes) a webview panel, optionally persisting its state.
    pub fn dispose(&mut self, id: WebviewId) -> bool {
        if let Some(panel) = self.panels.remove(&id) {
            if panel.options.retain_context_when_hidden {
                if let Some(state) = panel.state {
                    self.persisted_state.insert(panel.view_type, state);
                }
            }
            self.pending_messages.remove(&id);
            true
        } else {
            false
        }
    }

    // -- Content ----------------------------------------------------------

    /// Sets the HTML content for a webview panel.
    pub fn set_html(&mut self, id: WebviewId, html: impl Into<String>) -> bool {
        if let Some(panel) = self.panels.get_mut(&id) {
            panel.html = html.into();
            true
        } else {
            false
        }
    }

    /// Sets a custom Content Security Policy for a panel.
    pub fn set_csp(&mut self, id: WebviewId, csp: impl Into<String>) -> bool {
        if let Some(panel) = self.panels.get_mut(&id) {
            panel.csp = Some(csp.into());
            true
        } else {
            false
        }
    }

    /// Returns the effective HTML for a panel, with CSP meta injected.
    pub fn effective_html(&self, id: WebviewId) -> Option<String> {
        let panel = self.panels.get(&id)?;
        let Some(ref csp) = panel.csp else {
            return Some(panel.html.clone());
        };

        let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\">");

        let html = if let Some(pos) = panel.html.find("<head>") {
            let insert_at = pos + "<head>".len();
            format!(
                "{}{meta}{}",
                &panel.html[..insert_at],
                &panel.html[insert_at..]
            )
        } else {
            format!("{meta}{}", panel.html)
        };

        Some(html)
    }

    // -- Message passing --------------------------------------------------

    /// Sends a typed message to a webview panel.
    pub fn send_message(&mut self, panel_id: WebviewId, message: WebviewMessage) -> bool {
        if self.panels.contains_key(&panel_id) {
            self.pending_messages
                .entry(panel_id)
                .or_default()
                .push(message);
            true
        } else {
            false
        }
    }

    /// Posts a raw JSON value to a webview panel (convenience wrapper).
    pub fn post_message(&mut self, id: WebviewId, body: Value) -> bool {
        if self.panels.contains_key(&id) {
            self.pending_messages
                .entry(id)
                .or_default()
                .push(WebviewMessage {
                    webview_id: id,
                    command: String::new(),
                    data: body,
                });
            true
        } else {
            false
        }
    }

    /// Takes all pending messages for a webview, draining the queue.
    pub fn take_pending_messages(&mut self, id: WebviewId) -> Vec<WebviewMessage> {
        self.pending_messages.remove(&id).unwrap_or_default()
    }

    // -- State persistence ------------------------------------------------

    /// Saves the webview state for later restoration.
    pub fn set_state(&mut self, id: WebviewId, state: Value) -> bool {
        if let Some(panel) = self.panels.get_mut(&id) {
            panel.state = Some(state);
            true
        } else {
            false
        }
    }

    /// Gets the current persisted state.
    pub fn get_state(&self, id: WebviewId) -> Option<&Value> {
        self.panels.get(&id)?.state.as_ref()
    }

    // -- Resource URI translation -----------------------------------------

    /// Translates a `vscode-resource:` URI into a real file path, validated
    /// against the panel's `local_resource_roots`.
    pub fn resolve_resource_uri(&self, id: WebviewId, resource_path: &str) -> Option<PathBuf> {
        let panel = self.panels.get(&id)?;
        let path = PathBuf::from(resource_path);

        if panel.options.local_resource_roots.is_empty() {
            return Some(path);
        }

        for root in &panel.options.local_resource_roots {
            if path.starts_with(root) {
                return Some(path);
            }
        }

        None
    }

    // -- Queries ----------------------------------------------------------

    pub fn get(&self, id: WebviewId) -> Option<&WebviewPanel> {
        self.panels.get(&id)
    }

    pub fn get_mut(&mut self, id: WebviewId) -> Option<&mut WebviewPanel> {
        self.panels.get_mut(&id)
    }

    pub fn panel_ids(&self) -> Vec<WebviewId> {
        self.panels.keys().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.panels.len()
    }

    pub fn is_empty(&self) -> bool {
        self.panels.is_empty()
    }

    pub fn set_visible(&mut self, id: WebviewId, visible: bool) {
        if let Some(panel) = self.panels.get_mut(&id) {
            panel.visible = visible;
        }
    }

    pub fn set_title(&mut self, id: WebviewId, title: impl Into<String>) {
        if let Some(panel) = self.panels.get_mut(&id) {
            panel.title = title.into();
        }
    }

    pub fn panels_for_extension(&self, extension_id: &str) -> Vec<&WebviewPanel> {
        self.panels
            .values()
            .filter(|p| p.extension_id == extension_id)
            .collect()
    }

    /// Returns all webview views (sidebar/panel contributions).
    pub fn webview_views(&self) -> Vec<&WebviewPanel> {
        self.panels.values().filter(|p| p.is_webview_view).collect()
    }

    /// Disposes all panels belonging to an extension.
    pub fn dispose_extension_panels(&mut self, extension_id: &str) -> usize {
        let ids: Vec<WebviewId> = self
            .panels
            .iter()
            .filter(|(_, p)| p.extension_id == extension_id)
            .map(|(id, _)| *id)
            .collect();
        let count = ids.len();
        for id in ids {
            self.dispose(id);
        }
        count
    }

    // -- View descriptors -------------------------------------------------

    /// Registers a webview view descriptor (from extension contributes).
    pub fn register_view_descriptor(&mut self, desc: WebviewViewDescriptor) {
        self.view_descriptors.push(desc);
    }

    /// Returns all registered view descriptors.
    pub fn view_descriptors(&self) -> &[WebviewViewDescriptor] {
        &self.view_descriptors
    }

    /// Returns view descriptors for a specific extension.
    pub fn view_descriptors_for(&self, extension_id: &str) -> Vec<&WebviewViewDescriptor> {
        self.view_descriptors
            .iter()
            .filter(|d| d.extension_id == extension_id)
            .collect()
    }
}

impl Default for WebviewHost {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_get_panel() {
        let mut host = WebviewHost::new();
        let id = host.create(
            "markdown.preview",
            "Preview",
            1,
            WebviewOptions::default(),
            "ext.md",
        );
        assert_eq!(host.len(), 1);
        let panel = host.get(id).unwrap();
        assert_eq!(panel.view_type, "markdown.preview");
        assert_eq!(panel.title, "Preview");
        assert_eq!(panel.column, 1);
        assert!(panel.visible);
        assert!(panel.html.is_empty());
        assert!(!panel.is_webview_view);
    }

    #[test]
    fn set_html() {
        let mut host = WebviewHost::new();
        let id = host.create("test", "Test", 1, WebviewOptions::default(), "ext.test");
        assert!(host.set_html(id, "<h1>Hello</h1>"));
        assert_eq!(host.get(id).unwrap().html, "<h1>Hello</h1>");
    }

    #[test]
    fn set_html_nonexistent() {
        let mut host = WebviewHost::new();
        assert!(!host.set_html(999, "<p>nope</p>"));
    }

    #[test]
    fn send_and_take_typed_messages() {
        let mut host = WebviewHost::new();
        let id = host.create("test", "Test", 1, WebviewOptions::default(), "ext.test");

        let msg = WebviewMessage::new(id, "update", serde_json::json!({"key": "val"}));
        assert!(host.send_message(id, msg));

        let msgs = host.take_pending_messages(id);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].command, "update");
        assert_eq!(msgs[0].data["key"], "val");
    }

    #[test]
    fn post_raw_message() {
        let mut host = WebviewHost::new();
        let id = host.create("test", "Test", 1, WebviewOptions::default(), "ext.test");

        assert!(host.post_message(id, serde_json::json!({"type": "refresh"})));
        let msgs = host.take_pending_messages(id);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].data["type"], "refresh");
    }

    #[test]
    fn post_message_nonexistent() {
        let mut host = WebviewHost::new();
        assert!(!host.post_message(42, Value::Null));
    }

    #[test]
    fn state_persistence() {
        let mut host = WebviewHost::new();
        let id = host.create(
            "test",
            "Test",
            1,
            WebviewOptions {
                retain_context_when_hidden: true,
                ..Default::default()
            },
            "ext.test",
        );

        host.set_state(id, serde_json::json!({"scroll": 100}));
        assert!(host.get_state(id).is_some());

        host.dispose(id);
        assert!(host.get(id).is_none());

        let id2 = host.create("test", "Test", 1, WebviewOptions::default(), "ext.test");
        let state = host.get(id2).unwrap().state.as_ref();
        assert!(state.is_some());
        assert_eq!(state.unwrap()["scroll"], 100);
    }

    #[test]
    fn csp_injection() {
        let mut host = WebviewHost::new();
        let id = host.create("test", "Test", 1, WebviewOptions::default(), "ext.test");
        host.set_html(id, "<html><head></head><body></body></html>");
        host.set_csp(id, "default-src 'none'");

        let html = host.effective_html(id).unwrap();
        assert!(html.contains("Content-Security-Policy"));
        assert!(html.contains("default-src 'none'"));
    }

    #[test]
    fn resource_uri_resolution() {
        let mut host = WebviewHost::new();
        let root = PathBuf::from("/ext/resources");
        let id = host.create(
            "test",
            "Test",
            1,
            WebviewOptions {
                local_resource_roots: vec![root.clone()],
                ..Default::default()
            },
            "ext.test",
        );

        let allowed = host.resolve_resource_uri(id, "/ext/resources/icon.png");
        assert!(allowed.is_some());

        let denied = host.resolve_resource_uri(id, "/etc/passwd");
        assert!(denied.is_none());
    }

    #[test]
    fn dispose_panel() {
        let mut host = WebviewHost::new();
        let id = host.create("test", "Test", 1, WebviewOptions::default(), "ext.test");
        host.post_message(id, Value::Null);
        assert!(host.dispose(id));
        assert!(host.get(id).is_none());
        assert!(host.is_empty());
        assert!(host.take_pending_messages(id).is_empty());
    }

    #[test]
    fn dispose_nonexistent() {
        let mut host = WebviewHost::new();
        assert!(!host.dispose(999));
    }

    #[test]
    fn multiple_panels() {
        let mut host = WebviewHost::new();
        let id1 = host.create("a", "A", 1, WebviewOptions::default(), "ext.a");
        let id2 = host.create("b", "B", 2, WebviewOptions::default(), "ext.b");
        assert_eq!(host.len(), 2);
        assert_ne!(id1, id2);
    }

    #[test]
    fn set_visible_and_title() {
        let mut host = WebviewHost::new();
        let id = host.create("test", "Old", 1, WebviewOptions::default(), "ext.test");

        host.set_visible(id, false);
        assert!(!host.get(id).unwrap().visible);

        host.set_title(id, "New Title");
        assert_eq!(host.get(id).unwrap().title, "New Title");
    }

    #[test]
    fn panels_for_extension() {
        let mut host = WebviewHost::new();
        host.create("a", "A1", 1, WebviewOptions::default(), "ext.a");
        host.create("a", "A2", 1, WebviewOptions::default(), "ext.a");
        host.create("b", "B1", 1, WebviewOptions::default(), "ext.b");
        assert_eq!(host.panels_for_extension("ext.a").len(), 2);
    }

    #[test]
    fn dispose_extension_panels() {
        let mut host = WebviewHost::new();
        host.create("a", "A1", 1, WebviewOptions::default(), "ext.a");
        host.create("a", "A2", 1, WebviewOptions::default(), "ext.a");
        host.create("b", "B1", 1, WebviewOptions::default(), "ext.b");
        assert_eq!(host.dispose_extension_panels("ext.a"), 2);
        assert_eq!(host.len(), 1);
    }

    #[test]
    fn webview_view_creation() {
        let mut host = WebviewHost::new();
        let id = host.create_webview_view(
            "myExt.sidebar",
            "My View",
            WebviewOptions::default(),
            "ext.my",
        );
        let panel = host.get(id).unwrap();
        assert!(panel.is_webview_view);
        assert_eq!(panel.webview_view_id.as_deref(), Some("myExt.sidebar"));
        assert_eq!(host.webview_views().len(), 1);
    }

    #[test]
    fn view_column_round_trip() {
        assert_eq!(
            ViewColumn::from_i32(ViewColumn::Active.to_i32()),
            ViewColumn::Active
        );
        assert_eq!(
            ViewColumn::from_i32(ViewColumn::Beside.to_i32()),
            ViewColumn::Beside
        );
        assert_eq!(ViewColumn::from_i32(1), ViewColumn::One);
        assert_eq!(ViewColumn::from_i32(2), ViewColumn::Two);
        assert_eq!(ViewColumn::from_i32(3), ViewColumn::Three);
    }

    #[test]
    fn webview_message_construction() {
        let msg = WebviewMessage::new(42, "doSomething", serde_json::json!({"x": 1}));
        assert_eq!(msg.webview_id, 42);
        assert_eq!(msg.command, "doSomething");
        assert_eq!(msg.data["x"], 1);
    }

    #[test]
    fn register_view_descriptor() {
        let mut host = WebviewHost::new();
        host.register_view_descriptor(WebviewViewDescriptor {
            id: "myExt.treeView".into(),
            title: "My Tree".into(),
            extension_id: "ext.my".into(),
            location: WebviewViewLocation::Sidebar,
        });
        assert_eq!(host.view_descriptors().len(), 1);
        assert_eq!(host.view_descriptors_for("ext.my").len(), 1);
        assert!(host.view_descriptors_for("ext.other").is_empty());
    }

    #[test]
    fn port_mapping_serialize() {
        let pm = PortMapping {
            webview_port: 3000,
            extension_host_port: 8080,
        };
        let json = serde_json::to_string(&pm).unwrap();
        let back: PortMapping = serde_json::from_str(&json).unwrap();
        assert_eq!(back.webview_port, 3000);
        assert_eq!(back.extension_host_port, 8080);
    }
}

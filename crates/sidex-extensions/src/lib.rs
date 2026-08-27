//! Extension host management for `SideX` — Node.js extension host + WASM
//! extensions.
//!
//! This crate provides:
//!
//! - **Extension host** ([`host`]) — spawn and communicate with the Node.js
//!   extension host process via JSON-RPC.
//! - **Protocol** ([`protocol`]) — typed extension host JSON-RPC protocol
//!   messages (main thread ↔ ext host), modelled after VS Code's
//!   `extHost.protocol.ts`.
//! - **Activation** ([`activation`]) — activation event matching and
//!   triggering (`onLanguage`, `onCommand`, `*`, etc.).
//! - **Contribution handler** ([`contribution_handler`]) — process
//!   `package.json` `contributes` sections (commands, menus, keybindings,
//!   languages, grammars, themes, snippets, configuration, views, debuggers,
//!   task definitions).
//! - **Webview host** ([`webview_host`]) — manage extension webview panels
//!   with HTML content and bidirectional message passing.
//! - **Manifest parsing** ([`manifest`]) — parse VS Code `package.json` and
//!   `SideX` WASM `sidex.toml` manifests, build init-data payloads.
//! - **Registry** ([`registry`]) — discover, scan, and manage installed
//!   extensions across multiple directories.
//! - **Installer** ([`installer`]) — install, uninstall, and update extensions
//!   from `.vsix` files or the marketplace.
//! - **Marketplace client** ([`marketplace`]) — query the Open VSX registry
//!   with search, filtering, categories, trending, and caching.
//! - **VSIX handling** ([`vsix`]) — parse, validate, and install `.vsix`
//!   packages.
//! - **Tree views** ([`tree_view`]) — extension-contributed tree views with
//!   lazy loading, selection, drag-and-drop, and inline actions.
//! - **Paths** ([`paths`]) — standard filesystem paths for extension storage
//!   and Node.js runtime resolution.

pub mod activation;
pub mod contribution_handler;
pub mod contributions;
pub mod encoding;
pub mod host;
pub mod installer;
pub mod manifest;
pub mod marketplace;
pub mod paths;
pub mod protocol;
pub mod registry;
pub mod tree_view;
pub mod vsix;
pub mod webview_host;

pub use activation::{activate_by_event, eager_activation_ids, should_activate, ActivationEvent};
pub use contribution_handler::{
    process_all_contributions, process_contributions, ContributionIndex, ContributionSet,
    ResolvedCommand, ResolvedDebugger, ResolvedGrammar, ResolvedKeybinding, ResolvedLanguage,
    ResolvedMenuItem, ResolvedSnippet, ResolvedTaskDefinition, ResolvedTheme, ResolvedView,
};
pub use contributions::{
    parse_contributions, register_contributions, CommandContribution, ConfigurationContribution,
    ContributionHandler, ContributionPoint, DebuggerContribution, GrammarContribution,
    IconThemeContribution, KeybindingContribution, LanguageContribution, MenuContribution,
    ProblemMatcherContribution, SnippetContribution, TaskDefinitionContribution,
    TerminalContribution, TerminalProfileContribution, ThemeContribution,
    ViewContainerContribution, ViewContribution,
};
pub use host::{
    ActivationRequest, CrashHandler, ExtensionHost, ExtensionHostKind, ExtensionHostManager,
    HostProtocol, HostState, HostSummary, NotificationHandler, PendingRequest, RequestHandler,
};
pub use installer::{install_from_marketplace, install_from_vsix, uninstall, update};
pub use manifest::{
    build_extension_descriptions, build_init_data, is_version_greater, parse_manifest,
    path_to_uri_path, read_node_manifest, read_wasm_manifest, sanitize_ext_id,
    ExtensionContributes, ExtensionDescription, ExtensionHostInitData, ExtensionIdentifier,
    ExtensionKind, ExtensionManifest, UriComponents,
};
pub use marketplace::{
    current_target_platform, ExtensionCategory, ExtensionVersion, MarketplaceClient,
    MarketplaceExtension, PublisherInfo, SearchFilters, SearchResult, SortOrder,
};
pub use paths::{
    global_storage_dir, resolve_node_runtime, sidex_data_dir, user_data_dir, user_extensions_dir,
    NodeRuntime,
};
pub use protocol::{
    CodeActionContext, CompletionContext, ConfigurationTarget, DecorationData, DecorationRange,
    DocumentSelector, DocumentUri, ExtHostToMain,
    ExtensionDescription as ProtoExtensionDescription,
    ExtensionIdentifier as ProtoExtensionIdentifier, FormattingOptions, Handle, HostEnvironment,
    InputBoxOptions as ProtoInputBoxOptions, MainToExtHost, MessageSeverity,
    OpenDialogOptions as ProtoOpenDialogOptions, Position, ProgressOptions as ProtoProgressOptions,
    ProviderMetadata, QuickPickItem, QuickPickOptions as ProtoQuickPickOptions, Range,
    ReferenceContext, ResponseError, RevealType, RpcError, RpcMessage,
    SaveDialogOptions as ProtoSaveDialogOptions, Selection, SignatureHelpContext,
    StatusBarAlignment as ProtoStatusBarAlignment, TextEdit, TreeItem as ProtoTreeItem,
    ViewColumn as ProtoViewColumn, WebviewOptions, WorkspaceEdit,
};
pub use registry::{read_vsix_manifest, ExtensionRegistry, VsixManifest};
pub use tree_view::{
    CollapsibleState, ExtensionTreeView, TreeItem, TreeItemCommand, TreeItemIcon, TreeViewEvent,
    TreeViewRegistry, ViewContainer,
};
pub use vsix::{
    install_vsix as vsix_install, unpack_vsix, validate_vsix, InstalledExtension, VsixPackage,
};
pub use webview_host::{
    PortMapping, ViewColumn, WebviewHost, WebviewId, WebviewMessage,
    WebviewOptions as WebviewHostOptions, WebviewPanel, WebviewViewDescriptor, WebviewViewLocation,
};

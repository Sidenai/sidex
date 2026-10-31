//! Codicons as SVGs, served through a GPUI asset source.
//!
//! The codicon *font* can't be used: GPUI's macOS text system refuses fonts
//! without an `m` glyph (icon fonts have none). Zed draws SVGs for the same
//! reason, so this reads `@vscode/codicons` SVGs from the repo's
//! node_modules and layers them over gpui-kit's own assets.

use std::borrow::Cow;
use std::path::PathBuf;

use anyhow::Result;
use gpui_kit::*;

const PREFIX: &str = "codicons/";

pub struct Assets {
    kit: gpui_kit::assets::Assets,
    codicons_dir: PathBuf,
}

impl Assets {
    pub fn new() -> Self {
        let codicons_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../node_modules/@vscode/codicons/src/icons");
        Self {
            kit: gpui_kit::assets::Assets,
            codicons_dir,
        }
    }
}

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(name) = path.strip_prefix(PREFIX) {
            let file = self.codicons_dir.join(name);
            return Ok(std::fs::read(file).ok().map(Cow::Owned));
        }
        self.kit.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        self.kit.list(path)
    }
}

#[derive(Clone, Copy)]
pub struct Codicon(pub &'static str);

macro_rules! codicons {
    ($($name:ident = $file:literal),* $(,)?) => {
        impl Codicon { $(pub const $name: Codicon = Codicon($file);)* }
    };
}

codicons! {
    FILES = "files",
    SEARCH = "search",
    SOURCE_CONTROL = "source-control",
    DEBUG_ALT = "debug-alt",
    EXTENSIONS = "extensions",
    ACCOUNT = "account",
    SETTINGS_GEAR = "settings-gear",
    CHEVRON_RIGHT = "chevron-right",
    CHEVRON_DOWN = "chevron-down",
    FOLDER = "folder",
    FOLDER_OPENED = "folder-opened",
    FILE = "file",
    CLOSE = "close",
    ELLIPSIS = "ellipsis",
    SPLIT_HORIZONTAL = "split-horizontal",
    TERMINAL = "terminal",
    ADD = "add",
    TRASH = "trash",
    ERROR = "error",
    WARNING = "warning",
    INFO = "info",
    BELL_DOT = "bell-dot",
    GIT_BRANCH = "git-branch",
    BELL = "bell",
    SYNC = "sync",
    LAYOUT_SIDEBAR_LEFT = "layout-sidebar-left",
    LAYOUT_PANEL = "layout-panel",
    LAYOUT_SIDEBAR_RIGHT = "layout-sidebar-right",
    LAYOUT = "layout",
    ARROW_LEFT = "arrow-left",
    ARROW_RIGHT = "arrow-right",
    REMOTE = "remote",
    NEW_FILE = "new-file",
    NEW_FOLDER = "new-folder",
    REFRESH = "refresh",
    COLLAPSE_ALL = "collapse-all",
    CHEVRON_UP = "chevron-up",
    OUTPUT = "output",
    DEBUG_CONSOLE = "debug-console",
    PLUG = "plug",
    SCREEN_FULL = "screen-full",
    COMMENT_DISCUSSION = "comment-discussion",
    GIT_PULL_REQUEST = "git-pull-request",
    BEAKER = "beaker",
    REMOTE_EXPLORER = "remote-explorer",
}

impl Codicon {
    /// `size` is in design pixels and scaled by the user's zoom level.
    pub fn render(self, size: f32, color: Hsla) -> Div {
        let size = crate::vscode::z(size);
        div().flex_none().size(size).child(
            svg()
                .path(format!("{PREFIX}{}.svg", self.0))
                .size(size)
                .text_color(color),
        )
    }
}

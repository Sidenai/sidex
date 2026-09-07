//! Theme parsing and color management for `SideX`.
//!
//! Provides types for representing VS Code-compatible color themes, including
//! workbench UI colors, `TextMate` token colors, file/product icon themes,
//! built-in default themes, theme resolution with user customizations,
//! semantic token coloring, and an RGBA color type with hex parsing.

pub mod color;
pub mod default_themes;
pub mod icon_theme;
pub mod product_icons;
pub mod theme;
pub mod theme_resolver;
pub mod token_color;
pub mod workbench_colors;

pub use color::{blend_colors, color_to_hex, darken, hex_to_color, lighten, Color};
pub use default_themes::{dark_modern, hc_black, hc_light, light_modern, quiet_light};
pub use icon_theme::{FileIconTheme, IconInfo};
pub use product_icons::{ProductIcon, ProductIconTheme};
pub use theme::{Theme, ThemeKind};
pub use theme_resolver::{
    apply_theme, apply_theme_full, default_resolved_dark, default_resolved_light, ExtensionTheme,
    ResolvedTheme, SemanticTokenColorRule, ThemeRegistry, UiTheme,
};
pub use token_color::{FontStyle, ResolvedStyle, TokenColorMap, TokenColorRule};
pub use workbench_colors::WorkbenchColors;

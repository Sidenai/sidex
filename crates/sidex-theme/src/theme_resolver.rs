//! Theme resolution: merging a base theme with user customizations,
//! extension-contributed themes, and semantic token coloring.

use std::collections::HashMap;
use std::hash::BuildHasher;
use std::path::PathBuf;

use crate::color::Color;
use crate::theme::{Theme, ThemeKind};
use crate::token_color::{FontStyle, TokenColorRule};
use crate::workbench_colors::WorkbenchColors;

/// A theme contributed by an installed extension.
#[derive(Clone, Debug)]
pub struct ExtensionTheme {
    /// Unique identifier, e.g. `"dracula.dracula-theme"`.
    pub id: String,
    /// Human-readable label shown in the theme picker.
    pub label: String,
    /// Light, dark, or high-contrast base.
    pub ui_theme: UiTheme,
    /// Path to the JSON theme file inside the extension.
    pub path: PathBuf,
}

/// The base UI theme variant that an extension theme targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UiTheme {
    Light,
    Dark,
    HighContrast,
    HighContrastLight,
}

impl From<ThemeKind> for UiTheme {
    fn from(kind: ThemeKind) -> Self {
        match kind {
            ThemeKind::Light => UiTheme::Light,
            ThemeKind::Dark => UiTheme::Dark,
            ThemeKind::HighContrast => UiTheme::HighContrast,
            ThemeKind::HighContrastLight => UiTheme::HighContrastLight,
        }
    }
}

/// A semantic-token color rule mapping a semantic token type (and optional
/// modifiers) to a foreground color and font style.
#[derive(Clone, Debug)]
pub struct SemanticTokenColorRule {
    pub token_type: String,
    pub modifiers: Vec<String>,
    pub foreground: Option<Color>,
    pub font_style: Option<FontStyle>,
}

/// The fully resolved theme produced by merging a base theme with user
/// customizations and semantic token rules.
#[derive(Clone, Debug)]
pub struct ResolvedTheme {
    pub name: String,
    pub kind: ThemeKind,
    pub token_colors: Vec<TokenColorRule>,
    pub workbench_colors: HashMap<String, Color>,
    pub semantic_token_colors: HashMap<String, Color>,
}

/// Merge a base [`Theme`] with user color customizations (from
/// `workbench.colorCustomizations` and `editor.tokenColorCustomizations`)
/// to produce a final [`ResolvedTheme`].
pub fn apply_theme(
    theme: &Theme,
    customizations: &HashMap<String, String, impl BuildHasher>,
) -> ResolvedTheme {
    let mut wb_colors = workbench_to_map(&theme.workbench_colors);

    for (key, hex) in customizations {
        if let Ok(color) = Color::from_hex(hex) {
            wb_colors.insert(key.clone(), color);
        }
    }

    ResolvedTheme {
        name: theme.name.clone(),
        kind: theme.kind,
        token_colors: theme.token_colors.clone(),
        workbench_colors: wb_colors,
        semantic_token_colors: HashMap::new(),
    }
}

/// Merge a base [`Theme`] with user color customizations **and** semantic
/// token rules to produce a fully resolved theme.
pub fn apply_theme_full(
    theme: &Theme,
    customizations: &HashMap<String, String, impl BuildHasher>,
    semantic_rules: &[SemanticTokenColorRule],
) -> ResolvedTheme {
    let mut resolved = apply_theme(theme, customizations);

    for rule in semantic_rules {
        if let Some(fg) = rule.foreground {
            let key = if rule.modifiers.is_empty() {
                rule.token_type.clone()
            } else {
                format!("{}:{}", rule.token_type, rule.modifiers.join(","))
            };
            resolved.semantic_token_colors.insert(key, fg);
        }
    }

    resolved
}

/// Manages the set of available themes and handles instant switching.
pub struct ThemeRegistry {
    builtin: Vec<Theme>,
    extension_themes: Vec<ExtensionTheme>,
    active_theme_id: String,
    loaded_extension_themes: HashMap<String, Theme>,
}

impl ThemeRegistry {
    /// Create a registry pre-loaded with the four built-in themes.
    pub fn new() -> Self {
        let builtin = vec![
            crate::default_themes::dark_modern(),
            crate::default_themes::light_modern(),
            crate::default_themes::quiet_light(),
            crate::default_themes::hc_black(),
            crate::default_themes::hc_light(),
        ];
        let active_theme_id = builtin[0].name.clone();

        Self {
            builtin,
            extension_themes: Vec::new(),
            active_theme_id,
            loaded_extension_themes: HashMap::new(),
        }
    }

    /// Register a theme contributed by an extension.
    pub fn register_extension_theme(&mut self, ext_theme: ExtensionTheme) {
        self.extension_themes.push(ext_theme);
    }

    /// List all available theme names (builtin + extension).
    pub fn available_theme_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.builtin.iter().map(|t| t.name.as_str()).collect();
        for et in &self.extension_themes {
            names.push(&et.label);
        }
        names
    }

    /// Switch to a theme by name. Returns the new theme or `None` if not found.
    /// This is designed for instant switching — no restart required.
    pub fn switch_theme(&mut self, name: &str) -> Option<&Theme> {
        if let Some(t) = self.builtin.iter().find(|t| t.name == name) {
            t.name.clone_into(&mut self.active_theme_id);
            return Some(t);
        }

        if self.loaded_extension_themes.contains_key(name) {
            name.clone_into(&mut self.active_theme_id);
            return self.loaded_extension_themes.get(name);
        }

        if let Some(ext) = self.extension_themes.iter().find(|e| e.label == name) {
            let path = ext.path.clone();
            let id = ext.label.clone();
            if let Ok(contents) = std::fs::read_to_string(&path) {
                if let Ok(theme) = Theme::from_json(&contents) {
                    self.loaded_extension_themes.insert(id.clone(), theme);
                    self.active_theme_id.clone_from(&id);
                    return self.loaded_extension_themes.get(&id);
                }
            }
        }

        None
    }

    /// Get the currently active theme.
    pub fn active_theme(&self) -> Option<&Theme> {
        self.builtin
            .iter()
            .find(|t| t.name == self.active_theme_id)
            .or_else(|| self.loaded_extension_themes.get(&self.active_theme_id))
    }

    /// Get the name of the active theme.
    pub fn active_theme_name(&self) -> &str {
        &self.active_theme_id
    }
}

impl Default for ThemeRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn workbench_to_map(wb: &WorkbenchColors) -> HashMap<String, Color> {
    let json = serde_json::to_value(wb).unwrap_or_default();
    let mut map = HashMap::new();
    if let serde_json::Value::Object(obj) = json {
        for (key, val) in obj {
            if let Some(hex) = val.as_str() {
                if let Ok(color) = Color::from_hex(hex) {
                    map.insert(key, color);
                }
            }
        }
    }
    map
}

/// Convenience: resolve the default dark theme with no customizations.
pub fn default_resolved_dark() -> ResolvedTheme {
    apply_theme(&crate::default_themes::dark_modern(), &HashMap::new())
}

/// Convenience: resolve the default light theme with no customizations.
pub fn default_resolved_light() -> ResolvedTheme {
    apply_theme(&crate::default_themes::light_modern(), &HashMap::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_theme_with_no_customizations() {
        let theme = crate::default_themes::dark_modern();
        let resolved = apply_theme(&theme, &HashMap::new());
        assert_eq!(resolved.name, "Default Dark Modern");
        assert_eq!(resolved.kind, ThemeKind::Dark);
        assert!(!resolved.token_colors.is_empty());
        assert!(!resolved.workbench_colors.is_empty());
    }

    #[test]
    fn apply_theme_with_customizations() {
        let theme = crate::default_themes::dark_modern();
        let mut customs = HashMap::new();
        customs.insert("editorBackground".to_owned(), "#FF0000".to_owned());
        let resolved = apply_theme(&theme, &customs);
        assert_eq!(
            resolved.workbench_colors.get("editorBackground"),
            Some(&Color::from_hex("#FF0000").unwrap())
        );
    }

    #[test]
    fn apply_theme_full_with_semantic_rules() {
        let theme = crate::default_themes::dark_modern();
        let rules = vec![SemanticTokenColorRule {
            token_type: "function".to_owned(),
            modifiers: vec!["declaration".to_owned()],
            foreground: Some(Color::from_hex("#AABBCC").unwrap()),
            font_style: Some(FontStyle::BOLD),
        }];
        let resolved = apply_theme_full(&theme, &HashMap::new(), &rules);
        assert!(resolved
            .semantic_token_colors
            .contains_key("function:declaration"));
    }

    #[test]
    fn theme_registry_builtin_themes() {
        let reg = ThemeRegistry::new();
        let names = reg.available_theme_names();
        assert!(names.contains(&"Default Dark Modern"));
        assert!(names.contains(&"Default Light Modern"));
        assert!(names.contains(&"Default High Contrast"));
        assert!(names.contains(&"Default High Contrast Light"));
    }

    #[test]
    fn theme_registry_switch() {
        let mut reg = ThemeRegistry::new();
        let theme = reg.switch_theme("Default Light Modern").unwrap();
        assert_eq!(theme.kind, ThemeKind::Light);
        assert_eq!(reg.active_theme_name(), "Default Light Modern");
    }

    #[test]
    fn theme_registry_switch_nonexistent() {
        let mut reg = ThemeRegistry::new();
        assert!(reg.switch_theme("Nonexistent Theme").is_none());
    }

    #[test]
    fn theme_registry_active() {
        let reg = ThemeRegistry::new();
        let active = reg.active_theme().unwrap();
        assert_eq!(active.name, "Default Dark Modern");
    }

    #[test]
    fn ui_theme_from_theme_kind() {
        assert_eq!(UiTheme::from(ThemeKind::Dark), UiTheme::Dark);
        assert_eq!(UiTheme::from(ThemeKind::Light), UiTheme::Light);
        assert_eq!(
            UiTheme::from(ThemeKind::HighContrast),
            UiTheme::HighContrast
        );
    }

    #[test]
    fn default_resolved_dark_works() {
        let r = default_resolved_dark();
        assert_eq!(r.kind, ThemeKind::Dark);
    }

    #[test]
    fn default_resolved_light_works() {
        let r = default_resolved_light();
        assert_eq!(r.kind, ThemeKind::Light);
    }
}

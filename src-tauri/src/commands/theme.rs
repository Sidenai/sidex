use std::collections::HashMap;

use serde::Serialize;
use sidex_theme::theme::{Theme, ThemeKind};
use sidex_theme::theme_resolver::{ThemeRegistry, UiTheme};
use sidex_theme::token_color::FontStyle;

#[derive(Serialize)]
pub struct ThemeInfo {
    id: String,
    label: String,
    ui_theme: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeData {
    workbench_colors: HashMap<String, String>,
    token_colors: Vec<TokenColorRule>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenColorRule {
    scope: Vec<String>,
    settings: TokenColorSettings,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenColorSettings {
    foreground: Option<String>,
    font_style: Option<String>,
}

fn ui_theme_str(ui: UiTheme) -> &'static str {
    match ui {
        UiTheme::Dark => "vs-dark",
        UiTheme::Light => "vs",
        UiTheme::HighContrast => "hc-black",
        UiTheme::HighContrastLight => "hc-light",
    }
}

fn theme_kind_to_ui_str(kind: ThemeKind) -> &'static str {
    ui_theme_str(UiTheme::from(kind))
}

fn font_style_str(fs: FontStyle) -> Option<String> {
    if fs.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    if fs.contains(FontStyle::BOLD) {
        parts.push("bold");
    }
    if fs.contains(FontStyle::ITALIC) {
        parts.push("italic");
    }
    if fs.contains(FontStyle::UNDERLINE) {
        parts.push("underline");
    }
    if fs.contains(FontStyle::STRIKETHROUGH) {
        parts.push("strikethrough");
    }
    Some(parts.join(" "))
}

fn camel_to_vscode_key(key: &str) -> &'static str {
    match key {
        "editorBackground" => "editor.background",
        "editorForeground" => "editor.foreground",
        "editorLineHighlightBackground" => "editor.lineHighlightBackground",
        "editorSelectionBackground" => "editor.selectionBackground",
        "editorLineNumberForeground" => "editorLineNumber.foreground",
        "editorLineNumberActiveForeground" => "editorLineNumber.activeForeground",
        "editorCursorForeground" => "editorCursor.foreground",
        "editorWhitespaceForeground" => "editorWhitespace.foreground",
        "editorIndentGuideBackground" => "editorIndentGuide.background",
        "editorIndentGuideActiveBackground" => "editorIndentGuide.activeBackground",
        "editorRulerForeground" => "editorRuler.foreground",

        "activityBarBackground" => "activityBar.background",
        "activityBarForeground" => "activityBar.foreground",
        "activityBarInactiveForeground" => "activityBar.inactiveForeground",
        "activityBarBorder" => "activityBar.border",
        "activityBarActiveBorder" => "activityBar.activeBorder",
        "activityBarActiveBackground" => "activityBar.activeBackground",
        "activityBarBadgeBackground" => "activityBarBadge.background",
        "activityBarBadgeForeground" => "activityBarBadge.foreground",

        "sideBarBackground" => "sideBar.background",
        "sideBarForeground" => "sideBar.foreground",
        "sideBarBorder" => "sideBar.border",
        "sideBarTitleForeground" => "sideBarTitle.foreground",
        "sideBarSectionHeaderBackground" => "sideBarSectionHeader.background",
        "sideBarSectionHeaderForeground" => "sideBarSectionHeader.foreground",
        "sideBarSectionHeaderBorder" => "sideBarSectionHeader.border",

        "statusBarBackground" => "statusBar.background",
        "statusBarForeground" => "statusBar.foreground",
        "statusBarBorder" => "statusBar.border",
        "statusBarDebuggingBackground" => "statusBar.debuggingBackground",
        "statusBarDebuggingForeground" => "statusBar.debuggingForeground",
        "statusBarNoFolderBackground" => "statusBar.noFolderBackground",
        "statusBarNoFolderForeground" => "statusBar.noFolderForeground",

        "editorGroupBorder" => "editorGroup.border",
        "editorGroupHeaderTabsBackground" => "editorGroupHeader.tabsBackground",
        "editorGroupHeaderTabsBorder" => "editorGroupHeader.tabsBorder",
        "editorGroupHeaderNoTabsBackground" => "editorGroupHeader.noTabsBackground",
        "editorPaneBackground" => "editorPane.background",
        "tabActiveBackground" => "tab.activeBackground",
        "tabActiveForeground" => "tab.activeForeground",
        "tabInactiveBackground" => "tab.inactiveBackground",
        "tabInactiveForeground" => "tab.inactiveForeground",
        "tabBorder" => "tab.border",
        "tabActiveBorder" => "tab.activeBorder",
        "tabActiveBorderTop" => "tab.activeBorderTop",
        "tabHoverBackground" => "tab.hoverBackground",

        "panelBackground" => "panel.background",
        "panelForeground" => "panel.foreground",
        "panelBorder" => "panel.border",
        "panelTitleActiveForeground" => "panelTitle.activeForeground",
        "panelTitleActiveBorder" => "panelTitle.activeBorder",
        "panelTitleInactiveForeground" => "panelTitle.inactiveForeground",

        "listHoverBackground" => "list.hoverBackground",
        "listHoverForeground" => "list.hoverForeground",
        "listActiveSelectionBackground" => "list.activeSelectionBackground",
        "listActiveSelectionForeground" => "list.activeSelectionForeground",
        "listInactiveSelectionBackground" => "list.inactiveSelectionBackground",
        "listInactiveSelectionForeground" => "list.inactiveSelectionForeground",
        "listHighlightForeground" => "list.highlightForeground",

        "inputBackground" => "input.background",
        "inputForeground" => "input.foreground",
        "inputBorder" => "input.border",
        "inputPlaceholderForeground" => "input.placeholderForeground",
        "inputOptionActiveBackground" => "inputOption.activeBackground",
        "inputOptionActiveBorder" => "inputOption.activeBorder",
        "inputOptionActiveForeground" => "inputOption.activeForeground",

        "dropdownBackground" => "dropdown.background",
        "dropdownForeground" => "dropdown.foreground",
        "dropdownBorder" => "dropdown.border",
        "buttonBackground" => "button.background",
        "buttonForeground" => "button.foreground",
        "buttonHoverBackground" => "button.hoverBackground",
        "buttonBorder" => "button.border",

        "badgeBackground" => "badge.background",
        "badgeForeground" => "badge.foreground",
        "progressBarBackground" => "progressBar.background",

        "titleBarActiveBackground" => "titleBar.activeBackground",
        "titleBarActiveForeground" => "titleBar.activeForeground",
        "titleBarInactiveBackground" => "titleBar.inactiveBackground",
        "titleBarInactiveForeground" => "titleBar.inactiveForeground",
        "titleBarBorder" => "titleBar.border",

        "editorFindMatchBackground" => "editor.findMatchBackground",
        "editorFindMatchHighlightBackground" => "editor.findMatchHighlightBackground",
        "peekViewBorder" => "peekView.border",
        "peekViewEditorBackground" => "peekViewEditor.background",
        "peekViewEditorMatchHighlightBackground" => "peekViewEditor.matchHighlightBackground",
        "peekViewResultBackground" => "peekViewResult.background",
        "peekViewResultMatchHighlightBackground" => "peekViewResult.matchHighlightBackground",
        "peekViewTitleBackground" => "peekViewTitle.background",

        "minimapSelectionHighlight" => "minimap.selectionHighlight",
        "welcomePageTileBackground" => "welcomePage.tileBackground",
        "selectionBackground" => "selection.background",

        "notificationBackground" => "notifications.background",
        "notificationForeground" => "notifications.foreground",
        "notificationBorder" => "notifications.border",
        "notificationLinkForeground" => "notificationLink.foreground",

        _ => "",
    }
}

fn workbench_colors_to_map(wb: &sidex_theme::WorkbenchColors) -> HashMap<String, String> {
    let json = serde_json::to_value(wb).unwrap_or_default();
    let mut map = HashMap::new();
    if let serde_json::Value::Object(obj) = json {
        for (key, val) in obj {
            if let Some(hex) = val.as_str() {
                let vscode_key = camel_to_vscode_key(&key);
                if !vscode_key.is_empty() {
                    map.insert(vscode_key.to_owned(), hex.to_owned());
                }
                map.insert(key, hex.to_owned());
            }
        }
    }
    map
}

fn convert_token_rule(rule: &sidex_theme::TokenColorRule) -> TokenColorRule {
    TokenColorRule {
        scope: rule.scope.clone(),
        settings: TokenColorSettings {
            foreground: rule.foreground.map(sidex_theme::Color::to_hex),
            font_style: font_style_str(rule.font_style),
        },
    }
}

fn theme_to_data(theme: &Theme) -> ThemeData {
    ThemeData {
        workbench_colors: workbench_colors_to_map(&theme.workbench_colors),
        token_colors: theme.token_colors.iter().map(convert_token_rule).collect(),
    }
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn theme_list() -> Result<Vec<ThemeInfo>, String> {
    let registry = ThemeRegistry::new();

    let mut infos: Vec<ThemeInfo> = registry
        .available_theme_names()
        .into_iter()
        .map(|name| {
            let kind = match name {
                "Default Light Modern" | "Quiet Light" => ThemeKind::Light,
                "Default High Contrast" => ThemeKind::HighContrast,
                "Default High Contrast Light" => ThemeKind::HighContrastLight,
                _ => ThemeKind::Dark,
            };
            ThemeInfo {
                id: name.to_lowercase().replace(' ', "-"),
                label: name.to_owned(),
                ui_theme: theme_kind_to_ui_str(kind).to_owned(),
            }
        })
        .collect();

    infos.sort_by_key(|a| a.label.clone());
    Ok(infos)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn theme_get(id: String) -> Result<ThemeData, String> {
    let mut registry = ThemeRegistry::new();

    let id_trimmed = id
        .trim_start_matches("vs-dark ")
        .trim_start_matches("vs ")
        .trim_start_matches("hc-black ")
        .trim_start_matches("hc-light ")
        .trim_start_matches("sidex-builtin-");
    let label = id_trimmed.replace('-', " ").to_lowercase();

    let theme = registry
        .available_theme_names()
        .into_iter()
        .find(|n| {
            *n == id
                || n.eq_ignore_ascii_case(&id)
                || n.to_lowercase() == label
                || n.to_lowercase().replace(' ', "-") == id.to_lowercase()
        })
        .map(std::borrow::ToOwned::to_owned);

    let Some(name) = theme else {
        return Err(format!("theme not found: {id}"));
    };

    let theme = registry
        .switch_theme(&name)
        .ok_or_else(|| format!("failed to load theme: {name}"))?;

    Ok(theme_to_data(theme))
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn theme_get_default_dark() -> Result<ThemeData, String> {
    Ok(theme_to_data(&Theme::default_dark()))
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn theme_get_default_light() -> Result<ThemeData, String> {
    Ok(theme_to_data(&Theme::default_light()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_theme_list_includes_quiet_light() {
        let list = theme_list().expect("theme_list should succeed");
        let ql = list.into_iter().find(|t| t.label == "Quiet Light");
        assert!(ql.is_some(), "Quiet Light should be in theme_list");
        let ql = ql.unwrap();
        assert_eq!(ql.id, "quiet-light");
        assert_eq!(ql.ui_theme, "vs");
    }

    #[test]
    fn test_theme_get_by_various_ids() {
        let data_by_name = theme_get("Quiet Light".to_string()).expect("should find by display name");
        assert!(!data_by_name.workbench_colors.is_empty());
        assert!(!data_by_name.token_colors.is_empty());
        assert_eq!(
            data_by_name.workbench_colors.get("editor.background"),
            Some(&"#f5f5f5".to_string())
        );

        let data_by_slug = theme_get("quiet-light".to_string()).expect("should find by slug id");
        assert_eq!(
            data_by_slug.workbench_colors.get("editor.background"),
            Some(&"#f5f5f5".to_string())
        );

        let data_by_builtin =
            theme_get("sidex-builtin-quiet-light".to_string()).expect("should find by sidex-builtin id");
        assert_eq!(
            data_by_builtin.workbench_colors.get("editor.background"),
            Some(&"#f5f5f5".to_string())
        );
    }

    #[test]
    fn test_workbench_colors_mapping_quiet_light() {
        let theme = sidex_theme::default_themes::quiet_light();
        let map = workbench_colors_to_map(&theme.workbench_colors);

        assert_eq!(map.get("editor.background"), Some(&"#f5f5f5".to_string()));
        assert_eq!(map.get("editor.foreground"), Some(&"#333333".to_string()));
        assert_eq!(map.get("activityBar.background"), Some(&"#ededf5".to_string()));
        assert_eq!(map.get("statusBar.background"), Some(&"#705697".to_string()));
        assert_eq!(map.get("selection.background"), Some(&"#c9d0d9".to_string()));
        assert_eq!(map.get("errorForeground"), Some(&"#f1897f".to_string()));
    }
}

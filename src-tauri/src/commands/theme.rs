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
pub struct ThemeData {
    workbench_colors: HashMap<String, String>,
    token_colors: Vec<TokenColorRule>,
}

#[derive(Serialize)]
pub struct TokenColorRule {
    scope: Vec<String>,
    settings: TokenColorSettings,
}

#[derive(Serialize)]
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

fn workbench_colors_to_map(wb: &sidex_theme::WorkbenchColors) -> HashMap<String, String> {
    let json = serde_json::to_value(wb).unwrap_or_default();
    let mut map = HashMap::new();
    if let serde_json::Value::Object(obj) = json {
        for (key, val) in obj {
            if let Some(hex) = val.as_str() {
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
                "Default Light Modern" => ThemeKind::Light,
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

    let label = id.replace('-', " ");

    let theme = registry
        .available_theme_names()
        .into_iter()
        .find(|n| n.to_lowercase() == label)
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

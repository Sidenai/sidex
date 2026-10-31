//! Workbench colours from the user's active VSCode colour theme.
//!
//! Keys are VSCode's own (`activityBar.background`, ...). Where a theme
//! leaves a key unset, the fallback follows VSCode's registered default
//! (usually another key), ending in Dark Modern's value.

use std::sync::OnceLock;

use gpui_kit::{rgba, Hsla};

use crate::vscode;

pub struct Colors {
    pub frame: Hsla,
    pub editor: Hsla,
    pub editor_fg: Hsla,
    pub foreground: Hsla,
    pub description: Hsla,
    pub icon: Hsla,
    pub focus_border: Hsla,

    pub title_bar: Hsla,
    pub title_bar_fg: Hsla,
    pub title_bar_border: Hsla,
    pub command_center: Hsla,
    pub command_center_fg: Hsla,
    pub command_center_border: Hsla,

    pub activity_bar: Hsla,
    pub activity_bar_fg: Hsla,
    pub activity_bar_inactive_fg: Hsla,
    pub activity_bar_active_border: Hsla,
    pub badge: Hsla,
    pub badge_fg: Hsla,

    pub side_bar: Hsla,
    pub side_bar_fg: Hsla,
    pub side_bar_title_fg: Hsla,
    pub section_header: Hsla,
    pub section_header_fg: Hsla,
    pub section_header_border: Hsla,

    pub list_hover: Hsla,
    pub list_active_selection: Hsla,
    pub list_active_selection_fg: Hsla,
    pub indent_guide: Hsla,
    pub ignored_fg: Hsla,

    pub tabs_bar: Hsla,
    pub tab_active: Hsla,
    pub tab_active_fg: Hsla,
    pub tab_inactive: Hsla,
    pub tab_inactive_fg: Hsla,
    pub tab_border: Hsla,
    pub tab_active_border: Option<Hsla>,
    pub tab_active_border_top: Option<Hsla>,
    pub breadcrumb_fg: Hsla,

    pub line_number: Hsla,
    pub line_number_active: Hsla,
    pub line_highlight: Hsla,
    pub selection: Hsla,
    pub cursor: Hsla,
    pub gutter: Hsla,
    pub scrollbar: Hsla,
    pub scrollbar_hover: Hsla,

    pub panel: Hsla,
    pub panel_border: Hsla,
    pub panel_title_active_fg: Hsla,
    pub panel_title_inactive_fg: Hsla,
    pub panel_title_active_border: Hsla,

    pub status_bar: Hsla,
    pub status_bar_fg: Hsla,
    pub status_bar_border: Hsla,
    pub remote: Hsla,
    pub remote_fg: Hsla,

    pub quick_input: Hsla,
    pub quick_input_fg: Hsla,
    pub quick_input_focus: Hsla,
    pub quick_input_focus_fg: Hsla,
    pub widget_border: Hsla,
    pub terminal_selection: Hsla,

    pub notification: Hsla,
    pub notification_fg: Hsla,
    pub notification_border: Hsla,
    pub notification_info: Hsla,
    pub notification_warning: Hsla,
    pub notification_error: Hsla,

    pub terminal: Hsla,
    pub terminal_fg: Hsla,
    pub terminal_cursor: Hsla,
    /// Text drawn on top of a block cursor (VSCode's `terminalCursor.background`).
    pub terminal_cursor_text: Hsla,
    pub ansi: [Hsla; 16],
}

/// Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
pub fn parse_hex(s: &str) -> Option<Hsla> {
    let h = s.strip_prefix('#')?;
    let expand = |s: &str| s.chars().flat_map(|c| [c, c]).collect::<String>();
    let full = match h.len() {
        3 => expand(h) + "ff",
        4 => expand(h),
        6 => format!("{h}ff"),
        8 => h.to_owned(),
        _ => return None,
    };
    u32::from_str_radix(&full, 16).ok().map(|v| rgba(v).into())
}

static COLORS: OnceLock<Colors> = OnceLock::new();

pub fn colors() -> &'static Colors {
    COLORS.get_or_init(build)
}

fn build() -> Colors {
    let map = &vscode::get().colors;
    let get = |k: &str| map.get(k).and_then(|v| v.as_str()).and_then(parse_hex);
    // First key present wins; the last element is a hex default.
    let pick = |keys: &[&str], default: &str| {
        keys.iter()
            .find_map(|k| get(k))
            .unwrap_or_else(|| parse_hex(default).expect("valid default"))
    };

    let editor = pick(&["editor.background"], "#1f1f1f");
    let foreground = pick(&["foreground"], "#cccccc");
    let activity_bar_fg = pick(&["activityBar.foreground"], "#d7d7d7");
    let panel = pick(&["panel.background"], "#181818");

    let ansi_names = [
        "Black",
        "Red",
        "Green",
        "Yellow",
        "Blue",
        "Magenta",
        "Cyan",
        "White",
        "BrightBlack",
        "BrightRed",
        "BrightGreen",
        "BrightYellow",
        "BrightBlue",
        "BrightMagenta",
        "BrightCyan",
        "BrightWhite",
    ];
    let ansi_defaults = [
        "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
        "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
    ];
    let ansi = std::array::from_fn(|i| {
        pick(
            &[&format!("terminal.ansi{}", ansi_names[i])],
            ansi_defaults[i],
        )
    });

    Colors {
        frame: pick(
            &["activityBar.background", "titleBar.activeBackground"],
            "#181818",
        ),
        editor,
        editor_fg: pick(&["editor.foreground", "foreground"], "#cccccc"),
        foreground,
        description: pick(&["descriptionForeground"], "#9d9d9d"),
        icon: pick(&["icon.foreground", "foreground"], "#cccccc"),
        focus_border: pick(&["focusBorder"], "#0078d4"),

        title_bar: pick(&["titleBar.activeBackground"], "#181818"),
        title_bar_fg: pick(&["titleBar.activeForeground"], "#cccccc"),
        title_bar_border: pick(&["titleBar.border"], "#2b2b2b"),
        command_center: pick(&["commandCenter.background"], "#2b2b2b"),
        command_center_fg: pick(
            &["commandCenter.foreground", "titleBar.activeForeground"],
            "#cccccc",
        ),
        command_center_border: pick(&["commandCenter.border"], "#3c3c3c"),

        activity_bar: pick(&["activityBar.background"], "#181818"),
        activity_bar_fg,
        activity_bar_inactive_fg: pick(&["activityBar.inactiveForeground"], "#868686"),
        activity_bar_active_border: pick(
            &[
                "activityBar.activeBorder",
                "activityBar.activeFocusBorder",
                "activityBar.foreground",
            ],
            "#0078d4",
        ),
        badge: pick(&["activityBarBadge.background"], "#0078d4"),
        badge_fg: pick(&["activityBarBadge.foreground"], "#ffffff"),

        side_bar: pick(&["sideBar.background"], "#181818"),
        side_bar_fg: pick(&["sideBar.foreground", "foreground"], "#cccccc"),
        side_bar_title_fg: pick(
            &["sideBarTitle.foreground", "sideBar.foreground"],
            "#cccccc",
        ),
        section_header: pick(
            &["sideBarSectionHeader.background", "sideBar.background"],
            "#181818",
        ),
        section_header_fg: pick(
            &["sideBarSectionHeader.foreground", "sideBar.foreground"],
            "#cccccc",
        ),
        section_header_border: pick(
            &["sideBarSectionHeader.border", "sideBar.border"],
            "#2b2b2b",
        ),

        list_hover: pick(&["list.hoverBackground"], "#2a2d2e"),
        list_active_selection: pick(&["list.activeSelectionBackground"], "#04395e"),
        list_active_selection_fg: pick(
            &["list.activeSelectionForeground", "sideBar.foreground"],
            "#ffffff",
        ),
        indent_guide: pick(&["tree.indentGuidesStroke"], "#585858"),
        ignored_fg: pick(&["gitDecoration.ignoredResourceForeground"], "#8c8c8c"),

        tabs_bar: pick(&["editorGroupHeader.tabsBackground"], "#181818"),
        tab_active: pick(&["tab.activeBackground", "editor.background"], "#1f1f1f"),
        tab_active_fg: pick(&["tab.activeForeground"], "#ffffff"),
        tab_inactive: pick(
            &["tab.inactiveBackground", "editorGroupHeader.tabsBackground"],
            "#181818",
        ),
        tab_inactive_fg: pick(&["tab.inactiveForeground"], "#9d9d9d"),
        tab_border: pick(&["tab.border"], "#2b2b2b"),
        tab_active_border: get("tab.activeBorder"),
        tab_active_border_top: get("tab.activeBorderTop"),
        breadcrumb_fg: pick(&["breadcrumb.foreground"], "#a9a9a9"),

        line_number: pick(&["editorLineNumber.foreground"], "#6e7681"),
        line_number_active: pick(&["editorLineNumber.activeForeground"], "#cccccc"),
        line_highlight: pick(&["editor.lineHighlightBackground"], "#ffffff0a"),
        selection: pick(&["editor.selectionBackground"], "#264f78"),
        cursor: pick(&["editorCursor.foreground"], "#aeafad"),
        gutter: pick(&["editorGutter.background", "editor.background"], "#1f1f1f"),
        scrollbar: pick(&["scrollbarSlider.background"], "#79797966"),
        scrollbar_hover: pick(&["scrollbarSlider.hoverBackground"], "#646464b3"),

        panel,
        panel_border: pick(&["panel.border"], "#2b2b2b"),
        panel_title_active_fg: pick(&["panelTitle.activeForeground"], "#cccccc"),
        panel_title_inactive_fg: pick(&["panelTitle.inactiveForeground"], "#9d9d9d"),
        panel_title_active_border: pick(&["panelTitle.activeBorder"], "#0078d4"),

        status_bar: pick(&["statusBar.background"], "#181818"),
        status_bar_fg: pick(&["statusBar.foreground"], "#cccccc"),
        status_bar_border: pick(&["statusBar.border"], "#2b2b2b"),
        remote: pick(&["statusBarItem.remoteBackground"], "#0078d4"),
        remote_fg: pick(&["statusBarItem.remoteForeground"], "#ffffff"),

        quick_input: pick(
            &[
                "quickInput.background",
                "editorWidget.background",
                "sideBar.background",
            ],
            "#222222",
        ),
        quick_input_fg: pick(
            &[
                "quickInput.foreground",
                "editorWidget.foreground",
                "foreground",
            ],
            "#cccccc",
        ),
        quick_input_focus: pick(
            &[
                "quickInputList.focusBackground",
                "list.activeSelectionBackground",
            ],
            "#04395e",
        ),
        quick_input_focus_fg: pick(
            &[
                "quickInputList.focusForeground",
                "list.activeSelectionForeground",
                "foreground",
            ],
            "#ffffff",
        ),
        widget_border: pick(
            &["widget.border", "editorWidget.border", "panel.border"],
            "#313131",
        ),
        terminal_selection: pick(
            &["terminal.selectionBackground", "editor.selectionBackground"],
            "#264f78",
        ),
        notification: pick(
            &["notifications.background", "editorWidget.background"],
            "#1f1f1f",
        ),
        notification_fg: pick(
            &[
                "notifications.foreground",
                "editorWidget.foreground",
                "foreground",
            ],
            "#cccccc",
        ),
        notification_border: pick(
            &[
                "notificationToast.border",
                "widget.border",
                "editorWidget.border",
            ],
            "#2b2b2b",
        ),
        notification_info: pick(
            &["notificationsInfoIcon.foreground", "editorInfo.foreground"],
            "#3794ff",
        ),
        notification_warning: pick(
            &[
                "notificationsWarningIcon.foreground",
                "editorWarning.foreground",
            ],
            "#cca700",
        ),
        notification_error: pick(
            &[
                "notificationsErrorIcon.foreground",
                "editorError.foreground",
            ],
            "#f14c4c",
        ),
        terminal: pick(&["terminal.background", "panel.background"], "#181818"),
        terminal_fg: pick(&["terminal.foreground"], "#cccccc"),
        terminal_cursor: pick(
            &["terminalCursor.foreground", "terminal.foreground"],
            "#cccccc",
        ),
        terminal_cursor_text: pick(
            &[
                "terminalCursor.background",
                "terminal.background",
                "panel.background",
            ],
            "#181818",
        ),
        ansi,
    }
}

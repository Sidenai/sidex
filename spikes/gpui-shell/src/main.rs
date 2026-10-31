//! THROWAWAY SPIKE: SideX shell in GPUI, drawn to look like VSCode.
//!
//! Reads the user's VSCode colour theme, icon theme, fonts and zoom level so
//! the result can be compared side by side with real VSCode. Backed by the
//! existing `sidex-*` crates in-process; no Tauri, no webview, no JS.

mod editor_panel;
mod file_icons;
mod files_panel;
mod highlighter;
mod icons;
mod quick_open;
mod terminal_element;
mod terminal_keys;
mod terminal_panel;
mod theme;
mod vscode;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::component::resizable::{h_resizable, resizable_panel, v_resizable, ResizableState};
use gpui_kit::component::theme::{Theme, ThemeMode};
use gpui_kit::*;

use editor_panel::EditorPanel;
use files_panel::{FilesEvent, FilesPanel};
use icons::Codicon;
use quick_open::{PaletteCommand, QuickOpen, QuickOpenEvent};
use terminal_panel::TerminalPanel;
use vscode::z;

actions!(
    sidex,
    [
        Save,
        CloseTab,
        NextTab,
        PrevTab,
        QuickOpenFiles,
        ShowCommands,
        ToggleSidebar,
        TogglePanel,
        FocusTerminal,
        Quit,
    ]
);

fn key_bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("cmd-s", Save, None),
        KeyBinding::new("cmd-w", CloseTab, None),
        KeyBinding::new("ctrl-tab", NextTab, None),
        KeyBinding::new("ctrl-shift-tab", PrevTab, None),
        KeyBinding::new("cmd-p", QuickOpenFiles, None),
        KeyBinding::new("cmd-shift-p", ShowCommands, None),
        KeyBinding::new("cmd-b", ToggleSidebar, None),
        KeyBinding::new("cmd-j", TogglePanel, None),
        KeyBinding::new("ctrl-`", FocusTerminal, None),
        KeyBinding::new("cmd-q", Quit, None),
    ]
}

static COMMANDS: &[PaletteCommand] = &[
    PaletteCommand {
        label: "File: Save",
        keys: "⌘S",
        action: || Box::new(Save),
    },
    PaletteCommand {
        label: "View: Close Editor",
        keys: "⌘W",
        action: || Box::new(CloseTab),
    },
    PaletteCommand {
        label: "View: Open Next Editor",
        keys: "⌃Tab",
        action: || Box::new(NextTab),
    },
    PaletteCommand {
        label: "View: Open Previous Editor",
        keys: "⌃⇧Tab",
        action: || Box::new(PrevTab),
    },
    PaletteCommand {
        label: "Go to File...",
        keys: "⌘P",
        action: || Box::new(QuickOpenFiles),
    },
    PaletteCommand {
        label: "View: Toggle Primary Side Bar Visibility",
        keys: "⌘B",
        action: || Box::new(ToggleSidebar),
    },
    PaletteCommand {
        label: "View: Toggle Panel Visibility",
        keys: "⌘J",
        action: || Box::new(TogglePanel),
    },
    PaletteCommand {
        label: "Terminal: Focus Terminal",
        keys: "⌃`",
        action: || Box::new(FocusTerminal),
    },
    PaletteCommand {
        label: "Quit",
        keys: "⌘Q",
        action: || Box::new(Quit),
    },
];

const TITLE_BAR_H: f32 = 35.;
const ACTIVITY_BAR_W: f32 = 48.;
const STATUS_BAR_H: f32 = 22.;
/// Gap and corner radius of the floating panes (VSCode's 2025+ layout).
const PANE_GAP: f32 = 3.;
const PANE_RADIUS: f32 = 6.;

struct Workspace {
    focus_handle: FocusHandle,
    root: PathBuf,
    quick_open: Entity<QuickOpen>,
    quick_open_visible: bool,
    sidebar_visible: bool,
    panel_visible: bool,
    files: Entity<FilesPanel>,
    editor: Entity<EditorPanel>,
    terminal: Entity<TerminalPanel>,
    h_state: Entity<ResizableState>,
    v_state: Entity<ResizableState>,
    branch: SharedString,
    _subscriptions: Vec<Subscription>,
}

/// A rounded, bordered pane floating on the window frame colour.
pub fn pane(bg: Hsla, child: impl IntoElement) -> Div {
    let c = theme::colors();
    div().size_full().p(z(PANE_GAP)).child(
        div()
            .size_full()
            .overflow_hidden()
            .rounded(z(PANE_RADIUS))
            .border_1()
            .border_color(c.panel_border)
            .bg(bg)
            .child(child),
    )
}

impl Workspace {
    fn new(root: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let files = cx.new(|cx| FilesPanel::new(root.clone(), cx));
        let editor = cx.new(|cx| EditorPanel::new(root.clone(), window, cx));
        let terminal = cx.new(|cx| TerminalPanel::new(root.clone(), window, cx));

        let quick_open = cx.new(|cx| QuickOpen::new(root.clone(), COMMANDS, window, cx));

        let subscriptions =
            vec![
                cx.subscribe_in(&files, window, |this, _, event: &FilesEvent, window, cx| {
                    match event {
                        FilesEvent::OpenFile(path) => this.open_file(path.clone(), window, cx),
                        FilesEvent::FsChanged(events) => {
                            this.quick_open.read(cx).apply_fs_events(events);
                        }
                    }
                }),
                cx.subscribe_in(
                    &quick_open,
                    window,
                    |this, _, event: &QuickOpenEvent, window, cx| {
                        this.quick_open_visible = false;
                        match event {
                            QuickOpenEvent::Open(path) => this.open_file(path.clone(), window, cx),
                            QuickOpenEvent::Dismiss => this.restore_focus(window, cx),
                        }
                        cx.notify();
                    },
                ),
                // Status bar shows the editor's live cursor position.
                cx.observe(&editor, |_, _, cx| cx.notify()),
            ];

        let focus_handle = cx.focus_handle();
        focus_handle.focus(window, cx);
        Self {
            focus_handle,
            quick_open,
            quick_open_visible: false,
            sidebar_visible: true,
            panel_visible: true,
            branch: git_branch(&root).into(),
            root,
            files,
            editor,
            terminal,
            h_state: cx.new(|_| ResizableState::default()),
            v_state: cx.new(|_| ResizableState::default()),
            _subscriptions: subscriptions,
        }
    }

    fn open_file(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.quick_open.read(cx).mark_recent(&path);
        self.editor.update(cx, |e, cx| e.open(path, window, cx));
    }

    fn restore_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let has_tab = self.editor.read(cx).status_info(cx).file.is_some();
        if has_tab {
            self.editor.update(cx, |e, cx| e.cycle(0, window, cx));
        } else {
            self.focus_handle.focus(window, cx);
        }
    }

    fn show_quick_open(&mut self, prefix: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.quick_open_visible = true;
        self.quick_open
            .update(cx, |q, cx| q.show(prefix, window, cx));
        cx.notify();
    }

    fn on_save(&mut self, _: &Save, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| e.save(cx));
    }
    fn on_close_tab(&mut self, _: &CloseTab, window: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| e.close_active(window, cx));
    }
    fn on_next_tab(&mut self, _: &NextTab, window: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| e.cycle(1, window, cx));
    }
    fn on_prev_tab(&mut self, _: &PrevTab, window: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| e.cycle(-1, window, cx));
    }
    fn on_quick_open(&mut self, _: &QuickOpenFiles, window: &mut Window, cx: &mut Context<Self>) {
        self.show_quick_open("", window, cx);
    }
    fn on_show_commands(&mut self, _: &ShowCommands, window: &mut Window, cx: &mut Context<Self>) {
        self.show_quick_open(">", window, cx);
    }
    fn on_toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_visible = !self.sidebar_visible;
        cx.notify();
    }
    fn on_toggle_panel(&mut self, _: &TogglePanel, window: &mut Window, cx: &mut Context<Self>) {
        self.panel_visible = !self.panel_visible;
        if self.panel_visible {
            self.terminal.read(cx).focus_handle(cx).focus(window, cx);
        } else {
            self.restore_focus(window, cx);
        }
        cx.notify();
    }
    fn on_focus_terminal(
        &mut self,
        _: &FocusTerminal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.panel_visible = true;
        self.terminal.read(cx).focus_handle(cx).focus(window, cx);
        cx.notify();
    }
    fn on_quit(&mut self, _: &Quit, _: &mut Window, cx: &mut Context<Self>) {
        cx.quit();
    }

    fn title_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let c = theme::colors();
        let name = self
            .root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        div()
            .h(z(TITLE_BAR_H))
            .w_full()
            .flex_none()
            .flex()
            .items_center()
            .bg(c.title_bar)
            .text_color(c.title_bar_fg)
            .text_size(z(12.))
            // Space for the macOS traffic lights.
            .pl(z(80.))
            .pr(z(10.))
            .child(div().flex_1())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(z(8.))
                    .child(Codicon::ARROW_LEFT.render(16., c.description))
                    .child(Codicon::ARROW_RIGHT.render(16., c.description))
                    .child(
                        div()
                            .id("command-center")
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.show_quick_open("", window, cx)
                            }))
                            .w(z(560.))
                            .h(z(24.))
                            .rounded(z(6.))
                            .bg(c.command_center)
                            .border_1()
                            .border_color(c.command_center_border)
                            .flex()
                            .items_center()
                            .px(z(8.))
                            .text_color(c.command_center_fg)
                            .child(name),
                    ),
            )
            .child(div().flex_1())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(z(10.))
                    .child(Codicon::LAYOUT.render(16., c.title_bar_fg))
                    .child(
                        Codicon::LAYOUT_SIDEBAR_LEFT
                            .render(
                                16.,
                                if self.sidebar_visible {
                                    c.title_bar_fg
                                } else {
                                    c.description
                                },
                            )
                            .id("toggle-sidebar")
                            .cursor_pointer()
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(ToggleSidebar), cx)
                            }),
                    )
                    .child(
                        Codicon::LAYOUT_PANEL
                            .render(
                                16.,
                                if self.panel_visible {
                                    c.title_bar_fg
                                } else {
                                    c.description
                                },
                            )
                            .id("toggle-panel")
                            .cursor_pointer()
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(TogglePanel), cx)
                            }),
                    )
                    .child(Codicon::LAYOUT_SIDEBAR_RIGHT.render(16., c.description)),
            )
    }

    fn activity_bar(&self) -> impl IntoElement {
        let c = theme::colors();
        let item = |icon: Codicon, active: bool| {
            div()
                .w(z(ACTIVITY_BAR_W))
                .h(z(ACTIVITY_BAR_W))
                .flex()
                .items_center()
                .justify_center()
                .border_l(z(2.))
                .border_color(if active {
                    c.activity_bar_active_border
                } else {
                    c.activity_bar
                })
                .child(icon.render(
                    24.,
                    if active {
                        c.activity_bar_fg
                    } else {
                        c.activity_bar_inactive_fg
                    },
                ))
        };
        div()
            .w(z(ACTIVITY_BAR_W))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .bg(c.activity_bar)
            .child(
                item(Codicon::FILES, self.sidebar_visible)
                    .id("activity-explorer")
                    .cursor_pointer()
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleSidebar), cx)),
            )
            .child(item(Codicon::SEARCH, false))
            .child(item(Codicon::SOURCE_CONTROL, false))
            .child(item(Codicon::DEBUG_ALT, false))
            .child(item(Codicon::EXTENSIONS, false))
            .child(item(Codicon::REMOTE_EXPLORER, false))
            .child(item(Codicon::BEAKER, false))
            .child(div().flex_1())
            .child(item(Codicon::ACCOUNT, false))
            .child(item(Codicon::SETTINGS_GEAR, false))
    }

    fn status_bar(&self, info: editor_panel::StatusInfo) -> impl IntoElement {
        let c = theme::colors();
        let text = |s: String| div().child(SharedString::from(s)).into_any_element();
        let icon = |i: Codicon| i.render(14., c.status_bar_fg).into_any_element();
        let item = |children: Vec<AnyElement>| {
            div()
                .h_full()
                .px(z(5.))
                .flex()
                .items_center()
                .gap(z(4.))
                .children(children)
        };
        let mut right = div().h_full().flex().items_center().pr(z(6.));
        if let Some(info) = info.file {
            right = right
                .child(item(vec![text(format!(
                    "Ln {}, Col {}",
                    info.line, info.col
                ))]))
                .child(item(vec![text(info.indent)]))
                .child(item(vec![text("UTF-8".into())]))
                .child(item(vec![text(info.eol.into())]))
                .child(item(vec![
                    div().child("{ }").into_any_element(),
                    text(info.language),
                ]));
        }
        right = right.child(item(vec![icon(Codicon::BELL)]));

        div()
            .h(z(STATUS_BAR_H))
            .w_full()
            .flex_none()
            .flex()
            .items_center()
            .bg(c.status_bar)
            .text_color(c.status_bar_fg)
            .text_size(z(12.))
            .child(
                div()
                    .h_full()
                    .px(z(10.))
                    .flex()
                    .items_center()
                    .bg(c.remote)
                    .child(Codicon::REMOTE.render(14., c.remote_fg)),
            )
            .child(item(vec![
                icon(Codicon::GIT_BRANCH),
                text(self.branch.to_string()),
                icon(Codicon::SYNC),
            ]))
            .child(item(vec![
                icon(Codicon::ERROR),
                text("0".into()),
                icon(Codicon::WARNING),
                text("0".into()),
            ]))
            .child(div().flex_1())
            .child(right)
    }
}

impl Render for Workspace {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = theme::colors();
        let info = self.editor.read(cx).status_info(cx);

        let body = h_resizable("workbench")
            .with_state(&self.h_state)
            .child(
                resizable_panel()
                    .visible(self.sidebar_visible)
                    .size(z(300.))
                    .size_range(z(170.)..z(800.))
                    .child(pane(c.side_bar, self.files.clone())),
            )
            .child(
                resizable_panel().child(
                    v_resizable("editor-and-panel")
                        .with_state(&self.v_state)
                        .child(resizable_panel().child(pane(c.editor, self.editor.clone())))
                        .child(
                            resizable_panel()
                                .visible(self.panel_visible)
                                .size(z(280.))
                                .size_range(z(80.)..z(1200.))
                                .child(pane(c.panel, self.terminal.clone())),
                        ),
                ),
            );

        let overlay = self.quick_open_visible.then(|| {
            div()
                .absolute()
                .inset_0()
                .flex()
                .justify_center()
                .pt(z(TITLE_BAR_H + 4.))
                .child(
                    // Clicking outside the palette dismisses it.
                    div()
                        .id("quick-open-backdrop")
                        .absolute()
                        .inset_0()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, window, cx| {
                                this.quick_open_visible = false;
                                this.restore_focus(window, cx);
                                cx.notify();
                            }),
                        ),
                )
                .child(self.quick_open.clone())
        });

        div()
            .id("workspace")
            .track_focus(&self.focus_handle)
            .key_context("Workspace")
            .on_action(cx.listener(Self::on_save))
            .on_action(cx.listener(Self::on_close_tab))
            .on_action(cx.listener(Self::on_next_tab))
            .on_action(cx.listener(Self::on_prev_tab))
            .on_action(cx.listener(Self::on_quick_open))
            .on_action(cx.listener(Self::on_show_commands))
            .on_action(cx.listener(Self::on_toggle_sidebar))
            .on_action(cx.listener(Self::on_toggle_panel))
            .on_action(cx.listener(Self::on_focus_terminal))
            .on_action(cx.listener(Self::on_quit))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(c.frame)
            .text_color(c.foreground)
            .font_family(".SystemUIFont")
            .text_size(z(13.))
            .child(self.title_bar(cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_row()
                    .child(self.activity_bar())
                    .child(div().flex_1().min_w_0().h_full().pr(z(2.)).child(body)),
            )
            .child(self.status_bar(info))
            .children(overlay)
    }
}

fn git_branch(root: &Path) -> String {
    std::fs::read_to_string(root.join(".git/HEAD"))
        .ok()
        .and_then(|s| s.trim().strip_prefix("ref: refs/heads/").map(str::to_owned))
        .unwrap_or_else(|| "detached".to_owned())
}

/// Push the VSCode theme into gpui-kit's own theme, which its editor reads.
fn apply_kit_theme(cx: &mut App) {
    let setup = vscode::get();
    let c = theme::colors();
    Theme::change(
        if setup.is_dark {
            ThemeMode::Dark
        } else {
            ThemeMode::Light
        },
        None,
        cx,
    );
    Theme::update(cx, |t| {
        t.mono_font_family = setup.editor_font.clone().into();
        t.mono_font_size = z(setup.editor_font_size);
        t.colors.foreground = c.editor_fg;
        // gpui-kit draws line numbers in `muted_foreground` and has no
        // separate active-line-number colour.
        t.colors.muted_foreground = c.line_number;
        t.colors.selection = c.selection;
        t.colors.caret = c.cursor;
        t.colors.scrollbar = c.editor;
        t.colors.scrollbar_thumb = c.scrollbar;
        t.colors.scrollbar_thumb_hover = c.scrollbar_hover;
        // Command palette.
        t.colors.popover = c.quick_input;
        t.colors.popover_foreground = c.quick_input_fg;
        t.colors.accent = c.quick_input_focus;
        t.colors.accent_foreground = c.quick_input_focus_fg;
        t.colors.border = c.widget_border;
        let mut hl = (*t.highlight_theme).clone();
        hl.style.editor_background = Some(c.editor);
        hl.style.editor_foreground = Some(c.editor_fg);
        hl.style.editor_active_line = Some(c.line_highlight);
        hl.style.editor_gutter_background = Some(c.gutter);
        hl.style.editor_line_number = Some(c.line_number);
        hl.style.editor_active_line_number = Some(c.line_number_active);
        t.highlight_theme = Arc::new(hl);
    });
}

fn main() {
    env_logger::init();
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("cwd"));
    let root = std::fs::canonicalize(&root).unwrap_or(root);

    application()
        .with_assets(icons::Assets::new())
        .run(move |cx| {
            init(cx);
            cx.bind_keys(key_bindings());
            apply_kit_theme(cx);

            let bounds = Bounds::centered(None, size(px(1500.), px(960.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(SharedString::from("SideX (GPUI spike)")),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(12.), z(TITLE_BAR_H / 2. - 6.))),
                }),
                ..Default::default()
            };
            open_window(options, cx, move |window, cx| {
                // gpui-kit sizes its own widgets in rems; follow VSCode's zoom.
                window.set_rem_size(z(16.));
                cx.new(|cx| Workspace::new(root.clone(), window, cx))
            })
            .expect("failed to open window");
            cx.activate(true);
        });
}

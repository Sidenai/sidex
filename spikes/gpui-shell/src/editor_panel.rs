//! Editor group: VSCode-style tabs + breadcrumbs around gpui-kit's
//! rope-backed `Editor`, highlighted by `crate::highlighter`.
//!
//! Multiple tabs, save (writes through `sidex_workspace::file_ops`), an
//! unsaved-changes dot, and a live cursor position for the status bar.

use std::path::{Path, PathBuf};

use gpui_kit::component::input::{Editor, EditorState, InputEvent, TabSize};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use sidex_workspace::file_ops;

use crate::icons::Codicon;
use crate::theme;
use crate::vscode::{self, z};
use crate::{file_icons, highlighter};

const TAB_BAR_H: f32 = 35.;
const BREADCRUMB_H: f32 = 22.;

pub struct FileStatus {
    pub line: usize,
    pub col: usize,
    pub indent: String,
    pub eol: &'static str,
    pub language: String,
}

pub struct StatusInfo {
    pub file: Option<FileStatus>,
}

struct Tab {
    path: PathBuf,
    state: Entity<EditorState>,
    language: String,
    indent: String,
    eol: &'static str,
    dirty: bool,
    _subscriptions: Vec<Subscription>,
}

pub struct EditorPanel {
    focus_handle: FocusHandle,
    root: PathBuf,
    tabs: Vec<Tab>,
    active: usize,
    /// Tab whose close was refused because it has unsaved changes; a second
    /// close discards them.
    confirm_discard: Option<PathBuf>,
    message: Option<String>,
}

/// Guess indentation the way VSCode's `editor.detectIndentation` reports it.
fn detect_indent(text: &str) -> String {
    let mut tabs = 0;
    let mut widths = [0usize; 9];
    for line in text.lines().take(2000) {
        if line.starts_with('\t') {
            tabs += 1;
        } else {
            let n = line.len() - line.trim_start_matches(' ').len();
            if (2..=8).contains(&n) && !line.trim().is_empty() {
                widths[n] += 1;
            }
        }
    }
    let spaces: usize = widths.iter().sum();
    if tabs > spaces {
        return "Tab Size: 4".into();
    }
    if widths[2] > 0 && widths[2] * 2 >= widths[4] {
        "Spaces: 2".into()
    } else {
        "Spaces: 4".into()
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

impl EditorPanel {
    pub fn new(root: PathBuf, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            root,
            tabs: Vec::new(),
            active: 0,
            confirm_discard: None,
            message: None,
        }
    }

    fn active_tab(&self) -> Option<&Tab> {
        self.tabs.get(self.active)
    }

    pub fn status_info(&self, cx: &App) -> StatusInfo {
        StatusInfo {
            file: self.active_tab().map(|t| {
                let pos = t.state.read(cx).cursor_position();
                FileStatus {
                    line: pos.line as usize + 1,
                    col: pos.character as usize + 1,
                    indent: t.indent.clone(),
                    eol: t.eol,
                    language: t.language.clone(),
                }
            }),
        }
    }

    pub fn open(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.message = None;
        self.confirm_discard = None;
        if let Some(ix) = self.tabs.iter().position(|t| t.path == path) {
            self.activate(ix, window, cx);
            return;
        }
        let text = match file_ops::is_binary_file(&path) {
            Ok(true) => Err(format!("{} is a binary file", path.display())),
            Err(e) => Err(e.to_string()),
            Ok(false) => file_ops::read_file(&path).map_err(|e| e.to_string()),
        };
        let text = match text {
            Ok(t) => t,
            Err(e) => {
                self.message = Some(e);
                cx.notify();
                return;
            }
        };

        let name = file_name(&path);
        let language = highlighter::syntax_for(&name)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| "Plain Text".to_owned());
        let indent = detect_indent(&text);
        let eol = if text.contains("\r\n") { "CRLF" } else { "LF" };
        let tab_size = indent
            .rsplit(' ')
            .next()
            .and_then(|n| n.parse().ok())
            .unwrap_or(4);
        let factory = highlighter::factory(name);
        let state = cx.new(|cx| {
            let mut state = EditorState::new(window, cx)
                .language("sidex")
                .line_number(true)
                .folding(true)
                .searchable(true)
                .tab_size(TabSize {
                    tab_size,
                    hard_tabs: indent.starts_with("Tab"),
                })
                .default_value(text);
            state.set_highlighter_factory(factory, cx);
            state
        });

        let change_path = path.clone();
        let subscriptions = vec![
            cx.subscribe(&state, move |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    if let Some(tab) = this.tabs.iter_mut().find(|t| t.path == change_path) {
                        if !tab.dirty {
                            tab.dirty = true;
                            cx.notify();
                        }
                    }
                }
            }),
            // Cursor moves don't emit an event; re-render (and so refresh
            // the status bar's Ln/Col) whenever the editor redraws.
            cx.observe(&state, |_, _, cx| cx.notify()),
        ];

        // Like VSCode, open next to the active tab.
        let ix = if self.tabs.is_empty() {
            0
        } else {
            self.active + 1
        };
        self.tabs.insert(
            ix,
            Tab {
                path,
                state,
                language,
                indent,
                eol,
                dirty: false,
                _subscriptions: subscriptions,
            },
        );
        self.activate(ix, window, cx);
    }

    pub fn activate(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(tab) = self.tabs.get(ix) {
            self.active = ix;
            tab.state.update(cx, |s, cx| s.focus(window, cx));
            cx.notify();
        }
    }

    pub fn save(&mut self, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get_mut(self.active) else {
            return;
        };
        let text = tab.state.read(cx).value();
        match file_ops::write_file(&tab.path, &text) {
            Ok(()) => {
                tab.dirty = false;
                self.message = None;
            }
            Err(e) => self.message = Some(format!("Failed to save: {e}")),
        }
        cx.notify();
    }

    pub fn close_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close(self.active, window, cx);
    }

    fn close(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get(ix) else {
            return;
        };
        if tab.dirty && self.confirm_discard.as_ref() != Some(&tab.path) {
            self.confirm_discard = Some(tab.path.clone());
            self.message = Some(format!(
                "{} has unsaved changes. Save with ⌘S, or close again to discard them.",
                file_name(&tab.path)
            ));
            cx.notify();
            return;
        }
        self.confirm_discard = None;
        self.message = None;
        self.tabs.remove(ix);
        if self.active >= ix && self.active > 0 {
            self.active -= 1;
        }
        let active = self.active;
        self.activate(active, window, cx);
        cx.notify();
    }

    pub fn cycle(&mut self, delta: isize, window: &mut Window, cx: &mut Context<Self>) {
        if self.tabs.is_empty() {
            return;
        }
        let n = self.tabs.len() as isize;
        let ix = (self.active as isize + delta).rem_euclid(n) as usize;
        self.activate(ix, window, cx);
    }

    fn render_tab(&self, ix: usize, tab: &Tab, cx: &mut Context<Self>) -> impl IntoElement {
        let c = theme::colors();
        let setup = vscode::get();
        let active = ix == self.active;
        let name = file_name(&tab.path);
        let fg = if active {
            c.tab_active_fg
        } else {
            c.tab_inactive_fg
        };
        let icon: AnyElement = match setup
            .icons
            .as_ref()
            .and_then(|i: &file_icons::IconTheme| i.file(&name, setup.language_for(&name)))
        {
            Some(p) => img(p).size(z(16.)).flex_none().into_any_element(),
            None => Codicon::FILE.render(16., c.icon).into_any_element(),
        };
        // VSCode shows a dot for unsaved changes and swaps it for the close
        // button on hover.
        let group = SharedString::from(format!("tab-{ix}"));
        let close = div()
            .id(("close", ix))
            .ml(z(4.))
            .size(z(18.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(z(4.))
            .hover(|s| s.bg(c.list_hover))
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                this.close(ix, window, cx);
            }))
            .child(if tab.dirty {
                div()
                    .size(z(8.))
                    .rounded_full()
                    .bg(fg)
                    .group_hover(group.clone(), |s| s.invisible())
                    .into_any_element()
            } else {
                Codicon::CLOSE
                    .render(16., fg)
                    .when(!active, |d| {
                        d.invisible().group_hover(group.clone(), |s| s.visible())
                    })
                    .into_any_element()
            });

        div()
            .id(("tab", ix))
            .group(group)
            .relative()
            .h_full()
            .pl(z(10.))
            .pr(z(6.))
            .flex()
            .items_center()
            .gap(z(6.))
            .bg(if active { c.tab_active } else { c.tab_inactive })
            .border_r_1()
            .border_color(c.tab_border)
            .text_color(fg)
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| this.activate(ix, window, cx)))
            .child(icon)
            .child(name)
            .child(close)
            .when_some(c.tab_active_border_top.filter(|_| active), |d, top| {
                d.child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .right_0()
                        .h(px(1.))
                        .bg(top),
                )
            })
            .when_some(c.tab_active_border.filter(|_| active), |d, b| {
                d.child(
                    div()
                        .absolute()
                        .bottom_0()
                        .left_0()
                        .right_0()
                        .h(px(1.))
                        .bg(b),
                )
            })
    }

    fn tab_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let c = theme::colors();
        let tabs: Vec<AnyElement> = self
            .tabs
            .iter()
            .enumerate()
            .map(|(ix, t)| self.render_tab(ix, t, cx).into_any_element())
            .collect();
        div()
            .h(z(TAB_BAR_H))
            .w_full()
            .flex_none()
            .flex()
            .bg(c.tabs_bar)
            .child(
                div()
                    .id("tabs")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .overflow_x_scroll()
                    .children(tabs),
            )
            .child(
                div()
                    .h_full()
                    .px(z(8.))
                    .flex()
                    .items_center()
                    .gap(z(10.))
                    .child(Codicon::SPLIT_HORIZONTAL.render(16., c.icon))
                    .child(Codicon::ELLIPSIS.render(16., c.icon)),
            )
    }

    fn breadcrumbs(&self) -> impl IntoElement {
        let c = theme::colors();
        let mut row = div()
            .h(z(BREADCRUMB_H))
            .w_full()
            .flex_none()
            .flex()
            .items_center()
            .px(z(12.))
            .gap(z(2.))
            .text_size(z(12.))
            .text_color(c.breadcrumb_fg)
            .bg(c.editor);
        if let Some(tab) = self.active_tab() {
            let rel = tab.path.strip_prefix(&self.root).unwrap_or(&tab.path);
            for (i, part) in rel.components().enumerate() {
                if i > 0 {
                    row = row.child(Codicon::CHEVRON_RIGHT.render(14., c.breadcrumb_fg));
                }
                row = row.child(part.as_os_str().to_string_lossy().to_string());
            }
        }
        row
    }
}

impl Focusable for EditorPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for EditorPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = theme::colors();
        let setup = vscode::get();
        let body: AnyElement = match self.active_tab() {
            Some(tab) => Editor::new(&tab.state)
                .appearance(false)
                .bordered(false)
                .font_family(setup.editor_font.clone())
                .text_size(z(setup.editor_font_size))
                .line_height(z(setup.editor_line_height))
                .size_full()
                .into_any_element(),
            None => div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(z(8.))
                .text_color(c.description)
                .child("Show All Commands   ⇧⌘P")
                .child("Go to File   ⌘P")
                .child("Toggle Terminal   ⌘J")
                .into_any_element(),
        };
        let has_tabs = !self.tabs.is_empty();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(c.editor)
            .when(has_tabs, |d| {
                d.child(self.tab_bar(cx)).child(self.breadcrumbs())
            })
            .when_some(self.message.clone(), |d, m| {
                d.child(
                    div()
                        .px(z(12.))
                        .py(z(4.))
                        .text_size(z(12.))
                        .bg(c.list_hover)
                        .text_color(c.foreground)
                        .child(m),
                )
            })
            .child(div().flex_1().min_h_0().child(body))
    }
}

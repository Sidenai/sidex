//! Terminal pane on `alacritty_terminal`, the emulator Zed's terminal uses.
//!
//! alacritty owns the PTY, its reader thread and the VT parser (reflow on
//! resize, scrollback, mouse and keyboard modes, OSC colour queries);
//! `TerminalElement` paints the grid and this view turns GPUI input into
//! bytes. Text input goes through the platform input handler, so dead keys,
//! ⌥-composed characters and IME composition work.

use std::collections::HashMap;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use alacritty_terminal::event::{Event, EventListener, Notify, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, Msg, Notifier};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty;
use futures::channel::mpsc::{unbounded, UnboundedSender};
use futures::StreamExt;
use gpui_kit::*;
use regex::Regex;

use crate::icons::Codicon;
use crate::terminal_element::{hsla_rgb, palette, viewport_point, TerminalElement};
use crate::terminal_keys::{key_to_bytes, mouse_report, paste_bytes, ReportButton, ReportKind};
use crate::theme;
use crate::vscode::z;

const PANEL_HEADER_H: f32 = 35.;

/// Terminal font, size and row height from the user's VSCode settings,
/// scaled by zoom. VSCode's `terminal.integrated.lineHeight` default is 1,
/// which xterm.js renders at roughly 1.2x the font size.
pub fn font_family() -> String {
    crate::vscode::get().terminal_font.clone()
}
pub fn font_size() -> f32 {
    let s = crate::vscode::get();
    s.terminal_font_size * s.zoom
}
pub fn line_h() -> f32 {
    (font_size() * 1.2).round()
}

/// Where the grid was laid out in the last frame, for hit tests and resizes.
#[derive(Clone, PartialEq)]
pub struct GridLayout {
    pub origin: Point<Pixels>,
    pub cell_w: Pixels,
    pub line_h: Pixels,
    pub cols: usize,
    pub rows: usize,
}

struct GridSize {
    cols: usize,
    rows: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Forwards alacritty's events (from the PTY thread) to the view.
#[derive(Clone)]
pub(crate) struct Listener(UnboundedSender<Event>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let _ = self.0.unbounded_send(event);
    }
}

pub(crate) type Term_ = Term<Listener>;

struct Session {
    term: Arc<FairMutex<Term_>>,
    notifier: Notifier,
    shell: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.notifier.0.send(Msg::Shutdown);
    }
}

pub struct TerminalPanel {
    focus_handle: FocusHandle,
    cwd: PathBuf,
    session: Option<Session>,
    error: Option<String>,
    title: Option<String>,
    exited: bool,
    layout: Option<GridLayout>,
    /// IME composition in progress, drawn at the cursor.
    marked: Option<String>,
    ime_bounds: Option<Bounds<Pixels>>,
    /// Button the application is being sent reports for, while held.
    reporting: Option<ReportButton>,
    last_report_cell: Option<(usize, usize)>,
    selecting: bool,
    /// ⌘-hovered link: its cells and target.
    link: Option<(GridPoint, GridPoint, String)>,
    scroll_accum: f32,
    _events: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl TerminalPanel {
    pub fn new(cwd: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        // Applications that enabled focus reporting (vim, tmux) hear about it.
        let subscriptions = vec![
            cx.on_focus_in(&focus_handle, window, |this, _, cx| {
                this.report_focus(true);
                cx.notify();
            }),
            cx.on_focus_out(&focus_handle, window, |this, _, _, cx| {
                this.report_focus(false);
                cx.notify();
            }),
        ];
        let mut this = Self {
            focus_handle,
            cwd,
            session: None,
            error: None,
            title: None,
            exited: false,
            layout: None,
            marked: None,
            ime_bounds: None,
            reporting: None,
            last_report_cell: None,
            selecting: false,
            link: None,
            scroll_accum: 0.,
            _events: None,
            _subscriptions: subscriptions,
        };
        this.spawn(cx);
        this
    }

    fn spawn(&mut self, cx: &mut Context<Self>) {
        let (cols, rows, cell_w, cell_h) = match &self.layout {
            Some(l) => (l.cols, l.rows, f32::from(l.cell_w), f32::from(l.line_h)),
            None => (120, 30, 8., line_h()),
        };
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
        let env: HashMap<String, String> = [
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
            ("TERM_PROGRAM", "sidex"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        // `..Default::default()` only fills fields on Windows (`escape_args`).
        #[allow(clippy::needless_update)]
        let options = tty::Options {
            shell: Some(tty::Shell::new(shell.clone(), vec!["-l".to_owned()])),
            working_directory: Some(self.cwd.clone()),
            drain_on_exit: true,
            env,
            ..Default::default()
        };
        let window_size = WindowSize {
            num_lines: rows as u16,
            num_cols: cols as u16,
            cell_width: cell_w as u16,
            cell_height: cell_h as u16,
        };

        let (tx, mut rx) = unbounded();
        let listener = Listener(tx);
        let result = tty::new(&options, window_size, 0).and_then(|pty| {
            let term = Arc::new(FairMutex::new(Term::new(
                Config::default(),
                &GridSize { cols, rows },
                listener.clone(),
            )));
            let event_loop = EventLoop::new(Arc::clone(&term), listener, pty, true, false)?;
            let notifier = Notifier(event_loop.channel());
            event_loop.spawn();
            Ok((term, notifier))
        });
        match result {
            Ok((term, notifier)) => {
                self.session = Some(Session {
                    term,
                    notifier,
                    shell,
                });
                self.error = None;
                self.exited = false;
                self.title = None;
            }
            Err(e) => {
                self.error = Some(format!("Failed to start the shell: {e}"));
                return;
            }
        }

        // Event-driven repaint: drain everything the PTY thread queued, then
        // notify once, so a burst of output costs one frame.
        self._events = Some(cx.spawn(async move |this, cx| {
            while let Some(first) = rx.next().await {
                let mut batch = vec![first];
                while let Ok(e) = rx.try_recv() {
                    batch.push(e);
                }
                let alive = this.update(cx, |this, cx| {
                    for event in batch {
                        this.handle_event(event, cx);
                    }
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        }));
    }

    fn handle_event(&mut self, event: Event, cx: &mut Context<Self>) {
        match event {
            Event::Title(title) => self.title = Some(title),
            Event::ResetTitle => self.title = None,
            Event::PtyWrite(text) => self.write(text.into_bytes()),
            Event::ColorRequest(index, format) => {
                let overrides = self.term().map(|t| *t.lock().colors());
                if let Some(overrides) = overrides {
                    let color = hsla_rgb(palette(index, &overrides, theme::colors()));
                    self.write(format(color).into_bytes());
                }
            }
            Event::TextAreaSizeRequest(format) => {
                if let Some(l) = &self.layout {
                    let size = WindowSize {
                        num_lines: l.rows as u16,
                        num_cols: l.cols as u16,
                        cell_width: f32::from(l.cell_w) as u16,
                        cell_height: f32::from(l.line_h) as u16,
                    };
                    self.write(format(size).into_bytes());
                }
            }
            Event::ClipboardStore(_, text) => {
                cx.write_to_clipboard(ClipboardItem::new_string(text))
            }
            Event::ChildExit(_) | Event::Exit => self.exited = true,
            Event::ClipboardLoad(..)
            | Event::Wakeup
            | Event::Bell
            | Event::MouseCursorDirty
            | Event::CursorBlinkingChange => {}
        }
    }

    pub(crate) fn term(&self) -> Option<&Arc<FairMutex<Term_>>> {
        self.session.as_ref().map(|s| &s.term)
    }

    pub(crate) fn marked_text(&self) -> Option<&str> {
        self.marked.as_deref()
    }

    pub(crate) fn hovered_link(&self) -> Option<(GridPoint, GridPoint)> {
        self.link.as_ref().map(|(s, e, _)| (*s, *e))
    }

    pub(crate) fn set_ime_bounds(&mut self, bounds: Bounds<Pixels>) {
        self.ime_bounds = Some(bounds);
    }

    /// Called by the element each frame; resizes the PTY when the grid
    /// no longer fits.
    pub(crate) fn set_layout(&mut self, layout: GridLayout) {
        let resized = self
            .layout
            .as_ref()
            .is_none_or(|l| (l.cols, l.rows) != (layout.cols, layout.rows));
        if let Some(s) = self.session.as_ref().filter(|_| resized) {
            s.term.lock().resize(GridSize {
                cols: layout.cols,
                rows: layout.rows,
            });
            let _ = s.notifier.0.send(Msg::Resize(WindowSize {
                num_lines: layout.rows as u16,
                num_cols: layout.cols as u16,
                cell_width: f32::from(layout.cell_w) as u16,
                cell_height: f32::from(layout.line_h) as u16,
            }));
        }
        self.layout = Some(layout);
    }

    fn mode(&self) -> TermMode {
        self.term()
            .map(|t| *t.lock().mode())
            .unwrap_or(TermMode::NONE)
    }

    fn write(&self, bytes: impl Into<std::borrow::Cow<'static, [u8]>>) {
        if let Some(s) = &self.session {
            s.notifier.notify(bytes);
        }
    }

    /// Input from the user: snaps back to the prompt and drops the
    /// selection, as VSCode does.
    fn input(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        if let Some(term) = self.term() {
            let mut term = term.lock();
            term.scroll_display(Scroll::Bottom);
            term.selection = None;
        }
        self.write(bytes);
        cx.notify();
    }

    fn report_focus(&self, focused: bool) {
        if self.mode().contains(TermMode::FOCUS_IN_OUT) {
            self.write(if focused {
                &b"\x1b[I"[..]
            } else {
                &b"\x1b[O"[..]
            });
        }
    }

    fn restart(&mut self, cx: &mut Context<Self>) {
        self.session = None;
        self.spawn(cx);
        cx.notify();
    }

    fn selected_text(&self) -> Option<String> {
        self.term()?.lock().selection_to_string()
    }

    fn paste(&mut self, text: &str, cx: &mut Context<Self>) {
        let bytes = paste_bytes(text, self.mode());
        self.input(bytes, cx);
    }

    fn select_all(&mut self, cx: &mut Context<Self>) {
        if let Some(term) = self.term() {
            let mut term = term.lock();
            let top = GridPoint::new(term.topmost_line(), Column(0));
            let bottom = GridPoint::new(term.bottommost_line(), term.last_column());
            let mut selection = Selection::new(SelectionType::Simple, top, Side::Left);
            selection.update(bottom, Side::Right);
            term.selection = Some(selection);
        }
        cx.notify();
    }

    /// ⌘K: drop the scrollback and let the shell redraw its prompt at the top.
    fn clear(&mut self, cx: &mut Context<Self>) {
        if let Some(term) = self.term() {
            let mut term = term.lock();
            term.grid_mut().clear_history();
            term.selection = None;
        }
        self.write(&b"\x0c"[..]);
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        let m = ks.modifiers;
        if self.exited {
            self.restart(cx);
            cx.stop_propagation();
            return;
        }
        if m.platform && !m.control && !m.alt && !m.shift {
            let handled = match ks.key.as_str() {
                "c" => match self.selected_text() {
                    Some(text) => {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                        true
                    }
                    None => false,
                },
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                        self.paste(&text, cx);
                    }
                    true
                }
                "k" => {
                    self.clear(cx);
                    true
                }
                "a" => {
                    self.select_all(cx);
                    true
                }
                _ => false,
            };
            if handled {
                cx.stop_propagation();
                return;
            }
        }
        let mode = self.mode();
        // ⇧PgUp/⇧PgDn page through the scrollback, outside full-screen apps.
        if m.shift && !mode.contains(TermMode::ALT_SCREEN) {
            let scroll = match ks.key.as_str() {
                "pageup" => Some(Scroll::PageUp),
                "pagedown" => Some(Scroll::PageDown),
                _ => None,
            };
            if let Some(scroll) = scroll {
                if let Some(term) = self.term() {
                    term.lock().scroll_display(scroll);
                }
                cx.notify();
                cx.stop_propagation();
                return;
            }
        }
        if let Some(bytes) = key_to_bytes(ks, mode) {
            self.input(bytes, cx);
            cx.stop_propagation();
        }
    }
}

// Mouse: selection, application mouse reporting, links and scrolling.
impl TerminalPanel {
    /// Viewport cell under a window position, and which half of it.
    fn cell_at(&self, pos: Point<Pixels>) -> Option<(usize, usize, Side)> {
        let l = self.layout.as_ref()?;
        let x = f32::from(pos.x - l.origin.x).max(0.);
        let y = f32::from(pos.y - l.origin.y).max(0.);
        let cell_w = f32::from(l.cell_w);
        let col = ((x / cell_w) as usize).min(l.cols - 1);
        let line = ((y / f32::from(l.line_h)) as usize).min(l.rows - 1);
        let side = if x - col as f32 * cell_w < cell_w / 2. {
            Side::Left
        } else {
            Side::Right
        };
        Some((line, col, side))
    }

    fn grid_point(&self, line: usize, col: usize) -> Option<GridPoint> {
        let offset = self.term()?.lock().grid().display_offset();
        Some(viewport_point(offset, line, col))
    }

    /// Whether mouse events go to the application. Shift overrides, as in
    /// every xterm-style terminal.
    fn reports_mouse(&self, mods: &Modifiers) -> bool {
        !mods.shift && self.mode().intersects(TermMode::MOUSE_MODE)
    }

    fn report(
        &mut self,
        button: ReportButton,
        kind: ReportKind,
        pos: Point<Pixels>,
        mods: Modifiers,
    ) {
        let Some((line, col, _)) = self.cell_at(pos) else {
            return;
        };
        if kind == ReportKind::Motion && self.last_report_cell == Some((line, col)) {
            return;
        }
        self.last_report_cell = Some((line, col));
        if let Some(bytes) = mouse_report(button, kind, col, line, mods, self.mode()) {
            self.write(bytes);
        }
    }

    fn on_mouse_down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_handle.focus(window, cx);
        let button = match e.button {
            MouseButton::Left => ReportButton::Left,
            MouseButton::Middle => ReportButton::Middle,
            MouseButton::Right => ReportButton::Right,
            _ => return,
        };
        if self.reports_mouse(&e.modifiers) {
            self.reporting = Some(button);
            self.report(button, ReportKind::Press, e.position, e.modifiers);
            return;
        }
        if e.button != MouseButton::Left {
            return;
        }
        if let Some((_, _, url)) = self.link.as_ref().filter(|_| e.modifiers.platform) {
            cx.open_url(url);
            return;
        }
        let Some((line, col, side)) = self.cell_at(e.position) else {
            return;
        };
        let Some(point) = self.grid_point(line, col) else {
            return;
        };
        if let Some(term) = self.term() {
            let mut term = term.lock();
            match (&mut term.selection, e.modifiers.shift && e.click_count == 1) {
                (Some(selection), true) => selection.update(point, side),
                _ => {
                    let ty = match e.click_count {
                        1 => SelectionType::Simple,
                        2 => SelectionType::Semantic,
                        _ => SelectionType::Lines,
                    };
                    term.selection = Some(Selection::new(ty, point, side));
                }
            }
        }
        self.selecting = true;
        cx.notify();
    }

    fn on_mouse_move(&mut self, e: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.update_link(e.position, e.modifiers, cx);

        if let Some(button) = self.reporting {
            if self
                .mode()
                .intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION)
            {
                self.report(button, ReportKind::Motion, e.position, e.modifiers);
            }
            return;
        }
        if e.pressed_button.is_none()
            && self.mode().contains(TermMode::MOUSE_MOTION)
            && !e.modifiers.shift
        {
            // "Any event" tracking with no button: xterm reports button 3.
            if let Some((line, col, _)) = self
                .cell_at(e.position)
                .filter(|(line, col, _)| self.last_report_cell != Some((*line, *col)))
            {
                self.last_report_cell = Some((line, col));
                let mut bytes = mouse_report(
                    ReportButton::Left,
                    ReportKind::Motion,
                    col,
                    line,
                    e.modifiers,
                    self.mode(),
                );
                // Button bits 0b11 = no button.
                if let Some(b) = bytes.as_mut() {
                    patch_no_button(b);
                }
                if let Some(b) = bytes {
                    self.write(b);
                }
            }
            return;
        }
        if !self.selecting || e.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let Some((line, col, side)) = self.cell_at(e.position) else {
            return;
        };
        let Some(point) = self.grid_point(line, col) else {
            return;
        };
        if let Some(term) = self.term() {
            let mut term = term.lock();
            if let Some(selection) = term.selection.as_mut() {
                selection.update(point, side);
            }
        }
        cx.notify();
    }

    fn on_mouse_up(&mut self, e: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(button) = self.reporting.take() {
            self.report(button, ReportKind::Release, e.position, e.modifiers);
            return;
        }
        self.selecting = false;
        // A click without a drag leaves no selection behind.
        if let Some(term) = self.term() {
            let mut term = term.lock();
            if term.selection.as_ref().is_some_and(|s| s.is_empty()) {
                term.selection = None;
            }
        }
        cx.notify();
    }

    fn on_scroll(&mut self, e: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let line_h = line_h();
        self.scroll_accum += f32::from(e.delta.pixel_delta(px(line_h)).y);
        let lines = (self.scroll_accum / line_h).trunc() as i32;
        if lines == 0 {
            return;
        }
        self.scroll_accum -= lines as f32 * line_h;
        let mode = self.mode();

        if self.reports_mouse(&e.modifiers) {
            let button = if lines > 0 {
                ReportButton::WheelUp
            } else {
                ReportButton::WheelDown
            };
            for _ in 0..lines.unsigned_abs() {
                self.report(button, ReportKind::Press, e.position, e.modifiers);
            }
        } else if mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
            // Full-screen apps without mouse support (less, man) get arrows.
            let key = match (lines > 0, mode.contains(TermMode::APP_CURSOR)) {
                (true, true) => &b"\x1bOA"[..],
                (true, false) => b"\x1b[A",
                (false, true) => b"\x1bOB",
                (false, false) => b"\x1b[B",
            };
            let bytes: Vec<u8> = key.repeat(lines.unsigned_abs() as usize);
            self.write(bytes);
        } else if let Some(term) = self.term() {
            term.lock().scroll_display(Scroll::Delta(lines));
            cx.notify();
        }
    }

    /// With ⌘ held, find the link under the pointer: an OSC 8 hyperlink, or
    /// a URL in the line's text.
    fn update_link(&mut self, pos: Point<Pixels>, mods: Modifiers, cx: &mut Context<Self>) {
        let found = if mods.platform && !mods.shift {
            self.cell_at(pos)
                .and_then(|(line, col, _)| self.link_at(line, col))
        } else {
            None
        };
        let changed = found.as_ref().map(|(s, e, _)| (*s, *e)) != self.hovered_link();
        self.link = found;
        if changed {
            cx.notify();
        }
    }

    fn link_at(&self, line: usize, col: usize) -> Option<(GridPoint, GridPoint, String)> {
        static URL: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r#"(?:https?|file)://[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]"#).expect("valid regex")
        });
        let term = self.term()?.lock();
        let point = viewport_point(term.grid().display_offset(), line, col);
        let row = &term.grid()[point.line];
        let cols = term.columns();

        if let Some(link) = row[Column(col)].hyperlink() {
            let same = |c: usize| row[Column(c)].hyperlink().is_some_and(|h| h == link);
            let start = (0..=col).rev().take_while(|c| same(*c)).last()?;
            let end = (col..cols).take_while(|c| same(*c)).last()?;
            return Some((
                GridPoint::new(point.line, Column(start)),
                GridPoint::new(point.line, Column(end)),
                link.uri().to_owned(),
            ));
        }

        // Text of the row, with each char's column.
        let mut text = String::new();
        let mut cols_of: Vec<(usize, usize)> = Vec::new(); // (byte offset, column)
        for c in 0..cols {
            let cell = &row[Column(c)];
            if cell.flags.intersects(
                alacritty_terminal::term::cell::Flags::WIDE_CHAR_SPACER
                    | alacritty_terminal::term::cell::Flags::LEADING_WIDE_CHAR_SPACER,
            ) {
                continue;
            }
            cols_of.push((text.len(), c));
            text.push(cell.c);
        }
        let byte_at = cols_of.iter().find(|(_, c)| *c == col)?.0;
        let m = URL
            .find_iter(&text)
            .find(|m| m.range().contains(&byte_at))?;
        let col_of = |byte: usize| {
            cols_of
                .iter()
                .rev()
                .find(|(b, _)| *b <= byte)
                .map(|(_, c)| *c)
                .unwrap_or(0)
        };
        Some((
            GridPoint::new(point.line, Column(col_of(m.start()))),
            GridPoint::new(point.line, Column(col_of(m.end() - 1))),
            m.as_str().to_owned(),
        ))
    }
}

/// Turn a motion report for the left button into a no-button motion report.
fn patch_no_button(bytes: &mut [u8]) {
    if bytes.starts_with(b"\x1b[<") {
        // SGR: "\x1b[<32;..." -> "\x1b[<35;..."
        if let Some(end) = bytes[3..].iter().position(|b| *b == b';') {
            let digits = &bytes[3..3 + end];
            if let Some(cb) = std::str::from_utf8(digits)
                .ok()
                .and_then(|s| s.parse::<u8>().ok())
            {
                let patched = format!("{}", cb | 3);
                if patched.len() == digits.len() {
                    bytes[3..3 + end].copy_from_slice(patched.as_bytes());
                }
            }
        }
    } else if bytes.len() == 6 {
        bytes[3] |= 3;
    }
}

impl EntityInputHandler for TerminalPanel {
    fn text_for_range(
        &mut self,
        _: Range<usize>,
        _: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        None
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: 0..0,
            reversed: false,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|m| 0..m.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked = None;
        if self.exited {
            self.restart(cx);
            return;
        }
        self.input(text.as_bytes().to_vec(), cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked = (!text.is_empty()).then(|| text.to_owned());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        self.ime_bounds
    }

    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

impl TerminalPanel {
    fn panel_header(&self) -> impl IntoElement {
        let c = theme::colors();
        // Icon-only panel tabs, as VSCode shows them when the panel is
        // narrow or `workbench.panel.showLabels` is off.
        let tab = |icon: Codicon, active: bool| {
            div()
                .h_full()
                .px(z(6.))
                .flex()
                .items_center()
                .border_b(px(1.))
                .border_color(if active {
                    c.panel_title_active_border
                } else {
                    c.panel
                })
                .child(icon.render(
                    16.,
                    if active {
                        c.panel_title_active_fg
                    } else {
                        c.panel_title_inactive_fg
                    },
                ))
        };
        let label = self.title.clone().unwrap_or_else(|| {
            self.session
                .as_ref()
                .map(|s| {
                    std::path::Path::new(&s.shell)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                })
                .unwrap_or_else(|| "no shell".to_owned())
        });
        div()
            .h(z(PANEL_HEADER_H))
            .w_full()
            .flex_none()
            .flex()
            .items_center()
            .px(z(8.))
            .bg(c.panel)
            .child(
                div()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(z(4.))
                    .child(tab(Codicon::WARNING, false))
                    .child(tab(Codicon::TERMINAL, true))
                    .child(tab(Codicon::OUTPUT, false))
                    .child(tab(Codicon::DEBUG_CONSOLE, false))
                    .child(tab(Codicon::PLUG, false))
                    .child(tab(Codicon::COMMENT_DISCUSSION, false)),
            )
            .child(div().flex_1())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(z(10.))
                    .text_size(z(12.))
                    .text_color(c.panel_title_inactive_fg)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(z(4.))
                            .max_w(z(260.))
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(Codicon::TERMINAL.render(14., c.icon))
                            .child(SharedString::from(label)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .child(Codicon::ADD.render(16., c.icon))
                            .child(Codicon::CHEVRON_DOWN.render(12., c.icon)),
                    )
                    .child(Codicon::SPLIT_HORIZONTAL.render(16., c.icon))
                    .child(Codicon::TRASH.render(16., c.icon))
                    .child(Codicon::ELLIPSIS.render(16., c.icon))
                    .child(div().w(px(1.)).h(z(16.)).bg(c.panel_border))
                    .child(Codicon::SCREEN_FULL.render(16., c.icon))
                    .child(Codicon::CLOSE.render(16., c.icon)),
            )
    }
}

impl Focusable for TerminalPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for TerminalPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = theme::colors();
        let cursor_style = if self.link.is_some() {
            CursorStyle::PointingHand
        } else if self.mode().intersects(TermMode::MOUSE_MODE) {
            CursorStyle::Arrow
        } else {
            CursorStyle::IBeam
        };
        let notice = if let Some(err) = &self.error {
            Some((err.clone(), colors.ansi[1]))
        } else if self.exited {
            Some((
                "The terminal process exited. Press any key to start a new one.".to_owned(),
                colors.description,
            ))
        } else {
            None
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.panel)
            .child(self.panel_header())
            .child(
                div()
                    .id("terminal")
                    .track_focus(&self.focus_handle)
                    .key_context("Terminal")
                    .on_key_down(cx.listener(Self::on_key_down))
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_down(MouseButton::Middle, cx.listener(Self::on_mouse_down))
                    .on_mouse_down(MouseButton::Right, cx.listener(Self::on_mouse_down))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up(MouseButton::Middle, cx.listener(Self::on_mouse_up))
                    .on_mouse_up(MouseButton::Right, cx.listener(Self::on_mouse_up))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .on_scroll(cx.listener(Self::on_scroll))
                    .cursor(cursor_style)
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .bg(colors.terminal)
                    .pl(z(20.))
                    .pr(z(8.))
                    .pt(z(4.))
                    .children(notice.map(|(text, color)| {
                        div()
                            .flex_none()
                            .pb(z(4.))
                            .text_size(z(12.))
                            .text_color(color)
                            .child(text)
                    }))
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .child(TerminalElement::new(cx.entity(), self.focus_handle.clone())),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// The shell really runs through alacritty's PTY and lands in the grid.
    #[::core::prelude::v1::test]
    fn shell_output_reaches_the_grid() {
        let (tx, mut rx) = unbounded();
        let listener = Listener(tx);
        let options = tty::Options {
            shell: Some(tty::Shell::new(
                "/bin/sh".to_owned(),
                vec![
                    "-c".to_owned(),
                    "printf 'hello\\033[31mred'; sleep 1".to_owned(),
                ],
            )),
            ..Default::default()
        };
        let size = WindowSize {
            num_lines: 5,
            num_cols: 20,
            cell_width: 8,
            cell_height: 16,
        };
        let pty = tty::new(&options, size, 0).unwrap();
        let term = Arc::new(FairMutex::new(Term::new(
            Config::default(),
            &GridSize { cols: 20, rows: 5 },
            listener.clone(),
        )));
        let event_loop = EventLoop::new(Arc::clone(&term), listener, pty, true, false).unwrap();
        let _notifier = Notifier(event_loop.channel());
        event_loop.spawn();

        let deadline = Instant::now() + Duration::from_secs(5);
        let text = loop {
            while rx.try_recv().is_ok() {}
            let term = term.lock();
            let row = &term.grid()[alacritty_terminal::index::Line(0)];
            let text: String = (0..20).map(|c| row[Column(c)].c).collect();
            if text.contains("red") || Instant::now() > deadline {
                let red = row[Column(5)].fg;
                break (text, red);
            }
            drop(term);
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(text.0.trim_end(), "hellored");
        assert_eq!(
            text.1,
            alacritty_terminal::vte::ansi::Color::Named(
                alacritty_terminal::vte::ansi::NamedColor::Red
            )
        );
    }

    #[::core::prelude::v1::test]
    fn no_button_motion_patch() {
        let mut sgr = b"\x1b[<32;5;10M".to_vec();
        patch_no_button(&mut sgr);
        assert_eq!(sgr, b"\x1b[<35;5;10M");
        let mut x10 = vec![0x1b, b'[', b'M', 32 + 32, 33, 33];
        patch_no_button(&mut x10);
        assert_eq!(x10[3], 32 + 35);
    }
}

//! Terminal pane: `sidex_terminal` PTY + emulator, rendered cell-by-cell.
//!
//! gpui-kit has no terminal widget, so this is the one pane drawn by hand.
//! The grid is resized to fit the pane (measured with a `canvas`); no
//! scrollback view, no selection.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui_kit::*;
use sidex_terminal::grid::{Cell, Color, NamedColor};
use sidex_terminal::{PtyProcess, PtySpawnConfig, TerminalEmulator, TerminalGrid, TerminalSize};

use crate::icons::Codicon;
use crate::theme;
use crate::vscode::z;

const COLS: u16 = 120;
const ROWS: u16 = 30;
const PANEL_HEADER_H: f32 = 35.;

/// Terminal font, size and row height from the user's VSCode settings,
/// scaled by zoom. VSCode's `terminal.integrated.lineHeight` default is 1,
/// which xterm.js renders at roughly 1.2x the font size.
fn font_family() -> String {
    crate::vscode::get().terminal_font.clone()
}
fn font_size() -> f32 {
    let s = crate::vscode::get();
    s.terminal_font_size * s.zoom
}
fn line_h() -> f32 {
    (font_size() * 1.2).round()
}

pub struct TerminalPanel {
    focus_handle: FocusHandle,
    pty: Option<PtyProcess>,
    emulator: Arc<Mutex<TerminalEmulator>>,
    error: Option<String>,
    /// Grid size the last layout pass asked for, applied on the next tick.
    pending_size: Arc<Mutex<Option<(u16, u16)>>>,
    size: (u16, u16),
    /// Selection in absolute line coordinates (scrollback lines first, then
    /// the live screen): (line, col) anchor and head.
    selection: Option<((usize, u16), (usize, u16))>,
    /// Content origin and cell size from the last layout, for mouse hit tests.
    layout: Arc<Mutex<Option<(Point<Pixels>, f32, f32)>>>,
    scroll_accum: f32,
    _tick: Task<()>,
}

impl TerminalPanel {
    pub fn new(cwd: PathBuf, cx: &mut Context<Self>) -> Self {
        let emulator = Arc::new(Mutex::new(TerminalEmulator::new(TerminalGrid::new(
            ROWS, COLS,
        ))));
        let dirty = Arc::new(AtomicBool::new(false));

        let config = PtySpawnConfig {
            cwd: Some(cwd),
            size: TerminalSize {
                rows: ROWS,
                cols: COLS,
            },
            ..Default::default()
        };

        let mut error = None;
        let pty = match PtyProcess::spawn(&config) {
            Ok(mut pty) => {
                let emu = Arc::clone(&emulator);
                let dirty = Arc::clone(&dirty);
                if let Err(e) = pty.on_output(move |bytes| {
                    if let Ok(mut emu) = emu.lock() {
                        emu.process(bytes);
                    }
                    dirty.store(true, Ordering::Release);
                }) {
                    error = Some(format!("output handler: {e}"));
                }
                Some(pty)
            }
            Err(e) => {
                error = Some(format!("spawn failed: {e}"));
                None
            }
        };

        // Poll the dirty flag on the main thread and repaint when the PTY
        // produced output. Cheap enough for a spike; a real build would wake
        // the executor from the reader thread instead.
        let pending_size: Arc<Mutex<Option<(u16, u16)>>> = Arc::new(Mutex::new(None));
        let tick = cx.spawn({
            let pending_size = Arc::clone(&pending_size);
            async move |this, cx| loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let resize = pending_size.lock().ok().and_then(|mut p| p.take());
                let output = dirty.swap(false, Ordering::AcqRel);
                if resize.is_none() && !output {
                    continue;
                }
                let alive = this.update(cx, |this, cx| {
                    if let Some((rows, cols)) = resize {
                        this.apply_size(rows, cols);
                    }
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        });

        Self {
            focus_handle: cx.focus_handle(),
            pty,
            emulator,
            error,
            pending_size,
            size: (ROWS, COLS),
            selection: None,
            layout: Arc::default(),
            scroll_accum: 0.,
            _tick: tick,
        }
    }

    fn apply_size(&mut self, rows: u16, cols: u16) {
        if (rows, cols) == self.size || rows < 2 || cols < 10 {
            return;
        }
        self.size = (rows, cols);
        if let Ok(mut emu) = self.emulator.lock() {
            emu.grid_mut().resize(rows, cols);
        }
        if let Some(pty) = &mut self.pty {
            let _ = pty.resize(TerminalSize { rows, cols });
        }
    }

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
        let shell = self
            .pty
            .as_ref()
            .map(|p| {
                std::path::Path::new(p.shell())
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            })
            .unwrap_or_else(|| "no shell".to_owned());
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
                            .child(Codicon::TERMINAL.render(14., c.icon))
                            .child(SharedString::from(shell)),
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

    fn send(&mut self, bytes: &[u8]) {
        self.selection = None;
        if let Ok(mut emu) = self.emulator.lock() {
            emu.grid_mut().scroll_to_bottom();
        }
        if let Some(pty) = &self.pty {
            let _ = pty.write(bytes);
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        let m = ks.modifiers;
        if m.platform && !m.control && !m.alt {
            match ks.key.as_str() {
                "c" if self.selection.is_some() => {
                    if let Some(text) = self.selected_text() {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                    cx.stop_propagation();
                }
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                        self.paste(&text);
                    }
                    cx.stop_propagation();
                }
                // Other ⌘ shortcuts belong to the workbench.
                _ => {}
            }
            return;
        }
        let app_cursor = self
            .emulator
            .lock()
            .map(|e| e.application_cursor_keys())
            .unwrap_or(false);

        let bytes: Vec<u8> = if m.control && !m.platform {
            match ks.key.as_str() {
                k if k.len() == 1 && k.is_ascii() => {
                    let c = k.as_bytes()[0].to_ascii_lowercase();
                    if c.is_ascii_lowercase() {
                        vec![c & 0x1f]
                    } else {
                        return;
                    }
                }
                _ => return,
            }
        } else {
            match ks.key.as_str() {
                "enter" => b"\r".to_vec(),
                "backspace" => vec![0x7f],
                "tab" => b"\t".to_vec(),
                "escape" => vec![0x1b],
                "space" => b" ".to_vec(),
                "up" => arrow(b'A', app_cursor),
                "down" => arrow(b'B', app_cursor),
                "right" => arrow(b'C', app_cursor),
                "left" => arrow(b'D', app_cursor),
                "home" => b"\x1b[H".to_vec(),
                "end" => b"\x1b[F".to_vec(),
                "delete" => b"\x1b[3~".to_vec(),
                _ => match &ks.key_char {
                    Some(ch) if !m.platform => ch.as_bytes().to_vec(),
                    _ => return,
                },
            }
        };
        self.send(&bytes);
        cx.stop_propagation();
    }
}

impl TerminalPanel {
    fn paste(&mut self, text: &str) {
        let bracketed = self
            .emulator
            .lock()
            .map(|e| e.bracketed_paste())
            .unwrap_or(false);
        let body = text.replace("\r\n", "\r").replace('\n', "\r");
        let bytes = if bracketed {
            format!("\x1b[200~{body}\x1b[201~")
        } else {
            body
        };
        self.send(bytes.as_bytes());
    }

    /// Lines of the viewport in absolute coordinates: (first line, rows).
    fn viewport(grid: &TerminalGrid) -> (usize, usize) {
        let rows = grid.rows() as usize;
        let total = grid.scrollback_len() + rows;
        let offset = grid.scroll_offset.min(grid.scrollback_len());
        (total - rows - offset, rows)
    }

    fn line(grid: &TerminalGrid, abs: usize) -> Option<&[Cell]> {
        let sb = grid.scrollback_len();
        if abs < sb {
            grid.scrollback_line(abs)
        } else {
            grid.cells().get(abs - sb).map(Vec::as_slice)
        }
    }

    fn ordered_selection(&self) -> Option<((usize, u16), (usize, u16))> {
        let (a, b) = self.selection?;
        if a == b {
            return None;
        }
        Some(if a <= b { (a, b) } else { (b, a) })
    }

    fn selected_text(&self) -> Option<String> {
        let (start, end) = self.ordered_selection()?;
        let emu = self.emulator.lock().ok()?;
        let grid = emu.grid();
        let mut out = Vec::new();
        for abs in start.0..=end.0 {
            let Some(cells) = Self::line(grid, abs) else {
                continue;
            };
            let from = if abs == start.0 { start.1 as usize } else { 0 };
            let to = if abs == end.0 {
                end.1 as usize
            } else {
                cells.len()
            };
            let text: String = cells
                .iter()
                .skip(from)
                .take(to.saturating_sub(from))
                .filter(|c| !c.is_wide_continuation())
                .map(|c| c.c)
                .collect();
            out.push(text.trim_end().to_owned());
        }
        Some(out.join("\n"))
    }

    /// Map a window position to an absolute (line, col) cell.
    fn hit(&self, pos: Point<Pixels>) -> Option<(usize, u16)> {
        let (origin, cell_w, line_h) = (*self.layout.lock().ok()?)?;
        let emu = self.emulator.lock().ok()?;
        let grid = emu.grid();
        let (first, rows) = Self::viewport(grid);
        let x = f32::from(pos.x - origin.x).max(0.);
        let y = f32::from(pos.y - origin.y).max(0.);
        let row = ((y / line_h) as usize).min(rows.saturating_sub(1));
        let col = ((x / cell_w).round() as u16).min(grid.cols());
        Some((first + row, col))
    }

    fn on_mouse_down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_handle.focus(window, cx);
        self.selection = self.hit(e.position).map(|p| (p, p));
        cx.notify();
    }

    fn on_mouse_move(&mut self, e: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if e.pressed_button != Some(MouseButton::Left) {
            return;
        }
        if let (Some((anchor, _)), Some(head)) = (self.selection, self.hit(e.position)) {
            self.selection = Some((anchor, head));
            cx.notify();
        }
    }

    fn on_scroll(&mut self, e: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let line_h = line_h();
        self.scroll_accum += f32::from(e.delta.pixel_delta(px(line_h)).y);
        let lines = (self.scroll_accum / line_h).trunc() as i32;
        if lines == 0 {
            return;
        }
        self.scroll_accum -= lines as f32 * line_h;
        let alt = self
            .emulator
            .lock()
            .map(|e| e.is_alternate_screen())
            .unwrap_or(false);
        if alt {
            // Full-screen apps (less, vim) get arrow keys, as in VSCode.
            let key = if lines > 0 {
                arrow(b'A', false)
            } else {
                arrow(b'B', false)
            };
            for _ in 0..lines.unsigned_abs() {
                if let Some(pty) = &self.pty {
                    let _ = pty.write(&key);
                }
            }
        } else if let Ok(mut emu) = self.emulator.lock() {
            let grid = emu.grid_mut();
            if lines > 0 {
                grid.scroll_viewport_up(lines as usize);
            } else {
                grid.scroll_viewport_down(lines.unsigned_abs() as usize);
            }
        }
        cx.notify();
    }
}

fn arrow(code: u8, app_cursor: bool) -> Vec<u8> {
    if app_cursor {
        vec![0x1b, b'O', code]
    } else {
        vec![0x1b, b'[', code]
    }
}

fn to_hsla(color: Color, default: Hsla, ansi: &[Hsla; 16]) -> Hsla {
    match color {
        Color::Default => default,
        Color::Named(n) => ansi[named_index(n)],
        Color::Indexed(i) if i < 16 => ansi[i as usize],
        Color::Indexed(i) if i < 232 => {
            let i = i - 16;
            let step = |v: u8| if v == 0 { 0u32 } else { 55 + 40 * v as u32 };
            let (r, g, b) = (step(i / 36), step((i / 6) % 6), step(i % 6));
            rgb((r << 16) | (g << 8) | b).into()
        }
        Color::Indexed(i) => {
            let v = 8 + 10 * (i as u32 - 232);
            rgb((v << 16) | (v << 8) | v).into()
        }
        Color::Rgb(r, g, b) => rgb(((r as u32) << 16) | ((g as u32) << 8) | b as u32).into(),
    }
}

fn named_index(n: NamedColor) -> usize {
    use NamedColor::*;
    match n {
        Black => 0,
        Red => 1,
        Green => 2,
        Yellow => 3,
        Blue => 4,
        Magenta => 5,
        Cyan => 6,
        White => 7,
        BrightBlack => 8,
        BrightRed => 9,
        BrightGreen => 10,
        BrightYellow => 11,
        BrightBlue => 12,
        BrightMagenta => 13,
        BrightCyan => 14,
        BrightWhite => 15,
    }
}

/// One styled run of a terminal row.
struct Run {
    text: String,
    fg: Hsla,
    bg: Option<Hsla>,
    bold: bool,
    italic: bool,
}

fn runs_for_row(
    row: &[Cell],
    cursor_col: Option<u16>,
    selected: Option<(u16, u16)>,
    colors: &theme::Colors,
) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for (col, cell) in row.iter().enumerate() {
        if cell.is_wide_continuation() {
            continue;
        }
        let (mut fg, mut bg) = (
            to_hsla(cell.fg, colors.terminal_fg, &colors.ansi),
            match cell.bg {
                Color::Default => None,
                other => Some(to_hsla(other, colors.terminal, &colors.ansi)),
            },
        );
        if cell.inverse() {
            let old_fg = fg;
            fg = bg.unwrap_or(colors.terminal);
            bg = Some(old_fg);
        }
        if selected.is_some_and(|(from, to)| (col as u16) >= from && (col as u16) < to) {
            bg = Some(colors.terminal_selection);
        }
        if cursor_col == Some(col as u16) {
            fg = colors.terminal;
            bg = Some(colors.terminal_cursor);
        }
        let bold = cell.bold();
        let italic = cell.italic();
        let ch = if cell.hidden() { ' ' } else { cell.c };
        match runs.last_mut() {
            Some(r) if r.fg == fg && r.bg == bg && r.bold == bold && r.italic == italic => {
                r.text.push(ch);
            }
            _ => runs.push(Run {
                text: ch.to_string(),
                fg,
                bg,
                bold,
                italic,
            }),
        }
    }
    runs
}

impl Focusable for TerminalPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for TerminalPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = theme::colors();
        let focus_handle = self.focus_handle.clone();

        // Cell metrics for the monospace font, used to size the grid.
        let font_id = window.text_system().resolve_font(&font(font_family()));
        let cell_w = window
            .text_system()
            .em_width(font_id, px(font_size()))
            .map(f32::from)
            .unwrap_or(7.2);
        let line_h = line_h();
        let pending = Arc::clone(&self.pending_size);
        let layout = Arc::clone(&self.layout);
        let measure = canvas(
            move |bounds, _, _| {
                let cols = (f32::from(bounds.size.width) / cell_w).floor() as u16;
                let rows = (f32::from(bounds.size.height) / line_h).floor() as u16;
                if let Ok(mut p) = pending.lock() {
                    *p = Some((rows, cols));
                }
                if let Ok(mut l) = layout.lock() {
                    *l = Some((bounds.origin, cell_w, line_h));
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        let selection = self.ordered_selection();
        let mut lines: Vec<AnyElement> = Vec::new();
        if let Some(err) = &self.error {
            lines.push(
                div()
                    .text_color(colors.ansi[1])
                    .child(err.clone())
                    .into_any_element(),
            );
        }
        if let Ok(emu) = self.emulator.lock() {
            let grid = emu.grid();
            let (first, rows) = Self::viewport(grid);
            let (cur_row, cur_col) = grid.cursor_position();
            let live = grid.scroll_offset == 0;
            let show_cursor = emu.cursor_visible() && live;
            for r in 0..rows {
                let abs = first + r;
                let Some(row) = Self::line(grid, abs) else {
                    continue;
                };
                let cursor_col = (show_cursor && r as u16 == cur_row).then_some(cur_col);
                let selected = selection.and_then(|(s, e)| {
                    (abs >= s.0 && abs <= e.0).then(|| {
                        let from = if abs == s.0 { s.1 } else { 0 };
                        let to = if abs == e.0 { e.1 } else { u16::MAX };
                        (from, to)
                    })
                });
                let runs = runs_for_row(row, cursor_col, selected, colors);
                let mut line = div().flex().flex_row().h(px(line_h)).whitespace_nowrap();
                for run in runs {
                    let mut span = div().text_color(run.fg).child(run.text);
                    if let Some(bg) = run.bg {
                        span = span.bg(bg);
                    }
                    if run.bold {
                        span = span.font_weight(FontWeight::BOLD);
                    }
                    if run.italic {
                        span = span.italic();
                    }
                    line = line.child(span);
                }
                lines.push(line.into_any_element());
            }
        }

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.panel)
            .child(self.panel_header())
            .child(
                div()
                    .id("terminal")
                    .track_focus(&focus_handle)
                    .key_context("Terminal")
                    .on_key_down(cx.listener(Self::on_key_down))
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .on_scroll(cx.listener(Self::on_scroll))
                    .cursor(CursorStyle::IBeam)
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_hidden()
                    .bg(colors.terminal)
                    .text_color(colors.terminal_fg)
                    .font_family(font_family())
                    .text_size(px(font_size()))
                    .line_height(px(line_h))
                    .pl(z(20.))
                    .pr(z(8.))
                    .pt(z(4.))
                    .child(
                        div()
                            .relative()
                            .size_full()
                            .child(measure)
                            .child(div().flex().flex_col().children(lines)),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(cells: &[Cell]) -> String {
        cells
            .iter()
            .map(|c| c.c)
            .collect::<String>()
            .trim_end()
            .to_owned()
    }

    #[::core::prelude::v1::test]
    fn viewport_walks_back_through_scrollback() {
        let mut emu = TerminalEmulator::new(TerminalGrid::new(5, 20));
        for i in 0..30 {
            emu.process(format!("line {i}\r\n").as_bytes());
        }
        let grid = emu.grid_mut();
        let (first, rows) = TerminalPanel::viewport(grid);
        let live: Vec<_> = (first..first + rows)
            .map(|l| text(TerminalPanel::line(grid, l).unwrap()))
            .collect();
        println!("live: {live:?}");
        assert_eq!(live[0], "line 26");

        grid.scroll_viewport_up(10);
        let (first, _) = TerminalPanel::viewport(grid);
        let top = text(TerminalPanel::line(grid, first).unwrap());
        println!("scrolled top: {top:?}");
        assert_eq!(top, "line 16");
    }
}

//! Paints the terminal grid cell-exactly.
//!
//! Rows of `div`s can't keep a monospace grid aligned once a line mixes
//! fonts (powerline glyphs, CJK, emoji fall back to other faces), so this
//! element positions every text batch at its column: ASCII runs of one style
//! are shaped together, anything else is shaped on its own at its cell.
//! Same approach as Zed's terminal element.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point as GridPoint};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors as TermColors;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, CursorShape, NamedColor, Rgb};
use gpui_kit::*;

use crate::terminal_panel::{GridLayout, TerminalPanel};
use crate::theme;

pub struct TerminalElement {
    panel: Entity<TerminalPanel>,
    focus: FocusHandle,
}

impl TerminalElement {
    pub fn new(panel: Entity<TerminalPanel>, focus: FocusHandle) -> Self {
        Self { panel, focus }
    }
}

/// One cell's resolved look, copied out while the terminal is locked.
#[derive(Clone)]
struct StyledCell {
    line: usize,
    col: usize,
    /// 2 for a wide (CJK, emoji) character.
    width: usize,
    text: String,
    fg: Hsla,
    bg: Option<Hsla>,
    selected: bool,
    bold: bool,
    italic: bool,
    underline: Option<bool>, // Some(wavy)
    strike: bool,
}

impl StyledCell {
    fn same_style(&self, other: &Self) -> bool {
        self.fg == other.fg
            && self.bold == other.bold
            && self.italic == other.italic
            && self.underline == other.underline
            && self.strike == other.strike
    }
}

struct Cursor {
    bounds: Bounds<Pixels>,
    shape: CursorShape,
}

pub struct Prepaint {
    backgrounds: Vec<(Bounds<Pixels>, Hsla)>,
    selections: Vec<Bounds<Pixels>>,
    glyphs: Vec<(Point<Pixels>, ShapedLine)>,
    cursor: Option<Cursor>,
    link_underline: Option<Bounds<Pixels>>,
    marked: Option<(Bounds<Pixels>, ShapedLine)>,
    line_h: Pixels,
    focused: bool,
}

fn rgb_hsla(c: Rgb) -> Hsla {
    rgb(((c.r as u32) << 16) | ((c.g as u32) << 8) | c.b as u32).into()
}

pub fn hsla_rgb(c: Hsla) -> Rgb {
    let c = Rgba::from(c);
    let byte = |v: f32| (v.clamp(0., 1.) * 255.).round() as u8;
    Rgb {
        r: byte(c.r),
        g: byte(c.g),
        b: byte(c.b),
    }
}

/// Colour for palette slot `i` (0–255 xterm, then alacritty's named slots),
/// preferring what the application set with OSC 4/10/11.
pub fn palette(i: usize, overrides: &TermColors, colors: &theme::Colors) -> Hsla {
    if let Some(c) = overrides[i] {
        return rgb_hsla(c);
    }
    let dim = |c: Hsla| c.opacity(0.5);
    match i {
        0..=15 => colors.ansi[i],
        16..=231 => {
            let i = i - 16;
            let step = |v: usize| if v == 0 { 0 } else { 55 + 40 * v as u8 };
            rgb_hsla(Rgb {
                r: step(i / 36),
                g: step((i / 6) % 6),
                b: step(i % 6),
            })
        }
        232..=255 => {
            let v = 8 + 10 * (i - 232) as u8;
            rgb_hsla(Rgb { r: v, g: v, b: v })
        }
        _ => match i {
            x if x == NamedColor::Foreground as usize => colors.terminal_fg,
            x if x == NamedColor::Background as usize => colors.terminal,
            x if x == NamedColor::Cursor as usize => colors.terminal_cursor,
            x if x == NamedColor::BrightForeground as usize => colors.terminal_fg,
            x if x == NamedColor::DimForeground as usize => dim(colors.terminal_fg),
            // DimBlack..DimWhite follow Cursor in order.
            x if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&x) => {
                dim(colors.ansi[x - NamedColor::DimBlack as usize])
            }
            _ => colors.terminal_fg,
        },
    }
}

fn resolve(color: AnsiColor, overrides: &TermColors, colors: &theme::Colors) -> Hsla {
    match color {
        AnsiColor::Spec(c) => rgb_hsla(c),
        AnsiColor::Named(n) => palette(n as usize, overrides, colors),
        AnsiColor::Indexed(i) => palette(i as usize, overrides, colors),
    }
}

/// VSCode's `terminal.integrated.drawBoldTextInBrightColors` (on by default).
fn brighten(color: AnsiColor) -> AnsiColor {
    match color {
        AnsiColor::Named(n) if (n as usize) < 8 => AnsiColor::Named(n.to_bright()),
        AnsiColor::Indexed(i) if i < 8 => AnsiColor::Indexed(i + 8),
        other => other,
    }
}

fn is_default_bg(color: AnsiColor) -> bool {
    matches!(color, AnsiColor::Named(NamedColor::Background))
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let colors = theme::colors();
        let family = crate::terminal_panel::font_family();
        let font_size = px(crate::terminal_panel::font_size());
        let line_h = px(crate::terminal_panel::line_h());
        let focused = self.focus.is_focused(window);

        let regular = font(family);
        let font_id = window.text_system().resolve_font(&regular);
        let cell_w = window
            .text_system()
            .advance(font_id, font_size, 'm')
            .map(|s| s.width)
            .unwrap_or(px(7.2));

        let layout = GridLayout {
            origin: bounds.origin,
            cell_w,
            line_h,
            cols: (f32::from(bounds.size.width) / f32::from(cell_w))
                .floor()
                .max(2.) as usize,
            rows: (f32::from(bounds.size.height) / f32::from(line_h))
                .floor()
                .max(1.) as usize,
        };
        self.panel
            .update(cx, |panel, _| panel.set_layout(layout.clone()));

        // Copy what we draw out of the terminal, then let the PTY thread go.
        let mut cells: Vec<StyledCell> = Vec::new();
        let mut cursor_cell: Option<(usize, usize, usize, CursorShape)> = None;
        let mut link: Option<(usize, usize, usize)> = None;
        let marked_text: Option<String>;
        {
            let panel = self.panel.read(cx);
            marked_text = panel.marked_text().map(str::to_owned);
            if let Some(term) = panel.term() {
                let term = term.lock();
                let content = term.renderable_content();
                let offset = content.display_offset;
                let overrides = content.colors;
                let rows = term.screen_lines();

                let cur = content.cursor;
                let cur_line = cur.point.line.0 + offset as i32;
                if cur.shape != CursorShape::Hidden && (0..rows as i32).contains(&cur_line) {
                    let wide = term.grid()[cur.point].flags.contains(Flags::WIDE_CHAR);
                    cursor_cell = Some((
                        cur_line as usize,
                        cur.point.column.0,
                        if wide { 2 } else { 1 },
                        cur.shape,
                    ));
                }
                link = panel.hovered_link().and_then(|(start, end)| {
                    let line = start.line.0 + offset as i32;
                    (0..rows as i32).contains(&line).then_some((
                        line as usize,
                        start.column.0,
                        end.column.0 + 1,
                    ))
                });

                let selection = content.selection;
                for indexed in content.display_iter {
                    let cell = indexed.cell;
                    if cell
                        .flags
                        .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                    {
                        continue;
                    }
                    let line = (indexed.point.line.0 + offset as i32) as usize;
                    let col = indexed.point.column.0;
                    let flags = cell.flags;

                    let fg_color = if flags.contains(Flags::BOLD) {
                        brighten(cell.fg)
                    } else {
                        cell.fg
                    };
                    let mut fg = resolve(fg_color, overrides, colors);
                    if flags.contains(Flags::DIM) {
                        fg = fg.opacity(0.5);
                    }
                    let mut bg =
                        (!is_default_bg(cell.bg)).then(|| resolve(cell.bg, overrides, colors));
                    if flags.contains(Flags::INVERSE) {
                        let old_fg = fg;
                        fg = bg.unwrap_or(colors.terminal);
                        bg = Some(old_fg);
                    }
                    let is_cursor = focused
                        && cursor_cell.is_some_and(|(l, c, _, shape)| {
                            l == line && c == col && shape == CursorShape::Block
                        });
                    if is_cursor && marked_text.is_none() {
                        fg = colors.terminal_cursor_text;
                        bg = Some(colors.terminal_cursor);
                    }

                    let mut text = String::new();
                    if !flags.contains(Flags::HIDDEN) {
                        text.push(cell.c);
                        if let Some(zw) = cell.zerowidth() {
                            text.extend(zw);
                        }
                    }
                    let underline = if flags.contains(Flags::UNDERCURL) {
                        Some(true)
                    } else if flags.intersects(Flags::ALL_UNDERLINES) {
                        Some(false)
                    } else {
                        None
                    };
                    cells.push(StyledCell {
                        line,
                        col,
                        width: if flags.contains(Flags::WIDE_CHAR) {
                            2
                        } else {
                            1
                        },
                        text,
                        fg,
                        bg,
                        selected: selection.is_some_and(|s| s.contains(indexed.point)),
                        bold: flags.contains(Flags::BOLD),
                        italic: flags.contains(Flags::ITALIC),
                        underline,
                        strike: flags.contains(Flags::STRIKEOUT),
                    });
                }
            }
        }

        let cell_bounds = |line: usize, col: usize, width: usize| {
            Bounds::new(
                point(
                    bounds.origin.x + cell_w * col as f32,
                    bounds.origin.y + line_h * line as f32,
                ),
                size(cell_w * width as f32, line_h),
            )
        };

        // Backgrounds and selection, merged across runs of equal cells.
        let mut backgrounds: Vec<(Bounds<Pixels>, Hsla)> = Vec::new();
        let mut selections: Vec<Bounds<Pixels>> = Vec::new();
        for cell in &cells {
            let b = cell_bounds(cell.line, cell.col, cell.width);
            if let Some(bg) = cell.bg {
                match backgrounds.last_mut() {
                    Some((last, color))
                        if *color == bg
                            && last.origin.y == b.origin.y
                            && last.right() == b.left() =>
                    {
                        last.size.width += b.size.width;
                    }
                    _ => backgrounds.push((b, bg)),
                }
            }
            if cell.selected {
                match selections.last_mut() {
                    Some(last) if last.origin.y == b.origin.y && last.right() == b.left() => {
                        last.size.width += b.size.width;
                    }
                    _ => selections.push(b),
                }
            }
        }

        // Text: batch ASCII cells of one style; shape everything else alone.
        let font_for = |bold: bool, italic: bool| {
            let mut f = regular.clone();
            if bold {
                f.weight = FontWeight::BOLD;
            }
            if italic {
                f.style = FontStyle::Italic;
            }
            f
        };
        let mut glyphs: Vec<(Point<Pixels>, ShapedLine)> = Vec::new();
        let shape = |batch: &StyledCell, glyphs: &mut Vec<(Point<Pixels>, ShapedLine)>| {
            if batch.text.is_empty() {
                return;
            }
            let run = TextRun {
                len: batch.text.len(),
                font: font_for(batch.bold, batch.italic),
                color: batch.fg,
                background_color: None,
                underline: batch.underline.map(|wavy| UnderlineStyle {
                    thickness: px(1.),
                    color: Some(batch.fg),
                    wavy,
                }),
                strikethrough: batch.strike.then_some(StrikethroughStyle {
                    thickness: px(1.),
                    color: Some(batch.fg),
                }),
            };
            let shaped = window.text_system().shape_line(
                SharedString::from(batch.text.clone()),
                font_size,
                &[run],
                None,
            );
            glyphs.push((cell_bounds(batch.line, batch.col, 1).origin, shaped));
        };
        let mut batch: Option<StyledCell> = None;
        let mut batch_cells = 0;
        for cell in cells {
            let blank = cell.text.trim().is_empty() && cell.underline.is_none() && !cell.strike;
            let ascii = cell.text.len() == 1 && cell.text.is_ascii();
            let extends = batch.as_ref().is_some_and(|b| {
                ascii
                    && b.text.is_ascii()
                    && b.line == cell.line
                    && b.col + batch_cells == cell.col
                    && b.same_style(&cell)
            });
            if extends && !blank {
                if let Some(b) = batch.as_mut() {
                    b.text.push_str(&cell.text);
                    batch_cells += 1;
                }
                continue;
            }
            if let Some(b) = batch.take() {
                shape(&b, &mut glyphs);
            }
            if blank {
                continue;
            }
            batch_cells = cell.width;
            if ascii {
                batch = Some(cell);
            } else {
                shape(&cell, &mut glyphs);
            }
        }
        if let Some(b) = batch.take() {
            shape(&b, &mut glyphs);
        }

        let cursor = cursor_cell.map(|(line, col, width, shape)| Cursor {
            bounds: cell_bounds(line, col, width),
            shape,
        });

        // IME composition is drawn over the cursor, underlined.
        let marked = marked_text.zip(cursor.as_ref()).map(|(text, cursor)| {
            let run = TextRun {
                len: text.len(),
                font: regular.clone(),
                color: colors.terminal_fg,
                background_color: None,
                underline: Some(UnderlineStyle {
                    thickness: px(1.),
                    color: Some(colors.terminal_fg),
                    wavy: false,
                }),
                strikethrough: None,
            };
            let shaped =
                window
                    .text_system()
                    .shape_line(SharedString::from(text), font_size, &[run], None);
            let b = Bounds::new(
                cursor.bounds.origin,
                size(shaped.width().max(cell_w), line_h),
            );
            (b, shaped)
        });

        if let Some(c) = &cursor {
            let ime_bounds = marked.as_ref().map(|(b, _)| *b).unwrap_or(c.bounds);
            self.panel
                .update(cx, |panel, _| panel.set_ime_bounds(ime_bounds));
        }

        let link_underline = link.map(|(line, start, end)| {
            let b = cell_bounds(line, start, end.saturating_sub(start).max(1));
            Bounds::new(
                point(b.origin.x, b.bottom() - px(1.)),
                size(b.size.width, px(1.)),
            )
        });

        Prepaint {
            backgrounds,
            selections,
            glyphs,
            cursor,
            link_underline,
            marked,
            line_h,
            focused,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let colors = theme::colors();
        window.handle_input(
            &self.focus,
            ElementInputHandler::new(bounds, self.panel.clone()),
            cx,
        );
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for (b, color) in &prepaint.backgrounds {
                window.paint_quad(fill(*b, *color));
            }
            for b in &prepaint.selections {
                window.paint_quad(fill(*b, colors.terminal_selection));
            }
            for (origin, line) in &prepaint.glyphs {
                let _ = line.paint(*origin, prepaint.line_h, TextAlign::Left, None, window, cx);
            }
            if let Some(b) = prepaint.link_underline {
                window.paint_quad(fill(b, colors.terminal_fg));
            }
            if let Some((b, line)) = &prepaint.marked {
                window.paint_quad(fill(*b, colors.terminal));
                let _ = line.paint(b.origin, prepaint.line_h, TextAlign::Left, None, window, cx);
                return;
            }
            if let Some(cursor) = &prepaint.cursor {
                let b = cursor.bounds;
                let bar = px(2.);
                match (prepaint.focused, cursor.shape) {
                    // Drawn into the cell's colours during prepaint.
                    (true, CursorShape::Block) => {}
                    (true, CursorShape::Beam) => {
                        window.paint_quad(fill(
                            Bounds::new(b.origin, size(bar, b.size.height)),
                            colors.terminal_cursor,
                        ));
                    }
                    (true, CursorShape::Underline) => {
                        window.paint_quad(fill(
                            Bounds::new(
                                point(b.origin.x, b.bottom() - bar),
                                size(b.size.width, bar),
                            ),
                            colors.terminal_cursor,
                        ));
                    }
                    // Unfocused (or an app-requested hollow block): outline.
                    _ => {
                        window.paint_quad(outline(b, colors.terminal_cursor, BorderStyle::Solid));
                    }
                }
            }
        });
    }
}

/// Grid point for the cell under a viewport (line, column).
pub fn viewport_point(display_offset: usize, line: usize, col: usize) -> GridPoint {
    GridPoint::new(Line(line as i32 - display_offset as i32), Column(col))
}

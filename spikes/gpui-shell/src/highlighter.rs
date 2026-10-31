//! TextMate-scope highlighter for gpui-kit's editor, coloured by the user's
//! VSCode theme rules.
//!
//! gpui-kit's own syntect backend folds every TextMate scope down to ~40
//! Zed-style names (`keyword.control` and `storage.type` both become
//! `keyword`), so no VSCode theme can look right through it. This keeps the
//! full scope stack and matches `tokenColors` selectors against it the way
//! VSCode does: descendant selectors (`comment keyword`), deepest match
//! first, then the most specific selector, then the later rule.

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Duration;

use gpui_kit::base::input::{
    EditorState, FoldRange, HighlightStyleResolver, InputEdit, InputHighlighter,
    InputHighlighterFactory,
};
use gpui_kit::*;
use ropey::Rope;
use sidex_theme::{FontStyle as TmFontStyle, TokenColorRule};
use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};

use crate::theme::parse_hex;
use crate::vscode;

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);

/// Documents up to this size are parsed synchronously on every edit.
const SYNC_PARSE_MAX_BYTES: usize = 128 * 1024;

struct Rule {
    /// Each selector is a list of descendant parts: `comment keyword` ->
    /// `["comment", "keyword"]`.
    selectors: Vec<Vec<String>>,
    style: HighlightStyle,
}

struct Rules(Vec<Rule>);

static RULES: LazyLock<Rules> = LazyLock::new(|| {
    Rules(
        vscode::get()
            .token_rules
            .iter()
            .filter_map(compile_rule)
            .collect(),
    )
});

fn compile_rule(r: &TokenColorRule) -> Option<Rule> {
    let color = r
        .foreground
        .map(|c| parse_hex(&c.to_hex()).unwrap_or_default());
    let fs = r.font_style;
    let style = HighlightStyle {
        color,
        font_style: fs
            .contains(TmFontStyle::ITALIC)
            .then_some(FontStyle::Italic),
        font_weight: fs.contains(TmFontStyle::BOLD).then_some(FontWeight::BOLD),
        underline: fs.contains(TmFontStyle::UNDERLINE).then(|| UnderlineStyle {
            thickness: px(1.),
            ..Default::default()
        }),
        ..Default::default()
    };
    let selectors: Vec<Vec<String>> = r
        .scope
        .iter()
        // Exclusions (`a - b`) are rare in themes; keep only the include part.
        .map(|s| s.split(" - ").next().unwrap_or("").trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.split_whitespace().map(str::to_owned).collect())
        .collect();
    (!selectors.is_empty()).then_some(Rule { selectors, style })
}

fn prefix_match(scope: &str, sel: &str) -> bool {
    scope == sel || (scope.starts_with(sel) && scope.as_bytes().get(sel.len()) == Some(&b'.'))
}

/// Score a descendant selector against a scope stack (outermost first).
/// Returns (depth of the deepest matched scope, specificity) or None.
fn score(selector: &[String], stack: &[String]) -> Option<(usize, usize)> {
    let (last, parents) = selector.split_last()?;
    let depth = stack.iter().rposition(|s| prefix_match(s, last))?;
    let mut upto = depth;
    for p in parents.iter().rev() {
        upto = stack[..upto].iter().rposition(|s| prefix_match(s, p))?;
    }
    let specificity = selector.iter().map(|s| s.split('.').count()).sum();
    Some((depth, specificity))
}

impl Rules {
    /// VSCode-style resolution: colour and font style resolve independently.
    fn style_for(&self, stack: &[String]) -> HighlightStyle {
        let mut best_color: Option<((usize, usize), Hsla)> = None;
        let mut best_font: Option<((usize, usize), &HighlightStyle)> = None;
        for rule in &self.0 {
            let Some(s) = rule
                .selectors
                .iter()
                .filter_map(|sel| score(sel, stack))
                .max()
            else {
                continue;
            };
            if let Some(c) = rule.style.color {
                if best_color.is_none_or(|(b, _)| s >= b) {
                    best_color = Some((s, c));
                }
            }
            let has_font = rule.style.font_style.is_some()
                || rule.style.font_weight.is_some()
                || rule.style.underline.is_some();
            // A rule with `fontStyle: ""` still resets inherited italics in
            // VSCode; sidex-theme doesn't keep that distinction, so only
            // rules that set a style compete here.
            if has_font && best_font.is_none_or(|(b, _)| s >= b) {
                best_font = Some((s, &rule.style));
            }
        }
        let mut out = HighlightStyle {
            color: best_color.map(|(_, c)| c),
            ..Default::default()
        };
        if let Some((_, f)) = best_font {
            out.font_style = f.font_style;
            out.font_weight = f.font_weight;
            out.underline = f.underline;
        }
        out
    }
}

type Runs = Vec<(Range<usize>, HighlightStyle)>;

fn parse(syntax: &SyntaxReference, text: &str) -> Runs {
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut names: Vec<String> = Vec::new();
    let mut runs: Runs = Vec::new();
    let mut cache: std::collections::HashMap<Vec<String>, HighlightStyle> = Default::default();
    let rules = &*RULES;

    let mut push = |range: Range<usize>, names: &Vec<String>, runs: &mut Runs| {
        if range.is_empty() {
            return;
        }
        let style = *cache
            .entry(names.clone())
            .or_insert_with(|| rules.style_for(names));
        match runs.last_mut() {
            Some((r, s)) if r.end == range.start && *s == style => r.end = range.end,
            _ => runs.push((range, style)),
        }
    };

    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let Ok(ops) = state.parse_line(line, &SYNTAXES) else {
            push(offset..offset + line.len(), &names, &mut runs);
            offset += line.len();
            continue;
        };
        let mut cursor = 0;
        for (ix, op) in ops {
            push(offset + cursor..offset + ix, &names, &mut runs);
            cursor = ix;
            if stack.apply(&op).is_ok() {
                names = stack.as_slice().iter().map(|s| s.build_string()).collect();
            }
        }
        push(offset + cursor..offset + line.len(), &names, &mut runs);
        offset += line.len();
    }
    runs
}

fn brace_folds(text: &str) -> Vec<FoldRange> {
    let mut starts = Vec::new();
    let mut folds = Vec::new();
    for (line_ix, line) in text.lines().enumerate() {
        for ch in line.chars() {
            match ch {
                '{' | '[' | '(' => starts.push(line_ix),
                '}' | ']' | ')' => {
                    if let Some(start) = starts.pop() {
                        if line_ix > start {
                            folds.push(FoldRange {
                                start_line: start,
                                end_line: line_ix,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
    folds.sort_by_key(|f| f.start_line);
    folds
}

struct ThemedHighlighter {
    language: SharedString,
    syntax: &'static SyntaxReference,
    runs: Rc<RefCell<Runs>>,
    folds: Rc<RefCell<Vec<FoldRange>>>,
    task: Option<Task<()>>,
}

fn shift(runs: &mut Runs, edit: &InputEdit) {
    let delta = edit.new_end_byte as isize - edit.old_end_byte as isize;
    runs.retain(|(r, _)| r.end <= edit.start_byte || r.start >= edit.old_end_byte);
    for (r, _) in runs.iter_mut() {
        if r.start >= edit.old_end_byte {
            r.start = (r.start as isize + delta) as usize;
            r.end = (r.end as isize + delta) as usize;
        }
    }
}

impl InputHighlighter for ThemedHighlighter {
    fn language(&self) -> SharedString {
        self.language.clone()
    }

    fn update(
        &mut self,
        edit: Option<InputEdit>,
        text: &Rope,
        folding: bool,
        window: &mut Window,
        cx: &mut Context<EditorState>,
    ) {
        if let Some(edit) = edit {
            shift(&mut self.runs.borrow_mut(), &edit);
        }
        if text.len() <= SYNC_PARSE_MAX_BYTES {
            self.task = None;
            let text = text.to_string();
            *self.runs.borrow_mut() = parse(self.syntax, &text);
            *self.folds.borrow_mut() = if folding {
                brace_folds(&text)
            } else {
                Vec::new()
            };
            return;
        }
        let syntax = self.syntax;
        let runs = self.runs.clone();
        let folds = self.folds.clone();
        let text = text.clone();
        self.task = Some(cx.spawn_in(window, async move |entity, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(150))
                .await;
            let (parsed, folded) = cx
                .background_executor()
                .spawn(async move {
                    let text = text.to_string();
                    let f = if folding {
                        brace_folds(&text)
                    } else {
                        Vec::new()
                    };
                    (parse(syntax, &text), f)
                })
                .await;
            *runs.borrow_mut() = parsed;
            *folds.borrow_mut() = folded.clone();
            let _ = entity.update(cx, |state, cx| {
                state.apply_highlighter_fold_candidates(folded, cx);
            });
        }));
    }

    fn styles(
        &self,
        range: &Range<usize>,
        _resolver: &dyn HighlightStyleResolver,
    ) -> Vec<(Range<usize>, HighlightStyle)> {
        let runs = self.runs.borrow();
        let first = runs.partition_point(|(r, _)| r.end <= range.start);
        let mut out = Vec::new();
        let mut cursor = range.start;
        for (r, style) in &runs[first..] {
            if r.start >= range.end {
                break;
            }
            let start = r.start.max(cursor);
            let end = r.end.min(range.end);
            if start >= end {
                continue;
            }
            if cursor < start {
                out.push((cursor..start, HighlightStyle::default()));
            }
            out.push((start..end, *style));
            cursor = end;
        }
        if cursor < range.end {
            out.push((cursor..range.end, HighlightStyle::default()));
        }
        out
    }

    fn fold_ranges(&self, _: &Rope) -> Vec<FoldRange> {
        self.folds.borrow().clone()
    }
}

/// Find a grammar for a file: by extension, then by full name, then by the
/// VSCode language id.
pub fn syntax_for(file_name: &str) -> Option<&'static SyntaxReference> {
    let lower = file_name.to_lowercase();
    let mut rest = lower.as_str();
    while let Some(ix) = rest.find('.') {
        rest = &rest[ix + 1..];
        if let Some(s) = SYNTAXES.find_syntax_by_extension(rest) {
            return Some(s);
        }
    }
    if let Some(s) = SYNTAXES.find_syntax_by_extension(&lower) {
        return Some(s);
    }
    let lang = vscode::get().language_for(file_name)?;
    SYNTAXES
        .find_syntax_by_token(lang)
        .or_else(|| SYNTAXES.find_syntax_by_name(lang))
}

pub fn factory(file_name: String) -> InputHighlighterFactory {
    Rc::new(move |_language: &str| {
        let syntax = syntax_for(&file_name)?;
        Some(Box::new(ThemedHighlighter {
            language: syntax.name.clone().into(),
            syntax,
            runs: Rc::default(),
            folds: Rc::default(),
            task: None,
        }) as Box<dyn InputHighlighter>)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn rust_tokens_get_theme_colours() {
        let src =
            "// note\nfn main() {\n    let x: u32 = 42;\n    if x > 1 { println!(\"hi\"); }\n}\n";
        let syntax = syntax_for("main.rs").expect("rust grammar");
        for (r, style) in parse(syntax, src) {
            let text = &src[r.clone()];
            if text.trim().is_empty() {
                continue;
            }
            let color = style.color.map(|c| {
                let rgb = c.to_rgb();
                format!(
                    "#{:02x}{:02x}{:02x}",
                    (rgb.r * 255.) as u8,
                    (rgb.g * 255.) as u8,
                    (rgb.b * 255.) as u8
                )
            });
            println!("{text:?} -> {color:?} italic={:?}", style.font_style);
        }
    }
}

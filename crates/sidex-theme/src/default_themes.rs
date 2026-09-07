//! Built-in default themes ported from VS Code.
//!
//! Provides four const-constructable themes: Default Dark Modern,
//! Default Light Modern, High Contrast, and High Contrast Light.

use crate::color::Color;
use crate::theme::{Theme, ThemeKind};
use crate::token_color::{FontStyle, TokenColorRule};
use crate::workbench_colors::WorkbenchColors;

/// "Default Dark Modern" — the VS Code default dark theme.
pub fn dark_modern() -> Theme {
    Theme {
        name: "Default Dark Modern".to_owned(),
        kind: ThemeKind::Dark,
        token_colors: dark_modern_tokens(),
        workbench_colors: WorkbenchColors::default_dark(),
    }
}

/// "Quiet Light" — the VS Code Quiet Light theme.
pub fn quiet_light() -> Theme {
    Theme {
        name: "Quiet Light".to_owned(),
        kind: ThemeKind::Light,
        token_colors: quiet_light_tokens(),
        workbench_colors: WorkbenchColors::quiet_light(),
    }
}

/// "Default Light Modern" — the VS Code default light theme.
pub fn light_modern() -> Theme {
    Theme {
        name: "Default Light Modern".to_owned(),
        kind: ThemeKind::Light,
        token_colors: light_modern_tokens(),
        workbench_colors: WorkbenchColors::default_light(),
    }
}

/// "Default High Contrast" — dark high-contrast theme.
pub fn hc_black() -> Theme {
    Theme {
        name: "Default High Contrast".to_owned(),
        kind: ThemeKind::HighContrast,
        token_colors: hc_black_tokens(),
        workbench_colors: hc_black_colors(),
    }
}

/// "Default High Contrast Light" — light high-contrast theme.
pub fn hc_light() -> Theme {
    Theme {
        name: "Default High Contrast Light".to_owned(),
        kind: ThemeKind::HighContrastLight,
        token_colors: hc_light_tokens(),
        workbench_colors: hc_light_colors(),
    }
}

fn tok(scope: &str, fg: &str) -> TokenColorRule {
    TokenColorRule {
        name: None,
        scope: vec![scope.to_owned()],
        foreground: Color::from_hex(fg).ok(),
        background: None,
        font_style: FontStyle::NONE,
    }
}

fn tok_multi(scopes: &[&str], fg: &str) -> TokenColorRule {
    TokenColorRule {
        name: None,
        scope: scopes.iter().map(|s| (*s).to_owned()).collect(),
        foreground: Color::from_hex(fg).ok(),
        background: None,
        font_style: FontStyle::NONE,
    }
}

fn tok_styled(scope: &str, fg: &str, style: FontStyle) -> TokenColorRule {
    TokenColorRule {
        name: None,
        scope: vec![scope.to_owned()],
        foreground: Color::from_hex(fg).ok(),
        background: None,
        font_style: style,
    }
}

fn c(hex: &str) -> Option<Color> {
    Color::from_hex(hex).ok()
}

// ── Dark Modern token colors (from dark_plus / dark_modern base) ──────────

#[allow(clippy::too_many_lines)]
fn dark_modern_tokens() -> Vec<TokenColorRule> {
    vec![
        // Comments
        tok_styled("comment", "#6A9955", FontStyle::ITALIC),
        tok_styled("comment.line", "#6A9955", FontStyle::ITALIC),
        tok_styled("comment.block", "#6A9955", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#6A9955", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#6A9955"),
        // Strings
        tok("string", "#CE9178"),
        tok("string.quoted.single", "#CE9178"),
        tok("string.quoted.double", "#CE9178"),
        tok("string.template", "#CE9178"),
        tok("string.quoted.template", "#CE9178"),
        tok("string.regexp", "#D16969"),
        tok("string.interpolated", "#CE9178"),
        tok("constant.character.escape", "#D7BA7D"),
        tok_multi(&["string.quoted.triple", "string.quoted.raw"], "#CE9178"),
        // Numbers & constants
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
                "constant.numeric.octal",
                "constant.numeric.binary",
                "constant.other.color.rgb-value",
            ],
            "#B5CEA8",
        ),
        tok("constant.language", "#569CD6"),
        tok("constant.language.boolean", "#569CD6"),
        tok("constant.language.null", "#569CD6"),
        tok("constant.language.undefined", "#569CD6"),
        tok("constant.character", "#569CD6"),
        tok("constant.other", "#4FC1FF"),
        tok("constant.regexp", "#D16969"),
        // Variables
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#9CDCFE",
        ),
        tok("variable.other.readwrite", "#9CDCFE"),
        tok("variable.other.constant", "#4FC1FF"),
        tok("variable.other.enummember", "#4FC1FF"),
        tok("variable.other.property", "#9CDCFE"),
        tok("variable.other.object", "#9CDCFE"),
        tok("variable.parameter", "#9CDCFE"),
        tok("variable.language", "#569CD6"),
        tok("variable.language.this", "#569CD6"),
        tok("variable.language.self", "#569CD6"),
        tok("variable.language.super", "#569CD6"),
        tok("meta.object-literal.key", "#9CDCFE"),
        // Keywords
        tok("keyword", "#569CD6"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.loop",
                "keyword.control.conditional",
                "keyword.control.import",
                "keyword.control.from",
                "keyword.control.export",
                "keyword.other.using",
                "keyword.other.operator",
            ],
            "#C586C0",
        ),
        tok("keyword.operator", "#D4D4D4"),
        tok("keyword.operator.new", "#569CD6"),
        tok("keyword.operator.expression", "#569CD6"),
        tok("keyword.operator.logical", "#D4D4D4"),
        tok("keyword.operator.assignment", "#D4D4D4"),
        tok("keyword.operator.comparison", "#D4D4D4"),
        tok("keyword.operator.type", "#569CD6"),
        tok("keyword.operator.type.annotation", "#569CD6"),
        // Storage
        tok("storage", "#569CD6"),
        tok("storage.type", "#569CD6"),
        tok("storage.type.function", "#569CD6"),
        tok("storage.type.class", "#569CD6"),
        tok("storage.type.interface", "#569CD6"),
        tok("storage.type.enum", "#569CD6"),
        tok("storage.modifier", "#569CD6"),
        tok("storage.modifier.async", "#569CD6"),
        // Functions
        tok_multi(&["entity.name.function", "support.function"], "#DCDCAA"),
        tok("entity.name.function.member", "#DCDCAA"),
        tok("meta.function-call", "#DCDCAA"),
        tok("support.function.builtin", "#DCDCAA"),
        tok("entity.name.operator.custom-literal", "#DCDCAA"),
        // Types & classes
        tok_multi(
            &[
                "entity.name.type",
                "entity.name.class",
                "support.class",
                "support.type",
            ],
            "#4EC9B0",
        ),
        tok("entity.name.type.parameter", "#4EC9B0"),
        tok("entity.name.type.enum", "#4EC9B0"),
        tok("entity.name.type.interface", "#4EC9B0"),
        tok("entity.name.type.alias", "#4EC9B0"),
        tok("entity.name.type.module", "#4EC9B0"),
        tok("entity.name.type.numeric", "#4EC9B0"),
        tok_multi(
            &["meta.type.cast.expr", "entity.other.inherited-class"],
            "#4EC9B0",
        ),
        tok("support.type.primitive", "#4EC9B0"),
        tok("entity.name.namespace", "#4EC9B0"),
        // Tags & attributes (HTML/XML/JSX)
        tok("entity.name.tag", "#569CD6"),
        tok("entity.name.tag.html", "#569CD6"),
        tok("entity.name.tag.css", "#D7BA7D"),
        tok("entity.other.attribute-name", "#9CDCFE"),
        tok_multi(
            &[
                "entity.other.attribute-name.class.css",
                "entity.other.attribute-name.id.css",
                "entity.other.attribute-name.pseudo-class.css",
                "entity.other.attribute-name.pseudo-element.css",
            ],
            "#D7BA7D",
        ),
        // CSS property values
        tok("support.constant.property-value.css", "#CE9178"),
        tok("support.constant.font-name", "#CE9178"),
        tok("support.constant.color", "#CE9178"),
        tok("constant.other.color.rgb-value.hex", "#CE9178"),
        // Decorators / attributes / annotations
        tok_multi(
            &[
                "meta.decorator",
                "entity.name.function.decorator",
                "punctuation.decorator",
            ],
            "#DCDCAA",
        ),
        tok_multi(
            &["entity.other.attribute-name.pragma", "meta.attribute"],
            "#9CDCFE",
        ),
        // Preprocessor / macros
        tok("meta.preprocessor", "#569CD6"),
        tok("meta.preprocessor.string", "#CE9178"),
        tok("meta.preprocessor.numeric", "#B5CEA8"),
        tok("entity.name.function.preprocessor", "#569CD6"),
        tok_multi(
            &[
                "keyword.control.directive",
                "punctuation.definition.directive",
            ],
            "#569CD6",
        ),
        // Operators & punctuation
        tok("support.constant", "#569CD6"),
        tok("punctuation.definition.tag", "#808080"),
        tok("punctuation.separator", "#D4D4D4"),
        tok("punctuation.terminator", "#D4D4D4"),
        tok("punctuation.section", "#D4D4D4"),
        tok("punctuation.accessor", "#D4D4D4"),
        tok("meta.brace", "#D4D4D4"),
        // JSON
        tok("support.type.property-name.json", "#9CDCFE"),
        tok("string.value.json", "#CE9178"),
        // YAML
        tok("entity.name.tag.yaml", "#569CD6"),
        // TOML
        tok("entity.name.tag.toml", "#569CD6"),
        tok("support.type.property-name.toml", "#9CDCFE"),
        // Markup (Markdown, etc.)
        tok_styled("emphasis", "#D4D4D4", FontStyle::ITALIC),
        tok_styled("strong", "#D4D4D4", FontStyle::BOLD),
        tok_styled("markup.heading", "#6796E6", FontStyle::BOLD),
        tok_styled("markup.heading.setext", "#6796E6", FontStyle::BOLD),
        tok("markup.inserted", "#B5CEA8"),
        tok("markup.deleted", "#CE9178"),
        tok("markup.changed", "#569CD6"),
        tok_styled("markup.italic", "#D4D4D4", FontStyle::ITALIC),
        tok_styled("markup.bold", "#D4D4D4", FontStyle::BOLD),
        tok_styled("markup.underline", "#D4D4D4", FontStyle::UNDERLINE),
        tok_styled("markup.strikethrough", "#D4D4D4", FontStyle::STRIKETHROUGH),
        tok("markup.inline.raw", "#CE9178"),
        tok("markup.fenced_code.block", "#CE9178"),
        tok("markup.quote", "#6A9955"),
        tok("markup.list.numbered", "#6796E6"),
        tok("markup.list.unnumbered", "#6796E6"),
        tok("meta.link.inline.markdown", "#4daafc"),
        tok("string.other.link", "#4daafc"),
        // Rust-specific
        tok("entity.name.type.lifetime.rust", "#569CD6"),
        tok("keyword.operator.borrow.rust", "#569CD6"),
        tok("keyword.operator.sigil.rust", "#569CD6"),
        tok("entity.name.function.macro.rust", "#DCDCAA"),
        tok("meta.attribute.rust", "#9CDCFE"),
        // Invalid / deprecated
        tok("invalid", "#F44747"),
        tok("invalid.illegal", "#F44747"),
        tok_styled("invalid.deprecated", "#DCDCAA", FontStyle::STRIKETHROUGH),
    ]
}

#[allow(clippy::too_many_lines)]
fn light_modern_tokens() -> Vec<TokenColorRule> {
    vec![
        // Comments
        tok_styled("comment", "#008000", FontStyle::ITALIC),
        tok_styled("comment.line", "#008000", FontStyle::ITALIC),
        tok_styled("comment.block", "#008000", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#008000", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#008000"),
        // Strings
        tok("string", "#A31515"),
        tok("string.quoted.single", "#A31515"),
        tok("string.quoted.double", "#A31515"),
        tok("string.template", "#A31515"),
        tok("string.regexp", "#811F3F"),
        tok("string.interpolated", "#A31515"),
        tok("constant.character.escape", "#FF0000"),
        tok_multi(&["string.quoted.triple", "string.quoted.raw"], "#A31515"),
        // Numbers & constants
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
                "constant.numeric.octal",
                "constant.numeric.binary",
            ],
            "#098658",
        ),
        tok("constant.language", "#0000FF"),
        tok("constant.language.boolean", "#0000FF"),
        tok("constant.language.null", "#0000FF"),
        tok("constant.language.undefined", "#0000FF"),
        tok("constant.character", "#0000FF"),
        tok("constant.other", "#0070C1"),
        tok("constant.regexp", "#811F3F"),
        // Variables
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#001080",
        ),
        tok("variable.other.readwrite", "#001080"),
        tok("variable.other.constant", "#0070C1"),
        tok("variable.other.enummember", "#0070C1"),
        tok("variable.other.property", "#001080"),
        tok("variable.other.object", "#001080"),
        tok("variable.parameter", "#001080"),
        tok("variable.language", "#0000FF"),
        tok("variable.language.this", "#0000FF"),
        tok("variable.language.self", "#0000FF"),
        tok("meta.object-literal.key", "#001080"),
        // Keywords
        tok("keyword", "#0000FF"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.loop",
                "keyword.control.conditional",
                "keyword.control.import",
                "keyword.control.from",
                "keyword.control.export",
                "keyword.other.using",
            ],
            "#AF00DB",
        ),
        tok("keyword.operator", "#000000"),
        tok("keyword.operator.new", "#0000FF"),
        tok("keyword.operator.expression", "#0000FF"),
        tok("keyword.operator.logical", "#000000"),
        tok("keyword.operator.type", "#0000FF"),
        // Storage
        tok("storage", "#0000FF"),
        tok("storage.type", "#0000FF"),
        tok("storage.type.function", "#0000FF"),
        tok("storage.type.class", "#0000FF"),
        tok("storage.modifier", "#0000FF"),
        tok("storage.modifier.async", "#0000FF"),
        // Functions
        tok_multi(&["entity.name.function", "support.function"], "#795E26"),
        tok("entity.name.function.member", "#795E26"),
        tok("meta.function-call", "#795E26"),
        tok("support.function.builtin", "#795E26"),
        tok("entity.name.operator.custom-literal", "#795E26"),
        // Types & classes
        tok_multi(
            &[
                "entity.name.type",
                "entity.name.class",
                "support.class",
                "support.type",
            ],
            "#267F99",
        ),
        tok("entity.name.type.parameter", "#267F99"),
        tok("entity.name.type.enum", "#267F99"),
        tok("entity.name.type.interface", "#267F99"),
        tok("entity.name.type.alias", "#267F99"),
        tok("entity.name.type.module", "#267F99"),
        tok("support.type.primitive", "#267F99"),
        tok("entity.name.namespace", "#267F99"),
        tok_multi(
            &["meta.type.cast.expr", "entity.other.inherited-class"],
            "#267F99",
        ),
        // Tags & attributes
        tok("entity.name.tag", "#800000"),
        tok("entity.name.tag.css", "#800000"),
        tok("entity.other.attribute-name", "#E50000"),
        tok_multi(
            &[
                "entity.other.attribute-name.class.css",
                "entity.other.attribute-name.id.css",
                "entity.other.attribute-name.pseudo-class.css",
            ],
            "#800000",
        ),
        // CSS
        tok("support.constant.property-value.css", "#A31515"),
        tok("support.constant.font-name", "#A31515"),
        // Decorators / annotations
        tok_multi(
            &[
                "meta.decorator",
                "entity.name.function.decorator",
                "punctuation.decorator",
            ],
            "#795E26",
        ),
        tok("meta.attribute", "#E50000"),
        // Preprocessor / macros
        tok("meta.preprocessor", "#0000FF"),
        tok("meta.preprocessor.string", "#A31515"),
        tok("meta.preprocessor.numeric", "#098658"),
        tok("entity.name.function.preprocessor", "#0000FF"),
        tok_multi(
            &[
                "keyword.control.directive",
                "punctuation.definition.directive",
            ],
            "#0000FF",
        ),
        // Operators & punctuation
        tok("support.constant", "#0000FF"),
        tok("punctuation.definition.tag", "#800000"),
        tok("punctuation.separator", "#000000"),
        tok("punctuation.terminator", "#000000"),
        tok("meta.brace", "#000000"),
        // JSON
        tok("support.type.property-name.json", "#0451A5"),
        tok("string.value.json", "#A31515"),
        // YAML
        tok("entity.name.tag.yaml", "#800000"),
        // TOML
        tok("support.type.property-name.toml", "#0451A5"),
        // Markup
        tok_styled("emphasis", "#000000", FontStyle::ITALIC),
        tok_styled("strong", "#000000", FontStyle::BOLD),
        tok_styled("markup.heading", "#0451A5", FontStyle::BOLD),
        tok("markup.inserted", "#098658"),
        tok("markup.deleted", "#A31515"),
        tok("markup.changed", "#0451A5"),
        tok_styled("markup.italic", "#000000", FontStyle::ITALIC),
        tok_styled("markup.bold", "#000000", FontStyle::BOLD),
        tok_styled("markup.underline", "#000000", FontStyle::UNDERLINE),
        tok_styled("markup.strikethrough", "#000000", FontStyle::STRIKETHROUGH),
        tok("markup.inline.raw", "#A31515"),
        tok("markup.fenced_code.block", "#A31515"),
        tok("markup.quote", "#008000"),
        tok("markup.list.numbered", "#0451A5"),
        tok("markup.list.unnumbered", "#0451A5"),
        tok("meta.link.inline.markdown", "#0451A5"),
        tok("string.other.link", "#0451A5"),
        // Rust-specific
        tok("entity.name.type.lifetime.rust", "#0000FF"),
        tok("keyword.operator.borrow.rust", "#0000FF"),
        tok("entity.name.function.macro.rust", "#795E26"),
        tok("meta.attribute.rust", "#E50000"),
        // Invalid / deprecated
        tok("invalid", "#CD3131"),
        tok("invalid.illegal", "#CD3131"),
        tok_styled("invalid.deprecated", "#795E26", FontStyle::STRIKETHROUGH),
    ]
}

#[allow(clippy::too_many_lines)]
fn quiet_light_tokens() -> Vec<TokenColorRule> {
    vec![
        // Base / comments
        tok("source", "#333333"),
        tok_styled("comment", "#AAAAAA", FontStyle::ITALIC),
        tok_styled("comment.line", "#AAAAAA", FontStyle::ITALIC),
        tok_styled("comment.block", "#AAAAAA", FontStyle::ITALIC),
        tok_styled(
            "comment.block.documentation",
            "#448C27",
            FontStyle::ITALIC,
        ),
        tok("punctuation.definition.comment", "#AAAAAA"),

        // Strings
        tok("string", "#448C27"),
        tok("string.quoted.single", "#448C27"),
        tok("string.quoted.double", "#448C27"),
        tok("string.template", "#448C27"),
        tok("string.quoted.template", "#448C27"),
        tok("string.interpolated", "#448C27"),
        tok("string.regexp", "#4B69C6"),
        tok("constant.character.escape", "#9C5D27"),

        // Numbers & constants
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
                "constant.numeric.octal",
                "constant.numeric.binary",
            ],
            "#9C5D27",
        ),
        tok("constant.language", "#9C5D27"),
        tok("constant.language.boolean", "#9C5D27"),
        tok("constant.language.null", "#9C5D27"),
        tok("constant.language.undefined", "#9C5D27"),
        tok("constant.character", "#9C5D27"),
        tok("constant.other", "#9C5D27"),
        tok("constant.regexp", "#4B69C6"),

        // Variables
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#7A3E9D",
        ),
        tok("variable.other.readwrite", "#7A3E9D"),
        tok("variable.other.constant", "#9C5D27"),
        tok("variable.other.enummember", "#9C5D27"),
        tok("variable.other.property", "#7A3E9D"),
        tok("variable.other.object", "#7A3E9D"),
        tok("variable.parameter", "#7A3E9D"),
        tok("variable.language", "#4B69C6"),
        tok("variable.language.this", "#4B69C6"),
        tok("variable.language.self", "#4B69C6"),
        tok("variable.language.super", "#4B69C6"),
        tok("meta.object-literal.key", "#7A3E9D"),

        // Keywords & storage
        tok("keyword", "#4B69C6"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.loop",
                "keyword.control.conditional",
                "keyword.control.import",
                "keyword.control.from",
                "keyword.control.export",
                "keyword.other.using",
                "storage",
                "storage.type",
                "storage.modifier",
            ],
            "#4B69C6",
        ),
        tok("keyword.operator", "#777777"),
        tok("keyword.operator.new", "#4B69C6"),
        tok("keyword.operator.expression", "#4B69C6"),
        tok("keyword.operator.logical", "#777777"),
        tok("keyword.operator.assignment", "#777777"),
        tok("keyword.operator.comparison", "#777777"),
        tok("keyword.operator.type", "#4B69C6"),

        // Functions
        tok_styled(
            "entity.name.function",
            "#AA3731",
            FontStyle::BOLD,
        ),
        tok_styled(
            "entity.name.function.member",
            "#AA3731",
            FontStyle::BOLD,
        ),
        tok_styled("support.function", "#AA3731", FontStyle::BOLD),
        tok_styled("meta.function-call", "#AA3731", FontStyle::BOLD),
        tok_styled(
            "support.function.builtin",
            "#AA3731",
            FontStyle::BOLD,
        ),

        // Types & classes
        tok_styled(
            "entity.name.type",
            "#7A3E9D",
            FontStyle::BOLD,
        ),
        tok_styled(
            "entity.name.class",
            "#7A3E9D",
            FontStyle::BOLD,
        ),
        tok_styled("support.class", "#7A3E9D", FontStyle::BOLD),
        tok("support.type", "#7A3E9D"),
        tok("entity.name.type.parameter", "#7A3E9D"),
        tok("entity.name.type.enum", "#7A3E9D"),
        tok("entity.name.type.interface", "#7A3E9D"),
        tok("entity.name.type.alias", "#7A3E9D"),
        tok("entity.name.namespace", "#7A3E9D"),
        tok("support.type.primitive", "#7A3E9D"),
        tok_multi(
            &["meta.type.cast.expr", "entity.other.inherited-class"],
            "#7A3E9D",
        ),

        // HTML/XML/JSX
        tok("entity.name.tag", "#4B69C6"),
        tok("entity.name.tag.html", "#4B69C6"),
        tok("entity.name.tag.css", "#91B3E0"),
        tok("entity.other.attribute-name", "#8190A0"),

        // CSS
        tok("support.constant.property-value.css", "#448C27"),
        tok("support.constant.font-name", "#448C27"),
        tok("support.constant.color", "#448C27"),

        // Decorators / attributes
        tok_multi(
            &[
                "meta.decorator",
                "entity.name.function.decorator",
                "punctuation.decorator",
            ],
            "#AA3731",
        ),
        tok("meta.attribute", "#8190A0"),

        // Preprocessor / macros
        tok("meta.preprocessor", "#4B69C6"),
        tok("meta.preprocessor.string", "#448C27"),
        tok("meta.preprocessor.numeric", "#9C5D27"),
        tok("entity.name.function.preprocessor", "#4B69C6"),
        tok_multi(
            &[
                "keyword.control.directive",
                "punctuation.definition.directive",
            ],
            "#4B69C6",
        ),

        // Operators & punctuation
        tok("support.constant", "#9C5D27"),
        tok("punctuation.definition.tag", "#91B3E0"),
        tok("punctuation.separator", "#777777"),
        tok("punctuation.terminator", "#777777"),
        tok("punctuation.section", "#777777"),
        tok("punctuation.accessor", "#777777"),
        tok("meta.brace", "#777777"),

        // JSON / YAML / TOML
        tok("support.type.property-name.json", "#7A3E9D"),
        tok("string.value.json", "#448C27"),
        tok("entity.name.tag.yaml", "#4B69C6"),
        tok("entity.name.tag.toml", "#4B69C6"),
        tok("support.type.property-name.toml", "#7A3E9D"),

        // Markdown / markup
        tok_styled("emphasis", "#333333", FontStyle::ITALIC),
        tok_styled("strong", "#333333", FontStyle::BOLD),
        tok_styled("markup.heading", "#4B69C6", FontStyle::BOLD),
        tok("markup.inserted", "#448C27"),
        tok("markup.deleted", "#AA3731"),
        tok("markup.changed", "#4B69C6"),
        tok_styled("markup.italic", "#333333", FontStyle::ITALIC),
        tok_styled("markup.bold", "#333333", FontStyle::BOLD),
        tok_styled("markup.underline", "#333333", FontStyle::UNDERLINE),
        tok_styled(
            "markup.strikethrough",
            "#333333",
            FontStyle::STRIKETHROUGH,
        ),
        tok("markup.inline.raw", "#448C27"),
        tok("markup.fenced_code.block", "#448C27"),
        tok("markup.quote", "#448C27"),
        tok("markup.list.numbered", "#4B69C6"),
        tok("markup.list.unnumbered", "#4B69C6"),
        tok("meta.link.inline.markdown", "#4B69C6"),
        tok("string.other.link", "#4B69C6"),

        // Rust
        tok("entity.name.type.lifetime.rust", "#4B69C6"),
        tok("keyword.operator.borrow.rust", "#4B69C6"),
        tok("keyword.operator.sigil.rust", "#4B69C6"),
        tok("entity.name.function.macro.rust", "#AA3731"),
        tok("meta.attribute.rust", "#8190A0"),

        // Invalid / deprecated
        tok("invalid", "#cd3131"),
        tok("invalid.illegal", "#660000"),
        tok_styled(
            "invalid.deprecated",
            "#AA3731",
            FontStyle::STRIKETHROUGH,
        ),
    ]
}

#[allow(clippy::too_many_lines)]
fn hc_black_tokens() -> Vec<TokenColorRule> {
    vec![
        tok_styled("comment", "#7CA668", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#7CA668", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#7CA668"),
        tok("string", "#CE9178"),
        tok("string.quoted.single", "#CE9178"),
        tok("string.quoted.double", "#CE9178"),
        tok("string.template", "#CE9178"),
        tok("string.regexp", "#D16969"),
        tok("string.interpolated", "#CE9178"),
        tok("constant.character.escape", "#D7BA7D"),
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
                "constant.other.color.rgb-value",
            ],
            "#B5CEA8",
        ),
        tok("constant.language", "#569CD6"),
        tok("constant.language.boolean", "#569CD6"),
        tok("constant.language.null", "#569CD6"),
        tok("constant.character", "#569CD6"),
        tok("constant.other", "#4FC1FF"),
        tok("constant.regexp", "#B46695"),
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#9CDCFE",
        ),
        tok("variable.other.readwrite", "#9CDCFE"),
        tok("variable.other.constant", "#4FC1FF"),
        tok("variable.other.enummember", "#4FC1FF"),
        tok("variable.other.property", "#9CDCFE"),
        tok("variable.parameter", "#9CDCFE"),
        tok("variable.language", "#569CD6"),
        tok("keyword", "#569CD6"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.import",
                "keyword.other.using",
                "keyword.other.operator",
            ],
            "#C586C0",
        ),
        tok("keyword.operator", "#D4D4D4"),
        tok("keyword.operator.new", "#569CD6"),
        tok("keyword.operator.type", "#569CD6"),
        tok("storage", "#569CD6"),
        tok("storage.type", "#569CD6"),
        tok("storage.modifier", "#569CD6"),
        tok_multi(&["entity.name.function", "support.function"], "#DCDCAA"),
        tok("entity.name.function.member", "#DCDCAA"),
        tok("support.function.builtin", "#DCDCAA"),
        tok_multi(
            &[
                "entity.name.type",
                "entity.name.class",
                "support.class",
                "support.type",
            ],
            "#4EC9B0",
        ),
        tok("entity.name.type.parameter", "#4EC9B0"),
        tok("entity.name.type.enum", "#4EC9B0"),
        tok("entity.name.namespace", "#4EC9B0"),
        tok("support.type.primitive", "#4EC9B0"),
        tok("entity.name.tag", "#569CD6"),
        tok_multi(&["entity.name.tag.css", "entity.name.tag.less"], "#D7BA7D"),
        tok("entity.other.attribute-name", "#9CDCFE"),
        tok_multi(
            &[
                "entity.other.attribute-name.class.css",
                "entity.other.attribute-name.id.css",
            ],
            "#D7BA7D",
        ),
        tok_multi(
            &["meta.decorator", "entity.name.function.decorator"],
            "#DCDCAA",
        ),
        tok("meta.preprocessor", "#569CD6"),
        tok("meta.preprocessor.string", "#CE9178"),
        tok("meta.preprocessor.numeric", "#B5CEA8"),
        tok("punctuation.definition.tag", "#808080"),
        tok("support.constant", "#569CD6"),
        tok("support.type.property-name.json", "#9CDCFE"),
        tok("meta.attribute.rust", "#9CDCFE"),
        tok("entity.name.function.macro.rust", "#DCDCAA"),
        tok("invalid", "#F44747"),
        tok("invalid.illegal", "#F44747"),
        tok_styled("invalid.deprecated", "#DCDCAA", FontStyle::STRIKETHROUGH),
        tok_styled("emphasis", "#FFFFFF", FontStyle::ITALIC),
        tok_styled("strong", "#FFFFFF", FontStyle::BOLD),
        tok_styled("markup.heading", "#6796E6", FontStyle::BOLD),
        tok("markup.inserted", "#B5CEA8"),
        tok("markup.deleted", "#CE9178"),
        tok("markup.changed", "#569CD6"),
        tok_styled("markup.italic", "#FFFFFF", FontStyle::ITALIC),
        tok_styled("markup.bold", "#FFFFFF", FontStyle::BOLD),
        tok_styled("markup.underline", "#FFFFFF", FontStyle::UNDERLINE),
        tok_styled("markup.strikethrough", "#FFFFFF", FontStyle::STRIKETHROUGH),
        tok("markup.inline.raw", "#CE9178"),
        tok("markup.quote", "#7CA668"),
    ]
}

#[allow(clippy::too_many_lines)]
fn hc_light_tokens() -> Vec<TokenColorRule> {
    vec![
        tok_styled("comment", "#515151", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#515151", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#515151"),
        tok_multi(&["string", "meta.embedded.assembly"], "#0F4A85"),
        tok("string.quoted.single", "#0F4A85"),
        tok("string.quoted.double", "#0F4A85"),
        tok("string.template", "#0F4A85"),
        tok("string.regexp", "#811F3F"),
        tok("string.interpolated", "#0F4A85"),
        tok("constant.character.escape", "#EE0000"),
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
            ],
            "#096D48",
        ),
        tok("constant.language", "#0F4A85"),
        tok("constant.language.boolean", "#0F4A85"),
        tok("constant.language.null", "#0F4A85"),
        tok("constant.character", "#0F4A85"),
        tok("constant.other", "#0F4A85"),
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#001080",
        ),
        tok("variable.other.readwrite", "#001080"),
        tok("variable.other.constant", "#0070C1"),
        tok("variable.other.enummember", "#0070C1"),
        tok("variable.other.property", "#001080"),
        tok("variable.parameter", "#001080"),
        tok("variable.language", "#0F4A85"),
        tok("keyword", "#0F4A85"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.import",
                "keyword.other.using",
            ],
            "#B5200D",
        ),
        tok("keyword.operator", "#000000"),
        tok("keyword.operator.new", "#0F4A85"),
        tok("keyword.operator.type", "#0F4A85"),
        tok("storage", "#0F4A85"),
        tok("storage.type", "#0F4A85"),
        tok("storage.modifier", "#0F4A85"),
        tok_multi(&["entity.name.function", "support.function"], "#5E2CBC"),
        tok("entity.name.function.member", "#5E2CBC"),
        tok("support.function.builtin", "#5E2CBC"),
        tok_multi(
            &[
                "entity.name.type",
                "entity.name.class",
                "support.class",
                "support.type",
            ],
            "#185E73",
        ),
        tok("entity.name.type.parameter", "#185E73"),
        tok("entity.name.type.enum", "#185E73"),
        tok("entity.name.namespace", "#185E73"),
        tok("support.type.primitive", "#185E73"),
        tok("entity.name.tag", "#0F4A85"),
        tok("entity.other.attribute-name", "#264F78"),
        tok_multi(
            &[
                "entity.other.attribute-name.class.css",
                "entity.other.attribute-name.id.css",
            ],
            "#264F78",
        ),
        tok_multi(
            &["meta.decorator", "entity.name.function.decorator"],
            "#5E2CBC",
        ),
        tok("meta.preprocessor", "#0F4A85"),
        tok("meta.preprocessor.string", "#0F4A85"),
        tok("meta.preprocessor.numeric", "#096D48"),
        tok("punctuation.definition.tag", "#0F4A85"),
        tok("support.constant", "#0F4A85"),
        tok("support.type.property-name.json", "#264F78"),
        tok("meta.attribute.rust", "#264F78"),
        tok("entity.name.function.macro.rust", "#5E2CBC"),
        tok("invalid", "#B5200D"),
        tok("invalid.illegal", "#B5200D"),
        tok_styled("invalid.deprecated", "#5E2CBC", FontStyle::STRIKETHROUGH),
        tok_styled("emphasis", "#000000", FontStyle::ITALIC),
        tok_styled("strong", "#000080", FontStyle::BOLD),
        tok_styled("markup.heading", "#0F4A85", FontStyle::BOLD),
        tok("markup.inserted", "#096D48"),
        tok("markup.deleted", "#5A5A5A"),
        tok("markup.changed", "#0451A5"),
        tok_styled("markup.italic", "#800080", FontStyle::ITALIC),
        tok_styled("markup.bold", "#000080", FontStyle::BOLD),
        tok_styled("markup.underline", "#000000", FontStyle::UNDERLINE),
        tok_styled("markup.strikethrough", "#000000", FontStyle::STRIKETHROUGH),
        tok("markup.inline.raw", "#0F4A85"),
        tok("markup.quote", "#515151"),
    ]
}

#[allow(clippy::too_many_lines)]
fn hc_black_colors() -> WorkbenchColors {
    WorkbenchColors {
        editor_background: c("#000000"),
        editor_foreground: c("#FFFFFF"),
        editor_selection_background: c("#FFFFFF"),
        editor_whitespace_foreground: c("#7c7c7c"),
        editor_indent_guide_background: c("#FFFFFF"),
        editor_indent_guide_active_background: c("#FFFFFF"),
        side_bar_title_foreground: c("#FFFFFF"),
        selection_background: c("#008000"),
        foreground: c("#FFFFFF"),
        focus_border: c("#F38518"),
        contrast_border: c("#6FC3DF"),
        contrast_active_border: c("#F38518"),
        error_foreground: c("#F48771"),
        text_link_foreground: c("#21A6FF"),
        text_link_active_foreground: c("#21A6FF"),
        icon_foreground: c("#FFFFFF"),
        ..WorkbenchColors::default()
    }
}

#[allow(clippy::too_many_lines)]
fn hc_light_colors() -> WorkbenchColors {
    WorkbenchColors {
        editor_background: c("#FFFFFF"),
        editor_foreground: c("#292929"),
        foreground: c("#292929"),
        focus_border: c("#006BBD"),
        contrast_border: c("#0F4A85"),
        contrast_active_border: c("#006BBD"),
        error_foreground: c("#B5200D"),
        text_link_foreground: c("#0F4A85"),
        text_link_active_foreground: c("#0F4A85"),
        icon_foreground: c("#292929"),
        status_bar_item_remote_background: c("#FFFFFF"),
        status_bar_item_remote_foreground: c("#000000"),
        ..WorkbenchColors::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_modern_loads() {
        let t = dark_modern();
        assert_eq!(t.kind, ThemeKind::Dark);
        assert!(!t.token_colors.is_empty());
        assert!(t.workbench_colors.editor_background.is_some());
    }

    #[test]
    fn light_modern_loads() {
        let t = light_modern();
        assert_eq!(t.kind, ThemeKind::Light);
        assert!(!t.token_colors.is_empty());
    }

    #[test]
    fn hc_black_loads() {
        let t = hc_black();
        assert_eq!(t.kind, ThemeKind::HighContrast);
        assert_eq!(t.workbench_colors.editor_background, c("#000000"));
    }

    #[test]
    fn hc_light_loads() {
        let t = hc_light();
        assert_eq!(t.kind, ThemeKind::HighContrastLight);
        assert_eq!(t.workbench_colors.editor_background, c("#FFFFFF"));
    }

    #[test]
    fn quiet_light_loads() {
        let t = quiet_light();
        assert_eq!(t.kind, ThemeKind::Light);
        assert_eq!(t.workbench_colors.editor_background, c("#F5F5F5"));
        assert!(!t.token_colors.is_empty());
    }
}

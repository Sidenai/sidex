package index

import (
	"path/filepath"
	"strings"

	sitter "github.com/smacker/go-tree-sitter"
	"github.com/smacker/go-tree-sitter/cpp"
	"github.com/smacker/go-tree-sitter/golang"
	"github.com/smacker/go-tree-sitter/java"
	"github.com/smacker/go-tree-sitter/javascript"
	"github.com/smacker/go-tree-sitter/python"
	"github.com/smacker/go-tree-sitter/rust"
	"github.com/smacker/go-tree-sitter/typescript/tsx"
	"github.com/smacker/go-tree-sitter/typescript/typescript"
)

// Language identifies a supported programming language for parsing.
type Language struct {
	Name      string
	TSLang    *sitter.Language
	NodeKinds nodeKinds
}

// nodeKinds defines which tree-sitter node types correspond to chunk boundaries
// for a given language.
type nodeKinds struct {
	TopLevel   []string // nodes that are standalone top-level declarations
	SubBlock   []string // inner block nodes for splitting oversized functions
	ImportLike []string // import/use/include nodes to merge
}

var langGo = Language{
	Name:   "go",
	TSLang: golang.GetLanguage(),
	NodeKinds: nodeKinds{
		TopLevel:   []string{"function_declaration", "method_declaration", "type_declaration"},
		SubBlock:   []string{"if_statement", "for_statement", "switch_statement", "select_statement", "block"},
		ImportLike: []string{"import_declaration", "const_declaration", "var_declaration"},
	},
}

var langTypeScript = Language{
	Name:   "typescript",
	TSLang: typescript.GetLanguage(),
	NodeKinds: nodeKinds{
		TopLevel:   []string{"function_declaration", "class_declaration", "method_definition", "export_statement", "lexical_declaration", "interface_declaration", "type_alias_declaration"},
		SubBlock:   []string{"if_statement", "for_statement", "for_in_statement", "while_statement", "switch_statement", "try_statement", "statement_block"},
		ImportLike: []string{"import_statement", "export_statement"},
	},
}

var langTSX = Language{
	Name:   "tsx",
	TSLang: tsx.GetLanguage(),
	NodeKinds: nodeKinds{
		TopLevel:   []string{"function_declaration", "class_declaration", "method_definition", "export_statement", "lexical_declaration", "interface_declaration", "type_alias_declaration"},
		SubBlock:   []string{"if_statement", "for_statement", "for_in_statement", "while_statement", "switch_statement", "try_statement", "statement_block"},
		ImportLike: []string{"import_statement", "export_statement"},
	},
}

var langJavaScript = Language{
	Name:   "javascript",
	TSLang: javascript.GetLanguage(),
	NodeKinds: nodeKinds{
		TopLevel:   []string{"function_declaration", "class_declaration", "method_definition", "export_statement", "lexical_declaration", "variable_declaration"},
		SubBlock:   []string{"if_statement", "for_statement", "for_in_statement", "while_statement", "switch_statement", "try_statement", "statement_block"},
		ImportLike: []string{"import_statement", "export_statement"},
	},
}

var langPython = Language{
	Name:   "python",
	TSLang: python.GetLanguage(),
	NodeKinds: nodeKinds{
		TopLevel:   []string{"function_definition", "class_definition", "decorated_definition"},
		SubBlock:   []string{"if_statement", "for_statement", "while_statement", "with_statement", "try_statement", "block"},
		ImportLike: []string{"import_statement", "import_from_statement"},
	},
}

var langRust = Language{
	Name:   "rust",
	TSLang: rust.GetLanguage(),
	NodeKinds: nodeKinds{
		TopLevel:   []string{"function_item", "struct_item", "enum_item", "impl_item", "trait_item", "mod_item", "type_item"},
		SubBlock:   []string{"if_expression", "loop_expression", "for_expression", "while_expression", "match_expression", "block"},
		ImportLike: []string{"use_declaration", "const_item", "static_item"},
	},
}

var langJava = Language{
	Name:   "java",
	TSLang: java.GetLanguage(),
	NodeKinds: nodeKinds{
		TopLevel:   []string{"class_declaration", "interface_declaration", "enum_declaration", "method_declaration", "constructor_declaration"},
		SubBlock:   []string{"if_statement", "for_statement", "while_statement", "try_statement", "switch_expression", "block"},
		ImportLike: []string{"import_declaration", "package_declaration"},
	},
}

var langCPP = Language{
	Name:   "cpp",
	TSLang: cpp.GetLanguage(),
	NodeKinds: nodeKinds{
		TopLevel:   []string{"function_definition", "class_specifier", "struct_specifier", "enum_specifier", "namespace_definition", "template_declaration"},
		SubBlock:   []string{"if_statement", "for_statement", "while_statement", "switch_statement", "try_statement", "compound_statement"},
		ImportLike: []string{"preproc_include", "preproc_define", "using_declaration", "type_definition"},
	},
}

var langC = Language{
	Name:   "c",
	TSLang: cpp.GetLanguage(), // C is a subset; tree-sitter-cpp handles C files fine
	NodeKinds: nodeKinds{
		TopLevel:   []string{"function_definition", "struct_specifier", "enum_specifier"},
		SubBlock:   []string{"if_statement", "for_statement", "while_statement", "switch_statement", "compound_statement"},
		ImportLike: []string{"preproc_include", "preproc_define", "type_definition", "declaration"},
	},
}

// DetectLanguage returns a Language descriptor for the given file path based
// on its extension. Returns nil if the language is unsupported.
func DetectLanguage(filePath string) *Language {
	ext := strings.ToLower(filepath.Ext(filePath))
	switch ext {
	case ".go":
		return &langGo
	case ".ts":
		return &langTypeScript
	case ".tsx":
		return &langTSX
	case ".js", ".jsx", ".mjs", ".cjs":
		return &langJavaScript
	case ".py":
		return &langPython
	case ".rs":
		return &langRust
	case ".java":
		return &langJava
	case ".c", ".h":
		return &langC
	case ".cpp", ".cc", ".cxx", ".hpp", ".hh":
		return &langCPP
	default:
		return nil
	}
}

// isTopLevel returns true if the node type is a top-level declaration for the language.
func (l *Language) isTopLevel(nodeType string) bool {
	for _, k := range l.NodeKinds.TopLevel {
		if k == nodeType {
			return true
		}
	}
	return false
}

// isImportLike returns true if the node type is an import/constant/declaration that
// should be merged with adjacent similar nodes.
func (l *Language) isImportLike(nodeType string) bool {
	for _, k := range l.NodeKinds.ImportLike {
		if k == nodeType {
			return true
		}
	}
	return false
}

// isSubBlock returns true if the node type is a logical sub-block that can be
// used as a split point within an oversized function.
func (l *Language) isSubBlock(nodeType string) bool {
	for _, k := range l.NodeKinds.SubBlock {
		if k == nodeType {
			return true
		}
	}
	return false
}

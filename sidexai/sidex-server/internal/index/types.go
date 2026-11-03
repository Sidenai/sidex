package index

import "crypto/sha256"

// SearchResult represents a single result from semantic or hybrid search.
type SearchResult struct {
	File      string  `json:"file"`
	StartLine int     `json:"start_line"`
	EndLine   int     `json:"end_line"`
	Symbol    string  `json:"symbol,omitempty"`
	Snippet   string  `json:"snippet,omitempty"`
	Score     float64 `json:"score"`
}

// Chunk represents a semantically meaningful code fragment ready for embedding.
type Chunk struct {
	FilePath    string
	Language    string
	StartLine   int
	EndLine     int
	SymbolName  string
	SymbolKind  SymbolKind
	Content     string
	ContentHash [sha256.Size]byte
}

// SymbolKind classifies what a chunk represents in the code structure.
type SymbolKind string

const (
	KindFunction    SymbolKind = "function"
	KindMethod      SymbolKind = "method"
	KindClass       SymbolKind = "class"
	KindStruct      SymbolKind = "struct"
	KindInterface   SymbolKind = "interface"
	KindEnum        SymbolKind = "enum"
	KindTrait       SymbolKind = "trait"
	KindImpl        SymbolKind = "impl"
	KindType        SymbolKind = "type"
	KindModule      SymbolKind = "module"
	KindImport      SymbolKind = "import"
	KindConstant    SymbolKind = "constant"
	KindVariable    SymbolKind = "variable"
	KindDeclaration SymbolKind = "declaration"
	KindBlock       SymbolKind = "block"
)

// ChunkerConfig holds tuning parameters for the chunking algorithm.
type ChunkerConfig struct {
	TargetMinTokens int // minimum tokens per chunk (default 512)
	TargetMaxTokens int // maximum tokens per chunk (default 768)
	MergeThreshold  int // merge adjacent small chunks below this token count (default 256)
	CharsPerToken   int // estimated characters per token (default 4)
}

// DefaultConfig returns sane defaults for code chunking.
func DefaultConfig() ChunkerConfig {
	return ChunkerConfig{
		TargetMinTokens: 512,
		TargetMaxTokens: 768,
		MergeThreshold:  256,
		CharsPerToken:   4,
	}
}

// tokenEstimate returns the estimated token count for a string.
func (c ChunkerConfig) tokenEstimate(s string) int {
	if c.CharsPerToken <= 0 {
		return len(s) / 4
	}
	return len(s) / c.CharsPerToken
}

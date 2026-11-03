package index

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	sitter "github.com/smacker/go-tree-sitter"
)

// Chunker splits source files into semantically meaningful chunks using
// tree-sitter for accurate AST-aware boundaries.
type Chunker struct {
	config ChunkerConfig
	parser *sitter.Parser
}

// NewChunker creates a chunker with the given configuration.
func NewChunker(config ChunkerConfig) *Chunker {
	return &Chunker{
		config: config,
		parser: sitter.NewParser(),
	}
}

// NewDefaultChunker creates a chunker with default settings.
func NewDefaultChunker() *Chunker {
	return NewChunker(DefaultConfig())
}

// ChunkFile parses the file at the given path and splits its content into chunks.
// The path is used for language detection and stored in chunk metadata.
// content should be the raw file bytes.
func (c *Chunker) ChunkFile(path string, content []byte) ([]Chunk, error) {
	lang := DetectLanguage(path)
	if lang == nil {
		return nil, fmt.Errorf("unsupported language for file: %s", path)
	}

	c.parser.SetLanguage(lang.TSLang)

	tree, err := c.parser.ParseCtx(context.Background(), nil, content)
	if err != nil {
		return nil, fmt.Errorf("tree-sitter parse error for %s: %w", path, err)
	}
	defer tree.Close()

	root := tree.RootNode()
	rawChunks := c.extractNodes(root, content, lang, path)

	merged := c.mergeSmallImports(rawChunks)
	final := c.splitOversized(merged, content, lang, path)

	return final, nil
}

// rawChunk is an intermediate representation before final Chunk construction.
type rawChunk struct {
	startByte  uint32
	endByte    uint32
	startLine  int
	endLine    int
	symbolName string
	symbolKind SymbolKind
	nodeType   string
	isImport   bool
}

// byteRange represents a start/end byte offset pair.
type byteRange struct {
	start uint32
	end   uint32
}

// extractNodes walks the top-level children of the root AST and categorizes them.
func (c *Chunker) extractNodes(root *sitter.Node, content []byte, lang *Language, path string) []rawChunk {
	var chunks []rawChunk
	childCount := int(root.ChildCount())

	for i := 0; i < childCount; i++ {
		child := root.Child(i)
		nodeType := child.Type()

		if lang.isTopLevel(nodeType) || lang.isImportLike(nodeType) {
			name, kind := c.extractSymbolInfo(child, content, lang, nodeType)
			chunks = append(chunks, rawChunk{
				startByte:  child.StartByte(),
				endByte:    child.EndByte(),
				startLine:  int(child.StartPoint().Row) + 1,
				endLine:    int(child.EndPoint().Row) + 1,
				symbolName: name,
				symbolKind: kind,
				nodeType:   nodeType,
				isImport:   lang.isImportLike(nodeType),
			})
		} else if nodeType != "comment" && nodeType != "\n" {
			// Catch-all for other top-level statements (e.g., expression_statement in Python)
			text := string(content[child.StartByte():child.EndByte()])
			tokens := c.config.tokenEstimate(text)
			if tokens > 0 {
				chunks = append(chunks, rawChunk{
					startByte:  child.StartByte(),
					endByte:    child.EndByte(),
					startLine:  int(child.StartPoint().Row) + 1,
					endLine:    int(child.EndPoint().Row) + 1,
					symbolName: "",
					symbolKind: KindBlock,
					nodeType:   nodeType,
					isImport:   false,
				})
			}
		}
	}

	return chunks
}

// extractSymbolInfo determines the symbol name and kind from a tree-sitter node.
func (c *Chunker) extractSymbolInfo(node *sitter.Node, content []byte, lang *Language, nodeType string) (string, SymbolKind) {
	if lang.isImportLike(nodeType) {
		return "", KindImport
	}

	kind := c.nodeTypeToKind(nodeType, lang)
	name := c.findNameInNode(node, content, lang)

	return name, kind
}

// nodeTypeToKind maps tree-sitter node types to our SymbolKind.
func (c *Chunker) nodeTypeToKind(nodeType string, lang *Language) SymbolKind {
	switch {
	case strings.Contains(nodeType, "function") || strings.Contains(nodeType, "method"):
		if strings.Contains(nodeType, "method") {
			return KindMethod
		}
		return KindFunction
	case strings.Contains(nodeType, "class"):
		return KindClass
	case strings.Contains(nodeType, "struct"):
		return KindStruct
	case strings.Contains(nodeType, "interface"):
		return KindInterface
	case strings.Contains(nodeType, "enum"):
		return KindEnum
	case strings.Contains(nodeType, "trait"):
		return KindTrait
	case strings.Contains(nodeType, "impl"):
		return KindImpl
	case strings.Contains(nodeType, "type"):
		return KindType
	case strings.Contains(nodeType, "mod") || strings.Contains(nodeType, "namespace"):
		return KindModule
	case strings.Contains(nodeType, "const") || strings.Contains(nodeType, "static"):
		return KindConstant
	case strings.Contains(nodeType, "var") || strings.Contains(nodeType, "lexical"):
		return KindVariable
	case strings.Contains(nodeType, "export"):
		return KindDeclaration
	default:
		return KindBlock
	}
}

// findNameInNode attempts to extract the identifier name from a declaration node.
func (c *Chunker) findNameInNode(node *sitter.Node, content []byte, lang *Language) string {
	// For export_statement, look at the first child declaration
	if node.Type() == "export_statement" {
		decl := node.ChildByFieldName("declaration")
		if decl != nil {
			node = decl
		}
	}

	// Try common field names for the identifier
	for _, field := range []string{"name", "declarator"} {
		nameNode := node.ChildByFieldName(field)
		if nameNode != nil {
			if nameNode.Type() == "identifier" || nameNode.Type() == "type_identifier" ||
				nameNode.Type() == "property_identifier" {
				return string(content[nameNode.StartByte():nameNode.EndByte()])
			}
			// For Go method declarations: func (r *Receiver) Name(...)
			// The "name" field on function_declarator, etc.
			inner := nameNode.ChildByFieldName("name")
			if inner != nil {
				return string(content[inner.StartByte():inner.EndByte()])
			}
			return string(content[nameNode.StartByte():nameNode.EndByte()])
		}
	}

	// Walk children looking for an identifier
	for i := 0; i < int(node.ChildCount()); i++ {
		child := node.Child(i)
		t := child.Type()
		if t == "identifier" || t == "type_identifier" || t == "property_identifier" {
			return string(content[child.StartByte():child.EndByte()])
		}
	}

	return ""
}

// mergeSmallImports merges adjacent import-like nodes that are individually below
// the merge threshold into combined chunks.
func (c *Chunker) mergeSmallImports(chunks []rawChunk) []rawChunk {
	if len(chunks) == 0 {
		return chunks
	}

	var merged []rawChunk
	var pending []rawChunk

	flushPending := func() {
		if len(pending) == 0 {
			return
		}
		if len(pending) == 1 {
			merged = append(merged, pending[0])
		} else {
			combined := rawChunk{
				startByte:  pending[0].startByte,
				endByte:    pending[len(pending)-1].endByte,
				startLine:  pending[0].startLine,
				endLine:    pending[len(pending)-1].endLine,
				symbolName: "",
				symbolKind: KindImport,
				nodeType:   pending[0].nodeType,
				isImport:   true,
			}
			merged = append(merged, combined)
		}
		pending = nil
	}

	for _, ch := range chunks {
		if ch.isImport {
			pending = append(pending, ch)
		} else {
			flushPending()
			merged = append(merged, ch)
		}
	}
	flushPending()

	return merged
}

// splitOversized checks each chunk against the max token threshold.
// If a chunk is too large, it splits it at logical sub-block boundaries.
func (c *Chunker) splitOversized(rawChunks []rawChunk, content []byte, lang *Language, path string) []Chunk {
	var result []Chunk

	for _, rc := range rawChunks {
		text := string(content[rc.startByte:rc.endByte])
		tokens := c.config.tokenEstimate(text)

		if tokens <= c.config.TargetMaxTokens {
			result = append(result, c.buildChunk(rc, content, lang, path))
			continue
		}

		// Need to split: re-parse the sub-tree to find logical split points
		splits := c.splitAtSubBlocks(rc, content, lang, path)
		if len(splits) > 0 {
			result = append(result, splits...)
		} else {
			// Fallback: split by line count
			result = append(result, c.splitByLines(rc, content, lang, path)...)
		}
	}

	return result
}

// splitAtSubBlocks attempts to split an oversized chunk at sub-block boundaries
// (if_statement, for_statement, etc.) within the node.
func (c *Chunker) splitAtSubBlocks(rc rawChunk, content []byte, lang *Language, path string) []Chunk {
	c.parser.SetLanguage(lang.TSLang)
	tree, err := c.parser.ParseCtx(context.Background(), nil, content)
	if err != nil {
		return nil
	}
	defer tree.Close()

	node := c.findNodeAt(tree.RootNode(), rc.startByte, rc.endByte)
	if node == nil {
		return nil
	}

	var subBlocks []byteRange
	c.walkForSubBlocks(node, lang, &subBlocks)

	if len(subBlocks) < 2 {
		return nil
	}

	var chunks []Chunk
	rangeStart := rc.startByte
	currentEnd := rc.startByte

	for _, sb := range subBlocks {
		proposedText := string(content[rangeStart:sb.end])
		if c.config.tokenEstimate(proposedText) > c.config.TargetMaxTokens && currentEnd > rangeStart {
			chunks = append(chunks, c.buildChunkFromRange(rangeStart, currentEnd, content, rc, lang, path, len(chunks)))
			rangeStart = currentEnd
		}
		currentEnd = sb.end
	}

	if rangeStart < rc.endByte {
		chunks = append(chunks, c.buildChunkFromRange(rangeStart, rc.endByte, content, rc, lang, path, len(chunks)))
	}

	if len(chunks) <= 1 {
		return nil
	}
	return chunks
}

// walkForSubBlocks collects all sub-block boundaries within a node.
func (c *Chunker) walkForSubBlocks(node *sitter.Node, lang *Language, out *[]byteRange) {
	for i := 0; i < int(node.ChildCount()); i++ {
		child := node.Child(i)
		if lang.isSubBlock(child.Type()) {
			*out = append(*out, byteRange{start: child.StartByte(), end: child.EndByte()})
		} else {
			c.walkForSubBlocks(child, lang, out)
		}
	}
}

// findNodeAt locates the node in the tree that matches the given byte range.
func (c *Chunker) findNodeAt(root *sitter.Node, startByte, endByte uint32) *sitter.Node {
	if root.StartByte() == startByte && root.EndByte() == endByte {
		return root
	}
	for i := 0; i < int(root.ChildCount()); i++ {
		child := root.Child(i)
		if child.StartByte() <= startByte && child.EndByte() >= endByte {
			found := c.findNodeAt(child, startByte, endByte)
			if found != nil {
				return found
			}
		}
	}
	if root.StartByte() == startByte && root.EndByte() == endByte {
		return root
	}
	return nil
}

// splitByLines is a fallback that splits an oversized chunk by line count
// when no logical sub-block boundaries are found.
func (c *Chunker) splitByLines(rc rawChunk, content []byte, lang *Language, path string) []Chunk {
	text := string(content[rc.startByte:rc.endByte])
	lines := strings.Split(text, "\n")
	targetLines := (c.config.TargetMaxTokens * c.config.CharsPerToken) / avgLineLength(lines)
	if targetLines < 5 {
		targetLines = 5
	}

	var chunks []Chunk
	partIdx := 0
	for start := 0; start < len(lines); start += targetLines {
		end := start + targetLines
		if end > len(lines) {
			end = len(lines)
		}

		chunkContent := strings.Join(lines[start:end], "\n")
		startLine := rc.startLine + start
		endLine := rc.startLine + end - 1

		suffix := ""
		if partIdx > 0 {
			suffix = fmt.Sprintf("[part %d]", partIdx+1)
		}
		symbolName := rc.symbolName
		if suffix != "" {
			symbolName = symbolName + " " + suffix
		}

		chunks = append(chunks, Chunk{
			FilePath:    path,
			Language:    lang.Name,
			StartLine:   startLine,
			EndLine:     endLine,
			SymbolName:  symbolName,
			SymbolKind:  rc.symbolKind,
			Content:     chunkContent,
			ContentHash: sha256.Sum256([]byte(chunkContent)),
		})
		partIdx++
	}

	return chunks
}

// buildChunk creates a final Chunk from a rawChunk.
func (c *Chunker) buildChunk(rc rawChunk, content []byte, lang *Language, path string) Chunk {
	text := string(content[rc.startByte:rc.endByte])
	return Chunk{
		FilePath:    path,
		Language:    lang.Name,
		StartLine:   rc.startLine,
		EndLine:     rc.endLine,
		SymbolName:  rc.symbolName,
		SymbolKind:  rc.symbolKind,
		Content:     text,
		ContentHash: sha256.Sum256([]byte(text)),
	}
}

// buildChunkFromRange creates a Chunk from a byte range within a parent rawChunk.
func (c *Chunker) buildChunkFromRange(startByte, endByte uint32, content []byte, parent rawChunk, lang *Language, path string, partIdx int) Chunk {
	text := string(content[startByte:endByte])
	startLine := parent.startLine + strings.Count(string(content[parent.startByte:startByte]), "\n")
	endLine := startLine + strings.Count(text, "\n")

	symbolName := parent.symbolName
	if partIdx > 0 {
		symbolName = fmt.Sprintf("%s [part %d]", parent.symbolName, partIdx+1)
	}

	return Chunk{
		FilePath:    path,
		Language:    lang.Name,
		StartLine:   startLine,
		EndLine:     endLine,
		SymbolName:  symbolName,
		SymbolKind:  parent.symbolKind,
		Content:     text,
		ContentHash: sha256.Sum256([]byte(text)),
	}
}

// avgLineLength computes the average line length for a slice of lines, clamped to a minimum.
func avgLineLength(lines []string) int {
	if len(lines) == 0 {
		return 40
	}
	total := 0
	for _, l := range lines {
		total += len(l)
	}
	avg := total / len(lines)
	if avg < 20 {
		return 20
	}
	return avg
}

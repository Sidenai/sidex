package compress

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"
)

type Compressor struct {
	cache sync.Map
}

func New() *Compressor {
	return &Compressor{}
}

func EstimateTokens(s string) int {
	return utf8.RuneCountInString(s) / 3
}

func (c *Compressor) CompressText(text string, targetRatio float64) string {
	if targetRatio >= 1.0 {
		return text
	}

	h := sha256.Sum256([]byte(text))
	key := fmt.Sprintf("%x:%.2f", h, targetRatio)
	if cached, ok := c.cache.Load(key); ok {
		return cached.(string)
	}

	lines := strings.Split(text, "\n")
	targetLines := int(float64(len(lines)) * targetRatio)
	if targetLines < 1 {
		targetLines = 1
	}

	scored := make([]scoredLine, len(lines))
	for i, line := range lines {
		scored[i] = scoredLine{index: i, line: line, score: scoreLine(line, i, len(lines))}
	}

	sortByScore(scored)

	kept := make(map[int]bool)
	for i := 0; i < targetLines && i < len(scored); i++ {
		kept[scored[i].index] = true
	}

	var result strings.Builder
	prevKept := true
	for i, line := range lines {
		if kept[i] {
			if !prevKept {
				result.WriteString("  [...]\n")
			}
			result.WriteString(line)
			result.WriteByte('\n')
			prevKept = true
		} else {
			prevKept = false
		}
	}

	compressed := result.String()
	c.cache.Store(key, compressed)
	return compressed
}

type scoredLine struct {
	index int
	line  string
	score float64
}

func scoreLine(line string, idx, total int) float64 {
	score := 0.0
	trimmed := strings.TrimSpace(line)

	if strings.HasPrefix(trimmed, "func ") || strings.HasPrefix(trimmed, "fn ") ||
		strings.HasPrefix(trimmed, "def ") || strings.HasPrefix(trimmed, "class ") ||
		strings.HasPrefix(trimmed, "type ") || strings.HasPrefix(trimmed, "struct ") ||
		strings.HasPrefix(trimmed, "interface ") || strings.HasPrefix(trimmed, "impl ") ||
		strings.HasPrefix(trimmed, "pub ") || strings.HasPrefix(trimmed, "export ") {
		score += 10
	}

	if strings.HasPrefix(trimmed, "import ") || strings.HasPrefix(trimmed, "use ") ||
		strings.HasPrefix(trimmed, "package ") || strings.HasPrefix(trimmed, "mod ") ||
		strings.HasPrefix(trimmed, "from ") || strings.HasPrefix(trimmed, "#include") {
		score += 8
	}

	if strings.Contains(trimmed, "error") || strings.Contains(trimmed, "Error") ||
		strings.Contains(trimmed, "panic") || strings.Contains(trimmed, "TODO") ||
		strings.Contains(trimmed, "FIXME") || strings.Contains(trimmed, "HACK") {
		score += 7
	}

	if strings.Contains(trimmed, "return ") {
		score += 3
	}

	if trimmed == "" || trimmed == "{" || trimmed == "}" || trimmed == ")" {
		score -= 2
	}

	if idx < 10 || idx > total-5 {
		score += 2
	}

	return score
}

func sortByScore(lines []scoredLine) {
	for i := 1; i < len(lines); i++ {
		key := lines[i]
		j := i - 1
		for j >= 0 && lines[j].score < key.score {
			lines[j+1] = lines[j]
			j--
		}
		lines[j+1] = key
	}
}

func CompressFileContent(content string, maxLines int) string {
	lines := strings.Split(content, "\n")
	if len(lines) <= maxLines {
		return content
	}

	c := New()
	ratio := float64(maxLines) / float64(len(lines))
	return c.CompressText(content, ratio)
}

func SummarizeToolOutput(output string, maxChars int) string {
	if len(output) <= maxChars {
		return output
	}

	head := maxChars / 3
	tail := maxChars / 3
	return output[:head] + "\n\n... [truncated " +
		fmt.Sprintf("%d", len(output)-head-tail) +
		" chars] ...\n\n" + output[len(output)-tail:]
}

package tools

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func init_web_search(r *Registry) {
	r.tools["web_search"] = Tool{
		Name: "web_search",
		Description: `Search the web for real-time information and return structured results with titles, URLs, and snippets. Use this when you need current information not in your training data: up-to-date library docs, API references, error messages, or current events.

Do NOT use this to search the local codebase — use grep or context_search for that. Returns up to 20 results (default 5) from DuckDuckGo.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query":       map[string]interface{}{"type": "string", "description": "Search query."},
				"num_results": map[string]interface{}{"type": "integer", "description": "Max results to return (default 5)."},
			},
			"required": []string{"query"},
		},
	}
}

func (r *Registry) webSearch(args map[string]interface{}) ExecutionResult {
	query := str(args, "query")
	if query == "" {
		return ExecutionResult{Error: "query is required"}
	}
	numResults := intOr(args, "num_results", 5)
	if numResults < 1 {
		numResults = 1
	}
	if numResults > 20 {
		numResults = 20
	}

	searchURL := "https://html.duckduckgo.com/html/?q=" + url.QueryEscape(query)

	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest("GET", searchURL, nil)
	if err != nil {
		return ExecutionResult{Error: "failed to build request: " + err.Error()}
	}
	req.Header.Set("User-Agent", "Sidex/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return ExecutionResult{Error: "search request failed: " + err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 500000))
	if err != nil {
		return ExecutionResult{Error: "failed to read response: " + err.Error()}
	}

	results := parseDDGResults(string(body), numResults)
	if len(results) == 0 {
		return ExecutionResult{Output: "No results found for: " + query}
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Search results for: %s\n\n", query))
	for i, r := range results {
		sb.WriteString(fmt.Sprintf("%d. [%s](%s)\n", i+1, r.title, r.url))
		if r.snippet != "" {
			sb.WriteString(fmt.Sprintf("   %s\n", r.snippet))
		}
		sb.WriteString("\n")
	}
	return ExecutionResult{Output: sb.String()}
}

type ddgResult struct {
	title   string
	url     string
	snippet string
}

func parseDDGResults(html string, max int) []ddgResult {
	var results []ddgResult
	remaining := html

	for len(results) < max {
		idx := strings.Index(remaining, "class=\"result__title")
		if idx == -1 {
			break
		}
		remaining = remaining[idx:]

		title, link := extractTitleAndLink(remaining)
		snippet := extractSnippet(remaining)

		if title != "" {
			results = append(results, ddgResult{
				title:   cleanHTML(title),
				url:     link,
				snippet: cleanHTML(snippet),
			})
		}

		// Advance past this result block
		next := strings.Index(remaining[1:], "class=\"result__title")
		if next == -1 {
			break
		}
		remaining = remaining[next+1:]
	}

	return results
}

func extractTitleAndLink(block string) (string, string) {
	aIdx := strings.Index(block, "<a")
	if aIdx == -1 {
		return "", ""
	}
	aBlock := block[aIdx:]

	href := extractAttr(aBlock, "href")

	startTag := strings.Index(aBlock, ">")
	if startTag == -1 {
		return "", ""
	}
	endTag := strings.Index(aBlock[startTag:], "</a>")
	if endTag == -1 {
		return "", ""
	}

	title := aBlock[startTag+1 : startTag+endTag]
	return strings.TrimSpace(title), href
}

func extractSnippet(block string) string {
	idx := strings.Index(block, "class=\"result__snippet")
	if idx == -1 {
		return ""
	}
	sub := block[idx:]
	startTag := strings.Index(sub, ">")
	if startTag == -1 {
		return ""
	}
	// Find closing tag
	end := strings.Index(sub[startTag:], "</")
	if end == -1 {
		end = 300
		if startTag+end > len(sub) {
			end = len(sub) - startTag
		}
	}
	return strings.TrimSpace(sub[startTag+1 : startTag+end])
}

func extractAttr(tag, attr string) string {
	key := attr + "=\""
	idx := strings.Index(tag, key)
	if idx == -1 {
		return ""
	}
	start := idx + len(key)
	end := strings.Index(tag[start:], "\"")
	if end == -1 {
		return ""
	}
	return tag[start : start+end]
}

func cleanHTML(s string) string {
	var out strings.Builder
	inTag := false
	for _, c := range s {
		if c == '<' {
			inTag = true
			continue
		}
		if c == '>' {
			inTag = false
			continue
		}
		if !inTag {
			out.WriteRune(c)
		}
	}
	result := out.String()
	result = strings.ReplaceAll(result, "&amp;", "&")
	result = strings.ReplaceAll(result, "&lt;", "<")
	result = strings.ReplaceAll(result, "&gt;", ">")
	result = strings.ReplaceAll(result, "&quot;", "\"")
	result = strings.ReplaceAll(result, "&#x27;", "'")
	result = strings.ReplaceAll(result, "&nbsp;", " ")
	return strings.TrimSpace(result)
}

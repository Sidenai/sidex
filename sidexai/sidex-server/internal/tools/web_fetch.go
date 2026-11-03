package tools

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/sidex-ai/sidex-server/internal/compress"
)

func init_web_fetch(r *Registry) {
	r.tools["web_fetch"] = Tool{
		Name: "web_fetch",
		Description: `Fetch a URL and return its HTTP response body as text. Use this to read documentation pages, API responses, or web content the user referenced. Has a 500KB body cap and 15-second timeout.

Only fetch URLs the user provided or that you found in their local files — do NOT guess or construct URLs speculatively. Returns the HTTP status code followed by the body content.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"url": map[string]interface{}{"type": "string", "description": "Fully-qualified http(s) URL."},
			},
			"required": []string{"url"},
		},
	}
}

func (r *Registry) webFetch(args map[string]interface{}) ExecutionResult {
	rawURL := str(args, "url")
	if rawURL == "" {
		return ExecutionResult{Error: "url is required"}
	}
	if err := validateFetchURL(rawURL); err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("stopped after 5 redirects")
			}
			return validateFetchURL(req.URL.String())
		},
	}
	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	req.Header.Set("User-Agent", "Sidex/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 500000))
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	result := fmt.Sprintf("HTTP %d\n\n%s", resp.StatusCode, string(body))
	if len(result) > 100000 {
		result = compress.SummarizeToolOutput(result, 100000)
	}
	return ExecutionResult{Output: result}
}

func validateFetchURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("web_fetch only supports http and https URLs")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("url must include a host")
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("failed to resolve host: %w", err)
	}
	for _, ip := range ips {
		if isPrivateFetchIP(ip) {
			return fmt.Errorf("refusing to fetch private, local, or link-local address %s", ip.String())
		}
	}
	return nil
}

func isPrivateFetchIP(ip net.IP) bool {
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast()
}

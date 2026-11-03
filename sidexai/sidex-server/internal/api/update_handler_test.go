package api

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestIsLoopbackHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"localhost:8080", true},
		{"LOCALHOST:3000", true},
		{"127.0.0.1", true},
		{"127.0.0.1:8080", true},
		{"[::1]", true},
		{"[::1]:8080", true},
		{"::1", true},
		{"example.com", false},
		{"example.com:8080", false},
		{"203.0.113.5", false},
		{"203.0.113.5:8080", false},
		{"0.0.0.0", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := isLoopbackHost(tc.host); got != tc.want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

func writeManifest(t *testing.T, dir string) {
	t.Helper()
	manifest := releaseManifest{
		Version: "0.2.0",
		Platforms: map[string]platformRelease{
			"darwin-aarch64": {URL: "SideX_0.2.0_aarch64.app.tar.gz"},
			"absolute":       {URL: "https://cdn.example.com/already-absolute.tar.gz"},
		},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal fixture manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "latest.json"), data, 0o644); err != nil {
		t.Fatalf("write fixture manifest: %v", err)
	}
}

func decodeManifest(t *testing.T, w *httptest.ResponseRecorder) releaseManifest {
	t.Helper()
	var got releaseManifest
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response body: %v\nbody: %s", err, w.Body.String())
	}
	return got
}

// A remote client (no direct TLS on this process, and not loopback) must
// always get https:// download links — this is the case a bare hostname
// check used to special-case for one specific deployment.
func TestLatestForcesHTTPSForRemoteHostWithoutTLS(t *testing.T) {
	dir := t.TempDir()
	writeManifest(t, dir)
	h := &UpdateHandler{dir: dir}

	req := httptest.NewRequest(http.MethodGet, "/v1/update/latest.json", nil)
	req.Host = "updates.example.com"
	req.TLS = nil
	w := httptest.NewRecorder()

	h.Latest(w, req)

	got := decodeManifest(t, w)
	p := got.Platforms["darwin-aarch64"]
	want := "https://updates.example.com/v1/update/dl/SideX_0.2.0_aarch64.app.tar.gz"
	if p.URL != want {
		t.Fatalf("expected forced https URL, got %q want %q", p.URL, want)
	}
}

// Local development (loopback, no TLS listener) is the one legitimate case
// for a plaintext download link.
func TestLatestAllowsHTTPForLoopbackWithoutTLS(t *testing.T) {
	dir := t.TempDir()
	writeManifest(t, dir)
	h := &UpdateHandler{dir: dir}

	req := httptest.NewRequest(http.MethodGet, "/v1/update/latest.json", nil)
	req.Host = "127.0.0.1:8787"
	req.TLS = nil
	w := httptest.NewRecorder()

	h.Latest(w, req)

	got := decodeManifest(t, w)
	p := got.Platforms["darwin-aarch64"]
	want := "http://127.0.0.1:8787/v1/update/dl/SideX_0.2.0_aarch64.app.tar.gz"
	if p.URL != want {
		t.Fatalf("expected plaintext loopback URL, got %q want %q", p.URL, want)
	}
}

// A directly TLS-terminated connection always yields https, loopback or not.
func TestLatestKeepsHTTPSWhenTLSPresent(t *testing.T) {
	dir := t.TempDir()
	writeManifest(t, dir)
	h := &UpdateHandler{dir: dir}

	req := httptest.NewRequest(http.MethodGet, "/v1/update/latest.json", nil)
	req.Host = "localhost:8787"
	req.TLS = &tls.ConnectionState{}
	w := httptest.NewRecorder()

	h.Latest(w, req)

	got := decodeManifest(t, w)
	p := got.Platforms["darwin-aarch64"]
	want := "https://localhost:8787/v1/update/dl/SideX_0.2.0_aarch64.app.tar.gz"
	if p.URL != want {
		t.Fatalf("expected https URL, got %q want %q", p.URL, want)
	}
}

// URLs that are already absolute (e.g. a CDN) must pass through untouched.
func TestLatestLeavesAbsoluteURLsUntouched(t *testing.T) {
	dir := t.TempDir()
	writeManifest(t, dir)
	h := &UpdateHandler{dir: dir}

	req := httptest.NewRequest(http.MethodGet, "/v1/update/latest.json", nil)
	req.Host = "updates.example.com"
	w := httptest.NewRecorder()

	h.Latest(w, req)

	got := decodeManifest(t, w)
	p := got.Platforms["absolute"]
	want := "https://cdn.example.com/already-absolute.tar.gz"
	if p.URL != want {
		t.Fatalf("absolute URL was rewritten: got %q want %q", p.URL, want)
	}
}

func TestLatestReturnsNoContentWhenNoManifest(t *testing.T) {
	h := &UpdateHandler{dir: t.TempDir()}

	req := httptest.NewRequest(http.MethodGet, "/v1/update/latest.json", nil)
	w := httptest.NewRecorder()

	h.Latest(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", w.Code)
	}
}

package api

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// UpdateHandler serves desktop release manifests and update artifacts.
//
// Releases live in a directory on the API host (default ~/.sidex/releases,
// override with SIDEX_RELEASES_DIR):
//
//	releases/
//	  latest.json          ← manifest (version, notes, platforms{url,signature,sha256,size})
//	  SideX_0.2.0_aarch64.app.tar.gz        ← artifacts referenced by the manifest
//	  SideX_0.2.0_aarch64.app.tar.gz.sig
//	  ...
//
// The manifest's platform URLs may be absolute (CDN) or bare filenames —
// bare names are rewritten to this server's /v1/update/dl/<name> route so a
// single host can serve everything.
type UpdateHandler struct {
	dir string
}

// NewUpdateHandler creates the handler, resolving the releases directory.
func NewUpdateHandler() *UpdateHandler {
	dir := os.Getenv("SIDEX_RELEASES_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err == nil {
			dir = filepath.Join(home, ".sidex", "releases")
		} else {
			dir = "releases"
		}
	}
	return &UpdateHandler{dir: dir}
}

type platformRelease struct {
	URL       string `json:"url"`
	Signature string `json:"signature,omitempty"`
	Sha256    string `json:"sha256,omitempty"`
	Size      int64  `json:"size,omitempty"`
}

type releaseManifest struct {
	Version   string                     `json:"version"`
	PubDate   string                     `json:"pub_date,omitempty"`
	Notes     string                     `json:"notes,omitempty"`
	Platforms map[string]platformRelease `json:"platforms"`
}

// Latest handles GET /v1/update/latest.json.
// Returns 204 when no release has been published yet.
func (h *UpdateHandler) Latest(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(filepath.Join(h.dir, "latest.json"))
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var manifest releaseManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		http.Error(w, `{"error":"malformed release manifest on server"}`, http.StatusInternalServerError)
		return
	}

	// Rewrite bare artifact filenames to absolute download URLs on this host.
	// Default to https: anyone reaching this server from off the local
	// machine should be fetching update artifacts over TLS. Plaintext is
	// only legitimate for local development, where the request came in over
	// loopback and there's no TLS listener (or fronting proxy) to speak of.
	scheme := "https"
	if r.TLS == nil && isLoopbackHost(r.Host) {
		scheme = "http"
	}
	base := scheme + "://" + r.Host + "/v1/update/dl/"
	for key, p := range manifest.Platforms {
		if p.URL != "" && !strings.Contains(p.URL, "://") {
			p.URL = base + p.URL
			manifest.Platforms[key] = p
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	_ = json.NewEncoder(w).Encode(manifest)
}

// Download handles GET /v1/update/dl/{filename} — serves a release artifact.
// Only plain filenames inside the releases dir are allowed.
func (h *UpdateHandler) Download(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/v1/update/dl/")
	// No traversal: a bare filename only.
	if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, ".") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(h.dir, name)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, path)
}

// isLoopbackHost reports whether host — as found in an HTTP request's Host
// header, with an optional ":port" — can only mean "this machine", never
// something reachable over the network.
func isLoopbackHost(host string) bool {
	h := host
	if hostOnly, _, err := net.SplitHostPort(host); err == nil {
		h = hostOnly
	}
	h = strings.Trim(h, "[]") // SplitHostPort only strips IPv6 brackets when a port is present
	if strings.EqualFold(h, "localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

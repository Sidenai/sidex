package api

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/gorilla/mux"
	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/auth"
)

// APIKeyEntry represents a stored API key for a direct provider.
type APIKeyEntry struct {
	Provider  string `json:"provider"`
	KeyMasked string `json:"key_masked"`
	BaseURL   string `json:"base_url,omitempty"`
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"created_at,omitempty"`
}

// MigrateAPIKeys creates the api_keys table in the usage database.
func MigrateAPIKeys(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS api_keys (
		user_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		api_key TEXT NOT NULL,
		base_url TEXT,
		enabled INTEGER DEFAULT 1,
		created_at TEXT DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (user_id, provider)
	);`
	_, err := db.Exec(schema)
	return err
}

// SaveAPIKey stores or replaces an API key for a provider.
func (h *Handler) SaveAPIKey(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024) // 16KB max
	user := auth.GetUser(r.Context())
	if user == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	var req struct {
		Provider string `json:"provider"`
		APIKey   string `json:"api_key"`
		BaseURL  string `json:"base_url,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Provider == "" || req.APIKey == "" {
		http.Error(w, `{"error":"provider and api_key are required"}`, http.StatusBadRequest)
		return
	}

	if !ai.RequiresAPIKey(req.Provider) {
		http.Error(w, fmt.Sprintf(`{"error":"provider %q does not require an API key (available through the built-in OpenRouter routing)"}`, req.Provider), http.StatusBadRequest)
		return
	}

	baseURL := req.BaseURL
	if baseURL == "" {
		baseURL = ai.DirectProviders[req.Provider]
	}

	if h.usageService == nil {
		http.Error(w, `{"error":"storage not available"}`, http.StatusServiceUnavailable)
		return
	}

	encryptedKey, err := encryptAPIKey(req.APIKey)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to encrypt key: %s"}`, err), http.StatusInternalServerError)
		return
	}

	db := h.usageService.DB()
	_, err = db.Exec(
		`INSERT INTO api_keys (user_id, provider, api_key, base_url, enabled)
		 VALUES (?, ?, ?, ?, 1)
		 ON CONFLICT(user_id, provider) DO UPDATE SET
		   api_key = excluded.api_key,
		   base_url = excluded.base_url,
		   enabled = 1`,
		user.UserID, req.Provider, encryptedKey, baseURL,
	)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to save key: %s"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"provider": req.Provider,
		"status":   "saved",
	})
}

// ListAPIKeys returns saved providers with masked keys.
func (h *Handler) ListAPIKeys(w http.ResponseWriter, r *http.Request) {
	user := auth.GetUser(r.Context())
	if user == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if h.usageService == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]APIKeyEntry{})
		return
	}

	db := h.usageService.DB()
	rows, err := db.Query(
		`SELECT provider, api_key, base_url, enabled, created_at FROM api_keys WHERE user_id = ?`,
		user.UserID,
	)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"query failed: %s"}`, err), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var entries []APIKeyEntry
	for rows.Next() {
		var provider, apiKey, createdAt string
		var baseURL sql.NullString
		var enabled int
		if err := rows.Scan(&provider, &apiKey, &baseURL, &enabled, &createdAt); err != nil {
			continue
		}
		entries = append(entries, APIKeyEntry{
			Provider:  provider,
			KeyMasked: maskKey(decryptAPIKeyForMask(apiKey)),
			BaseURL:   baseURL.String,
			Enabled:   enabled == 1,
			CreatedAt: createdAt,
		})
	}
	if entries == nil {
		entries = []APIKeyEntry{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}

// DeleteAPIKey removes a stored API key for a provider.
func (h *Handler) DeleteAPIKey(w http.ResponseWriter, r *http.Request) {
	user := auth.GetUser(r.Context())
	if user == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	provider := mux.Vars(r)["provider"]
	if provider == "" {
		http.Error(w, `{"error":"provider is required"}`, http.StatusBadRequest)
		return
	}

	if h.usageService == nil {
		http.Error(w, `{"error":"storage not available"}`, http.StatusServiceUnavailable)
		return
	}

	db := h.usageService.DB()
	_, err := db.Exec(
		`DELETE FROM api_keys WHERE user_id = ? AND provider = ?`,
		user.UserID, provider,
	)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"delete failed: %s"}`, err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetAPIKeyForProvider retrieves the decrypted API key for a provider (internal use only).
func (h *Handler) GetAPIKeyForProvider(userID, provider string) (string, error) {
	cfg, err := h.GetProviderConfig(userID, provider)
	return cfg.APIKey, err
}

// clientFor returns an AI client carrying whatever credentials apply to the
// given model's provider.
//
// Every request path must go through this. Credentials passed down by the
// desktop app win, because in the account-free build they are the only ones
// that exist; a stored per-user key is the fallback for hosted deployments.
func (h *Handler) clientFor(model, userID string) *ai.Client {
	client := h.aiClient.WithModel(model)

	provider := ai.ProviderFromModelID(client.Model())
	if provider == "" {
		return client
	}
	if cfg, ok := ai.LocalProviderConfig(provider); ok {
		return client.WithProviderConfig(cfg)
	}
	if userID != "" && ai.RequiresAPIKey(provider) {
		if cfg, err := h.GetProviderConfig(userID, provider); err == nil {
			return client.WithProviderConfig(cfg)
		}
	}
	return client
}

func (h *Handler) GetProviderConfig(userID, provider string) (ai.ProviderConfig, error) {
	if h.usageService == nil {
		return ai.ProviderConfig{}, fmt.Errorf("storage not available")
	}
	db := h.usageService.DB()
	var apiKey string
	var baseURL sql.NullString
	err := db.QueryRow(
		`SELECT api_key, base_url FROM api_keys WHERE user_id = ? AND provider = ? AND enabled = 1`,
		userID, provider,
	).Scan(&apiKey, &baseURL)
	if err != nil {
		return ai.ProviderConfig{}, err
	}
	decrypted, err := decryptAPIKey(apiKey)
	if err != nil {
		return ai.ProviderConfig{}, err
	}
	url := baseURL.String
	if url == "" {
		url = ai.DirectProviders[provider]
	}
	return ai.ProviderConfig{Provider: provider, APIKey: decrypted, BaseURL: url, Enabled: true}, nil
}

func maskKey(key string) string {
	if len(key) <= 8 {
		return strings.Repeat("*", len(key))
	}
	return key[:4] + "..." + key[len(key)-4:]
}

func encryptAPIKey(plain string) (string, error) {
	gcm, err := apiKeyGCM()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(plain), nil)
	return "v1:" + base64.StdEncoding.EncodeToString(append(nonce, ciphertext...)), nil
}

func decryptAPIKey(value string) (string, error) {
	if !strings.HasPrefix(value, "v1:") {
		return value, nil
	}
	gcm, err := apiKeyGCM()
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, "v1:"))
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", fmt.Errorf("encrypted key payload is invalid")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decryptAPIKeyForMask(value string) string {
	plain, err := decryptAPIKey(value)
	if err != nil {
		return ""
	}
	return plain
}

func apiKeyGCM() (cipher.AEAD, error) {
	secret := os.Getenv("SIDEX_API_KEY_ENCRYPTION_KEY")
	if secret == "" {
		secret = os.Getenv("SIDEX_JWT_SECRET")
	}
	if secret == "" {
		return nil, fmt.Errorf("SIDEX_API_KEY_ENCRYPTION_KEY or SIDEX_JWT_SECRET is required")
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

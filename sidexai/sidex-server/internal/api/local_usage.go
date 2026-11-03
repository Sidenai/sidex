package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/auth"
	"github.com/sidex-ai/sidex-server/internal/usage"
)

// localUsageSummary is what the desktop app renders in Settings → Usage.
type localUsageSummary struct {
	TotalCost         float64             `json:"totalCost"`
	TotalInputTokens  int                 `json:"totalInputTokens"`
	TotalOutputTokens int                 `json:"totalOutputTokens"`
	RequestCount      int                 `json:"requestCount"`
	CreditsRemaining  float64             `json:"creditsRemaining"`
	ExtraCredits      float64             `json:"extraCredits"`
	PeriodStart       string              `json:"periodStart"`
	PeriodEnd         string              `json:"periodEnd"`
	PercentUsed       float64             `json:"percentUsed"`
	Accounts          []localUsageAccount `json:"accounts"`
}

type localUsageAccount struct {
	ID           string           `json:"id"`
	Label        string           `json:"label"`
	Source       string           `json:"source"`
	InputTokens  int              `json:"inputTokens"`
	OutputTokens int              `json:"outputTokens"`
	Cost         float64          `json:"cost"`
	Windows      []ai.QuotaWindow `json:"windows,omitempty"`
	ExtraCredits *ai.ExtraCredits `json:"extraCredits,omitempty"`
	Unavailable  string           `json:"unavailable,omitempty"`
}

func (h *Handler) LocalUsageSummary(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	out := localUsageSummary{Accounts: []localUsageAccount{}}

	accountID := "local"
	if user := auth.GetUser(r.Context()); user != nil && user.UserID != "" {
		accountID = user.UserID
	}
	periodStart := usage.BillingPeriodStart()

	userID := accountID
	if h.usageService != nil {
		if resolved, err := h.usageService.ResolveAccount(accountID); err == nil {
			userID = resolved
		}
		if summary, err := h.usageService.GetUserSummary(userID, periodStart); err == nil && summary != nil {
			out.TotalCost = summary.TotalCost
			out.TotalInputTokens = summary.TotalInputTokens
			out.TotalOutputTokens = summary.TotalOutputTokens
			out.RequestCount = summary.RequestCount
			out.PeriodStart = summary.PeriodStart.Format("2006-01-02T15:04:05Z07:00")
			out.PeriodEnd = summary.PeriodEnd.Format("2006-01-02T15:04:05Z07:00")
		}
	}

	out.Accounts = assembleUsageAccounts(h.usageService, userID, periodStart)
	_ = json.NewEncoder(w).Encode(out)
}

func assembleUsageAccounts(svc *usage.Service, userID string, periodStart time.Time) []localUsageAccount {
	localBy := map[string]usage.ProviderUsage{}
	if svc != nil && userID != "" {
		if rows, err := svc.GetProviderBreakdown(userID, periodStart); err == nil {
			for _, row := range rows {
				localBy[row.Provider] = row
			}
		}
	}

	cfgs := map[string]ai.ProviderConfig{}
	for _, cfg := range ai.ConfiguredLocalProviders() {
		cfgs[cfg.Provider] = cfg
	}

	seen := map[string]struct{}{}
	var ids []string
	add := func(id string) {
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for id := range cfgs {
		add(id)
	}
	for id := range localBy {
		add(id)
	}
	sortUsageAccountIDs(ids)

	accounts := make([]localUsageAccount, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		cfg, hasCfg := cfgs[id]
		local := localBy[id]
		accounts[i] = localUsageAccount{
			ID:           id,
			Label:        usageAccountLabel(id, cfg, hasCfg),
			Source:       usageAccountSource(cfg, hasCfg),
			InputTokens:  local.InputTokens,
			OutputTokens: local.OutputTokens,
			Cost:         local.Cost,
		}
		if !hasCfg || cfg.AuthMode != ai.AuthModeOAuth {
			continue
		}
		wg.Add(1)
		go func(idx int, c ai.ProviderConfig) {
			defer wg.Done()
			q, err := ai.FetchSubscriptionQuota(c)
			if err != nil {
				accounts[idx].Unavailable = "Could not load plan usage from this account."
				return
			}
			if q == nil {
				return
			}
			accounts[idx].Windows = q.Windows
			accounts[idx].ExtraCredits = q.Extra
		}(i, cfg)
	}
	wg.Wait()
	return accounts
}

func usageAccountLabel(id string, cfg ai.ProviderConfig, hasCfg bool) string {
	if hasCfg {
		switch {
		case id == "anthropic" && cfg.AuthMode == ai.AuthModeOAuth:
			return "Claude Code"
		case id == "openai" && cfg.AuthMode == ai.AuthModeOAuth:
			return "Codex"
		}
	}
	switch id {
	case "anthropic":
		return "Anthropic"
	case "openai":
		return "OpenAI"
	case "openrouter":
		return "OpenRouter"
	default:
		if id == "" {
			return "Other"
		}
		return strings.ToUpper(id[:1]) + id[1:]
	}
}

func usageAccountSource(cfg ai.ProviderConfig, hasCfg bool) string {
	if !hasCfg {
		return "recorded"
	}
	if cfg.AuthMode == ai.AuthModeOAuth {
		return "oauth"
	}
	if cfg.APIKey == "" {
		return "local"
	}
	return "api_key"
}

func sortUsageAccountIDs(ids []string) {
	rank := func(s string) int {
		switch s {
		case "anthropic":
			return 0
		case "openai":
			return 1
		default:
			return 2
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		if rank(ids[i]) != rank(ids[j]) {
			return rank(ids[i]) < rank(ids[j])
		}
		return ids[i] < ids[j]
	})
}

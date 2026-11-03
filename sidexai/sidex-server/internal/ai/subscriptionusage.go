package ai

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// CodexCreditUSD is OpenAI's published Codex credit price ($0.04 per credit).
const CodexCreditUSD = 0.04

// QuotaWindow is one subscription bucket (5-hour session, weekly, …).
type QuotaWindow struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    string  `json:"resetsAt,omitempty"`
}

// ExtraCredits is the optional pay-as-you-go pool on a Claude/Codex plan.
type ExtraCredits struct {
	Enabled     bool    `json:"enabled"`
	Used        float64 `json:"used"`
	Limit       float64 `json:"limit"`
	UsedPercent float64 `json:"usedPercent"`
	Balance           string  `json:"balance,omitempty"`
	Currency          string  `json:"currency,omitempty"`
	CreditsRemaining  float64 `json:"creditsRemaining,omitempty"`
	UsdRemaining      float64 `json:"usdRemaining,omitempty"`
}

// SubscriptionQuota is live plan usage from the provider, not SideX's local token log.
type SubscriptionQuota struct {
	Windows []QuotaWindow
	Extra   *ExtraCredits
}

func FetchSubscriptionQuota(cfg ProviderConfig) (*SubscriptionQuota, error) {
	if cfg.AuthMode != AuthModeOAuth || cfg.APIKey == "" {
		return nil, nil
	}
	switch {
	case cfg.Provider == "anthropic":
		return fetchClaudeOAuthUsage(cfg)
	case isCodexHost(cfg):
		return fetchCodexUsage(cfg)
	default:
		return nil, nil
	}
}

func fetchClaudeOAuthUsage(cfg ProviderConfig) (*SubscriptionQuota, error) {
	req, err := http.NewRequest(http.MethodGet, "https://api.anthropic.com/api/oauth/usage", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("anthropic-version", anthropicVersion)
	applyClaudeCodeIdentity(req, cfg.APIKey, "")

	resp, err := quotaHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("claude usage HTTP %d", resp.StatusCode)
	}
	return parseClaudeOAuthUsage(body)
}

type claudeUsageBucket struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

func parseClaudeOAuthUsage(raw []byte) (*SubscriptionQuota, error) {
	var env struct {
		FiveHour       *claudeUsageBucket `json:"five_hour"`
		SevenDay       *claudeUsageBucket `json:"seven_day"`
		SevenDayOpus   *claudeUsageBucket `json:"seven_day_opus"`
		SevenDaySonnet *claudeUsageBucket `json:"seven_day_sonnet"`
		ExtraUsage     *struct {
			IsEnabled    *bool    `json:"is_enabled"`
			Enabled      *bool    `json:"enabled"`
			MonthlyLimit *float64 `json:"monthly_limit"`
			UsedCredits  *float64 `json:"used_credits"`
			Utilization  *float64 `json:"utilization"`
			Currency     string   `json:"currency"`
		} `json:"extra_usage"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	q := &SubscriptionQuota{}
	addClaudeBucket := func(id, label string, b *claudeUsageBucket) {
		if b == nil || (b.Utilization == nil && strings.TrimSpace(b.ResetsAt) == "") {
			return
		}
		w := QuotaWindow{ID: id, Label: label, ResetsAt: strings.TrimSpace(b.ResetsAt)}
		if b.Utilization != nil {
			w.UsedPercent = utilizationAsPercent(*b.Utilization)
		}
		q.Windows = append(q.Windows, w)
	}
	addClaudeBucket("five_hour", "5-hour session", env.FiveHour)
	addClaudeBucket("seven_day", "Weekly", env.SevenDay)
	addClaudeBucket("seven_day_sonnet", "Weekly Sonnet", env.SevenDaySonnet)
	addClaudeBucket("seven_day_opus", "Weekly Opus", env.SevenDayOpus)

	if env.ExtraUsage != nil {
		enabled := false
		if env.ExtraUsage.IsEnabled != nil {
			enabled = *env.ExtraUsage.IsEnabled
		} else if env.ExtraUsage.Enabled != nil {
			enabled = *env.ExtraUsage.Enabled
		}
		used, limit, pct := 0.0, 0.0, 0.0
		if env.ExtraUsage.UsedCredits != nil {
			used = *env.ExtraUsage.UsedCredits
		}
		if env.ExtraUsage.MonthlyLimit != nil {
			limit = *env.ExtraUsage.MonthlyLimit
		}
		if env.ExtraUsage.Utilization != nil {
			pct = utilizationAsPercent(*env.ExtraUsage.Utilization)
		} else if limit > 0 {
			pct = (used / limit) * 100
		}
		if enabled || used > 0 || limit > 0 {
			q.Extra = &ExtraCredits{
				Enabled:     enabled,
				Used:        used,
				Limit:       limit,
				UsedPercent: pct,
				Currency:    env.ExtraUsage.Currency,
			}
		}
	}
	return q, nil
}

func fetchCodexUsage(cfg ProviderConfig) (*SubscriptionQuota, error) {
	urls := []string{strings.TrimRight(cfg.BaseURL, "/") + "/usage"}
	if !strings.Contains(cfg.BaseURL, "/wham/") {
		urls = append(urls, "https://chatgpt.com/backend-api/wham/usage")
	}
	var last error
	for _, u := range urls {
		q, err := getCodexUsageURL(cfg, u)
		if err == nil && q != nil {
			return q, nil
		}
		last = err
	}
	if last == nil {
		last = fmt.Errorf("codex usage unavailable")
	}
	return nil, last
}

func getCodexUsageURL(cfg ProviderConfig, url string) (*SubscriptionQuota, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	applyCodexIdentity(req, cfg.APIKey, cfg.AccountID)
	req.Header.Set("Accept", "application/json")

	resp, err := quotaHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("codex usage HTTP %d", resp.StatusCode)
	}
	return parseCodexUsage(body)
}

type codexWindowJSON struct {
	UsedPercent        *float64 `json:"used_percent"`
	LimitWindowSeconds *float64 `json:"limit_window_seconds"`
	ResetAt            *int64   `json:"reset_at"`
	ResetAfterSeconds  *float64 `json:"reset_after_seconds"`
}

func parseCodexUsage(raw []byte) (*SubscriptionQuota, error) {
	var env struct {
		PlanType  string `json:"plan_type"`
		RateLimit *struct {
			PrimaryWindow   *codexWindowJSON `json:"primary_window"`
			SecondaryWindow *codexWindowJSON `json:"secondary_window"`
		} `json:"rate_limit"`
		Credits *struct {
			HasCredits *bool   `json:"has_credits"`
			Unlimited  *bool   `json:"unlimited"`
			Balance    *string `json:"balance"`
		} `json:"credits"`
		Additional []struct {
			LimitName string `json:"limit_name"`
			RateLimit *struct {
				PrimaryWindow *codexWindowJSON `json:"primary_window"`
			} `json:"rate_limit"`
		} `json:"additional_rate_limits"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	q := &SubscriptionQuota{}
	if env.RateLimit != nil {
		appendCodexWindow(q, codexWindow("primary", env.RateLimit.PrimaryWindow))
		appendCodexWindow(q, codexWindow("secondary", env.RateLimit.SecondaryWindow))
	}
	for _, extra := range env.Additional {
		if extra.RateLimit == nil {
			continue
		}
		w := codexWindow(strings.TrimSpace(extra.LimitName), extra.RateLimit.PrimaryWindow)
		if extra.LimitName != "" && w != nil {
			w.Label = extra.LimitName
			w.ID = slugID(extra.LimitName)
		}
		appendCodexWindow(q, w)
	}
	if env.Credits != nil {
		has := env.Credits.HasCredits != nil && *env.Credits.HasCredits
		unlimited := env.Credits.Unlimited != nil && *env.Credits.Unlimited
		bal := ""
		if env.Credits.Balance != nil {
			bal = strings.TrimSpace(*env.Credits.Balance)
		}
		credits, _ := strconv.ParseFloat(strings.ReplaceAll(bal, ",", ""), 64)
		if has || unlimited || credits > 0 {
			usd := 0.0
			if credits > 0 {
				usd = math.Floor(credits) * CodexCreditUSD
			}
			q.Extra = &ExtraCredits{
				Enabled:          has || unlimited || credits > 0,
				Balance:          bal,
				Currency:         "USD",
				CreditsRemaining: credits,
				UsdRemaining:     usd,
			}
		}
	}
	return q, nil
}

func codexWindow(fallbackID string, w *codexWindowJSON) *QuotaWindow {
	if w == nil {
		return nil
	}
	out := QuotaWindow{ID: fallbackID, Label: fallbackID}
	if w.LimitWindowSeconds != nil {
		out.Label = windowLabelFromSeconds(*w.LimitWindowSeconds)
		out.ID = slugID(out.Label)
	} else if fallbackID == "primary" {
		out.Label = "5-hour session"
		out.ID = "five_hour"
	} else if fallbackID == "secondary" || fallbackID == "weekly" {
		out.Label = "Monthly"
		out.ID = "monthly"
	}
	hasUsage := w.UsedPercent != nil
	if hasUsage {
		out.UsedPercent = utilizationAsPercent(*w.UsedPercent)
	}
	if w.ResetAt != nil && *w.ResetAt > 0 {
		out.ResetsAt = time.Unix(*w.ResetAt, 0).UTC().Format(time.RFC3339)
	} else if w.ResetAfterSeconds != nil && *w.ResetAfterSeconds > 0 {
		out.ResetsAt = time.Now().UTC().Add(time.Duration(*w.ResetAfterSeconds) * time.Second).Format(time.RFC3339)
	}
	if !hasUsage && out.ResetsAt == "" {
		return nil
	}
	return &out
}

func appendCodexWindow(q *SubscriptionQuota, w *QuotaWindow) {
	if q == nil || w == nil {
		return
	}
	labelCodexWindow(w)
	q.Windows = append(q.Windows, *w)
}

func labelCodexWindow(w *QuotaWindow) {
	id := strings.ToLower(strings.TrimSpace(w.ID))
	label := strings.ToLower(strings.TrimSpace(w.Label))
	if id == "seven_day" || id == "weekly" || strings.Contains(label, "week") {
		w.Label = "Monthly"
		w.ID = "monthly"
	}
}

func windowLabelFromSeconds(sec float64) string {
	switch {
	case sec >= 2_000_000: // ~23d
		return "Monthly"
	case sec >= 500000: // ~6d
		return "Weekly"
	case sec >= 14000 && sec <= 22000:
		return "5-hour session"
	case sec >= 3000 && sec <= 4200:
		return "Hourly"
	default:
		hours := int(sec / 3600)
		if hours >= 1 {
			return fmt.Sprintf("%d-hour window", hours)
		}
		return "Usage window"
	}
}

func utilizationAsPercent(v float64) float64 {
	if v >= 0 && v <= 1 {
		return v * 100
	}
	return v
}

func slugID(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "_")
	return s
}

func quotaHTTPClient() *http.Client {
	return &http.Client{Timeout: 8 * time.Second}
}

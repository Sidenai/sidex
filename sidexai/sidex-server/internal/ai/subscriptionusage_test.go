package ai

import (
	"testing"
)

func TestParseClaudeOAuthUsage(t *testing.T) {
	raw := []byte(`{
		"five_hour": { "utilization": 35.0, "resets_at": "2026-08-26T20:00:00Z" },
		"seven_day": { "utilization": 12.0, "resets_at": "2026-08-31T00:00:00Z" },
		"seven_day_opus": null,
		"seven_day_sonnet": { "utilization": 0.4, "resets_at": "2026-08-31T00:00:00Z" },
		"extra_usage": {
			"is_enabled": true,
			"monthly_limit": 100,
			"used_credits": 12.5,
			"utilization": 12.5,
			"currency": "USD"
		}
	}`)
	q, err := parseClaudeOAuthUsage(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 3 {
		t.Fatalf("windows = %d %#v", len(q.Windows), q.Windows)
	}
	if q.Windows[0].Label != "5-hour session" || q.Windows[0].UsedPercent != 35 {
		t.Fatalf("5h = %#v", q.Windows[0])
	}
	if q.Windows[2].UsedPercent != 40 {
		t.Fatalf("sonnet fraction 0.4 should be 40%%, got %v", q.Windows[2].UsedPercent)
	}
	if q.Extra == nil || !q.Extra.Enabled || q.Extra.Used != 12.5 || q.Extra.Limit != 100 {
		t.Fatalf("extra = %#v", q.Extra)
	}
}

func TestParseCodexUsageWindowsAndCredits(t *testing.T) {
	raw := []byte(`{
		"plan_type": "plus",
		"rate_limit": {
			"primary_window": { "used_percent": 22, "limit_window_seconds": 18000, "reset_at": 1786536977 },
			"secondary_window": { "used_percent": 81, "limit_window_seconds": 604800, "reset_at": 1786536977 }
		},
		"credits": { "has_credits": true, "unlimited": false, "balance": "2363.8061450000" },
		"additional_rate_limits": []
	}`)
	q, err := parseCodexUsage(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("windows = %#v", q.Windows)
	}
	if q.Windows[0].Label != "5-hour session" || q.Windows[0].UsedPercent != 22 {
		t.Fatalf("primary = %#v", q.Windows[0])
	}
	if q.Windows[1].Label != "Monthly" || q.Windows[1].UsedPercent != 81 {
		t.Fatalf("monthly = %#v", q.Windows[1])
	}
	if q.Extra == nil || q.Extra.CreditsRemaining < 2363 || q.Extra.CreditsRemaining > 2364 {
		t.Fatalf("credits = %#v", q.Extra)
	}
	if q.Extra.UsdRemaining != 2363*CodexCreditUSD {
		t.Fatalf("usd remaining = %v want %v", q.Extra.UsdRemaining, 2363*CodexCreditUSD)
	}
}

func TestUtilizationAsPercent(t *testing.T) {
	if utilizationAsPercent(0.42) != 42 {
		t.Fatal("fraction")
	}
	if utilizationAsPercent(35) != 35 {
		t.Fatal("already percent")
	}
}

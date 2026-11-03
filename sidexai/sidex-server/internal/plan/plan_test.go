package plan

import "testing"

// SideX's desktop build runs this server locally with the user's own provider
// credentials. Nobody is billing them through us, so tier limits must not
// apply — otherwise the agent refuses work over credits no one is counting.

func TestMeteredFollowsAuthMode(t *testing.T) {
	t.Setenv("SIDEX_NO_AUTH", "1")
	if Metered() {
		t.Error("limits must not be metered when the server runs without auth")
	}

	t.Setenv("SIDEX_NO_AUTH", "")
	if !Metered() {
		t.Error("a server with auth enabled is a billed deployment and stays metered")
	}
}

// The default tier grants zero credits, so an unguarded check rejects the very
// first request. This is the exact shape of the bug that surfaced as
// "Plan limit reached: monthly credit limit reached" for a user on their own
// Claude account.
func TestDefaultTierWouldRejectImmediatelyIfMetered(t *testing.T) {
	tier := ParseTier("local")
	if GetLimits(tier).MonthlyCreditsUSD != 0 {
		t.Skip("default tier now grants credits; this regression no longer applies")
	}

	allowed, reason := CanMakeRequest(tier, 0, 0)
	if allowed {
		return // nothing to guard against
	}
	if reason == "" {
		t.Fatal("expected a human-readable reason")
	}
	// The guard is what keeps this from ever reaching an unmetered user.
	t.Setenv("SIDEX_NO_AUTH", "1")
	if Metered() {
		t.Fatalf("unmetered server would surface %q to the user", reason)
	}
}

func TestUnknownTierFallsBackToDefault(t *testing.T) {
	if ParseTier("not-a-tier") != TierHobby {
		t.Error("an unrecognised plan string must fall back to the base tier")
	}
}

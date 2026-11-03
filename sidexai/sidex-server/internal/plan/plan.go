package plan

import "os"

type Tier string

const (
	TierHobby      Tier = "hobby"
	TierPro        Tier = "pro"
	TierProPlus    Tier = "pro_plus"
	TierUltra      Tier = "ultra"
	TierTeams      Tier = "teams"
	TierEnterprise Tier = "enterprise"
)

type PlanLimits struct {
	MonthlyCreditsUSD  float64
	AgentRequestsLimit int // -1 = unlimited
	TabCompletions     int // -1 = unlimited
	MaxTurnsPerSession int
	AllowedModels      []string // empty = all models
	MaxMode            bool
	CloudAgents        bool
	Priority           int // higher = better queue priority
}

var tierLimits = map[Tier]PlanLimits{
	TierHobby: {
		MonthlyCreditsUSD:  0,
		AgentRequestsLimit: 50,
		TabCompletions:     2000,
		MaxTurnsPerSession: 200,
		AllowedModels:      nil,
		MaxMode:            true,
		CloudAgents:        true,
		Priority:           1,
	},
	TierPro: {
		MonthlyCreditsUSD:  20,
		AgentRequestsLimit: -1,
		TabCompletions:     -1,
		MaxTurnsPerSession: 200,
		AllowedModels:      nil,
		MaxMode:            true,
		CloudAgents:        true,
		Priority:           5,
	},
	TierProPlus: {
		MonthlyCreditsUSD:  60,
		AgentRequestsLimit: -1,
		TabCompletions:     -1,
		MaxTurnsPerSession: 200,
		AllowedModels:      nil,
		MaxMode:            true,
		CloudAgents:        true,
		Priority:           8,
	},
	TierUltra: {
		MonthlyCreditsUSD:  200,
		AgentRequestsLimit: -1,
		TabCompletions:     -1,
		MaxTurnsPerSession: 200,
		AllowedModels:      nil,
		MaxMode:            true,
		CloudAgents:        true,
		Priority:           10,
	},
	TierTeams: {
		MonthlyCreditsUSD:  20,
		AgentRequestsLimit: -1,
		TabCompletions:     -1,
		MaxTurnsPerSession: 40,
		AllowedModels:      nil,
		MaxMode:            true,
		CloudAgents:        true,
		Priority:           5,
	},
	TierEnterprise: {
		MonthlyCreditsUSD:  -1, // unlimited
		AgentRequestsLimit: -1,
		TabCompletions:     -1,
		MaxTurnsPerSession: 200,
		AllowedModels:      nil,
		MaxMode:            true,
		CloudAgents:        true,
		Priority:           10,
	},
}

// GetLimits returns the limits for a given tier. Falls back to hobby if unknown.
func GetLimits(tier Tier) PlanLimits {
	if limits, ok := tierLimits[tier]; ok {
		return limits
	}
	return tierLimits[TierHobby]
}

// CanMakeRequest checks if a user can make a request given their current usage.
// Returns (allowed, reason) where reason explains why the request was denied.
func CanMakeRequest(tier Tier, creditsUsed float64, requestsThisPeriod int) (bool, string) {
	limits := GetLimits(tier)

	if limits.AgentRequestsLimit >= 0 && requestsThisPeriod >= limits.AgentRequestsLimit {
		return false, "monthly agent request limit reached"
	}

	if limits.MonthlyCreditsUSD >= 0 && creditsUsed >= limits.MonthlyCreditsUSD {
		return false, "monthly credit limit reached"
	}

	return true, ""
}

// IsModelAllowed checks whether the given model is permitted for the tier.
func IsModelAllowed(tier Tier, model string) bool {
	limits := GetLimits(tier)
	if len(limits.AllowedModels) == 0 {
		return true
	}
	for _, m := range limits.AllowedModels {
		if m == model {
			return true
		}
	}
	return false
}

// ParseTier converts a string to a Tier, defaulting to hobby if unrecognized.
func ParseTier(s string) Tier {
	t := Tier(s)
	if _, ok := tierLimits[t]; ok {
		return t
	}
	return TierHobby
}

// Metered reports whether plan limits should be enforced.
//
// SideX's desktop build runs this server locally with SIDEX_NO_AUTH=1 and the
// user's own provider credentials. There is no subscription in that mode and
// nobody is billing them through us, so credit ceilings and per-tier model
// allowlists must not apply — the provider's own account limits do.
func Metered() bool {
	return os.Getenv("SIDEX_NO_AUTH") != "1"
}

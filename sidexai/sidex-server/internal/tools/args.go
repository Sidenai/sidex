package tools

import "time"

// Argument extraction helpers used across all tool implementations.

func str(m map[string]interface{}, key string) string {
	v, _ := m[key].(string)
	return v
}

func strOr(m map[string]interface{}, key, fallback string) string {
	v, ok := m[key].(string)
	if !ok || v == "" {
		return fallback
	}
	return v
}

func intOr(m map[string]interface{}, key string, fallback int) int {
	v, ok := m[key].(float64)
	if !ok {
		return fallback
	}
	return int(v)
}

func boolOr(m map[string]interface{}, key string, fallback bool) bool {
	v, ok := m[key].(bool)
	if !ok {
		return fallback
	}
	return v
}

// now wraps time.Now for testability.
func now() time.Time {
	return time.Now()
}

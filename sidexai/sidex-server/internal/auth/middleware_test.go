package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The server has no authentication provider: the desktop app starts it on
// loopback for the single user at the machine. These tests pin the contract
// handlers rely on — that a user is always present in the request context.

func TestDevUserMiddlewareInjectsLocalUser(t *testing.T) {
	var got *UserContext
	var gotID string

	handler := DevUserMiddleware()(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = GetUser(r.Context())
		gotID = UserIDFromContext(r.Context())
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/health", nil))

	if got == nil {
		t.Fatal("handlers require a user in context; middleware injected none")
	}
	if got.UserID != "local" {
		t.Errorf("UserID = %q, want %q", got.UserID, "local")
	}
	if got.Plan != "local" {
		t.Errorf("Plan = %q, want %q", got.Plan, "local")
	}
	if gotID != got.UserID {
		t.Errorf("UserIDFromContext = %q, want %q", gotID, got.UserID)
	}
}

func TestDevUserMiddlewareUsesConfiguredEmail(t *testing.T) {
	t.Setenv("SIDEX_DEV_USER", "me@example.com")

	var got *UserContext
	handler := DevUserMiddleware()(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = GetUser(r.Context())
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/health", nil))

	if got == nil || got.Email != "me@example.com" {
		t.Fatalf("email not carried through: %+v", got)
	}
}

// Some code paths run outside a request, so the accessors must cope with a
// bare context rather than panic.
func TestAccessorsDegradeOnBareContext(t *testing.T) {
	if u := GetUser(context.Background()); u != nil {
		t.Errorf("GetUser on a bare context = %+v, want nil", u)
	}
	if id := UserIDFromContext(context.Background()); id != "" {
		t.Errorf("UserIDFromContext on a bare context = %q, want empty", id)
	}
}

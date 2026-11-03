// Package auth carries the request-scoped user identity that internal/api
// handlers read via GetUser and UserIDFromContext.
//
// This server used to run as multi-tenant SaaS behind WorkOS, verifying
// SideX- and WorkOS-issued JWTs on every request. It now ships only as the
// local agent process the desktop app launches on loopback for a single
// user, with SIDEX_NO_AUTH=1 — there is no remote auth provider left to
// verify a token against. What remains is the UserContext plumbing,
// populated unconditionally by DevUserMiddleware.
package auth

import (
	"context"
	"net/http"
	"os"
)

// UserContext is the user attached to a request's context. In this
// single-user deployment it always describes the local user, but the shape
// is kept because handlers across internal/api read it through GetUser.
type UserContext struct {
	UserID    string
	Email     string
	Plan      string
	ExpiresAt int64
}

type contextKey string

const UserContextKey contextKey = "user"

// DevUserMiddleware injects the local user into every request's context.
// It is the server's only auth path: main.go only ever reaches here after
// confirming the process is bound to loopback (or SIDEX_ALLOW_DEV_AUTH=1
// was set deliberately), which matters because this server executes shell
// commands on the caller's behalf.
func DevUserMiddleware() func(http.Handler) http.Handler {
	localEmail := os.Getenv("SIDEX_DEV_USER")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), UserContextKey, &UserContext{
				UserID: "local",
				Email:  localEmail,
				Plan:   "local",
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetUser retrieves the authenticated user from the request context.
func GetUser(ctx context.Context) *UserContext {
	user, _ := ctx.Value(UserContextKey).(*UserContext)
	return user
}

// UserIDFromContext returns the request's user id, or "" when unauthenticated.
func UserIDFromContext(ctx context.Context) string {
	if u := GetUser(ctx); u != nil {
		return u.UserID
	}
	return ""
}

// The three functions below back the old hosted-SaaS login/token-exchange
// endpoints in internal/api/postgres_handlers.go (GetAuthSession,
// ExchangeToken), which are still wired up in cmd/server/main.go. They are
// stubbed to fail rather than deleted, since removing an exported name
// another package depends on is outside this file's scope. In practice they
// are already unreachable in the desktop build: both callers early-return
// once usage.GetPostgres() is nil, which it always is without
// SIDEX_DATABASE_URL. Removing those routes and this stub trio is a
// follow-up that touches internal/api and main.go's route table.

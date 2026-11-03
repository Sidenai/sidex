package main

import (
	"database/sql"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/mux"
	_ "github.com/lib/pq"
	"github.com/sidex-ai/sidex-server/internal/api"
	"github.com/sidex-ai/sidex-server/internal/auth"
	"github.com/sidex-ai/sidex-server/internal/cost"
	"github.com/sidex-ai/sidex-server/internal/index"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/paths"
	"github.com/sidex-ai/sidex-server/internal/session"
	"github.com/sidex-ai/sidex-server/internal/usage"
)

func main() {
	port := os.Getenv("SIDEX_PORT")
	if port == "" {
		port = "7433"
	}

	// Initialize ~/.sidex/ directory structure
	if err := paths.EnsureGlobalDirs(); err != nil {
		log.Fatalf("failed to create sidex home dirs: %v", err)
	}

	// Begin background model pricing/metadata refresh from OpenRouter
	cost.Start()

	// Open state database at ~/.sidex/state.db (not in the user's repo)
	storeDBPath := paths.StateDB()
	// The state database allows a single writer. A previous instance that is
	// still shutting down — or one orphaned by a crash — will hold the lock
	// briefly, so retry before giving up rather than failing the launch.
	store, err := openStateStore(storeDBPath)
	if err != nil {
		log.Fatalf("failed to open memory store at %s: %v", storeDBPath, err)
	}
	defer store.Close()
	log.Printf("State store: %s", storeDBPath)

	dataDir := paths.ExpandUser(os.Getenv("SIDEX_DATA_DIR"))
	if dataDir == "" {
		dataDir = filepath.Join(paths.SidexHome(), "data")
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("failed to create data dir: %v", err)
	}

	var usageSvc *usage.Service
	usageDBPath := filepath.Join(dataDir, "usage.db")
	usageSvc, err = usage.NewService(usageDBPath)
	if err != nil {
		log.Printf("warning: failed to initialize usage service: %v (continuing without usage tracking)", err)
	} else {
		defer usageSvc.Close()
		if migrateErr := api.MigrateAPIKeys(usageSvc.DB()); migrateErr != nil {
			log.Printf("warning: failed to migrate api_keys table: %v", migrateErr)
		}
	}

	// Initialize Postgres connection for usage events and user data
	if dbURL := os.Getenv("SIDEX_DATABASE_URL"); dbURL != "" {
		pgDB, pgErr := sql.Open("postgres", dbURL)
		if pgErr != nil {
			log.Printf("warning: failed to connect to Postgres: %v (usage events will not be recorded)", pgErr)
		} else {
			if pingErr := pgDB.Ping(); pingErr != nil {
				log.Printf("warning: Postgres ping failed: %v (usage events will not be recorded)", pingErr)
				pgDB.Close()
			} else {
				pgDB.SetMaxOpenConns(10)
				pgDB.SetMaxIdleConns(5)
				usage.InitPostgres(pgDB)
				defer pgDB.Close()
				log.Printf("Postgres connected for usage/billing data")
			}
		}
	} else {
		log.Printf("SIDEX_DATABASE_URL not set — usage events will not be recorded to Postgres")
	}

	sm := session.NewManager(store)

	// Index service for codebase search
	indexSvc := index.NewIndexService(os.Getenv("TURBOPUFFER_API_KEY"))

	handler := api.NewHandler(sm, store, usageSvc, indexSvc)
	defer handler.Close()
	indexHandler := api.NewIndexHandler(indexSvc)

	r := mux.NewRouter()

	// Public endpoints (no auth required)
	r.HandleFunc("/v1/health", handler.Health).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/models", handler.ListModels).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/usage/summary", handler.LocalUsageSummary).Methods("GET", "OPTIONS")

	// Desktop auto-update: manifest + artifact downloads (public, unauthenticated)
	updateHandler := api.NewUpdateHandler()
	r.HandleFunc("/v1/update/latest.json", updateHandler.Latest).Methods("GET", "OPTIONS")
	r.PathPrefix("/v1/update/dl/").HandlerFunc(updateHandler.Download).Methods("GET", "OPTIONS")

	// Protected endpoints
	protected := r.PathPrefix("/v1").Subrouter()

	// Bind to loopback unless told otherwise. This server executes shell
	// commands and edits files on behalf of the agent, so it must not be
	// reachable from the network by accident.
	bindAddr := os.Getenv("SIDEX_BIND_ADDR")
	if bindAddr == "" {
		bindAddr = "127.0.0.1"
	}

	// There is no authentication provider: this server is started by the
	// desktop app on loopback and serves the single user at the machine.
	// Off loopback it would be an unauthenticated remote code-execution hole,
	// so that path needs a deliberate opt-in.
	if !isLoopbackAddr(bindAddr) && os.Getenv("SIDEX_ALLOW_UNAUTHENTICATED") != "1" {
		log.Fatalf(
			"refusing to serve %q: this server executes shell commands and has no "+
				"authentication. Bind to 127.0.0.1, or set SIDEX_ALLOW_UNAUTHENTICATED=1 "+
				"if you have put your own authentication in front of it.",
			bindAddr,
		)
	}
	protected.Use(auth.DevUserMiddleware())
	log.Printf("Serving the local user on %s", bindAddr)

	protected.HandleFunc("/chat", handler.Chat).Methods("POST", "OPTIONS")
	protected.HandleFunc("/stream", handler.Stream).Methods("GET", "OPTIONS")
	protected.HandleFunc("/sessions", handler.ListSessions).Methods("GET", "OPTIONS")
	protected.HandleFunc("/sessions/{id}", handler.GetSession).Methods("GET", "OPTIONS")
	protected.HandleFunc("/sessions/{id}", handler.DeleteSession).Methods("DELETE", "OPTIONS")
	protected.HandleFunc("/sessions/{id}/resume", handler.ResumeSession).Methods("GET", "OPTIONS")
	protected.HandleFunc("/sessions/{id}/title", handler.SetSessionTitle).Methods("POST", "OPTIONS")
	protected.HandleFunc("/transcripts", handler.ListTranscripts).Methods("GET", "OPTIONS")
	protected.HandleFunc("/memory", handler.SearchMemory).Methods("GET", "OPTIONS")
	protected.HandleFunc("/memory", handler.SaveMemory).Methods("POST", "OPTIONS")
	protected.HandleFunc("/tools", handler.ListTools).Methods("GET", "OPTIONS")
	protected.HandleFunc("/completions", handler.Completions).Methods("POST", "OPTIONS")
	protected.HandleFunc("/complete", handler.Complete).Methods("POST", "OPTIONS")
	protected.HandleFunc("/inline-edit", handler.InlineEdit).Methods("POST", "OPTIONS")
	protected.HandleFunc("/usage", handler.GetUsage).Methods("GET", "OPTIONS")
	protected.HandleFunc("/plan", handler.GetPlan).Methods("GET", "OPTIONS")
	protected.HandleFunc("/api-keys", handler.ListAPIKeys).Methods("GET", "OPTIONS")
	protected.HandleFunc("/api-keys", handler.SaveAPIKey).Methods("POST", "OPTIONS")
	protected.HandleFunc("/api-keys/{provider}", handler.DeleteAPIKey).Methods("DELETE", "OPTIONS")

	// Flow awareness endpoints
	protected.HandleFunc("/flow/event", handler.RecordFlowEvent).Methods("POST", "OPTIONS")
	protected.HandleFunc("/flow/context", handler.GetFlowContext).Methods("GET", "OPTIONS")
	protected.HandleFunc("/flow/files", handler.GetRecentFiles).Methods("GET", "OPTIONS")

	// Codebase indexing & search
	indexHandler.RegisterRoutes(protected)

	listenAddr := bindAddr + ":" + port

	log.Printf("Sidex home: %s", paths.SidexHome())
	log.Printf("Sidex server listening on %s", listenAddr)
	if err := http.ListenAndServe(listenAddr, cors(r)); err != nil {
		log.Fatal(err)
	}
}

func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if api.AllowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// isLoopbackAddr reports whether the server will only be reachable from this
// machine, which is what makes running without authentication acceptable.
func isLoopbackAddr(addr string) bool {
	switch addr {
	case "127.0.0.1", "localhost", "::1", "[::1]":
		return true
	}
	if ip := net.ParseIP(strings.Trim(addr, "[]")); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// openStateStore opens the state database, retrying while it is locked by
// another instance that is on its way out.
func openStateStore(path string) (*memory.Store, error) {
	const (
		attempts = 10
		delay    = 500 * time.Millisecond
	)
	var err error
	for i := 0; i < attempts; i++ {
		var store *memory.Store
		store, err = memory.NewBoltStore(path)
		if err == nil {
			return store, nil
		}
		if !strings.Contains(err.Error(), "timeout") {
			return nil, err
		}
		if i == 0 {
			log.Printf("state store is locked by another instance; waiting for it to exit")
		}
		time.Sleep(delay)
	}
	return nil, fmt.Errorf("state store still locked after %s: %w", time.Duration(attempts)*delay, err)
}

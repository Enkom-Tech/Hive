package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Enkom-Tech/hive-worker/internal/adapter"
	"github.com/Enkom-Tech/hive-worker/internal/handler"
	"github.com/Enkom-Tech/hive-worker/internal/link"
	"github.com/Enkom-Tech/hive-worker/internal/linkconfig"
	"github.com/Enkom-Tech/hive-worker/internal/provision"
	"github.com/Enkom-Tech/hive-worker/internal/runstore"
)

// Config holds optional overrides for Run (e.g. in tests).
type Config struct {
	Addr                string       // listen address, default ":8080"
	Listener            net.Listener // if set, used instead of Addr (for tests with :0)
	HealthWorkspacePath string       // path for health check; empty means "/workspace"
}

// Run starts the HTTP server (health, metrics) and the WebSocket link client. Blocks until ctx is cancelled.
// If linkCred is nil, WebSocket URL, token, and agent id are read from the environment (same as before).
func Run(ctx context.Context, cfg *Config, linkCred *link.Credentials) error {
	if cfg == nil {
		cfg = &Config{}
	}
	store := runstore.New()
	registry := adapter.NewRegistryFromEnvWithProvisioner(provision.NewFromEnv())

	healthHandler := handler.NewHealthHandler()
	if cfg.HealthWorkspacePath != "" {
		healthHandler.WorkspacePath = cfg.HealthWorkspacePath
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", healthHandler.ServeHTTP)
	mux.HandleFunc("GET /metrics", handler.Metrics)

	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	done := make(chan struct{})
	go func() {
		defer close(done)
		var err error
		if cfg.Listener != nil {
			err = server.Serve(cfg.Listener)
		} else {
			addr := cfg.Addr
			if addr == "" {
				addr = ":8080"
			}
			server.Addr = addr
			err = server.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			log.Printf("server: %v", err)
		}
	}()

	stateDir := os.Getenv("HIVE_WORKER_STATE_DIR")
	startLink := func(creds link.Credentials) {
		if creds.WSURL == "" || creds.Token == "" {
			return
		}
		c := creds
		go func() {
			client := &link.Client{
				Registry:        registry,
				Store:           store,
				AgentID:         c.AgentID,
				Token:           c.Token,
				WSURL:           c.WSURL,
				StateDir:        stateDir,
				AllowedAgentIDs: link.AgentAllowlistFromEnv(),
			}
			if err := client.Run(ctx); err != nil && ctx.Err() == nil {
				log.Printf("link(%s): %v", c.AgentID, err)
			}
		}()
	}

	if linkCred != nil {
		startLink(*linkCred)
	} else {
		for _, creds := range linkconfig.ResolveLinks() {
			startLink(creds)
		}
	}

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	<-done
	return nil
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-quit
		cancel()
	}()

	// Optional "link" subcommand: same as default (outbound WebSocket + local HTTP). Common UX: hive-worker link
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "link" {
		args = args[1:]
	}

	hookClient := &http.Client{Timeout: 5 * time.Minute}
	if err := provision.ApplyManifestHooksFromEnv(context.Background(), hookClient); err != nil {
		log.Fatalf("hive-worker: provision manifest hooks: %v", err)
	}

	var linkOverride *link.Credentials
	if len(args) >= 1 && args[0] == "pair" {
		c, err := parsePairSubcommand(ctx, args[1:])
		if err != nil {
			log.Fatal(err)
		}
		linkOverride = c
	} else if shouldAutoPairFromEnv() {
		c, err := autoPairFromEnv(ctx)
		if err != nil {
			log.Fatal(err)
		}
		linkOverride = c
	}

	preferred := preferredHTTPListenAddr()
	portAuto := httpListenPortAuto()
	ln, err := openListenTCP(preferred, portAuto)
	if err != nil {
		log.Fatalf("hive-worker: listen %s: %v", preferred, err)
	}

	if err := Run(ctx, &Config{Listener: ln}, linkOverride); err != nil {
		log.Fatal(err)
	}
}

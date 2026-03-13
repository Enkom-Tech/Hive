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

	"github.com/enkom/hive-worker/internal/executor"
	"github.com/enkom/hive-worker/internal/handler"
)

// Config holds optional overrides for Run (e.g. in tests).
type Config struct {
	Addr                string   // listen address, default ":8080"
	Listener            net.Listener // if set, used instead of Addr (for tests with :0)
	HealthWorkspacePath string   // path for health check; empty means "/workspace"
}

// Run starts the HTTP server and blocks until ctx is cancelled, then shuts down gracefully.
// If cfg is nil, defaults are used. Run is testable without signal handling.
func Run(ctx context.Context, cfg *Config) error {
	if cfg == nil {
		cfg = &Config{}
	}
	runHandler := handler.NewRunHandler()
	runHandler.Executor = &executor.Executor{}
	healthHandler := handler.NewHealthHandler()
	if cfg.HealthWorkspacePath != "" {
		healthHandler.WorkspacePath = cfg.HealthWorkspacePath
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /run", runHandler.ServeHTTP)
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
	if err := Run(ctx, nil); err != nil {
		log.Fatal(err)
	}
}

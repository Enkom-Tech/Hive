package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

// TestRunServerStartupAndShutdown starts the server with a random port and a temp health path,
// asserts GET /health returns 200, then cancels context and verifies graceful shutdown.
func TestRunServerStartupAndShutdown(t *testing.T) {
	dir := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	runDone := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = Run(ctx, &Config{
			Listener:            listener,
			HealthWorkspacePath: dir,
		})
		close(runDone)
	}()
	defer listener.Close()

	baseURL := "http://" + listener.Addr().String()
	client := &http.Client{Timeout: 5 * time.Second}

	// Wait for server to be up
	var resp *http.Response
	for i := 0; i < 50; i++ {
		resp, err = client.Get(baseURL + "/health")
		if err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /health status: %d, want 200", resp.StatusCode)
	}

	cancel()
	<-runDone // wait for graceful shutdown
	_, err = client.Get(baseURL + "/health")
	if err == nil {
		t.Error("expected connection to fail after server shutdown")
	}
}

// TestRunServerMetricsEndpoint verifies /metrics is served (Prometheus format).
func TestRunServerMetricsEndpoint(t *testing.T) {
	dir := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	runDone := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = Run(ctx, &Config{
			Listener:            listener,
			HealthWorkspacePath: dir,
		})
		close(runDone)
	}()
	defer func() { cancel(); <-runDone; listener.Close() }()

	baseURL := "http://" + listener.Addr().String()
	client := &http.Client{Timeout: 2 * time.Second}
	var resp *http.Response
	for i := 0; i < 30; i++ {
		resp, err = client.Get(baseURL + "/metrics")
		if err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /metrics status: %d, want 200", resp.StatusCode)
	}
	if resp.Header.Get("Content-Type") != "text/plain; charset=utf-8" && resp.Header.Get("Content-Type") != "text/plain" {
		t.Logf("Content-Type: %s (Prometheus often uses text/plain)", resp.Header.Get("Content-Type"))
	}
}

// TestRunHealthUnavailableWhenWorkspaceMissing verifies health returns 503 when workspace path is missing.
func TestRunHealthUnavailableWhenWorkspaceMissing(t *testing.T) {
	badPath := os.TempDir() + "/nonexistent-hive-workspace-path"
	_ = os.RemoveAll(badPath)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	runDone := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = Run(ctx, &Config{
			Listener:            listener,
			HealthWorkspacePath: badPath,
		})
		close(runDone)
	}()
	defer func() { cancel(); <-runDone; listener.Close() }()

	baseURL := "http://" + listener.Addr().String()
	client := &http.Client{Timeout: 2 * time.Second}
	var resp *http.Response
	for i := 0; i < 30; i++ {
		resp, err = client.Get(baseURL + "/health")
		if err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("GET /health status: %d, want 503 (workspace missing)", resp.StatusCode)
	}
}

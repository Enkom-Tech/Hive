package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClient_ListAgents(t *testing.T) {
	agents := []Agent{
		{ID: "a1", CompanyID: "c1", Name: "worker-1", AdapterType: "http"},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/companies/c1/agents" {
			t.Errorf("path = %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer token1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(agents)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	list, err := client.ListAgents(ctx, "c1")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != "a1" {
		t.Errorf("list = %+v", list)
	}
}

func TestClient_CreateAgent(t *testing.T) {
	var received CreateAgentRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/companies/c1/agents" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Agent{ID: "new-id", Name: received.Name, AdapterType: received.AdapterType})
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	agent, err := client.CreateAgent(ctx, "c1", CreateAgentRequest{
		Name:         "hive-worker-1",
		AdapterType:  "http",
		AdapterConfig: map[string]interface{}{"url": "http://svc/run"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if agent.ID != "new-id" || agent.Name != "hive-worker-1" {
		t.Errorf("agent = %+v", agent)
	}
	if received.Name != "hive-worker-1" || received.AdapterType != "http" {
		t.Errorf("received = %+v", received)
	}
}

func TestClient_CreateAgentKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/agent-1/keys" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(APIKey{ID: "key-1", Key: "secret-key"})
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	key, err := client.CreateAgentKey(ctx, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if key.ID != "key-1" || key.Key != "secret-key" {
		t.Errorf("key = %+v", key)
	}
}

func TestClient_PatchAgent(t *testing.T) {
	var patch map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/agent-1" || r.Method != http.MethodPatch {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&patch)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	err := client.PatchAgent(ctx, "agent-1", map[string]interface{}{
		"adapterConfig": map[string]interface{}{"url": "http://worker/run"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if patch["adapterConfig"] == nil {
		t.Errorf("patch = %+v", patch)
	}
}

func TestClient_PauseResume(t *testing.T) {
	var pause, resume bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/a1/pause":
			pause = true
		case "/api/agents/a1/resume":
			resume = true
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	if err := client.PauseAgent(ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	if !pause {
		t.Error("pause not called")
	}
	if err := client.ResumeAgent(ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	if !resume {
		t.Error("resume not called")
	}
}

func TestClient_Health(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	code, err := client.Health(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if code != http.StatusOK {
		t.Errorf("code = %d", code)
	}
}

func TestClient_ListAgents_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "bad-token")
	ctx := context.Background()
	_, err := client.ListAgents(ctx, "c1")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestClient_ListAgents_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	_, err := client.ListAgents(ctx, "c1")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error should mention 404: %v", err)
	}
}

func TestClient_CreateAgent_Conflict(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	_, err := client.CreateAgent(ctx, "c1", CreateAgentRequest{Name: "w1", AdapterType: "http"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "409") {
		t.Errorf("error should mention 409: %v", err)
	}
}

func TestClient_CreateAgent_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	client.MaxRetries = 1
	ctx := context.Background()
	_, err := client.CreateAgent(ctx, "c1", CreateAgentRequest{Name: "w1", AdapterType: "http"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error should mention 500: %v", err)
	}
}

func TestClient_RetryOn500ThenSuccess(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts < 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]Agent{{ID: "a1", Name: "w1"}})
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	client.MaxRetries = 3
	ctx := context.Background()
	list, err := client.ListAgents(ctx, "c1")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != "a1" {
		t.Errorf("list = %+v", list)
	}
	if attempts != 2 {
		t.Errorf("expected 2 attempts, got %d", attempts)
	}
}

func TestClient_AuthHeaderSet(t *testing.T) {
	var authSeen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authSeen = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/companies/c1/agents":
			if r.Method == http.MethodGet {
				_ = json.NewEncoder(w).Encode([]Agent{})
			} else {
				_ = json.NewEncoder(w).Encode(Agent{ID: "a1"})
			}
		case "/api/agents/a1/keys":
			_ = json.NewEncoder(w).Encode(APIKey{ID: "k1", Key: "x"})
		case "/api/agents/a1":
			w.WriteHeader(http.StatusOK)
		case "/api/agents/a1/pause", "/api/agents/a1/resume":
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "bearer-token")
	ctx := context.Background()

	_, _ = client.ListAgents(ctx, "c1")
	if authSeen != "Bearer bearer-token" {
		t.Errorf("ListAgents auth = %q", authSeen)
	}
	_, _ = client.CreateAgent(ctx, "c1", CreateAgentRequest{Name: "w", AdapterType: "http"})
	if authSeen != "Bearer bearer-token" {
		t.Errorf("CreateAgent auth = %q", authSeen)
	}
	_, _ = client.CreateAgentKey(ctx, "a1")
	if authSeen != "Bearer bearer-token" {
		t.Errorf("CreateAgentKey auth = %q", authSeen)
	}
	_ = client.PatchAgent(ctx, "a1", map[string]interface{}{})
	if authSeen != "Bearer bearer-token" {
		t.Errorf("PatchAgent auth = %q", authSeen)
	}
	_ = client.PauseAgent(ctx, "a1")
	if authSeen != "Bearer bearer-token" {
		t.Errorf("PauseAgent auth = %q", authSeen)
	}
	_ = client.ResumeAgent(ctx, "a1")
	if authSeen != "Bearer bearer-token" {
		t.Errorf("ResumeAgent auth = %q", authSeen)
	}
}

func TestClient_Health_StatusCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	ctx := context.Background()
	code, err := client.Health(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if code != http.StatusServiceUnavailable {
		t.Errorf("code = %d", code)
	}
}

func TestClient_Health_AuthHeader(t *testing.T) {
	var authSeen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authSeen = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "health-token")
	ctx := context.Background()
	_, _ = client.Health(ctx)
	if authSeen != "Bearer health-token" {
		t.Errorf("Health auth = %q", authSeen)
	}
}

func TestClient_ContextTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	client.HTTPClient.Timeout = 10 * time.Millisecond
	ctx := context.Background()
	_, err := client.ListAgents(ctx, "c1")
	if err == nil {
		t.Fatal("expected timeout error")
	}
}

func TestClient_EmptyToken_NoAuthHeader(t *testing.T) {
	var authSeen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authSeen = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]Agent{})
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "")
	ctx := context.Background()
	_, err := client.ListAgents(ctx, "c1")
	if err != nil {
		t.Fatal(err)
	}
	if authSeen != "" {
		t.Errorf("expected no Authorization header when token empty, got %q", authSeen)
	}
}

func TestClient_RetryBackoff(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts <= 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(APIKey{ID: "k1", Key: "secret"})
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "token1")
	client.MaxRetries = 5
	ctx := context.Background()
	key, err := client.CreateAgentKey(ctx, "a1")
	if err != nil {
		t.Fatal(err)
	}
	if key.Key != "secret" {
		t.Errorf("key = %+v", key)
	}
	if attempts != 3 {
		t.Errorf("expected 3 attempts, got %d", attempts)
	}
}

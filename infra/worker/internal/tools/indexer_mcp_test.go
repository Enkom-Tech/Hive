package tools

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMessageEndpoint(t *testing.T) {
	if got := messageEndpoint("http://gw:9090/mcp"); got != "http://gw:9090/mcp/message" {
		t.Fatalf("got %q", got)
	}
	if got := messageEndpoint("http://gw:9090/mcp/"); got != "http://gw:9090/mcp/message" {
		t.Fatalf("got %q", got)
	}
}

func TestIndexerGatewayConfig_CallIndexerTool(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp/message" {
			http.NotFound(w, r)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			http.Error(w, "auth", http.StatusUnauthorized)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var req map[string]any
		_ = json.Unmarshal(b, &req)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      req["id"],
			"result": map[string]any{
				"content": []any{map[string]any{"type": "text", "text": `{"ok":true}`}},
			},
		})
	}))
	defer srv.Close()

	g := &IndexerGatewayConfig{
		BaseURL: srv.URL + "/mcp",
		Token:   "worker-secret",
		HTTP:    srv.Client(),
	}
	res, err := g.CallIndexerTool(context.Background(), "get_index_stats", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	text, err := ParseIndexerToolText(res)
	if err != nil {
		t.Fatal(err)
	}
	if text != `{"ok":true}` {
		t.Fatalf("text %q", text)
	}
}

func TestIndexerHTTPClientFromEnv_respectsShortTimeout(t *testing.T) {
	t.Setenv("HIVE_MCP_INDEXER_HTTP_TIMEOUT_MS", "50")
	client := IndexerHTTPClientFromEnv()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(req)
	if err == nil {
		t.Fatal("expected client timeout (server sleeps longer than HIVE_MCP_INDEXER_HTTP_TIMEOUT_MS)")
	}
}

func TestIndexerCircuitBreaker_opensAfterFailures(t *testing.T) {
	t.Setenv("HIVE_MCP_INDEXER_CB_FAILURES", "3")
	t.Setenv("HIVE_MCP_INDEXER_CB_OPEN_MS", "60000")
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	g := &IndexerGatewayConfig{
		BaseURL:     srv.URL + "/mcp",
		Token:       "t",
		HTTP:        srv.Client(),
		GatewayName: "code",
		Breaker:     NewIndexerCircuitBreaker("code"),
	}
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		_, err := g.CallIndexerTool(ctx, "get_index_stats", json.RawMessage(`{}`))
		if err == nil {
			t.Fatalf("call %d: want error", i)
		}
	}
	_, err := g.CallIndexerTool(ctx, "get_index_stats", json.RawMessage(`{}`))
	if err == nil || !strings.Contains(err.Error(), "circuit open") {
		t.Fatalf("want circuit open, got n=%d err=%v", n, err)
	}
}

func TestParseIndexerToolText_nonMCPShape(t *testing.T) {
	s, err := ParseIndexerToolText(map[string]any{"foo": 1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "foo") {
		t.Fatalf("got %q", s)
	}
}

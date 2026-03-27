package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCPClient_costReport_forwardsBearer(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		if r.URL.Path != "/api/worker-api/cost-report" {
			t.Fatalf("path %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := &CPClient{
		APIBase: strings.TrimSuffix(srv.URL, "/") + "/api",
		JWT:     "worker-jwt-test",
		AgentID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		RunID:   "run-1",
		HTTP:    srv.Client(),
	}
	args, _ := json.Marshal(map[string]any{
		"provider":  "x",
		"model":     "m",
		"costCents": 1,
	})
	_, err := c.costReport(context.Background(), args)
	if err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer worker-jwt-test" {
		t.Fatalf("Authorization: %q", auth)
	}
}

func TestCPClient_issueGet_query(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path + "?" + r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"result":{}}`))
	}))
	defer srv.Close()

	c := &CPClient{
		APIBase: strings.TrimSuffix(srv.URL, "/") + "/api",
		JWT:     "j",
		AgentID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		HTTP:    srv.Client(),
	}
	args, _ := json.Marshal(map[string]any{"issueId": "cccccccc-cccc-cccc-cccc-cccccccccccc"})
	_, err := c.issueGet(context.Background(), args)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(path, "agentId=") {
		t.Fatalf("expected agentId in query: %q", path)
	}
}

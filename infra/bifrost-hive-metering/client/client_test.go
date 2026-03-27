package hivemetering

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLookupCompany(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/hive/gateway-virtual-key-lookup" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("keyHash") != "deadbeef" {
			http.Error(w, "bad hash", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"companyId": "550e8400-e29b-41d4-a716-446655440000"})
	}))
	defer ts.Close()

	c := &Client{ControlPlaneBaseURL: ts.URL, OperatorBearer: "secret"}
	id, err := c.LookupCompany(context.Background(), "deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	if id != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("got %q", id)
	}
}

func TestPostGatewayAggregate(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/hive/inference-metering" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if body["source"] != "gateway_aggregate" {
			t.Fatalf("source: %v", body["source"])
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer ts.Close()

	c := &Client{ControlPlaneBaseURL: ts.URL, OperatorBearer: "x", Provider: "bifrost"}
	if err := c.PostGatewayAggregate(context.Background(), "550e8400-e29b-41d4-a716-446655440000", "m", 1, 2, 0); err != nil {
		t.Fatal(err)
	}
}

package pairing

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCreateRequestAndPollUntilReady(t *testing.T) {
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/worker-pairing/requests":
			b, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(b), `"agentId":"agent-1"`) {
				t.Errorf("body %s", string(b))
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"requestId":"req-abc","expiresAt":"2099-01-01T00:00:00.000Z"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/worker-pairing/requests/req-abc":
			n := polls.Add(1)
			if n < 2 {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"status":"pending"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ready","enrollmentToken":"secret-token-xyz","agentId":"agent-1"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	apiPrefix := strings.TrimSuffix(srv.URL, "/") + "/api"
	ctx := context.Background()
	rid, exp, err := CreateRequest(ctx, srv.Client(), apiPrefix, "agent-1", map[string]any{"os": "test"})
	if err != nil {
		t.Fatal(err)
	}
	if rid != "req-abc" || exp.IsZero() {
		t.Fatalf("rid=%q exp=%v", rid, exp)
	}

	ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tok, err := PollUntilReady(ctx2, srv.Client(), apiPrefix, rid, 20*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if tok != "secret-token-xyz" {
		t.Fatalf("token = %q", tok)
	}
}

func TestPollUntilReadyRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"rejected"}`))
	}))
	defer srv.Close()
	apiPrefix := strings.TrimSuffix(srv.URL, "/") + "/api"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := PollUntilReady(ctx, srv.Client(), apiPrefix, "rid", 10*time.Millisecond)
	if !errors.Is(err, ErrRejected) {
		t.Fatalf("err = %v want ErrRejected", err)
	}
}

package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"

	"github.com/enkom/hive-worker/internal/executor"
)

// RunHandler handles POST /run (task dispatch from control plane HTTP adapter).
type RunHandler struct {
	mu   sync.Mutex
	busy bool
	// Executor runs the task in the background. If nil, no execution is performed (accept-only).
	Executor *executor.Executor
	// testHook, if set, is called after setting busy and before processing (used by tests to force 429).
	testHook func()
}

// NewRunHandler creates a run handler. Agent key is read from HIVE_AGENT_KEY env.
func NewRunHandler() *RunHandler {
	return &RunHandler{}
}

// RunPayload is the body sent by the Squadron HTTP adapter.
type RunPayload struct {
	AgentID string          `json:"agentId"`
	RunID   string          `json:"runId"`
	Context json.RawMessage `json:"context"`
}

func (h *RunHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if key := r.Header.Get("Authorization"); key != "" && len(key) > 7 && key[:7] == "Bearer " {
		expected := os.Getenv("HIVE_AGENT_KEY")
		if expected != "" && key[7:] != expected {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	h.mu.Lock()
	if h.busy {
		h.mu.Unlock()
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}
	h.busy = true
	h.mu.Unlock()
	if h.testHook != nil {
		h.testHook()
	}
	defer func() {
		h.mu.Lock()
		h.busy = false
		h.mu.Unlock()
	}()

	var payload RunPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if payload.AgentID == "" || payload.RunID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Dispatch acknowledged; run executor in background if configured.
	w.WriteHeader(http.StatusOK)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"accepted"}`))

	if h.Executor != nil {
		payloadCopy := &executor.Payload{
			AgentID: payload.AgentID,
			RunID:   payload.RunID,
			Context: payload.Context,
		}
		go func() {
			ctx := context.Background()
			stdout, stderr, err := h.Executor.Run(ctx, payloadCopy, "")
			if err != nil {
				log.Printf("executor run failed: %v (stdout=%s stderr=%s)", err, stdout, stderr)
			}
		}()
	}
}

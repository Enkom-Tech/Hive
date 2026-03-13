package handler

import (
	"net/http"
	"os"
)

// HealthHandler handles GET /health for liveness/readiness.
type HealthHandler struct {
	// WorkspacePath is the path to check for mount (default /workspace). Set for tests.
	WorkspacePath string
}

func NewHealthHandler() *HealthHandler {
	return &HealthHandler{WorkspacePath: "/workspace"}
}

func (h *HealthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := h.WorkspacePath
	if path == "" {
		path = "/workspace"
	}
	if _, err := os.Stat(path); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("workspace not ready"))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

package handler

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHealthHandler_MethodNotAllowed(t *testing.T) {
	h := NewHealthHandler()
	h.WorkspacePath = os.TempDir()
	req := httptest.NewRequest(http.MethodPost, "/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("code = %d", rec.Code)
	}
}

func TestHealthHandler_OKWhenWorkspaceExists(t *testing.T) {
	dir := t.TempDir()
	h := NewHealthHandler()
	h.WorkspacePath = dir
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("code = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "ok" {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func TestHealthHandler_503WhenWorkspaceMissing(t *testing.T) {
	h := NewHealthHandler()
	h.WorkspacePath = filepath.Join(os.TempDir(), "nonexistent-workspace-path-xyz")
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("code = %d", rec.Code)
	}
	if rec.Body.String() != "workspace not ready" {
		t.Errorf("body = %s", rec.Body.String())
	}
}

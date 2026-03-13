package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestRunHandler_MethodNotAllowed(t *testing.T) {
	h := NewRunHandler()
	req := httptest.NewRequest(http.MethodGet, "/run", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("code = %d", rec.Code)
	}
}

func TestRunHandler_ValidPayload(t *testing.T) {
	h := NewRunHandler()
	body := []byte(`{"agentId":"a1","runId":"r1","context":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("code = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type = %s", rec.Header().Get("Content-Type"))
	}
	if rec.Body.String() != `{"status":"accepted"}` {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func TestRunHandler_MalformedJSON(t *testing.T) {
	h := NewRunHandler()
	req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("code = %d", rec.Code)
	}
}

func TestRunHandler_MissingAgentID(t *testing.T) {
	h := NewRunHandler()
	body := []byte(`{"runId":"r1","context":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("code = %d", rec.Code)
	}
}

func TestRunHandler_MissingRunID(t *testing.T) {
	h := NewRunHandler()
	body := []byte(`{"agentId":"a1","context":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("code = %d", rec.Code)
	}
}

func TestRunHandler_ConcurrentReturns429(t *testing.T) {
	h := NewRunHandler()
	block := make(chan struct{})
	started := make(chan struct{})
	h.testHook = func() {
		close(started)
		<-block
	}
	results := make(chan int, 1)
	go func() {
		body := []byte(`{"agentId":"a1","runId":"r1","context":{}}`)
		req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		results <- rec.Code
	}()
	<-started
	body := []byte(`{"agentId":"a1","runId":"r2","context":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rec.Code)
	}
	close(block)
	if <-results != http.StatusOK {
		t.Error("first request should get 200")
	}
}

func TestRunHandler_UnauthorizedWhenKeySet(t *testing.T) {
	os.Setenv("HIVE_AGENT_KEY", "secret-key")
	defer os.Unsetenv("HIVE_AGENT_KEY")
	h := NewRunHandler()
	body := []byte(`{"agentId":"a1","runId":"r1","context":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer wrong-key")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("code = %d", rec.Code)
	}
}

func TestRunHandler_AuthorizedWhenKeyMatches(t *testing.T) {
	os.Setenv("HIVE_AGENT_KEY", "secret-key")
	defer os.Unsetenv("HIVE_AGENT_KEY")
	h := NewRunHandler()
	body := []byte(`{"agentId":"a1","runId":"r1","context":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/run", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret-key")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("code = %d", rec.Code)
	}
}

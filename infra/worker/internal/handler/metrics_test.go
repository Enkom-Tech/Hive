package handler

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
)

func TestMetrics_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/metrics", nil)
	rec := httptest.NewRecorder()
	Metrics(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("code = %d", rec.Code)
	}
}

func TestMetrics_ReturnsPrometheusFormat(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	Metrics(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("code = %d", rec.Code)
	}
	if rec.Header().Get("Content-Type") != "text/plain; version=0.0.4" {
		t.Errorf("Content-Type = %s", rec.Header().Get("Content-Type"))
	}
	body := rec.Body.String()
	// Must contain Prometheus exposition format
	if !regexp.MustCompile(`hive_tasks_total \d+`).MatchString(body) {
		t.Errorf("missing hive_tasks_total: %s", body)
	}
	if !regexp.MustCompile(`hive_tasks_active \d+`).MatchString(body) {
		t.Errorf("missing hive_tasks_active: %s", body)
	}
	if !regexp.MustCompile(`hive_errors_total \d+`).MatchString(body) {
		t.Errorf("missing hive_errors_total: %s", body)
	}
	for _, name := range []string{
		`hive_mcp_indexer_calls_total\{gateway="code",result="ok"\}`,
		`hive_mcp_indexer_circuit_open\{gateway="code"\}`,
		`hive_wasm_skill_calls_total\{result="ok"\}`,
	} {
		if !regexp.MustCompile(name + ` \d+`).MatchString(body) {
			t.Errorf("missing metric line %s in body", name)
		}
	}
}

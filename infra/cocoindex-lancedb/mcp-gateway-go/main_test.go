package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBlocklistJSONEmbedded(t *testing.T) {
	var f gatewayBlocklistFile
	if err := json.Unmarshal(embeddedBlocklist, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cocoindex) == 0 || len(f.Docindex) == 0 {
		t.Fatal("blocklist.json must define cocoindex and docindex arrays")
	}
}

func TestToolIsBlocked_cocoDefault(t *testing.T) {
	t.Setenv("GATEWAY_DOCINDEX_MODE", "")
	if !toolIsBlocked("index_repository") || !toolIsBlocked("delete_repo") || !toolIsBlocked("force_reindex") {
		t.Fatal("expected coco blocklist")
	}
	if toolIsBlocked("search_code") {
		t.Fatal("search_code should not be blocked")
	}
	if toolIsBlocked("index_documents") {
		t.Fatal("index_documents not a coco MCP tool; should not be blocked in coco mode")
	}
}

func TestToolIsBlocked_docIndexMode(t *testing.T) {
	t.Setenv("GATEWAY_DOCINDEX_MODE", "1")
	if !toolIsBlocked("index_documents") || !toolIsBlocked("force_reindex") {
		t.Fatal("expected docindex blocklist")
	}
	if toolIsBlocked("search_documents") {
		t.Fatal("search_documents should not be blocked")
	}
	if toolIsBlocked("index_repository") {
		t.Fatal("coco-only tool name should not be blocked in docindex mode")
	}
}

func TestRequireWorkerRejectsMissingHeader(t *testing.T) {
	t.Setenv("GATEWAY_WORKER_TOKEN", "worker-secret-token")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/mcp/message", strings.NewReader(`{}`))
	if requireWorker(rec, req) {
		t.Fatal("expected false")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestRequireWorkerAcceptsValidBearer(t *testing.T) {
	t.Setenv("GATEWAY_WORKER_TOKEN", "worker-secret-token")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/mcp/message", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer worker-secret-token")
	if !requireWorker(rec, req) {
		t.Fatalf("expected ok, body=%q", rec.Body.String())
	}
}

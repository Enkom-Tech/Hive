package link

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadRunUsageSidecar(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, RunUsageFileName)
	if err := os.WriteFile(p, []byte(`{"usage":{"inputTokens":1,"outputTokens":2},"costUsd":0.01,"provider":"openai","model":"gpt-4o"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := ReadRunUsageSidecar(dir)
	if s == nil || s.Usage == nil || s.Usage.InputTokens != 1 {
		t.Fatalf("unexpected sidecar: %+v", s)
	}
	m := map[string]any{"type": "status", "runId": "r1"}
	MergeRunUsageIntoStatus(m, s, "fallback")
	if m["model"] != "gpt-4o" {
		t.Fatalf("expected model from sidecar, got %v", m["model"])
	}
}

func TestMergeRunUsageFallbackModel(t *testing.T) {
	m := map[string]any{"type": "status"}
	MergeRunUsageIntoStatus(m, nil, "vllm:llama")
	if m["model"] != "vllm:llama" {
		t.Fatalf("expected fallback model, got %v", m["model"])
	}
}

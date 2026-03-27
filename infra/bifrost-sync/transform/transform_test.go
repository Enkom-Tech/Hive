package transform

import (
	"testing"
)

func TestGroupModelsByBaseURL(t *testing.T) {
	models := []RouterModel{
		{ID: "a", BaseURL: "http://v1/v1"},
		{ID: "b", BaseURL: "http://v1/v1"},
		{ID: "c", BaseURL: "http://v2/v1"},
	}
	g := GroupModelsByBaseURL(models)
	if len(g["http://v1/v1"]) != 2 || len(g["http://v2/v1"]) != 1 {
		t.Fatalf("unexpected groups: %#v", g)
	}
}

func TestHostAllowed(t *testing.T) {
	suf := []string{".svc.cluster.local", "internal"}
	if err := HostAllowed("http://llm.hive-llm.svc.cluster.local:8000/v1", suf); err != nil {
		t.Fatal(err)
	}
	if err := HostAllowed("http://evil.example.com/v1", suf); err == nil {
		t.Fatal("expected error")
	}
}

func TestValidateGroupedBaseURLs(t *testing.T) {
	g := map[string][]string{
		"http://x.hive.svc.cluster.local/v1": {"m"},
	}
	if err := ValidateGroupedBaseURLs(g, []string{".svc.cluster.local"}); err != nil {
		t.Fatal(err)
	}
}

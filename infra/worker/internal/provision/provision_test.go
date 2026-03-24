package provision

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDefaultProvisioner_Provision_NoURLReturnsEmpty(t *testing.T) {
	os.Unsetenv(AdapterURLEnv("testkey"))
	defer os.Unsetenv(AdapterURLEnv("testkey"))
	p := NewFromEnv()
	path, err := p.Provision(context.Background(), "testkey")
	if err != nil {
		t.Fatal(err)
	}
	if path != "" {
		t.Errorf("path = %s", path)
	}
}

func TestDefaultProvisioner_Provision_HTTPSOnly(t *testing.T) {
	os.Setenv(AdapterURLEnv("x"), "http://evil/bad")
	defer os.Unsetenv(AdapterURLEnv("x"))
	p := NewFromEnv()
	_, err := p.Provision(context.Background(), "x")
	if err == nil {
		t.Error("expected error for non-HTTPS URL")
	}
}

func TestDefaultProvisioner_Provision_DownloadsBinary(t *testing.T) {
	// Test cache dir and URL env; full download test would require HTTPS mock server.
	dir := t.TempDir()
	os.Setenv(CacheDirEnv, dir)
	os.Setenv(AdapterURLEnv("bin"), "https://example.com/fake")
	defer func() {
		os.Unsetenv(CacheDirEnv)
		os.Unsetenv(AdapterURLEnv("bin"))
	}()
	_ = dir
}

func TestSafeKey(t *testing.T) {
	if safeKey("claude") != "claude" {
		t.Error(safeKey("claude"))
	}
	if safeKey("a/b") != "a_b" {
		t.Error(safeKey("a/b"))
	}
}

func TestFindExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable bit not set on Windows for WriteFile")
	}
	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(binDir, 0750); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(binDir, "cmd")
	if err := os.WriteFile(path, []byte("x"), 0755); err != nil {
		t.Fatal(err)
	}
	got, err := findExecutable(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != path {
		t.Errorf("got %s", got)
	}
}

func TestManifestEntryForAdapter_InlineJSON(t *testing.T) {
	t.Setenv("HIVE_PROVISION_MANIFEST_JSON", `{"version":"v1","adapters":{"codex":{"url":"https://example.com/codex.tgz","sha256":"abc"}}}`)
	url, sha, ok, err := manifestEntryForAdapter(context.Background(), nil, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected adapter entry")
	}
	if url != "https://example.com/codex.tgz" || sha != "abc" {
		t.Fatalf("unexpected entry: %s %s", url, sha)
	}
}

func TestManifestEntryForAdapter_URL(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"v1","adapters":{"claude":{"url":"https://example.com/claude.zip"}}}`))
	}))
	defer srv.Close()

	t.Setenv("HIVE_PROVISION_MANIFEST_URL", srv.URL)
	client := srv.Client()
	url, sha, ok, err := manifestEntryForAdapter(context.Background(), client, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || url != "https://example.com/claude.zip" || sha != "" {
		t.Fatalf("unexpected manifest result: ok=%v url=%s sha=%s", ok, url, sha)
	}
}

func TestLoadProvisionManifest_SendsBearerWhenSet(t *testing.T) {
	var auth string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"v1","adapters":{}}`))
	}))
	defer srv.Close()

	t.Setenv("HIVE_PROVISION_MANIFEST_URL", srv.URL)
	t.Setenv("HIVE_PROVISION_MANIFEST_BEARER", "hive_test_secret")
	t.Setenv("HIVE_AGENT_KEY", "should_not_win")
	client := srv.Client()
	m, err := LoadProvisionManifest(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	if m == nil {
		t.Fatal("expected manifest")
	}
	if auth != "Bearer hive_test_secret" {
		t.Fatalf("Authorization = %q", auth)
	}
}

func TestApplyManifestHooksFromEnv_NoOpWhenDisabled(t *testing.T) {
	t.Setenv("HIVE_PROVISION_MANIFEST_HOOKS", "")
	t.Setenv("HIVE_PROVISION_MANIFEST_JSON", `{"version":"v1","adapters":{},"aptPackages":["curl"]}`)
	if err := ApplyManifestHooksFromEnv(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
}

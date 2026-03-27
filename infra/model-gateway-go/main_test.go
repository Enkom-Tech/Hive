package main

import (
	"net/http"
	"os"
	"testing"
)

func TestSha256Hex(t *testing.T) {
	// echo -n x | shasum -a 256
	const want = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
	if got := sha256Hex("x"); got != want {
		t.Fatalf("sha256Hex: got %q want %q", got, want)
	}
}

func TestBearerToken(t *testing.T) {
	h := http.Header{}
	h.Set("Authorization", "Bearer  hive_gvk_abc")
	if got := bearerToken(h); got != "hive_gvk_abc" {
		t.Fatalf("bearerToken: got %q", got)
	}
	if bearerToken(http.Header{}) != "" {
		t.Fatal("expected empty")
	}
}

// Bifrost governance recognizes Bearer tokens with prefix sk-bf- (see control-plane/doc/adr/006-bifrost-model-gateway.md).
func TestBearerTokenBifrostVirtualKeyPrefix(t *testing.T) {
	h := http.Header{}
	h.Set("Authorization", "Bearer sk-bf-test")
	if got := bearerToken(h); got != "sk-bf-test" {
		t.Fatalf("bearerToken: got %q", got)
	}
}

func TestLoadVirtualKeyMapFromEnvJSON(t *testing.T) {
	t.Setenv("VIRTUAL_KEYS_JSON", `{"keys":[{"sha256":"aa","company_id":"550e8400-e29b-41d4-a716-446655440000"}]}`)
	t.Setenv("VIRTUAL_KEYS_PATH", "")
	m := loadVirtualKeyMap("")
	if m["aa"] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("map: %+v", m)
	}
}

func TestLoadVirtualKeyMapFromFile(t *testing.T) {
	t.Setenv("VIRTUAL_KEYS_JSON", "")
	f, err := os.CreateTemp(t.TempDir(), "vk-*.json")
	if err != nil {
		t.Fatal(err)
	}
	path := f.Name()
	if _, err := f.WriteString(`{"keys":[{"sha256":"bb","company_id":"550e8400-e29b-41d4-a716-446655440001"}]}`); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	m := loadVirtualKeyMap(path)
	if m["bb"] != "550e8400-e29b-41d4-a716-446655440001" {
		t.Fatalf("map: %+v", m)
	}
}

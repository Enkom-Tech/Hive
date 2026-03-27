package deploygrant

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyImageCosignIfConfigured_SkipsWhenNoKey(t *testing.T) {
	t.Setenv("HIVE_DEPLOY_GRANT_COSIGN_PUBLIC_KEY_PATH", "")
	if err := VerifyImageCosignIfConfigured(context.Background(), "ghcr.io/x/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyImageCosignIfConfigured_RequiresRefWhenKeySet(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "key.pub")
	if err := os.WriteFile(keyFile, []byte("-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HIVE_DEPLOY_GRANT_COSIGN_PUBLIC_KEY_PATH", keyFile)
	if err := VerifyImageCosignIfConfigured(context.Background(), ""); err == nil {
		t.Fatal("expected error for empty ref")
	}
}

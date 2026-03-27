package deploygrant

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// CosignPublicKeyPath returns HIVE_DEPLOY_GRANT_COSIGN_PUBLIC_KEY_PATH when set (PEM or cosign public key file).
func CosignPublicKeyPath() string {
	return strings.TrimSpace(os.Getenv("HIVE_DEPLOY_GRANT_COSIGN_PUBLIC_KEY_PATH"))
}

// CosignVerifyBinary returns HIVE_COSIGN_BINARY or "cosign".
func CosignVerifyBinary() string {
	if b := strings.TrimSpace(os.Getenv("HIVE_COSIGN_BINARY")); b != "" {
		return b
	}
	return "cosign"
}

// VerifyImageCosignIfConfigured runs `cosign verify` when HIVE_DEPLOY_GRANT_COSIGN_PUBLIC_KEY_PATH is set.
// Uses --insecure-ignore-tlog so offline / private-registry operators can verify key-only bundles without Rekor.
func VerifyImageCosignIfConfigured(ctx context.Context, imageRef string) error {
	keyPath := CosignPublicKeyPath()
	if keyPath == "" {
		return nil
	}
	ref := strings.TrimSpace(imageRef)
	if ref == "" {
		return fmt.Errorf("deploygrant cosign: empty image ref")
	}
	bin := CosignVerifyBinary()
	args := []string{
		"verify",
		"--key", keyPath,
		"--insecure-ignore-tlog",
		ref,
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("deploygrant cosign verify: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

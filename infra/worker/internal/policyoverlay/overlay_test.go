package policyoverlay

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
)

func TestApplySignedAllowlist(t *testing.T) {
	t.Setenv("HIVE_WORKER_POLICY_SECRET", "s3cret")
	defer func() { _ = os.Unsetenv("HIVE_WORKER_POLICY_SECRET") }()
	payload := "1|ghcr.io/org/|2099-01-01"
	mac := hmac.New(sha256.New, []byte("s3cret"))
	_, _ = mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))
	if !ApplySignedAllowlist("1", "ghcr.io/org/", "2099-01-01", sig) {
		t.Fatal("expected accept")
	}
	if AllowlistExtraCSV() != "ghcr.io/org/" {
		t.Fatal(AllowlistExtraCSV())
	}
}

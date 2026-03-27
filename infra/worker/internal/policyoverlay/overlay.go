// Package policyoverlay merges control-plane–signed container allowlist fragments (WebSocket policy push).
package policyoverlay

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"sync/atomic"
)

var allowlistExtra atomic.Value // string

// Secret returns HIVE_WORKER_POLICY_SECRET (trimmed).
func Secret() string {
	return strings.TrimSpace(os.Getenv("HIVE_WORKER_POLICY_SECRET"))
}

// AllowlistExtraCSV returns the last successfully applied allowlist fragment (comma-separated prefixes).
func AllowlistExtraCSV() string {
	v := allowlistExtra.Load()
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}

// ApplySignedAllowlist verifies HMAC-SHA256(secret, version+"|"+allowlistCsv+"|"+expiresAt) and stores allowlistCsv.
func ApplySignedAllowlist(version, allowlistCsv, expiresAt, signatureHex string) bool {
	secret := Secret()
	if secret == "" {
		return false
	}
	v := strings.TrimSpace(version)
	al := strings.TrimSpace(allowlistCsv)
	ex := strings.TrimSpace(expiresAt)
	sig := strings.TrimSpace(signatureHex)
	if v == "" || al == "" || sig == "" {
		return false
	}
	payload := v + "|" + al + "|" + ex
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(payload))
	expected := mac.Sum(nil)
	got, err := hex.DecodeString(strings.ToLower(sig))
	if err != nil || len(got) != len(expected) {
		return false
	}
	if !hmac.Equal(expected, got) {
		return false
	}
	allowlistExtra.Store(al)
	return true
}

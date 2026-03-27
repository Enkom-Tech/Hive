package deploygrant

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strconv"
	"strings"
	"time"
)

// Enabled returns true when HIVE_REQUEST_DEPLOY_ENABLED is set.
func Enabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("HIVE_REQUEST_DEPLOY_ENABLED")))
	return v == "1" || v == "true" || v == "yes"
}

// VerifySignature checks HMAC-SHA256(secret, companyId|imageRef|expiresAtMs) == sigHex.
func VerifySignature(secret, companyID, imageRef, expiresAtMs, sigHex string) bool {
	if strings.TrimSpace(secret) == "" || strings.TrimSpace(sigHex) == "" {
		return false
	}
	msg := strings.TrimSpace(companyID) + "|" + strings.TrimSpace(imageRef) + "|" + strings.TrimSpace(expiresAtMs)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(msg))
	expect := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(strings.ToLower(sigHex)), []byte(strings.ToLower(expect)))
}

// Expired returns true if expiresAtMs (unix ms string) is in the past.
func Expired(expiresAtMs string) bool {
	n, err := strconv.ParseInt(strings.TrimSpace(expiresAtMs), 10, 64)
	if err != nil || n <= 0 {
		return true
	}
	return time.Now().UnixMilli() > n
}

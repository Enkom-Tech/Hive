package provision

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
)

// HTTP header set by the control plane when HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY* is configured.
const manifestSigHeader = "X-Hive-Manifest-Signature"

const manifestSigPrefix = "v1-ed25519-"

// verifyManifestHTTPSignature checks Ed25519 detached signature over exact response body bytes.
// When HIVE_PROVISION_MANIFEST_PUBLIC_KEY is unset, verification is skipped (compat).
// When set, the response must include a valid signature header (fail closed).
func verifyManifestHTTPSignature(body []byte, resp *http.Response) error {
	pubRaw := strings.TrimSpace(os.Getenv("HIVE_PROVISION_MANIFEST_PUBLIC_KEY"))
	if pubRaw == "" {
		return nil
	}
	sigLine := strings.TrimSpace(resp.Header.Get(manifestSigHeader))
	if sigLine == "" {
		return fmt.Errorf("response missing %s (required when HIVE_PROVISION_MANIFEST_PUBLIC_KEY is set)", manifestSigHeader)
	}
	if !strings.HasPrefix(sigLine, manifestSigPrefix) {
		return fmt.Errorf("unknown manifest signature format (expected %s prefix)", manifestSigPrefix)
	}
	sigB64 := strings.TrimPrefix(sigLine, manifestSigPrefix)
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("invalid manifest signature encoding")
	}
	pub, err := parseEd25519PublicKey(pubRaw)
	if err != nil {
		return err
	}
	if !ed25519.Verify(pub, body, sig) {
		return errors.New("manifest Ed25519 signature verification failed")
	}
	return nil
}

func parseEd25519PublicKey(s string) (ed25519.PublicKey, error) {
	s = strings.TrimSpace(s)
	if strings.Contains(s, "BEGIN") {
		block, _ := pem.Decode([]byte(s))
		if block == nil {
			return nil, errors.New("invalid PEM in HIVE_PROVISION_MANIFEST_PUBLIC_KEY")
		}
		pk, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		switch k := pk.(type) {
		case ed25519.PublicKey:
			return k, nil
		default:
			return nil, fmt.Errorf("public key is not Ed25519")
		}
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("HIVE_PROVISION_MANIFEST_PUBLIC_KEY must be base64-encoded 32-byte Ed25519 public key or PEM")
	}
	return ed25519.PublicKey(b), nil
}

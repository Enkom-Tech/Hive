package provision

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"testing"
)

func TestVerifyManifestHTTPSignature_OptionalWhenNoPublicKey(t *testing.T) {
	t.Setenv("HIVE_PROVISION_MANIFEST_PUBLIC_KEY", "")
	resp := &http.Response{Header: http.Header{}}
	if err := verifyManifestHTTPSignature([]byte(`{}`), resp); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyManifestHTTPSignature_GoodSignature(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"version":"v1","adapters":{}}`)
	sig := ed25519.Sign(priv, body)
	hdr := manifestSigPrefix + base64.StdEncoding.EncodeToString(sig)

	resp := &http.Response{Header: http.Header{}}
	resp.Header.Set(manifestSigHeader, hdr)

	t.Setenv("HIVE_PROVISION_MANIFEST_PUBLIC_KEY", base64.StdEncoding.EncodeToString(pub))
	if err := verifyManifestHTTPSignature(body, resp); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyManifestHTTPSignature_RequiresHeaderWhenPubSet(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HIVE_PROVISION_MANIFEST_PUBLIC_KEY", base64.StdEncoding.EncodeToString(pub))
	resp := &http.Response{Header: http.Header{}}
	if err := verifyManifestHTTPSignature([]byte(`{}`), resp); err == nil {
		t.Fatal("expected error when signature missing")
	}
}

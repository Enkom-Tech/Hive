package deploygrant

import (
	"testing"
)

func TestRegistryAllowed(t *testing.T) {
	validDigest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	okRef := "registry.example/project/img@sha256:" + validDigest

	tests := []struct {
		name    string
		env     string
		ref     string
		allowed bool
	}{
		{name: "empty env denies", env: "", ref: okRef, allowed: false},
		{name: "prefix match", env: "registry.example/", ref: okRef, allowed: true},
		{name: "wrong registry", env: "other.example/", ref: okRef, allowed: false},
		{name: "multi prefix", env: "a.com/,registry.example/", ref: okRef, allowed: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HIVE_DEPLOY_ALLOWED_REGISTRIES", tt.env)
			if got := RegistryAllowed(tt.ref); got != tt.allowed {
				t.Fatalf("RegistryAllowed(%q) with env %q = %v, want %v", tt.ref, tt.env, got, tt.allowed)
			}
		})
	}
}

func TestDigestPinned(t *testing.T) {
	validDigest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	okRef := "docker.io/library/nginx@sha256:" + validDigest

	tests := []struct {
		name string
		ref  string
		want bool
	}{
		{name: "pinned", ref: okRef, want: true},
		{name: "trimmed", ref: "  " + okRef + "  ", want: true},
		{name: "latest tag", ref: "docker.io/library/nginx:latest", want: false},
		{name: "short digest", ref: "x@sha256:abc", want: false},
		{name: "empty", ref: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DigestPinned(tt.ref); got != tt.want {
				t.Fatalf("DigestPinned(%q) = %v, want %v", tt.ref, got, tt.want)
			}
		})
	}
}

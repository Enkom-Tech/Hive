package executor

import "testing"

func TestEnforceContainerImagePolicy_NoAllowlist(t *testing.T) {
	t.Setenv("HIVE_CONTAINER_IMAGE_ALLOWLIST", "")
	t.Setenv("HIVE_CONTAINER_IMAGE_ENFORCE", "")
	if err := EnforceContainerImagePolicy("ghcr.io/org/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err != nil {
		t.Fatalf("expected nil when allowlist empty, got %v", err)
	}
}

func TestEnforceContainerImagePolicy_AllowlistMatch(t *testing.T) {
	t.Setenv("HIVE_CONTAINER_IMAGE_ALLOWLIST", "ghcr.io/org/")
	t.Setenv("HIVE_CONTAINER_IMAGE_ENFORCE", "")
	img := "ghcr.io/org/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := EnforceContainerImagePolicy(img); err != nil {
		t.Fatalf("expected match: %v", err)
	}
}

func TestEnforceContainerImagePolicy_DigestRefPrefix(t *testing.T) {
	t.Setenv("HIVE_CONTAINER_IMAGE_ALLOWLIST", "registry.example.com/proj/")
	t.Setenv("HIVE_CONTAINER_IMAGE_ENFORCE", "")
	img := "registry.example.com/proj/agent@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := EnforceContainerImagePolicy(img); err != nil {
		t.Fatalf("digest-pinned ref should match prefix: %v", err)
	}
}

func TestEnforceContainerImagePolicy_PrefixNotSubstringTrap(t *testing.T) {
	t.Setenv("HIVE_CONTAINER_IMAGE_ALLOWLIST", "registry.io/safe/")
	t.Setenv("HIVE_CONTAINER_IMAGE_ENFORCE", "")
	// Must not match via accidental substring inside another host
	img := "evil.com/registry.io/safe/hijack@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	if err := EnforceContainerImagePolicy(img); err == nil {
		t.Fatal("expected deny: prefix is evil.com/..., not registry.io/safe/")
	}
}

func TestEnforceContainerImagePolicy_EnforceRequiresAllowlist(t *testing.T) {
	t.Setenv("HIVE_CONTAINER_IMAGE_ALLOWLIST", "")
	t.Setenv("HIVE_CONTAINER_IMAGE_ENFORCE", "true")
	if err := EnforceContainerImagePolicy("ghcr.io/x@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"); err == nil {
		t.Fatal("expected error when enforce set but allowlist empty")
	}
}

func TestEnforceContainerImagePolicy_EnforceDeny(t *testing.T) {
	t.Setenv("HIVE_CONTAINER_IMAGE_ALLOWLIST", "ghcr.io/allowed/")
	t.Setenv("HIVE_CONTAINER_IMAGE_ENFORCE", "1")
	if err := EnforceContainerImagePolicy("docker.io/library/nginx@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"); err == nil {
		t.Fatal("expected deny for image outside allowlist")
	}
}

func TestEnforceContainerImagePolicy_SkipEmptyCommaEntries(t *testing.T) {
	t.Setenv("HIVE_CONTAINER_IMAGE_ALLOWLIST", " , ghcr.io/good/ ,  ")
	t.Setenv("HIVE_CONTAINER_IMAGE_ENFORCE", "")
	img := "ghcr.io/good/img@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	if err := EnforceContainerImagePolicy(img); err != nil {
		t.Fatalf("empty segments should be ignored: %v", err)
	}
}

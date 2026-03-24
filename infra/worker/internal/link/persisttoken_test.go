package link

import (
	"testing"
)

func TestReadPersistedLinkToken(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if err := PersistLinkToken(dir, "hive_wen_test_secret\n"); err != nil {
		t.Fatal(err)
	}
	if got := ReadPersistedLinkToken(dir); got != "hive_wen_test_secret" {
		t.Fatalf("got %q", got)
	}
}

func TestTokenFromEnv_prefersPersistedOverDroneProvision(t *testing.T) {
	dir := t.TempDir()
	if err := PersistLinkToken(dir, "hive_wen_from_file"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HIVE_WORKER_STATE_DIR", dir)
	t.Setenv("HIVE_DRONE_PROVISION_TOKEN", "hive_dpv_should_lose")
	if got := TokenFromEnv(); got != "hive_wen_from_file" {
		t.Fatalf("expected persisted token, got %q", got)
	}
}

func TestTokenFromEnv_prefersAgentKeyOverPersistedFile(t *testing.T) {
	dir := t.TempDir()
	if err := PersistLinkToken(dir, "hive_wen_stale_from_file"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HIVE_WORKER_STATE_DIR", dir)
	t.Setenv("HIVE_AGENT_KEY", "hive_wen_from_env_wins")
	if got := TokenFromEnv(); got != "hive_wen_from_env_wins" {
		t.Fatalf("expected env agent key, got %q", got)
	}
}

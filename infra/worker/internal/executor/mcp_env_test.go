package executor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteHiveMcpJSON_createsFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HIVE_MCP_SERVER_COMMAND", "")
	exe, err := os.Executable()
	if err != nil || exe == "" {
		t.Skip("no executable path")
	}
	if err := WriteHiveMcpJSON(dir); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, ".mcp.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 20 {
		t.Fatalf("short file: %q", raw)
	}
}

func TestWriteHiveMcpJSON_usesHiveMcpServerCommand(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HIVE_MCP_SERVER_COMMAND", "/usr/local/bin/hive-worker")
	if err := WriteHiveMcpJSON(dir); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "/usr/local/bin/hive-worker") {
		t.Fatalf("expected custom command in %s", raw)
	}
}

func TestAppendHiveMcpEnv_passesMaxConcurrentWhenSet(t *testing.T) {
	t.Setenv("HIVE_MCP_MAX_CONCURRENT", "4")
	out := AppendHiveMcpEnv(nil)
	found := false
	for _, e := range out {
		if e == "HIVE_MCP_MAX_CONCURRENT=4" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected HIVE_MCP_MAX_CONCURRENT in %v", out)
	}
}

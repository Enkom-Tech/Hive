package executor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// WriteHiveMcpJSON writes .mcp.json in workspaceDir so agent CLIs can discover the hive stdio MCP server.
// When HIVE_MCP_SERVER_COMMAND is set (e.g. path inside an agent container), it is used as the command instead of os.Executable().
func WriteHiveMcpJSON(workspaceDir string) error {
	cmd := strings.TrimSpace(os.Getenv("HIVE_MCP_SERVER_COMMAND"))
	if cmd == "" {
		exe, err := os.Executable()
		if err != nil || strings.TrimSpace(exe) == "" {
			return nil
		}
		cmd = exe
	}
	type server struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	root := struct {
		McpServers map[string]server `json:"mcpServers"`
	}{
		McpServers: map[string]server{
			"hive": {Command: cmd, Args: []string{"mcp"}},
		},
	}
	b, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(workspaceDir, ".mcp.json"), b, 0o600)
}

// AppendHiveMcpEnv adds env vars consumed by agent runtimes and hive-worker mcp.
func AppendHiveMcpEnv(env []string) []string {
	cmd := strings.TrimSpace(os.Getenv("HIVE_MCP_SERVER_COMMAND"))
	if cmd == "" {
		if exe, err := os.Executable(); err == nil && strings.TrimSpace(exe) != "" {
			cmd = exe
		}
	}
	if cmd != "" {
		env = append(env, "HIVE_WORKER_BINARY="+cmd)
		env = append(env, "HIVE_MCP_CMD="+cmd+" mcp")
	}
	if sd := strings.TrimSpace(os.Getenv("HIVE_WORKER_STATE_DIR")); sd != "" {
		env = append(env, "HIVE_WORKER_STATE_DIR="+sd)
	}
	// Bounded MCP JSON-RPC concurrency for hive-worker mcp (agent subprocess inherits process executor env).
	if mc := strings.TrimSpace(os.Getenv("HIVE_MCP_MAX_CONCURRENT")); mc != "" {
		env = append(env, "HIVE_MCP_MAX_CONCURRENT="+mc)
	}
	return env
}

// Package executor container executor runs the agent process inside a container (e.g. Docker).
package executor

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
)

// ContainerExecutor runs one task inside a container: only workspace and explicitly configured mounts are visible.
// Image and command come from operator config only.
type ContainerExecutor struct {
	// Image is the container image (e.g. hive-agent-claude:latest).
	Image string
	// Command is the executable run inside the container (e.g. claude).
	Command string
	// Runtime is the container runtime binary (e.g. "docker" or "podman"). Default "docker".
	Runtime string
	// Runner invokes the runtime. If nil, DefaultCommandRunner is used.
	Runner CommandRunner
}

func (e *ContainerExecutor) runtime() string {
	if e.Runtime != "" {
		return e.Runtime
	}
	if r := os.Getenv("HIVE_CONTAINER_RUNTIME"); r != "" {
		return r
	}
	return "docker"
}

func (e *ContainerExecutor) runner() CommandRunner {
	if e.Runner != nil {
		return e.Runner
	}
	return DefaultCommandRunner{}
}

// Run runs the task in a container: -v workspace:/workspace, -w /workspace, env vars, then image and command.
// Context cancellation stops the container.
func (e *ContainerExecutor) Run(ctx context.Context, payload *Payload, workspaceDir string) (stdout, stderr []byte, err error) {
	if e.Image == "" || e.Command == "" {
		return nil, nil, nil
	}
	if workspaceDir == "" {
		workspaceDir = os.Getenv("HIVE_WORKSPACE")
		if workspaceDir == "" {
			workspaceDir = "/workspace/repo"
		}
	}
	absDir, err := filepath.Abs(workspaceDir)
	if err != nil {
		absDir = workspaceDir
	}
	_ = WriteHiveMcpJSON(absDir)
	volume := absDir + ":/workspace"
	args := []string{
		"run", "--rm",
		"-v", volume,
		"-e", "HIVE_AGENT_ID=" + payload.AgentID,
		"-e", "HIVE_RUN_ID=" + payload.RunID,
		"-w", "/workspace",
	}
	if m := strings.TrimSpace(payload.ModelID); m != "" {
		args = append(args, "-e", "HIVE_MODEL_ID="+m, "-e", "HIVE_MODEL="+m)
	}
	if len(payload.Context) > 0 {
		args = append(args, "-e", "HIVE_CONTEXT_JSON="+base64.StdEncoding.EncodeToString(payload.Context))
	}
	if sd := strings.TrimSpace(os.Getenv("HIVE_WORKER_STATE_DIR")); sd != "" {
		args = append(args, "-e", "HIVE_WORKER_STATE_DIR="+sd)
	}
	if cmd := strings.TrimSpace(os.Getenv("HIVE_MCP_SERVER_COMMAND")); cmd != "" {
		args = append(args, "-e", "HIVE_WORKER_BINARY="+cmd)
		args = append(args, "-e", "HIVE_MCP_CMD="+cmd+" mcp")
	} else if exe, err := os.Executable(); err == nil && strings.TrimSpace(exe) != "" {
		args = append(args, "-e", "HIVE_WORKER_BINARY="+exe)
		args = append(args, "-e", "HIVE_MCP_CMD="+exe+" mcp")
	}
	args = appendContainerInferenceEnv(args)
	args = append(args, e.Image, e.Command)
	// Only selected env vars are passed (HIVE_* above + inference-related via appendContainerInferenceEnv).
	// Indexer MCP (HIVE_MCP_*) is intentionally omitted: hive-worker mcp proxies code/doc search using
	// gateway credentials from the worker pod; agents use stdio MCP only (.mcp.json "hive" server).
	return e.runner().Run(ctx, e.runtime(), args, "", nil)
}

// appendContainerInferenceEnv adds -e flags for model-gateway and OpenAI-compatible clients.
// ProcessExecutor inherits host env via os.Environ(); container runs only receive vars listed here.
func appendContainerInferenceEnv(args []string) []string {
	keys := []string{
		"HIVE_MODEL_GATEWAY_URL",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"ANTHROPIC_API_KEY",
	}
	seen := make(map[string]string)
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			seen[k] = v
		}
	}
	if gw := strings.TrimSpace(os.Getenv("HIVE_MODEL_GATEWAY_URL")); gw != "" {
		if _, ok := seen["OPENAI_BASE_URL"]; !ok {
			seen["OPENAI_BASE_URL"] = gw
		}
	}
	order := []string{
		"HIVE_MODEL_GATEWAY_URL",
		"OPENAI_BASE_URL",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
	}
	for _, k := range order {
		if v, ok := seen[k]; ok {
			args = append(args, "-e", k+"="+v)
		}
	}
	return args
}

// IsContainerEnabled returns true if HIVE_ADAPTER_<key>_CONTAINER is 1 or true (case-insensitive).
func IsContainerEnabled(key string) bool {
	v := os.Getenv("HIVE_ADAPTER_" + key + "_CONTAINER")
	v = strings.TrimSpace(strings.ToLower(v))
	return v == "1" || v == "true"
}

// GetAdapterImage returns HIVE_ADAPTER_<key>_IMAGE.
func GetAdapterImage(key string) string {
	return os.Getenv("HIVE_ADAPTER_" + key + "_IMAGE")
}

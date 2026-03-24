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
	volume := absDir + ":/workspace"
	args := []string{
		"run", "--rm",
		"-v", volume,
		"-e", "HIVE_AGENT_ID=" + payload.AgentID,
		"-e", "HIVE_RUN_ID=" + payload.RunID,
		"-w", "/workspace",
	}
	if len(payload.Context) > 0 {
		args = append(args, "-e", "HIVE_CONTEXT_JSON="+base64.StdEncoding.EncodeToString(payload.Context))
	}
	args = append(args, e.Image, e.Command)
	// Do not pass host env into container; only HIVE_* are set above.
	return e.runner().Run(ctx, e.runtime(), args, "", nil)
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

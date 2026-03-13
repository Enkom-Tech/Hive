// Package executor runs a single task by invoking a configurable command (e.g. AI tool) with context.
package executor

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// Payload is the task payload (agent, run id, opaque context).
type Payload struct {
	AgentID string
	RunID   string
	Context []byte
}

// CommandRunner runs a command and returns stdout/stderr. Used for dependency injection in tests.
type CommandRunner interface {
	Run(ctx context.Context, name string, args []string, dir string, env []string) (stdout, stderr []byte, err error)
}

// DefaultCommandRunner runs commands via exec.CommandContext.
type DefaultCommandRunner struct{}

func (DefaultCommandRunner) Run(ctx context.Context, name string, args []string, dir string, env []string) (stdout, stderr []byte, err error) {
	cmd := exec.CommandContext(ctx, name, args...) // #nosec G204 -- name from operator-controlled config (HIVE_TOOL_CMD)
	cmd.Dir = dir
	cmd.Env = env
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err = cmd.Run()
	return outBuf.Bytes(), errBuf.Bytes(), err
}

// Executor runs one task by invoking a configurable command.
type Executor struct {
	// Command is the executable name (e.g. "claude"). From HIVE_TOOL_CMD if empty.
	Command string
	// Runner is the command runner. If nil, DefaultCommandRunner is used.
	Runner CommandRunner
	// WorkspaceDir is the default workspace. From HIVE_WORKSPACE or "/workspace/repo" if empty.
	WorkspaceDir string
}

func (e *Executor) command() string {
	if e.Command != "" {
		return e.Command
	}
	return os.Getenv("HIVE_TOOL_CMD")
}

func (e *Executor) workspaceDir() string {
	if e.WorkspaceDir != "" {
		return e.WorkspaceDir
	}
	if d := os.Getenv("HIVE_WORKSPACE"); d != "" {
		return d
	}
	return "/workspace/repo"
}

func (e *Executor) runner() CommandRunner {
	if e.Runner != nil {
		return e.Runner
	}
	return DefaultCommandRunner{}
}

// Run runs the task: builds env, invokes the command, returns stdout/stderr. The process is killed when ctx is done.
func (e *Executor) Run(ctx context.Context, payload *Payload, workspaceDir string) (stdout, stderr []byte, err error) {
	cmd := e.command()
	if cmd == "" {
		return nil, nil, nil // no-op when no command configured
	}
	if workspaceDir == "" {
		workspaceDir = e.workspaceDir()
	}
	absDir, err := filepath.Abs(workspaceDir)
	if err != nil {
		absDir = workspaceDir
	}
	// Pass context to the tool via env so it can be used by the subprocess.
	env := append(os.Environ(),
		"HIVE_AGENT_ID="+payload.AgentID,
		"HIVE_RUN_ID="+payload.RunID,
	)
	if len(payload.Context) > 0 {
		env = append(env, "HIVE_CONTEXT_JSON="+base64.StdEncoding.EncodeToString(payload.Context))
	}
	runner := e.runner()
	return runner.Run(ctx, cmd, nil, absDir, env)
}

// BlockingRunner is a CommandRunner that blocks until context is cancelled (for cancellation tests).
type BlockingRunner struct {
	mu     sync.Mutex
	called bool
}

func (b *BlockingRunner) Run(ctx context.Context, _ string, _ []string, _ string, _ []string) (stdout, stderr []byte, err error) {
	b.mu.Lock()
	b.called = true
	b.mu.Unlock()
	<-ctx.Done()
	return nil, nil, ctx.Err()
}

func (b *BlockingRunner) Called() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.called
}

// Package executor runs a single task by invoking a configurable command (e.g. AI tool) with context.
package executor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Payload is the task payload (agent, run id, opaque context).
type Payload struct {
	AgentID string
	RunID   string
	Context []byte
	// ModelID is the logical LLM model id (OpenAI-style) for HIVE_MODEL_ID / model-gateway routing.
	ModelID string
}

// AppendModelEnv sets HIVE_MODEL_ID and HIVE_MODEL when modelID is non-empty.
func AppendModelEnv(env []string, modelID string) []string {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return env
	}
	return append(env, "HIVE_MODEL_ID="+modelID, "HIVE_MODEL="+modelID)
}

// Executor runs one task (e.g. invoke a CLI with context). Implementations are allowlisted and configured by the operator.
type Executor interface {
	Run(ctx context.Context, payload *Payload, workspaceDir string) (stdout, stderr []byte, err error)
}

// CommandRunner runs a command and returns stdout/stderr. Used for dependency injection in tests.
type CommandRunner interface {
	Run(ctx context.Context, name string, args []string, dir string, env []string) (stdout, stderr []byte, err error)
}

// DefaultCommandRunner runs commands via exec.CommandContext.
type DefaultCommandRunner struct{}

func (DefaultCommandRunner) Run(ctx context.Context, name string, args []string, dir string, env []string) (stdout, stderr []byte, err error) {
	cmd := exec.CommandContext(ctx, name, args...) // #nosec G204 -- name from operator-controlled config (HIVE_TOOL_CMD / adapter registry)
	cmd.Dir = dir
	cmd.Env = env
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err = cmd.Run()
	return outBuf.Bytes(), errBuf.Bytes(), err
}

// ProcessExecutor runs one task by invoking a configurable command (implements Executor).
type ProcessExecutor struct {
	// Command is the executable name (e.g. "claude"). From HIVE_TOOL_CMD if empty.
	Command string
	// Runner is the command runner. If nil, DefaultCommandRunner is used.
	Runner CommandRunner
	// WorkspaceDir is the default workspace. From HIVE_WORKSPACE or "/workspace/repo" if empty.
	WorkspaceDir string
}

func (e *ProcessExecutor) command() string {
	if e.Command != "" {
		return e.Command
	}
	return os.Getenv("HIVE_TOOL_CMD")
}

// DefaultWorkspaceRoot is the directory used for runs when the executor is given an empty workspace path (HIVE_WORKSPACE or "/workspace/repo").
func DefaultWorkspaceRoot() string {
	if d := os.Getenv("HIVE_WORKSPACE"); d != "" {
		return d
	}
	return "/workspace/repo"
}

func (e *ProcessExecutor) workspaceDir() string {
	if e.WorkspaceDir != "" {
		return e.WorkspaceDir
	}
	return DefaultWorkspaceRoot()
}

// CancelGraceDuration returns HIVE_CANCEL_GRACE_SECONDS as duration, or 0 if unset/invalid (immediate kill via context).
func CancelGraceDuration() time.Duration {
	s := strings.TrimSpace(os.Getenv("HIVE_CANCEL_GRACE_SECONDS"))
	if s == "" {
		return 0
	}
	sec, err := strconv.Atoi(s)
	if err != nil || sec < 0 {
		return 0
	}
	return time.Duration(sec) * time.Second
}

func (e *ProcessExecutor) runner() CommandRunner {
	if e.Runner != nil {
		return e.Runner
	}
	return DefaultCommandRunner{}
}

// Run runs the task: builds env, invokes the command, returns stdout/stderr. The process is killed when ctx is done.
func (e *ProcessExecutor) Run(ctx context.Context, payload *Payload, workspaceDir string) (stdout, stderr []byte, err error) {
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
	_ = WriteHiveMcpJSON(absDir)
	// Pass context to the tool via env so it can be used by the subprocess.
	env := AppendModelEnv(append(os.Environ(),
		"HIVE_AGENT_ID="+payload.AgentID,
		"HIVE_RUN_ID="+payload.RunID,
	), payload.ModelID)
	if len(payload.Context) > 0 {
		env = append(env, "HIVE_CONTEXT_JSON="+base64.StdEncoding.EncodeToString(payload.Context))
	}
	env = AppendHiveMcpEnv(env)
	grace := CancelGraceDuration()
	if grace == 0 {
		return e.runner().Run(ctx, cmd, nil, absDir, env)
	}
	c := exec.Command(cmd) // #nosec G204 -- cmd from operator config
	setProcAttrs(c)
	c.Dir = absDir
	c.Env = env
	var stdoutBuf, stderrBuf bytes.Buffer
	c.Stdout = &stdoutBuf
	c.Stderr = &stderrBuf
	if err := c.Start(); err != nil {
		return nil, nil, err
	}
	waitCh := make(chan error, 1)
	go func() { waitCh <- c.Wait() }()
	select {
	case <-ctx.Done():
		terminateGracefully(c.Process, grace)
		<-waitCh
		return stdoutBuf.Bytes(), stderrBuf.Bytes(), ctx.Err()
	case err := <-waitCh:
		return stdoutBuf.Bytes(), stderrBuf.Bytes(), err
	}
}

// LogChunkCallback is called for each streamed stdout/stderr chunk (stream, chunk, iso8601 ts).
type LogChunkCallback func(stream string, chunk string, ts string)

// RunStream runs the task and invokes onChunk for each stdout/stderr chunk. Returns full stdout, stderr, and error when done.
// If onChunk is nil, behaves like Run (no streaming).
func (e *ProcessExecutor) RunStream(ctx context.Context, payload *Payload, workspaceDir string, onChunk LogChunkCallback) (stdout, stderr []byte, err error) {
	cmd := e.command()
	if cmd == "" {
		return nil, nil, nil
	}
	if workspaceDir == "" {
		workspaceDir = e.workspaceDir()
	}
	absDir, err := filepath.Abs(workspaceDir)
	if err != nil {
		absDir = workspaceDir
	}
	_ = WriteHiveMcpJSON(absDir)
	env := AppendModelEnv(append(os.Environ(),
		"HIVE_AGENT_ID="+payload.AgentID,
		"HIVE_RUN_ID="+payload.RunID,
	), payload.ModelID)
	if len(payload.Context) > 0 {
		env = append(env, "HIVE_CONTEXT_JSON="+base64.StdEncoding.EncodeToString(payload.Context))
	}
	env = AppendHiveMcpEnv(env)
	if onChunk == nil {
		return e.Run(ctx, payload, workspaceDir)
	}
	grace := CancelGraceDuration()
	var execCmd *exec.Cmd
	if grace > 0 {
		execCmd = exec.Command(cmd) // #nosec G204 -- cmd from operator config
		setProcAttrs(execCmd)
	} else {
		execCmd = exec.CommandContext(ctx, cmd) // #nosec G204
	}
	execCmd.Dir = absDir
	execCmd.Env = env
	stdoutPipe, err := execCmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	stderrPipe, err := execCmd.StderrPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := execCmd.Start(); err != nil {
		return nil, nil, err
	}
	var outBuf, errBuf bytes.Buffer
	var wg sync.WaitGroup
	readStream := func(pipe io.Reader, stream string, buf *bytes.Buffer) {
		defer wg.Done()
		scanner := bufio.NewScanner(pipe)
		scanner.Buffer(nil, 64*1024)
		for scanner.Scan() {
			line := scanner.Bytes()
			buf.Write(line)
			buf.WriteByte('\n')
			onChunk(stream, string(line)+"\n", time.Now().UTC().Format(time.RFC3339Nano))
		}
	}
	wg.Add(2)
	go readStream(stdoutPipe, "stdout", &outBuf)
	go readStream(stderrPipe, "stderr", &errBuf)
	if grace > 0 {
		waitCh := make(chan error, 1)
		go func() { waitCh <- execCmd.Wait() }()
		select {
		case <-ctx.Done():
			terminateGracefully(execCmd.Process, grace)
			wg.Wait()
			<-waitCh
			return outBuf.Bytes(), errBuf.Bytes(), ctx.Err()
		case err := <-waitCh:
			wg.Wait()
			if ctx.Err() != nil {
				return outBuf.Bytes(), errBuf.Bytes(), ctx.Err()
			}
			return outBuf.Bytes(), errBuf.Bytes(), err
		}
	}
	wg.Wait()
	waitErr := execCmd.Wait()
	if ctx.Err() != nil {
		return outBuf.Bytes(), errBuf.Bytes(), ctx.Err()
	}
	return outBuf.Bytes(), errBuf.Bytes(), waitErr
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

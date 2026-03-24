// Package executor: AcpxExecutor runs a single task via acpx (Agent Client Protocol CLI).
package executor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"
)

const maxPromptLen = 256 * 1024 // 256 KB

// AcpxExecutor runs a task by invoking acpx <agent> exec "<prompt>". Prompt is taken from payload.Context (JSON: "prompt" or "instruction").
type AcpxExecutor struct {
	AcpxPath  string // Path or command for acpx (e.g. "acpx" or "npx acpx"). From operator env only.
	AgentName string // acpx agent name (e.g. "codex", "claude"). From operator env only.
	Runner    CommandRunner
}

func (e *AcpxExecutor) runner() CommandRunner {
	if e.Runner != nil {
		return e.Runner
	}
	return DefaultCommandRunner{}
}

// extractPrompt parses context JSON and returns the prompt or instruction string. Returns error if missing, empty, or invalid.
func extractPrompt(contextJSON []byte) (string, error) {
	if len(contextJSON) == 0 {
		return "", errors.New("acpx: context missing prompt or instruction")
	}
	var m map[string]interface{}
	if err := json.Unmarshal(contextJSON, &m); err != nil {
		return "", fmt.Errorf("acpx: context invalid JSON: %w", err)
	}
	var prompt string
	if v, ok := m["prompt"]; ok && v != nil {
		if s, ok := v.(string); ok && s != "" {
			prompt = s
		}
	}
	if prompt == "" {
		if v, ok := m["instruction"]; ok && v != nil {
			if s, ok := v.(string); ok && s != "" {
				prompt = s
			}
		}
	}
	if prompt == "" {
		return "", errors.New("acpx: context missing prompt or instruction")
	}
	if len(prompt) > maxPromptLen {
		return "", fmt.Errorf("acpx: prompt exceeds max length %d", maxPromptLen)
	}
	if !utf8.ValidString(prompt) {
		return "", errors.New("acpx: prompt is not valid UTF-8")
	}
	return prompt, nil
}

// Run implements Executor. Extracts prompt from payload.Context, validates it, and runs acpx agent exec <prompt> with env.
func (e *AcpxExecutor) Run(ctx context.Context, payload *Payload, workspaceDir string) (stdout, stderr []byte, err error) {
	if e.AcpxPath == "" || e.AgentName == "" {
		return nil, nil, errors.New("acpx: AcpxPath and AgentName must be set")
	}
	prompt, err := extractPrompt(payload.Context)
	if err != nil {
		return nil, nil, err
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
	env := append(os.Environ(),
		"HIVE_AGENT_ID="+payload.AgentID,
		"HIVE_RUN_ID="+payload.RunID,
	)
	if len(payload.Context) > 0 {
		env = append(env, "HIVE_CONTEXT_JSON="+base64.StdEncoding.EncodeToString(payload.Context))
	}
	args := []string{e.AgentName, "exec", prompt}
	return e.runner().Run(ctx, e.AcpxPath, args, absDir, env)
}

// RunStream runs the task and invokes onChunk for each stdout/stderr chunk. If onChunk is nil, behaves like Run.
func (e *AcpxExecutor) RunStream(ctx context.Context, payload *Payload, workspaceDir string, onChunk LogChunkCallback) (stdout, stderr []byte, err error) {
	if e.AcpxPath == "" || e.AgentName == "" {
		return nil, nil, errors.New("acpx: AcpxPath and AgentName must be set")
	}
	prompt, err := extractPrompt(payload.Context)
	if err != nil {
		return nil, nil, err
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
	env := append(os.Environ(),
		"HIVE_AGENT_ID="+payload.AgentID,
		"HIVE_RUN_ID="+payload.RunID,
	)
	if len(payload.Context) > 0 {
		env = append(env, "HIVE_CONTEXT_JSON="+base64.StdEncoding.EncodeToString(payload.Context))
	}
	args := []string{e.AgentName, "exec", prompt}
	if onChunk == nil {
		return e.Run(ctx, payload, workspaceDir)
	}
	execCmd := exec.CommandContext(ctx, e.AcpxPath, args...) // #nosec G204 -- AcpxPath and args from operator config
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
	wg.Wait()
	waitErr := execCmd.Wait()
	if ctx.Err() != nil {
		return outBuf.Bytes(), errBuf.Bytes(), ctx.Err()
	}
	return outBuf.Bytes(), errBuf.Bytes(), waitErr
}

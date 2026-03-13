package executor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRun_NoCommand_ReturnsNil(t *testing.T) {
	ex := &Executor{}
	stdout, stderr, err := ex.Run(context.Background(), &Payload{AgentID: "a1", RunID: "r1"}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stdout != nil || stderr != nil {
		t.Errorf("expected nil stdout/stderr when no command; got stdout=%q stderr=%q", stdout, stderr)
	}
}

func TestRun_OutputCapture(t *testing.T) {
	fixedOut := []byte("line1\nline2")
	fixedErr := []byte("errline")
	ex := &Executor{
		Runner: &fixedRunner{stdout: fixedOut, stderr: fixedErr},
		Command: "fake",
	}
	stdout, stderr, err := ex.Run(context.Background(), &Payload{AgentID: "a1", RunID: "r1"}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(stdout) != string(fixedOut) {
		t.Errorf("stdout: got %q want %q", stdout, fixedOut)
	}
	if string(stderr) != string(fixedErr) {
		t.Errorf("stderr: got %q want %q", stderr, fixedErr)
	}
}

type fixedRunner struct {
	stdout, stderr []byte
	err           error
}

func (f *fixedRunner) Run(_ context.Context, _ string, _ []string, _ string, _ []string) (stdout, stderr []byte, err error) {
	return f.stdout, f.stderr, f.err
}

func TestRun_Timeout(t *testing.T) {
	blocker := &BlockingRunner{}
	ex := &Executor{Runner: blocker, Command: "fake"}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, _, err := ex.Run(ctx, &Payload{AgentID: "a1", RunID: "r1"}, "")
	if err == nil {
		t.Fatal("expected error on timeout")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("expected context.DeadlineExceeded; got %v", err)
	}
	if !blocker.Called() {
		t.Error("BlockingRunner was not called")
	}
}

func TestRun_Cancellation(t *testing.T) {
	blocker := &BlockingRunner{}
	ex := &Executor{Runner: blocker, Command: "fake"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_, _, _ = ex.Run(ctx, &Payload{AgentID: "a1", RunID: "r1"}, "")
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
		// Run returned after cancel
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after context cancel")
	}
	if !blocker.Called() {
		t.Error("BlockingRunner was not called")
	}
}

func TestRun_EnvPassedToRunner(t *testing.T) {
	var seenEnv []string
	ex := &Executor{
		Runner: &envCaptureRunner{env: &seenEnv},
		Command: "fake",
	}
	_, _, _ = ex.Run(context.Background(), &Payload{
		AgentID: "agent-1",
		RunID:   "run-2",
		Context: []byte(`{"task":"hello"}`),
	}, "/tmp/ws")
	foundAgent := false
	foundRun := false
	foundContext := false
	for _, e := range seenEnv {
		if e == "HIVE_AGENT_ID=agent-1" {
			foundAgent = true
		}
		if e == "HIVE_RUN_ID=run-2" {
			foundRun = true
		}
		if strings.HasPrefix(e, "HIVE_CONTEXT_JSON=") {
			foundContext = true
		}
	}
	if !foundAgent || !foundRun || !foundContext {
		t.Errorf("env not passed correctly: agent=%v run=%v context=%v (env count=%d)", foundAgent, foundRun, foundContext, len(seenEnv))
	}
}

type envCaptureRunner struct {
	env *[]string
}

func (e *envCaptureRunner) Run(_ context.Context, _ string, _ []string, _ string, env []string) (stdout, stderr []byte, err error) {
	*e.env = env
	return nil, nil, nil
}

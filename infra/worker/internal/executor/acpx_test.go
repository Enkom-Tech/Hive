package executor

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestAcpxExecutor_Run_MissingPrompt(t *testing.T) {
	ex := &AcpxExecutor{AcpxPath: "acpx", AgentName: "codex"}
	_, _, err := ex.Run(context.Background(), &Payload{
		AgentID: "a1",
		RunID:   "r1",
		Context: []byte(`{}`),
	}, "")
	if err == nil {
		t.Fatal("expected error when context has no prompt or instruction")
	}
	if !strings.Contains(err.Error(), "acpx: context missing prompt or instruction") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestAcpxExecutor_Run_EmptyContext(t *testing.T) {
	ex := &AcpxExecutor{AcpxPath: "acpx", AgentName: "codex"}
	_, _, err := ex.Run(context.Background(), &Payload{AgentID: "a1", RunID: "r1", Context: nil}, "")
	if err == nil {
		t.Fatal("expected error when context is empty")
	}
	if !strings.Contains(err.Error(), "acpx: context missing prompt or instruction") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestAcpxExecutor_Run_PromptTooLong(t *testing.T) {
	ex := &AcpxExecutor{AcpxPath: "acpx", AgentName: "codex"}
	ctx := map[string]interface{}{"prompt": strings.Repeat("x", maxPromptLen+1)}
	ctxJSON, _ := json.Marshal(ctx)
	_, _, err := ex.Run(context.Background(), &Payload{
		AgentID: "a1",
		RunID:   "r1",
		Context: ctxJSON,
	}, "")
	if err == nil {
		t.Fatal("expected error when prompt exceeds max length")
	}
	if !strings.Contains(err.Error(), "acpx: prompt exceeds max length") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestAcpxExecutor_Run_InvalidJSON(t *testing.T) {
	ex := &AcpxExecutor{AcpxPath: "acpx", AgentName: "codex"}
	_, _, err := ex.Run(context.Background(), &Payload{
		AgentID: "a1",
		RunID:   "r1",
		Context: []byte(`{invalid`),
	}, "")
	if err == nil {
		t.Fatal("expected error when context is invalid JSON")
	}
	if !strings.Contains(err.Error(), "acpx: context invalid JSON") {
		t.Errorf("unexpected error: %v", err)
	}
}

type acpxCaptureRunner struct {
	name string
	args []string
	dir  string
}

func (r *acpxCaptureRunner) Run(_ context.Context, name string, args []string, dir string, _ []string) (stdout, stderr []byte, err error) {
	r.name = name
	r.args = args
	r.dir = dir
	return []byte("ok"), nil, nil
}

func TestAcpxExecutor_Run_ValidPrompt_ArgsBuiltCorrectly(t *testing.T) {
	cap := &acpxCaptureRunner{}
	ex := &AcpxExecutor{AcpxPath: "acpx", AgentName: "codex", Runner: cap}
	ctx := map[string]interface{}{"prompt": "fix the tests"}
	ctxJSON, _ := json.Marshal(ctx)
	stdout, stderr, err := ex.Run(context.Background(), &Payload{
		AgentID: "a1",
		RunID:   "r1",
		Context: ctxJSON,
	}, "/tmp/ws")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(stdout) != "ok" {
		t.Errorf("stdout: got %q", stdout)
	}
	if cap.name != "acpx" {
		t.Errorf("runner name: got %q want acpx", cap.name)
	}
	wantArgs := []string{"codex", "exec", "fix the tests"}
	if len(cap.args) != len(wantArgs) {
		t.Fatalf("args length: got %d want %d", len(cap.args), len(wantArgs))
	}
	for i, w := range wantArgs {
		if cap.args[i] != w {
			t.Errorf("args[%d]: got %q want %q", i, cap.args[i], w)
		}
	}
	if cap.dir == "" || !strings.Contains(cap.dir, "ws") {
		t.Errorf("dir should be workspace dir; got %q", cap.dir)
	}
	_ = stderr
}

func TestAcpxExecutor_Run_InstructionPreferredWhenPromptEmpty(t *testing.T) {
	cap := &acpxCaptureRunner{}
	ex := &AcpxExecutor{AcpxPath: "acpx", AgentName: "claude", Runner: cap}
	ctx := map[string]interface{}{"prompt": "", "instruction": "review the PR"}
	ctxJSON, _ := json.Marshal(ctx)
	_, _, err := ex.Run(context.Background(), &Payload{
		AgentID: "a1",
		RunID:   "r1",
		Context: ctxJSON,
	}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cap.args) < 3 || cap.args[2] != "review the PR" {
		t.Errorf("expected prompt 'review the PR' in args; got %v", cap.args)
	}
}

func TestAcpxExecutor_Run_PromptPreferredOverInstruction(t *testing.T) {
	cap := &acpxCaptureRunner{}
	ex := &AcpxExecutor{AcpxPath: "acpx", AgentName: "codex", Runner: cap}
	ctx := map[string]interface{}{"prompt": "use this", "instruction": "ignore this"}
	ctxJSON, _ := json.Marshal(ctx)
	_, _, err := ex.Run(context.Background(), &Payload{
		AgentID: "a1",
		RunID:   "r1",
		Context: ctxJSON,
	}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cap.args[2] != "use this" {
		t.Errorf("expected prompt 'use this'; got %q", cap.args[2])
	}
}

func TestAcpxExecutor_Run_EmptyPathOrAgent_ReturnsError(t *testing.T) {
	ex1 := &AcpxExecutor{AcpxPath: "", AgentName: "codex"}
	_, _, err := ex1.Run(context.Background(), &Payload{
		AgentID: "a1", RunID: "r1",
		Context: []byte(`{"prompt":"hi"}`),
	}, "")
	if err == nil {
		t.Fatal("expected error when AcpxPath empty")
	}
	ex2 := &AcpxExecutor{AcpxPath: "acpx", AgentName: ""}
	_, _, err = ex2.Run(context.Background(), &Payload{
		AgentID: "a1", RunID: "r1",
		Context: []byte(`{"prompt":"hi"}`),
	}, "")
	if err == nil {
		t.Fatal("expected error when AgentName empty")
	}
}

func TestAcpxExecutor_Run_RunnerErrorPropagated(t *testing.T) {
	wantErr := errors.New("runner failed")
	ex := &AcpxExecutor{
		AcpxPath:  "acpx",
		AgentName: "codex",
		Runner:    &fixedRunner{err: wantErr},
	}
	_, _, err := ex.Run(context.Background(), &Payload{
		AgentID: "a1", RunID: "r1",
		Context: []byte(`{"prompt":"hi"}`),
	}, "")
	if err != wantErr {
		t.Errorf("expected runner error; got %v", err)
	}
}

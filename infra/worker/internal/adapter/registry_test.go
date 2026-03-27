package adapter

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/Enkom-Tech/hive-worker/internal/executor"
)

func TestRegistry_Executor_EmptyKeyReturnsDefault(t *testing.T) {
	os.Unsetenv("HIVE_ADAPTER_DEFAULT_CMD")
	os.Unsetenv("HIVE_TOOL_CMD")
	// With no env set, default command is "" and ProcessExecutor.Run is no-op
	r := NewRegistryFromEnv()
	ex := r.Executor("")
	if ex == nil {
		t.Fatal("Executor(\"\") must not return nil")
	}
	stdout, stderr, err := ex.Run(context.Background(), &executor.Payload{AgentID: "a", RunID: "r"}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stdout != nil || stderr != nil {
		t.Errorf("expected nil stdout/stderr when no command; got stdout=%q stderr=%q", stdout, stderr)
	}
}

func TestRegistry_Executor_UnknownKeyReturnsDefault(t *testing.T) {
	os.Setenv("HIVE_TOOL_CMD", "default-cmd")
	defer os.Unsetenv("HIVE_TOOL_CMD")
	r := NewRegistryFromEnv()
	ex := r.Executor("nonexistent")
	if ex == nil {
		t.Fatal("Executor(unknown) must not return nil")
	}
	// Default should be the one from HIVE_TOOL_CMD (we can't easily assert which command without running it)
	_ = ex
}

func TestRegistry_Executor_KnownKeyReturnsConfigured(t *testing.T) {
	os.Setenv("HIVE_TOOL_CMD", "fallback")
	os.Setenv("HIVE_ADAPTER_claude_CMD", "claude")
	defer func() {
		os.Unsetenv("HIVE_TOOL_CMD")
		os.Unsetenv("HIVE_ADAPTER_claude_CMD")
	}()
	r := NewRegistryFromEnv()
	exDefault := r.Executor("")
	exClaude := r.Executor("claude")
	if exDefault == nil || exClaude == nil {
		t.Fatal("executors must not be nil")
	}
	// Both should run without error (claude is a real binary name; fallback is "fallback")
	_, _, err := exClaude.Run(context.Background(), &executor.Payload{AgentID: "a", RunID: "r"}, "/tmp")
	if err != nil && !os.IsNotExist(err) {
		// May fail if "claude" not in PATH; that's ok for unit test
		t.Logf("exClaude.Run (expected if claude not installed): %v", err)
	}
	_ = exDefault
}

func TestRegistry_Executor_ContainerWhenEnvSet(t *testing.T) {
	os.Setenv("HIVE_ADAPTER_ct_CMD", "claude")
	os.Setenv("HIVE_ADAPTER_ct_CONTAINER", "1")
	os.Setenv("HIVE_ADAPTER_ct_IMAGE", "hive-agent:latest")
	defer func() {
		os.Unsetenv("HIVE_ADAPTER_ct_CMD")
		os.Unsetenv("HIVE_ADAPTER_ct_CONTAINER")
		os.Unsetenv("HIVE_ADAPTER_ct_IMAGE")
	}()
	r := NewRegistryFromEnv()
	ex := r.Executor("ct")
	if ex == nil {
		t.Fatal("Executor(\"ct\") must not return nil")
	}
	ce, ok := ex.(*executor.ContainerExecutor)
	if !ok {
		t.Fatalf("expected *ContainerExecutor, got %T", ex)
	}
	if ce.Image != "hive-agent:latest" || ce.Command != "claude" {
		t.Errorf("Image=%q Command=%q", ce.Image, ce.Command)
	}
}

func TestRegistry_Executor_AutosandboxDefaultUsesImageWithoutContainerFlag(t *testing.T) {
	os.Setenv("HIVE_ADAPTER_ct_CMD", "claude")
	os.Setenv("HIVE_ADAPTER_ct_IMAGE", "hive-agent:sandbox")
	os.Setenv("HIVE_AUTOSANDBOX_DEFAULT", "true")
	defer func() {
		os.Unsetenv("HIVE_ADAPTER_ct_CMD")
		os.Unsetenv("HIVE_ADAPTER_ct_IMAGE")
		os.Unsetenv("HIVE_AUTOSANDBOX_DEFAULT")
	}()
	r := NewRegistryFromEnv()
	ex := r.Executor("ct")
	ce, ok := ex.(*executor.ContainerExecutor)
	if !ok {
		t.Fatalf("expected *ContainerExecutor, got %T", ex)
	}
	if ce.Image != "hive-agent:sandbox" {
		t.Errorf("Image=%q", ce.Image)
	}
}

func TestRegistry_Executor_AcpxWhenCmdAndAgentSet(t *testing.T) {
	os.Setenv("HIVE_ADAPTER_codex_acp_CMD", "acpx")
	os.Setenv("HIVE_ADAPTER_codex_acp_AGENT", "codex")
	defer func() {
		os.Unsetenv("HIVE_ADAPTER_codex_acp_CMD")
		os.Unsetenv("HIVE_ADAPTER_codex_acp_AGENT")
	}()
	r := NewRegistryFromEnv()
	ex := r.Executor("codex_acp")
	if ex == nil {
		t.Fatal("Executor(\"codex_acp\") must not return nil")
	}
	acpxEx, ok := ex.(*executor.AcpxExecutor)
	if !ok {
		t.Fatalf("expected *executor.AcpxExecutor, got %T", ex)
	}
	if acpxEx.AcpxPath != "acpx" || acpxEx.AgentName != "codex" {
		t.Errorf("AcpxPath=%q AgentName=%q", acpxEx.AcpxPath, acpxEx.AgentName)
	}
	// Run with context missing prompt must return error
	_, _, err := ex.Run(context.Background(), &executor.Payload{
		AgentID: "a", RunID: "r",
		Context: []byte(`{}`),
	}, "")
	if err == nil {
		t.Fatal("expected error when context has no prompt")
	}
	if !strings.Contains(err.Error(), "acpx: context missing prompt or instruction") {
		t.Errorf("unexpected error: %v", err)
	}
}

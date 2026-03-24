package executor

import (
	"context"
	"strings"
	"testing"
)

func TestContainerExecutor_NoOpWhenEmptyCommand(t *testing.T) {
	ex := &ContainerExecutor{Image: "img", Command: ""}
	stdout, stderr, err := ex.Run(context.Background(), &Payload{AgentID: "a", RunID: "r"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if stdout != nil || stderr != nil {
		t.Errorf("expected nil output")
	}
}

func TestContainerExecutor_NoOpWhenEmptyImage(t *testing.T) {
	ex := &ContainerExecutor{Image: "", Command: "claude"}
	stdout, stderr, err := ex.Run(context.Background(), &Payload{AgentID: "a", RunID: "r"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if stdout != nil || stderr != nil {
		t.Errorf("expected nil output")
	}
}

func TestContainerExecutor_InvokesRuntimeWithVolumeAndEnv(t *testing.T) {
	var name string
	var args []string
	ex := &ContainerExecutor{
		Image:   "hive-agent:latest",
		Command: "claude",
		Runtime: "docker",
		Runner: &argsCaptureRunner{name: &name, args: &args},
	}
	_, _, err := ex.Run(context.Background(), &Payload{
		AgentID: "agent1",
		RunID:   "run1",
		Context: []byte("ctx"),
	}, "/tmp/workspace")
	if err != nil {
		t.Fatal(err)
	}
	if name != "docker" {
		t.Errorf("runtime = %s", name)
	}
	argsStr := strings.Join(args, " ")
	if !strings.Contains(argsStr, "--rm") {
		t.Error("expected --rm in args")
	}
	if !strings.Contains(argsStr, "/workspace") {
		t.Error("expected /workspace in args")
	}
	if !strings.Contains(argsStr, "HIVE_AGENT_ID=agent1") {
		t.Error("expected HIVE_AGENT_ID in args")
	}
	if !strings.Contains(argsStr, "HIVE_RUN_ID=run1") {
		t.Error("expected HIVE_RUN_ID in args")
	}
	if !strings.Contains(argsStr, "HIVE_CONTEXT_JSON=") {
		t.Error("expected HIVE_CONTEXT_JSON in args")
	}
	if !strings.Contains(argsStr, "-w") {
		t.Error("expected -w in args")
	}
	if !strings.Contains(argsStr, "hive-agent:latest") {
		t.Error("expected image in args")
	}
	if !strings.Contains(argsStr, "claude") {
		t.Error("expected command in args")
	}
}

type argsCaptureRunner struct {
	name *string
	args *[]string
}

func (r *argsCaptureRunner) Run(_ context.Context, name string, args []string, _ string, _ []string) ([]byte, []byte, error) {
	*r.name = name
	*r.args = args
	return nil, nil, nil
}

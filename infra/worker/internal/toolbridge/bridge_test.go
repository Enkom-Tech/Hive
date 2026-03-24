package toolbridge

import "testing"

func TestActionAllowed(t *testing.T) {
	t.Setenv("HIVE_WORKER_TOOL_BRIDGE_ALLOWED_ACTIONS", "task.create,task.update")
	if !actionAllowed("task.create") {
		t.Fatal("expected allowlisted action")
	}
	if actionAllowed("hire.request") {
		t.Fatal("expected action to be blocked")
	}
}

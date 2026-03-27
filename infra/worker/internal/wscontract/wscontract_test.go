// Package wscontract tests document the worker WebSocket JSON shapes (DRONE-SPEC §10).
package wscontract

import (
	"encoding/json"
	"testing"
)

func TestGoldenRunMessage(t *testing.T) {
	msg := map[string]any{
		"type":       "run",
		"runId":      "550e8400-e29b-41d4-a716-446655440000",
		"agentId":    "agent-1",
		"context":    map[string]any{"hiveWorkspace": map[string]any{"cwd": "/tmp/ws"}},
		"adapterKey": "default",
		"modelId":    "gpt-4o",
	}
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"type", "runId", "agentId", "context"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("missing key %q", k)
		}
	}
}

func TestGoldenCancelMessage(t *testing.T) {
	msg := map[string]string{"type": "cancel", "runId": "r1"}
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]string
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out["type"] != "cancel" || out["runId"] != "r1" {
		t.Fatalf("%v", out)
	}
}

func TestGoldenAckRejected(t *testing.T) {
	msg := map[string]any{
		"type":    "ack",
		"runId":   "r1",
		"agentId": "a1",
		"status":  "rejected",
		"code":    "placement_mismatch",
	}
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out["code"] != "placement_mismatch" {
		t.Fatalf("%v", out)
	}
}

func TestGoldenStatusLog(t *testing.T) {
	st := map[string]any{
		"type":    "status",
		"runId":   "r1",
		"agentId": "a1",
		"status":  "running",
	}
	if _, err := json.Marshal(st); err != nil {
		t.Fatal(err)
	}
	lg := map[string]string{
		"type":    "log",
		"runId":   "r1",
		"agentId": "a1",
		"stream":  "stdout",
		"chunk":   "hi\n",
		"ts":      "2025-01-01T00:00:00Z",
	}
	if _, err := json.Marshal(lg); err != nil {
		t.Fatal(err)
	}
}

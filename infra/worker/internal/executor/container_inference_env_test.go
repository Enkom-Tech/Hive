package executor

import (
	"testing"
)

func TestAppendContainerInferenceEnv(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		t.Setenv("HIVE_MODEL_GATEWAY_URL", "")
		t.Setenv("OPENAI_API_KEY", "")
		t.Setenv("OPENAI_BASE_URL", "")
		t.Setenv("ANTHROPIC_API_KEY", "")
		got := appendContainerInferenceEnv([]string{"docker", "run"})
		if len(got) != 2 {
			t.Fatalf("expected only base args, got %v", got)
		}
	})

	t.Run("gateway sets openai base url when missing", func(t *testing.T) {
		t.Setenv("HIVE_MODEL_GATEWAY_URL", "http://bifrost:8080/v1")
		t.Setenv("OPENAI_BASE_URL", "")
		t.Setenv("OPENAI_API_KEY", "sk-bf-test")
		t.Setenv("ANTHROPIC_API_KEY", "")
		got := appendContainerInferenceEnv([]string{"docker", "run"})
		wantTail := []string{
			"-e", "HIVE_MODEL_GATEWAY_URL=http://bifrost:8080/v1",
			"-e", "OPENAI_BASE_URL=http://bifrost:8080/v1",
			"-e", "OPENAI_API_KEY=sk-bf-test",
		}
		if len(got) < len(wantTail)+2 {
			t.Fatalf("got %v", got)
		}
		tail := got[len(got)-len(wantTail):]
		for i := range wantTail {
			if tail[i] != wantTail[i] {
				t.Fatalf("got tail %v want %v", tail, wantTail)
			}
		}
	})

	t.Run("explicit openai base url preserved", func(t *testing.T) {
		t.Setenv("HIVE_MODEL_GATEWAY_URL", "http://a/v1")
		t.Setenv("OPENAI_BASE_URL", "http://b/v1")
		t.Setenv("OPENAI_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "")
		got := appendContainerInferenceEnv(nil)
		found := false
		for i := 0; i+1 < len(got); i += 2 {
			if got[i] == "-e" && got[i+1] == "OPENAI_BASE_URL=http://b/v1" {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected OPENAI_BASE_URL=http://b/v1 in %v", got)
		}
	})
}

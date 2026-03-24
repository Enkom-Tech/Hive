package runstore

import (
	"sync"
	"testing"
)

func TestStore_RegisterUnregister(t *testing.T) {
	s := New()
	cancelCalled := false
	cancel := func() { cancelCalled = true }
	s.Register("run-1", "", cancel)
	s.Unregister("run-1")
	if cancelCalled {
		t.Error("Unregister should not call cancel")
	}
	s.Unregister("run-1") // idempotent
}

func TestStore_Cancel(t *testing.T) {
	s := New()
	cancelCalled := false
	cancel := func() { cancelCalled = true }
	s.Register("run-1", "", cancel)
	ok := s.Cancel("run-1")
	if !ok {
		t.Error("Cancel should return true when run exists")
	}
	if !cancelCalled {
		t.Error("Cancel should have invoked cancel function")
	}
	// Second Cancel returns false (already removed)
	ok2 := s.Cancel("run-1")
	if ok2 {
		t.Error("Cancel should return false for unknown run")
	}
}

func TestStore_CancelUnknown(t *testing.T) {
	s := New()
	ok := s.Cancel("nonexistent")
	if ok {
		t.Error("Cancel should return false for unknown runId")
	}
}

func TestStore_ActiveCount(t *testing.T) {
	s := New()
	if n := s.ActiveCount(); n != 0 {
		t.Errorf("ActiveCount() = %d, want 0", n)
	}
	s.Register("r1", "", func() {})
	if n := s.ActiveCount(); n != 1 {
		t.Errorf("ActiveCount() = %d, want 1", n)
	}
	s.Register("r2", "", func() {})
	if n := s.ActiveCount(); n != 2 {
		t.Errorf("ActiveCount() = %d, want 2", n)
	}
	s.Unregister("r1")
	if n := s.ActiveCount(); n != 1 {
		t.Errorf("ActiveCount() = %d, want 1", n)
	}
}

func TestStore_ActiveAgentCount(t *testing.T) {
	s := New()
	if n := s.ActiveAgentCount(); n != 0 {
		t.Errorf("ActiveAgentCount() = %d, want 0", n)
	}
	s.Register("r1", "agent-x", func() {})
	if n := s.ActiveAgentCount(); n != 1 {
		t.Errorf("ActiveAgentCount() = %d, want 1", n)
	}
	s.Register("r2", "agent-x", func() {})
	if n := s.ActiveAgentCount(); n != 1 {
		t.Errorf("ActiveAgentCount() = %d, want 1 (same agent)", n)
	}
	s.Register("r3", "agent-y", func() {})
	if n := s.ActiveAgentCount(); n != 2 {
		t.Errorf("ActiveAgentCount() = %d, want 2", n)
	}
}

func TestStore_Concurrent(t *testing.T) {
	s := New()
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		runID := string(rune('a' + i))
		s.Register(runID, "", func() {})
	}
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			runID := string(rune('a' + i))
			s.Cancel(runID)
		}(i)
	}
	wg.Wait()
}

// Package runstore tracks in-flight runs by runId and allows cancelling them.
package runstore

import (
	"strings"
	"sync"
)

type runEntry struct {
	agentID string
	cancel  func()
}

// Store holds runId -> cancel function for in-flight runs. Safe for concurrent use.
type Store struct {
	mu      sync.Mutex
	cancels map[string]runEntry
}

// New returns a new run store.
func New() *Store {
	return &Store{cancels: make(map[string]runEntry)}
}

// Register adds a run and its cancel function. If runId is already registered, Register panics (caller must ensure uniqueness).
// agentID is the board agent id for this run (used for stats); may be empty.
func (s *Store) Register(runID, agentID string, cancel func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.cancels[runID]; exists {
		panic("runstore: duplicate runId " + runID)
	}
	s.cancels[runID] = runEntry{
		agentID: strings.TrimSpace(agentID),
		cancel:  cancel,
	}
}

// Unregister removes a run. Call when the run finishes (e.g. in a defer). Idempotent.
func (s *Store) Unregister(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cancels, runID)
}

// ActiveCount returns the number of in-flight runs.
func (s *Store) ActiveCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.cancels)
}

// ActiveAgentCount returns how many distinct board agent ids have at least one in-flight run.
func (s *Store) ActiveAgentCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := make(map[string]struct{})
	for _, e := range s.cancels {
		if e.agentID == "" {
			continue
		}
		key := strings.ToLower(e.agentID)
		seen[key] = struct{}{}
	}
	return len(seen)
}

// Cancel cancels the run if it is registered. It calls the cancel function and unregisters the run.
// Returns true if the run was found and cancelled, false if unknown or already finished.
func (s *Store) Cancel(runID string) bool {
	s.mu.Lock()
	entry, ok := s.cancels[runID]
	if ok {
		delete(s.cancels, runID)
	}
	s.mu.Unlock()
	if ok && entry.cancel != nil {
		entry.cancel()
		return true
	}
	return false
}

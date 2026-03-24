// Mock control plane HTTP server for E2E tests. Implements the subset of
// Hive API used by the Hive operator: GET/POST agents, POST keys, PATCH agent, pause/resume, health.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
)

// requestLogEntry is one recorded request for test assertions.
type requestLogEntry struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   []byte `json:"body,omitempty"`
}

type requestLog struct {
	mu      sync.Mutex
	entries []requestLogEntry
}

func (rl *requestLog) append(method, path string, body []byte) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.entries = append(rl.entries, requestLogEntry{Method: method, Path: path, Body: body})
}

func (rl *requestLog) get() []requestLogEntry {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	out := make([]requestLogEntry, len(rl.entries))
	copy(out, rl.entries)
	return out
}

func (rl *requestLog) clear() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.entries = nil
}

func main() {
	mux := http.NewServeMux()
	store := &store{agents: make(map[string][]agent), keys: make(map[string]string)}
	var nextID int64
	reqLog := &requestLog{}

	// Middleware: read body once, log request, replace body for handlers.
	wrap := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var body []byte
			if r.Body != nil {
				var err error
				body, err = io.ReadAll(r.Body)
				if err != nil {
					http.Error(w, "failed to read body", http.StatusBadRequest)
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(body))
			}
			reqLog.append(r.Method, r.URL.Path, body)
			h(w, r)
		}
	}

	mux.HandleFunc("/test/requests", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(reqLog.get())
			return
		}
		if r.Method == http.MethodDelete {
			reqLog.clear()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	})

	mux.HandleFunc("/api/health", wrap(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	mux.HandleFunc("/api/companies/", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "" || len(r.URL.Path) < 20 {
			http.NotFound(w, r)
			return
		}
		path := r.URL.Path[len("/api/companies/"):]
		var companyID string
		for i, c := range path {
			if c == '/' {
				companyID = path[:i]
				break
			}
		}
		if companyID == "" {
			http.NotFound(w, r)
			return
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		if r.Method == http.MethodGet {
			list := store.agents[companyID]
			if list == nil {
				list = []agent{}
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(list)
			return
		}
		if r.Method == http.MethodPost {
			var req struct {
				Name         string `json:"name"`
				AdapterType  string `json:"adapterType"`
				AdapterConfig map[string]interface{} `json:"adapterConfig"`
				Metadata    map[string]string `json:"metadata"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			id := fmt.Sprintf("agent-%d", atomic.AddInt64(&nextID, 1))
			a := agent{
				ID:            id,
				CompanyID:     companyID,
				Name:          req.Name,
				AdapterType:   req.AdapterType,
				AdapterConfig: req.AdapterConfig,
				Metadata:      req.Metadata,
			}
			store.agents[companyID] = append(store.agents[companyID], a)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(a)
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	}))
	mux.HandleFunc("/api/agents/", wrap(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path[len("/api/agents/"):]
		var agentID string
		for i, c := range path {
			if c == '/' {
				agentID = path[:i]
				break
			}
		}
		if agentID == "" {
			agentID = path
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		if len(path) > len(agentID) && path[len(agentID):] == "/keys" && r.Method == http.MethodPost {
			key := "key-" + agentID
			store.keys[agentID] = key
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"id": "key-1", "key": key})
			return
		}
		if path == agentID && r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			return
		}
		if len(path) > len(agentID) && (path[len(agentID):] == "/pause" || path[len(agentID):] == "/resume") && r.Method == http.MethodPost {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))

	log.Println("mock control plane listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

type store struct {
	mu     sync.Mutex
	agents map[string][]agent
	keys   map[string]string
}

type agent struct {
	ID           string                 `json:"id"`
	CompanyID    string                 `json:"companyId"`
	Name         string                 `json:"name"`
	AdapterType  string                 `json:"adapterType"`
	AdapterConfig map[string]interface{} `json:"adapterConfig,omitempty"`
	Metadata     map[string]string      `json:"metadata,omitempty"`
}

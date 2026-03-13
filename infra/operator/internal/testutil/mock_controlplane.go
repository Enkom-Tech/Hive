// Package testutil provides shared test fixtures and a configurable mock control plane.
package testutil

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

// Request is one recorded HTTP request for test assertions.
type Request struct {
	Method string
	Path   string
	Body   []byte
}

// MockControlPlane is an in-process HTTP server implementing the control plane API
// subset used by the operator (agents, keys, pause/resume, health). Each instance
// has its own state and request log for per-test isolation.
type MockControlPlane struct {
	mu        sync.Mutex
	agents    map[string][]map[string]interface{}
	keys      map[string]string
	nextID    int
	reqLog    []Request
	srv       *http.Server
	listener  net.Listener
	baseURL   string
}

// NewMockControlPlane returns a fresh mock control plane (new server, empty request log and store).
func NewMockControlPlane() *MockControlPlane {
	return &MockControlPlane{
		agents: make(map[string][]map[string]interface{}),
		keys:   make(map[string]string),
		nextID: 1,
		reqLog: nil,
	}
}

// Start listens on 127.0.0.1:0, starts the HTTP server in the background, and returns the base URL.
func (m *MockControlPlane) Start() (baseURL string, err error) {
	m.listener, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	m.baseURL = "http://" + m.listener.Addr().String()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", m.wrap(m.handleHealth))
	mux.HandleFunc("/api/companies/", m.wrap(m.handleCompanies))
	mux.HandleFunc("/api/agents/", m.wrap(m.handleAgents))
	m.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	go func() { _ = m.srv.Serve(m.listener) }()
	return m.baseURL, nil
}

// Close shuts down the server. Safe to call multiple times.
func (m *MockControlPlane) Close() error {
	if m.srv == nil {
		return nil
	}
	err := m.srv.Close()
	m.srv = nil
	m.listener = nil
	return err
}

// BaseURL returns the base URL (e.g. http://127.0.0.1:12345). Only valid after Start().
func (m *MockControlPlane) BaseURL() string {
	return m.baseURL
}

// Requests returns a copy of the request log.
func (m *MockControlPlane) Requests() []Request {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Request, len(m.reqLog))
	copy(out, m.reqLog)
	return out
}

// ClearRequests clears the request log.
func (m *MockControlPlane) ClearRequests() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reqLog = nil
}

func (m *MockControlPlane) wrap(h func(http.ResponseWriter, *http.Request, []byte)) http.HandlerFunc {
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
		m.mu.Lock()
		m.reqLog = append(m.reqLog, Request{Method: r.Method, Path: r.URL.Path, Body: body})
		m.mu.Unlock()
		h(w, r, body)
	}
}

func (m *MockControlPlane) handleHealth(w http.ResponseWriter, _ *http.Request, _ []byte) {
	w.WriteHeader(http.StatusOK)
}

func (m *MockControlPlane) handleCompanies(w http.ResponseWriter, r *http.Request, body []byte) {
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

	m.mu.Lock()
	defer m.mu.Unlock()

	switch r.Method {
	case http.MethodGet:
		list := m.agents[companyID]
		if list == nil {
			list = []map[string]interface{}{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
	case http.MethodPost:
		var req struct {
			Name          string                 `json:"name"`
			AdapterType   string                 `json:"adapterType"`
			AdapterConfig map[string]interface{} `json:"adapterConfig"`
			Metadata      map[string]string     `json:"metadata"`
		}
		if err := json.NewDecoder(bytes.NewReader(body)).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		agentID := fmt.Sprintf("agent-%d", m.nextID)
		m.nextID++
		agent := map[string]interface{}{
			"id":            agentID,
			"companyId":     companyID,
			"name":          req.Name,
			"adapterType":   req.AdapterType,
			"adapterConfig": req.AdapterConfig,
			"metadata":     req.Metadata,
		}
		if m.agents[companyID] == nil {
			m.agents[companyID] = []map[string]interface{}{}
		}
		m.agents[companyID] = append(m.agents[companyID], agent)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(agent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (m *MockControlPlane) handleAgents(w http.ResponseWriter, r *http.Request, _ []byte) {
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

	m.mu.Lock()
	defer m.mu.Unlock()

	switch {
	case len(path) > len(agentID) && path[len(agentID):] == "/keys" && r.Method == http.MethodPost:
		key := "key-" + agentID
		m.keys[agentID] = key
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "key-1", "key": key})
	case path == agentID && r.Method == http.MethodPatch:
		w.WriteHeader(http.StatusOK)
	case len(path) > len(agentID) && (path[len(agentID):] == "/pause" || path[len(agentID):] == "/resume") && r.Method == http.MethodPost:
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

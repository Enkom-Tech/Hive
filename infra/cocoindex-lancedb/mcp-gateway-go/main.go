// Command mcp-gateway is a stdlib replacement for mcp_gateway.py (worker token → indexer admin).
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

//go:embed blocklist.json
var embeddedBlocklist []byte

type gatewayBlocklistFile struct {
	Cocoindex []string `json:"cocoindex"`
	Docindex  []string `json:"docindex"`
}

var blockedCocoTools map[string]struct{}
var blockedDocTools map[string]struct{}

func init() {
	var f gatewayBlocklistFile
	if err := json.Unmarshal(embeddedBlocklist, &f); err != nil {
		panic("mcp-gateway: blocklist.json: " + err.Error())
	}
	blockedCocoTools = toolNameSet(f.Cocoindex)
	blockedDocTools = toolNameSet(f.Docindex)
}

func toolNameSet(names []string) map[string]struct{} {
	m := make(map[string]struct{}, len(names))
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n != "" {
			m[n] = struct{}{}
		}
	}
	return m
}

// docIndexGatewayMode mirrors mcp_gateway.py GATEWAY_DOCINDEX_MODE for HiveDocIndexer (block document indexing tools).
func docIndexGatewayMode() bool {
	m := strings.TrimSpace(strings.ToLower(os.Getenv("GATEWAY_DOCINDEX_MODE")))
	return m == "1" || m == "true" || m == "yes"
}

func toolIsBlocked(name string) bool {
	if docIndexGatewayMode() {
		_, ok := blockedDocTools[name]
		return ok
	}
	_, ok := blockedCocoTools[name]
	return ok
}

func env(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func workerToken() string { return os.Getenv("GATEWAY_WORKER_TOKEN") }
func adminToken() string  { return os.Getenv("GATEWAY_ADMIN_TOKEN") }
func indexerURL() string {
	u := strings.TrimRight(env("GATEWAY_INDEXER_URL", "http://localhost:8080"), "/")
	return u
}

func requireWorker(w http.ResponseWriter, r *http.Request) bool {
	tok := workerToken()
	if tok == "" {
		http.Error(w, `{"detail":"Gateway worker token not configured"}`, http.StatusInternalServerError)
		return false
	}
	const pfx = "bearer "
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(h) < len(pfx)+1 || strings.ToLower(h[:len(pfx)]) != pfx {
		http.Error(w, `{"detail":"Unauthorized"}`, http.StatusUnauthorized)
		return false
	}
	got := strings.TrimSpace(h[len(pfx):])
	if len(got) != len(tok) || subtle.ConstantTimeCompare([]byte(got), []byte(tok)) != 1 {
		http.Error(w, `{"detail":"Unauthorized"}`, http.StatusUnauthorized)
		return false
	}
	return true
}

func forwardIndexer(ctx context.Context, body []byte) ([]byte, int, error) {
	at := adminToken()
	if at == "" {
		return nil, 0, fmt.Errorf("admin token not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, indexerURL()+"/mcp/message", bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+at)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	return out, resp.StatusCode, err
}

func handleMCPMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !requireWorker(w, r) {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}

	var msg map[string]json.RawMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		http.Error(w, `{"detail":"Invalid JSON"}`, http.StatusBadRequest)
		return
	}

	var reqID any
	_ = json.Unmarshal(msg["id"], &reqID)

	method := ""
	if m, ok := msg["method"]; ok {
		_ = json.Unmarshal(m, &method)
	}

	if method == "initialize" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      reqID,
			"result": map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo": map[string]any{
					"name":    "hive-mcp-gateway",
					"version": "1.0.0",
				},
			},
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	if method == "tools/list" {
		t0 := time.Now()
		out, code, err := forwardIndexer(ctx, body)
		log.Printf("mcp-gateway: tools/list duration_ms=%d indexer_status=%d err=%v", time.Since(t0).Milliseconds(), code, err)
		if err != nil || code != http.StatusOK {
			log.Printf("mcp-gateway: indexer tools/list: %v status=%d", err, code)
			writeJSONRPCError(w, reqID, -32603, "Indexer request failed")
			return
		}
		var resp map[string]any
		if err := json.Unmarshal(out, &resp); err != nil {
			writeJSONRPCError(w, reqID, -32603, "Bad indexer response")
			return
		}
		if result, ok := resp["result"].(map[string]any); ok {
			if tools, ok := result["tools"].([]any); ok {
				filtered := make([]any, 0, len(tools))
				for _, t := range tools {
					tm, ok := t.(map[string]any)
					if !ok {
						continue
					}
					name, _ := tm["name"].(string)
					if toolIsBlocked(name) {
						continue
					}
					filtered = append(filtered, t)
				}
				result["tools"] = filtered
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
		return
	}

	if method == "tools/call" {
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if p, ok := msg["params"]; ok {
			_ = json.Unmarshal(p, &params)
		}
		if toolIsBlocked(params.Name) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      reqID,
				"error": map[string]any{
					"code":    -32602,
					"message": fmt.Sprintf("Tool '%s' is not available", params.Name),
				},
			})
			return
		}
		log.Printf("mcp-gateway: tools/call name=%s", params.Name)
	}

	t0 := time.Now()
	out, code, err := forwardIndexer(ctx, body)
	log.Printf("mcp-gateway: method=%s duration_ms=%d indexer_status=%d err=%v", method, time.Since(t0).Milliseconds(), code, err)
	if err != nil {
		log.Printf("mcp-gateway: forward: %v", err)
		writeJSONRPCError(w, reqID, -32603, "Internal gateway error")
		return
	}
	if code != http.StatusOK {
		writeJSONRPCError(w, reqID, -32603, "Indexer request failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

func writeJSONRPCError(w http.ResponseWriter, id any, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
}

func handleMCPSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !requireWorker(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	_, _ = fmt.Fprintf(w, "event: endpoint\ndata: /mcp/message\n\n")
	fl.Flush()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			_, _ = fmt.Fprintf(w, "event: ping\ndata: \n\n")
			fl.Flush()
		}
	}
}

func main() {
	addr := env("LISTEN_ADDR", ":9090")
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"healthy"}`))
	})
	mux.HandleFunc("/mcp", handleMCPSSE)
	mux.HandleFunc("/mcp/message", handleMCPMessage)

	log.Printf("mcp-gateway listening on %s indexer=%s docindex_mode=%v", addr, indexerURL(), docIndexGatewayMode())
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

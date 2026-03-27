package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// ServeConfig wires the MCP stdio server to the control plane, optional wasm skills,
// and optional indexer HTTP MCP gateways (worker-tier tokens; never exposed to agent env).
type ServeConfig struct {
	CP          *CPClient
	Wasm        []WasmSkill
	CodeIndexer *IndexerGatewayConfig
	DocsIndexer *IndexerGatewayConfig
	// MaxConcurrent in-flight JSON-RPC handlers (tools/call, initialize, etc.). Default 1 (sequential).
	// When >1, responses may arrive out of order; each line is still one JSON object with matching id.
	MaxConcurrent int
}

type mcpTool struct {
	Name        string
	Description string
	InputSchema json.RawMessage
	Call        func(ctx context.Context, args json.RawMessage) (any, error)
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponseOK struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
}

type rpcResponseErr struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Error   rpcErrorObj     `json:"error"`
}

type rpcErrorObj struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func nullishID(id json.RawMessage) bool {
	if len(id) == 0 {
		return true
	}
	s := strings.TrimSpace(string(id))
	return s == "" || s == "null"
}

func cloneRPCRequest(req rpcRequest) rpcRequest {
	out := rpcRequest{JSONRPC: req.JSONRPC, Method: req.Method}
	if len(req.ID) > 0 {
		out.ID = append(json.RawMessage(nil), req.ID...)
	}
	if len(req.Params) > 0 {
		out.Params = append(json.RawMessage(nil), req.Params...)
	}
	return out
}

// ServeMCP runs a JSON-RPC MCP-style loop on stdin/stdout (one JSON object per line).
func ServeMCP(ctx context.Context, stdin io.Reader, stdout io.Writer, cfg ServeConfig) error {
	if cfg.CP == nil || strings.TrimSpace(cfg.CP.JWT) == "" {
		return fmt.Errorf("ServeMCP: CP client and JWT required")
	}
	if strings.TrimSpace(cfg.CP.AgentID) == "" {
		return fmt.Errorf("ServeMCP: HIVE_AGENT_ID is required for worker-api calls")
	}

	conc := cfg.MaxConcurrent
	if conc < 1 {
		conc = 1
	}
	if conc > 64 {
		conc = 64
	}
	var wasmMu *sync.Mutex
	if conc > 1 && len(cfg.Wasm) > 0 {
		var m sync.Mutex
		wasmMu = &m
	}
	toolList := buildToolTable(cfg, wasmMu)
	sem := make(chan struct{}, conc)

	var writeMu sync.Mutex
	writeLine := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = stdout.Write(append(b, '\n'))
		return err
	}

	var wg sync.WaitGroup
	runOne := func(req rpcRequest) {
		defer wg.Done()
		defer func() { <-sem }()

		toolLabel := ""
		if req.Method == "tools/call" && len(req.Params) > 0 {
			var p struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(req.Params, &p)
			toolLabel = strings.TrimSpace(p.Name)
		}

		handle := func() (any, error) {
			switch req.Method {
			case "initialize":
				return map[string]any{
					"protocolVersion": "2024-11-05",
					"capabilities": map[string]any{
						"tools": map[string]any{},
					},
					"serverInfo": map[string]any{
						"name":    "hive-worker",
						"version": "1.0.0",
					},
				}, nil
			case "notifications/initialized":
				return nil, nil
			case "tools/list":
				list := make([]map[string]any, 0, len(toolList))
				for _, t := range toolList {
					var schema any
					if len(t.InputSchema) > 0 {
						_ = json.Unmarshal(t.InputSchema, &schema)
					}
					if schema == nil {
						schema = map[string]any{"type": "object"}
					}
					list = append(list, map[string]any{
						"name":        t.Name,
						"description": t.Description,
						"inputSchema": schema,
					})
				}
				return map[string]any{"tools": list}, nil
			case "tools/call":
				var p struct {
					Name      string          `json:"name"`
					Arguments json.RawMessage `json:"arguments"`
				}
				if len(req.Params) > 0 {
					_ = json.Unmarshal(req.Params, &p)
				}
				name := strings.TrimSpace(p.Name)
				if name == "" {
					return nil, fmt.Errorf("tools/call missing name")
				}
				args := p.Arguments
				if len(args) == 0 || string(args) == "null" {
					args = json.RawMessage(`{}`)
				}
				for _, t := range toolList {
					if t.Name == name {
						return t.Call(ctx, args)
					}
				}
				return nil, fmt.Errorf("unknown tool %q", name)
			default:
				return nil, fmt.Errorf("method not found: %s", req.Method)
			}
		}

		start := time.Now()
		res, err := handle()
		dur := time.Since(start)
		agentID := strings.TrimSpace(cfg.CP.AgentID)
		if toolLabel != "" {
			log.Printf("hive-mcp: agent=%s method=%s tool=%s duration_ms=%d err=%v", agentID, req.Method, toolLabel, dur.Milliseconds(), err)
		} else {
			log.Printf("hive-mcp: agent=%s method=%s duration_ms=%d err=%v", agentID, req.Method, dur.Milliseconds(), err)
		}

		if err != nil && (req.Method == "notifications/initialized" || nullishID(req.ID)) {
			return
		}
		if err != nil {
			if werr := writeLine(rpcResponseErr{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error: rpcErrorObj{
					Code:    -32000,
					Message: err.Error(),
				},
			}); werr != nil {
				log.Printf("hive-mcp: stdout write error: %v", werr)
			}
			return
		}
		if req.Method == "notifications/initialized" || nullishID(req.ID) {
			return
		}

		var mcpResult any
		if req.Method == "tools/call" {
			text, _ := json.Marshal(res)
			mcpResult = map[string]any{
				"content": []map[string]any{
					{"type": "text", "text": string(text)},
				},
			}
		} else {
			mcpResult = res
		}

		if werr := writeLine(rpcResponseOK{JSONRPC: "2.0", ID: req.ID, Result: mcpResult}); werr != nil {
			log.Printf("hive-mcp: stdout write error: %v", werr)
		}
	}

	sc := bufio.NewScanner(stdin)
	buf := make([]byte, 0, 64*1024)
	sc.Buffer(buf, 4<<20)

	for sc.Scan() {
		select {
		case <-ctx.Done():
			wg.Wait()
			return ctx.Err()
		default:
		}
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = writeLine(rpcResponseErr{
				JSONRPC: "2.0",
				Error: rpcErrorObj{
					Code:    -32700,
					Message: "parse error",
				},
			})
			continue
		}
		if req.JSONRPC != "2.0" {
			if !nullishID(req.ID) {
				_ = writeLine(rpcResponseErr{
					JSONRPC: "2.0",
					ID:      req.ID,
					Error:   rpcErrorObj{Code: -32600, Message: "invalid request"},
				})
			}
			continue
		}

		reqC := cloneRPCRequest(req)
		select {
		case <-ctx.Done():
			wg.Wait()
			return ctx.Err()
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go runOne(reqC)
	}
	wg.Wait()
	return sc.Err()
}

func buildToolTable(cfg ServeConfig, wasmMu *sync.Mutex) []mcpTool {
	cp := cfg.CP
	out := []mcpTool{
		{
			Name:        "cost.report",
			Description: "Report a cost event for the current agent (worker-authenticated).",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"provider":{"type":"string"},"model":{"type":"string"},"costCents":{"type":"integer"},"inputTokens":{"type":"integer"},"outputTokens":{"type":"integer"},"occurredAt":{"type":"string"}},"required":["provider","model","costCents"]}`),
			Call:        cp.costReport,
		},
		{
			Name:        "issue.appendComment",
			Description: "Append a comment to an issue (by UUID or identifier).",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"issueId":{"type":"string"},"body":{"type":"string"}},"required":["issueId","body"]}`),
			Call:        cp.issueAppendComment,
		},
		{
			Name:        "issue.transitionStatus",
			Description: "Transition issue status (assignee must be the current agent).",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"issueId":{"type":"string"},"status":{"type":"string"}},"required":["issueId","status"]}`),
			Call:        cp.issueTransition,
		},
		{
			Name:        "issue.get",
			Description: "Fetch issue summary fields.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"issueId":{"type":"string"}},"required":["issueId"]}`),
			Call:        cp.issueGet,
		},
		{
			Name:        "issue.create",
			Description: "Create an issue (same fields as board create; agentId injected by worker).",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"status":{"type":"string"},"priority":{"type":"string"},"projectId":{"type":"string"},"goalId":{"type":"string"},"departmentId":{"type":"string"},"parentId":{"type":"string"},"assigneeAgentId":{"type":"string"},"assigneeUserId":{"type":"string"},"labelIds":{"type":"array","items":{"type":"string"}},"idempotencyKey":{"type":"string","description":"Optional; sent as X-Hive-Worker-Idempotency-Key for POST /worker-api/issues replay"}},"required":["title"]}`),
			Call:        cp.issueCreate,
		},
		{
			Name:        "issue.update",
			Description: "Patch issue fields (no status—use issue.transitionStatus; no inline comment—use issue.appendComment).",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"issueId":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},"priority":{"type":"string"},"projectId":{"type":"string"},"goalId":{"type":"string"},"departmentId":{"type":"string"},"parentId":{"type":"string"},"assigneeAgentId":{"type":"string"},"assigneeUserId":{"type":"string"},"labelIds":{"type":"array","items":{"type":"string"}}},"required":["issueId"]}`),
			Call:        cp.issueUpdate,
		},
		{
			Name:        "agent.requestHire",
			Description: "Request a new agent (hire); respects company approval policy and agents:create permission.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"name":{"type":"string"},"role":{"type":"string"},"adapterType":{"type":"string"},"sourceIssueIds":{"type":"array","items":{"type":"string"}}},"required":["name"]}`),
			Call:        cp.agentRequestHire,
		},
	}
	if g := cfg.CodeIndexer; g != nil {
		out = append(out,
			mcpTool{
				Name:        "code.search",
				Description: "Semantic search over indexed source code (proxied to code indexer MCP gateway).",
				InputSchema: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"},"repo":{"type":"string"},"language":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["query"]}`),
				Call:        makeIndexerForwarder(g, "search_code"),
			},
			mcpTool{
				Name:        "code.indexStats",
				Description: "Return code index statistics (chunk count, table name).",
				InputSchema: json.RawMessage(`{"type":"object","properties":{}}`),
				Call:        makeIndexerForwarder(g, "get_index_stats"),
			},
		)
	}
	if g := cfg.DocsIndexer; g != nil {
		out = append(out,
			mcpTool{
				Name:        "documents.search",
				Description: "Semantic search over indexed documents (proxied to document indexer MCP gateway).",
				InputSchema: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"},"source_id":{"type":"string"},"acl_scope":{"type":"string"},"mime":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["query"]}`),
				Call:        makeIndexerForwarder(g, "search_documents"),
			},
			mcpTool{
				Name:        "documents.indexStats",
				Description: "Return document index statistics.",
				InputSchema: json.RawMessage(`{"type":"object","properties":{}}`),
				Call:        makeIndexerForwarder(g, "get_index_stats"),
			},
		)
	}
	for _, w := range cfg.Wasm {
		w := w
		meta := w
		schema := meta.InputSchema
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object"}`)
		}
		out = append(out, mcpTool{
			Name:        meta.Name,
			Description: meta.Description,
			InputSchema: schema,
			Call: func(ctx context.Context, args json.RawMessage) (any, error) {
				if wasmMu != nil {
					wasmMu.Lock()
					defer wasmMu.Unlock()
				}
				b, err := RunWasmSkill(ctx, meta.WasmPath, args)
				if err != nil {
					return nil, err
				}
				var parsed any
				if err := json.Unmarshal(b, &parsed); err != nil {
					return map[string]any{"raw": string(b)}, nil
				}
				return parsed, nil
			},
		})
	}
	return out
}

// RunMCPStdio is a convenience wrapper using os.Stdin / os.Stdout.
func RunMCPStdio(ctx context.Context, cfg ServeConfig) error {
	return ServeMCP(ctx, os.Stdin, os.Stdout, cfg)
}

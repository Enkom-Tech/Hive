package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Enkom-Tech/hive-worker/internal/handler"
)

// IndexerGatewayConfig holds the worker-tier HTTP MCP gateway URL (includes /mcp path) and token.
// Set from HIVE_MCP_CODE_* / HIVE_MCP_DOCS_* or legacy HIVE_MCP_* (code indexer only).
type IndexerGatewayConfig struct {
	BaseURL     string
	Token       string
	HTTP        *http.Client
	GatewayName string // "code" or "docs" — for metrics and circuit breaker labels
	Breaker     *IndexerCircuitBreaker
}

type rpcErrPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// IndexerCircuitBreaker opens after consecutive failures to fail fast (see HIVE_MCP_INDEXER_CB_*).
type IndexerCircuitBreaker struct {
	mu           sync.Mutex
	gateway      string
	threshold    int
	openDuration time.Duration
	consecutive  int
	openUntil    time.Time
}

// NewIndexerCircuitBreaker returns nil when circuit breaking is disabled (HIVE_MCP_INDEXER_CB_FAILURES <= 0).
func NewIndexerCircuitBreaker(gateway string) *IndexerCircuitBreaker {
	th := parseIntEnv("HIVE_MCP_INDEXER_CB_FAILURES", 5)
	if th <= 0 {
		return nil
	}
	openMs := parseIntEnv("HIVE_MCP_INDEXER_CB_OPEN_MS", 30000)
	if openMs <= 0 {
		openMs = 30000
	}
	return &IndexerCircuitBreaker{
		gateway:      gateway,
		threshold:    th,
		openDuration: time.Duration(openMs) * time.Millisecond,
	}
}

func parseIntEnv(key string, defaultVal int) int {
	s := strings.TrimSpace(os.Getenv(key))
	if s == "" {
		return defaultVal
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return defaultVal
	}
	return v
}

func (b *IndexerCircuitBreaker) before() error {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	if now.Before(b.openUntil) {
		return fmt.Errorf("indexer gateway circuit open for %s (cooldown)", b.gateway)
	}
	return nil
}

func (b *IndexerCircuitBreaker) recordSuccess() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.consecutive = 0
	if !time.Now().Before(b.openUntil) {
		handler.SetIndexerCircuitOpen(b.gateway, false)
	}
}

func (b *IndexerCircuitBreaker) recordFailure() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.consecutive++
	if b.consecutive >= b.threshold {
		b.openUntil = time.Now().Add(b.openDuration)
		b.consecutive = 0
		handler.SetIndexerCircuitOpen(b.gateway, true)
		log.Printf("hive-mcp indexer: circuit open gateway=%s for %s", b.gateway, b.openDuration)
	}
}

func indexerFailureForBreaker(err error, httpStatus int, rpcErr *rpcErrPayload) bool {
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return false
		}
		return true
	}
	if httpStatus >= 400 {
		return true
	}
	if rpcErr != nil {
		return true
	}
	return false
}

var indexerRPCID int64
var indexerRPCMu sync.Mutex

func nextIndexerRPCID() int64 {
	indexerRPCMu.Lock()
	defer indexerRPCMu.Unlock()
	indexerRPCID++
	return indexerRPCID
}

func (g *IndexerGatewayConfig) httpClient() *http.Client {
	if g.HTTP != nil {
		return g.HTTP
	}
	return http.DefaultClient
}

// messageEndpoint returns POST URL for JSON-RPC (BaseURL is .../mcp).
func messageEndpoint(baseURL string) string {
	b := strings.TrimSuffix(strings.TrimSpace(baseURL), "/")
	return b + "/message"
}

// CallIndexerTool posts tools/call to the gateway and returns the parsed MCP tool result payload
// (the JSON object inside result, typically including "content" for text responses).
func (g *IndexerGatewayConfig) CallIndexerTool(ctx context.Context, toolName string, arguments json.RawMessage) (any, error) {
	if g == nil || strings.TrimSpace(g.BaseURL) == "" || strings.TrimSpace(g.Token) == "" {
		return nil, fmt.Errorf("indexer gateway not configured")
	}
	gw := strings.TrimSpace(g.GatewayName)
	if err := g.Breaker.before(); err != nil {
		handler.RecordIndexerGatewayCall(gw, false, 0)
		return nil, err
	}
	var argsObj any
	if len(arguments) > 0 && string(arguments) != "null" {
		if err := json.Unmarshal(arguments, &argsObj); err != nil {
			return nil, fmt.Errorf("arguments: %w", err)
		}
	} else {
		argsObj = map[string]any{}
	}
	body := map[string]any{
		"jsonrpc": "2.0",
		"id":      nextIndexerRPCID(),
		"method":  "tools/call",
		"params": map[string]any{
			"name":      toolName,
			"arguments": argsObj,
		},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, messageEndpoint(g.BaseURL), bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(g.Token))
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := g.httpClient().Do(req)
	dur := time.Since(start)
	durMs := dur.Milliseconds()
	if err != nil {
		log.Printf("hive-mcp indexer: tool=%s duration_ms=%d err=%v", toolName, durMs, err)
		if indexerFailureForBreaker(err, 0, nil) {
			g.Breaker.recordFailure()
		}
		handler.RecordIndexerGatewayCall(gw, false, durMs)
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		log.Printf("hive-mcp indexer: tool=%s duration_ms=%d read_err=%v", toolName, durMs, err)
		if indexerFailureForBreaker(err, resp.StatusCode, nil) {
			g.Breaker.recordFailure()
		}
		handler.RecordIndexerGatewayCall(gw, false, durMs)
		return nil, err
	}
	if resp.StatusCode >= 400 {
		log.Printf("hive-mcp indexer: tool=%s duration_ms=%d http_status=%d", toolName, durMs, resp.StatusCode)
	} else {
		log.Printf("hive-mcp indexer: tool=%s duration_ms=%d ok", toolName, durMs)
	}
	var envelope struct {
		Result any            `json:"result"`
		Error  *rpcErrPayload `json:"error"`
	}
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		parseErr := fmt.Errorf("gateway response: %w", err)
		if indexerFailureForBreaker(parseErr, resp.StatusCode, nil) {
			g.Breaker.recordFailure()
		}
		handler.RecordIndexerGatewayCall(gw, false, durMs)
		return nil, parseErr
	}
	if envelope.Error != nil {
		outErr := fmt.Errorf("indexer gateway: %s", envelope.Error.Message)
		if indexerFailureForBreaker(nil, resp.StatusCode, envelope.Error) {
			g.Breaker.recordFailure()
		}
		handler.RecordIndexerGatewayCall(gw, false, durMs)
		return nil, outErr
	}
	if resp.StatusCode >= 400 {
		outErr := fmt.Errorf("indexer gateway HTTP %d", resp.StatusCode)
		if indexerFailureForBreaker(outErr, resp.StatusCode, nil) {
			g.Breaker.recordFailure()
		}
		handler.RecordIndexerGatewayCall(gw, false, durMs)
		return nil, outErr
	}
	g.Breaker.recordSuccess()
	handler.RecordIndexerGatewayCall(gw, true, durMs)
	return envelope.Result, nil
}

// ParseIndexerToolText extracts the first text content item from an MCP tools/call result.
func ParseIndexerToolText(result any) (string, error) {
	m, ok := result.(map[string]any)
	if !ok {
		b, _ := json.Marshal(result)
		return string(b), nil
	}
	content, _ := m["content"].([]any)
	if len(content) == 0 {
		b, err := json.Marshal(result)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	first, ok := content[0].(map[string]any)
	if !ok {
		b, err := json.Marshal(result)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	if first["type"] == "text" {
		if s, ok := first["text"].(string); ok {
			return s, nil
		}
	}
	b, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// IndexerHTTPClientFromEnv returns an HTTP client for indexer gateways (HIVE_MCP_INDEXER_HTTP_TIMEOUT_MS, default 90000, max 600000).
func IndexerHTTPClientFromEnv() *http.Client {
	ms := parseIntEnv("HIVE_MCP_INDEXER_HTTP_TIMEOUT_MS", 90000)
	if ms <= 0 {
		ms = 90000
	}
	const maxMs = 600000
	if ms > maxMs {
		ms = maxMs
	}
	return &http.Client{Timeout: time.Duration(ms) * time.Millisecond}
}

// DefaultIndexerHTTPClient is an alias for IndexerHTTPClientFromEnv (tests may override with a custom client on IndexerGatewayConfig).
func DefaultIndexerHTTPClient() *http.Client {
	return IndexerHTTPClientFromEnv()
}

// indexerResponseMaxBytes returns max text bytes forwarded to the model from indexer tools (0 = unlimited).
func indexerResponseMaxBytes() int {
	s := strings.TrimSpace(os.Getenv("HIVE_MCP_INDEXER_MAX_TEXT_BYTES"))
	if s == "" {
		return 0
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < 0 {
		return 0
	}
	if v > 8<<20 {
		return 8 << 20
	}
	return v
}

func maybeTruncateIndexerText(s string, maxBytes int) string {
	if maxBytes <= 0 || len(s) <= maxBytes {
		return s
	}
	const suf = "...[truncated]"
	if maxBytes <= len(suf) {
		if maxBytes <= 3 {
			return s[:maxBytes]
		}
		return s[:maxBytes-3] + "..."
	}
	return s[:maxBytes-len(suf)] + suf
}

// makeIndexerForwarder returns a stdio MCP tool handler that forwards to the HTTP MCP gateway.
func makeIndexerForwarder(g *IndexerGatewayConfig, remoteTool string) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		res, err := g.CallIndexerTool(ctx, remoteTool, args)
		if err != nil {
			return nil, err
		}
		text, err := ParseIndexerToolText(res)
		if err != nil {
			return nil, err
		}
		text = maybeTruncateIndexerText(text, indexerResponseMaxBytes())
		var parsed any
		if err := json.Unmarshal([]byte(text), &parsed); err != nil {
			return text, nil
		}
		return parsed, nil
	}
}

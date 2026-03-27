package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CPClient calls /api/worker-api on the control plane using the worker JWT.
type CPClient struct {
	APIBase string
	JWT     string
	AgentID string
	RunID   string
	HTTP    *http.Client
}

func (c *CPClient) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *CPClient) authHeaders(req *http.Request, jsonBody bool) {
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.JWT))
	if jsonBody {
		req.Header.Set("Content-Type", "application/json")
	}
	if r := strings.TrimSpace(c.RunID); r != "" {
		req.Header.Set("X-Hive-Run-Id", r)
	}
}

func (c *CPClient) postJSON(ctx context.Context, path string, body any) ([]byte, int, error) {
	return c.postJSONWithHeaders(ctx, path, body, nil)
}

func (c *CPClient) postJSONWithHeaders(ctx context.Context, path string, body any, extra map[string]string) ([]byte, int, error) {
	base := strings.TrimSuffix(strings.TrimSpace(c.APIBase), "/")
	u := base + path
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(raw))
	if err != nil {
		return nil, 0, err
	}
	c.authHeaders(req, true)
	for k, v := range extra {
		if strings.TrimSpace(k) != "" && strings.TrimSpace(v) != "" {
			req.Header.Set(k, strings.TrimSpace(v))
		}
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return b, resp.StatusCode, nil
}

func (c *CPClient) get(ctx context.Context, path string) ([]byte, int, error) {
	base := strings.TrimSuffix(strings.TrimSpace(c.APIBase), "/")
	u := base + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	c.authHeaders(req, false)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return b, resp.StatusCode, nil
}

func (c *CPClient) patchJSON(ctx context.Context, path string, body any) ([]byte, int, error) {
	base := strings.TrimSuffix(strings.TrimSpace(c.APIBase), "/")
	u := base + path
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, u, bytes.NewReader(raw))
	if err != nil {
		return nil, 0, err
	}
	c.authHeaders(req, true)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return b, resp.StatusCode, nil
}

func (c *CPClient) costReport(ctx context.Context, args json.RawMessage) (any, error) {
	var m map[string]any
	if len(args) > 0 && string(args) != "null" {
		if err := json.Unmarshal(args, &m); err != nil {
			return nil, fmt.Errorf("cost.report arguments: %w", err)
		}
	}
	if m == nil {
		m = map[string]any{}
	}
	m["agentId"] = strings.TrimSpace(c.AgentID)
	if _, ok := m["occurredAt"]; !ok {
		m["occurredAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if _, ok := m["source"]; !ok {
		m["source"] = "agent_run"
	}
	body, code, err := c.postJSON(ctx, "/worker-api/cost-report", m)
	if err != nil {
		return nil, err
	}
	if code >= 400 {
		return nil, fmt.Errorf("cost.report: status %d: %s", code, string(body))
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *CPClient) issueAppendComment(ctx context.Context, args json.RawMessage) (any, error) {
	var p struct {
		IssueID string `json:"issueId"`
		Body    string `json:"body"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, err
	}
	p.IssueID = strings.TrimSpace(p.IssueID)
	if p.IssueID == "" || strings.TrimSpace(p.Body) == "" {
		return nil, fmt.Errorf("issue.appendComment requires issueId and body")
	}
	payload := map[string]any{
		"agentId": strings.TrimSpace(c.AgentID),
		"body":    p.Body,
	}
	path := "/worker-api/issues/" + url.PathEscape(p.IssueID) + "/comments"
	body, code, err := c.postJSON(ctx, path, payload)
	if err != nil {
		return nil, err
	}
	if code >= 400 {
		return nil, fmt.Errorf("issue.appendComment: status %d: %s", code, string(body))
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *CPClient) issueTransition(ctx context.Context, args json.RawMessage) (any, error) {
	var p struct {
		IssueID string `json:"issueId"`
		Status  string `json:"status"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, err
	}
	p.IssueID = strings.TrimSpace(p.IssueID)
	p.Status = strings.TrimSpace(p.Status)
	if p.IssueID == "" || p.Status == "" {
		return nil, fmt.Errorf("issue.transitionStatus requires issueId and status")
	}
	payload := map[string]any{
		"agentId": strings.TrimSpace(c.AgentID),
		"status":  p.Status,
	}
	path := "/worker-api/issues/" + url.PathEscape(p.IssueID) + "/transition"
	body, code, err := c.postJSON(ctx, path, payload)
	if err != nil {
		return nil, err
	}
	if code >= 400 {
		return nil, fmt.Errorf("issue.transitionStatus: status %d: %s", code, string(body))
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *CPClient) issueGet(ctx context.Context, args json.RawMessage) (any, error) {
	var p struct {
		IssueID string `json:"issueId"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		return nil, err
	}
	p.IssueID = strings.TrimSpace(p.IssueID)
	if p.IssueID == "" {
		return nil, fmt.Errorf("issue.get requires issueId")
	}
	aid := strings.TrimSpace(c.AgentID)
	q := "?agentId=" + url.QueryEscape(aid)
	path := "/worker-api/issues/" + url.PathEscape(p.IssueID) + q
	body, code, err := c.get(ctx, path)
	if err != nil {
		return nil, err
	}
	if code >= 400 {
		return nil, fmt.Errorf("issue.get: status %d: %s", code, string(body))
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *CPClient) issueCreate(ctx context.Context, args json.RawMessage) (any, error) {
	var m map[string]any
	if len(args) > 0 && string(args) != "null" {
		if err := json.Unmarshal(args, &m); err != nil {
			return nil, fmt.Errorf("issue.create arguments: %w", err)
		}
	}
	if m == nil {
		m = map[string]any{}
	}
	m["agentId"] = strings.TrimSpace(c.AgentID)
	var extra map[string]string
	if v, ok := m["idempotencyKey"].(string); ok {
		if k := strings.TrimSpace(v); k != "" {
			extra = map[string]string{"X-Hive-Worker-Idempotency-Key": k}
		}
	}
	delete(m, "idempotencyKey")
	body, code, err := c.postJSONWithHeaders(ctx, "/worker-api/issues", m, extra)
	if err != nil {
		return nil, err
	}
	if code >= 400 {
		return nil, fmt.Errorf("issue.create: status %d: %s", code, string(body))
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *CPClient) issueUpdate(ctx context.Context, args json.RawMessage) (any, error) {
	var m map[string]any
	if err := json.Unmarshal(args, &m); err != nil {
		return nil, fmt.Errorf("issue.update arguments: %w", err)
	}
	issueID, _ := m["issueId"].(string)
	issueID = strings.TrimSpace(issueID)
	if issueID == "" {
		return nil, fmt.Errorf("issue.update requires issueId")
	}
	delete(m, "issueId")
	m["agentId"] = strings.TrimSpace(c.AgentID)
	path := "/worker-api/issues/" + url.PathEscape(issueID)
	body, code, err := c.patchJSON(ctx, path, m)
	if err != nil {
		return nil, err
	}
	if code >= 400 {
		return nil, fmt.Errorf("issue.update: status %d: %s", code, string(body))
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *CPClient) agentRequestHire(ctx context.Context, args json.RawMessage) (any, error) {
	var m map[string]any
	if err := json.Unmarshal(args, &m); err != nil {
		return nil, fmt.Errorf("agent.requestHire arguments: %w", err)
	}
	m["agentId"] = strings.TrimSpace(c.AgentID)
	body, code, err := c.postJSON(ctx, "/worker-api/agent-hires", m)
	if err != nil {
		return nil, err
	}
	if code >= 400 {
		return nil, fmt.Errorf("agent.requestHire: status %d: %s", code, string(body))
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

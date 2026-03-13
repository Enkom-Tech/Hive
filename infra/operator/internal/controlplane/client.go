// Package controlplane provides a REST client for the Squadron (future: Hive) control plane API.
// Package name is neutral so the product rename is a one-line import change.
package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Client talks to the control plane REST API (agents, keys, companies).
type Client struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
	// MaxRetries is the number of retries on 5xx or temporary errors. 0 disables retry.
	MaxRetries int
}

// NewClient returns a client with default HTTP client (10s timeout) and 3 retries on 5xx.
func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL:    baseURL,
		Token:      token,
		MaxRetries: 3,
		HTTPClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// Agent is the control plane agent representation.
type Agent struct {
	ID           string            `json:"id"`
	CompanyID    string            `json:"companyId"`
	Name         string            `json:"name"`
	AdapterType  string            `json:"adapterType"`
	AdapterConfig map[string]interface{} `json:"adapterConfig,omitempty"`
	Metadata     map[string]string `json:"metadata,omitempty"`
	Status       string            `json:"status,omitempty"`
}

// CreateAgentRequest is the payload for POST /companies/:id/agents.
type CreateAgentRequest struct {
	Name          string            `json:"name"`
	AdapterType   string            `json:"adapterType"`
	AdapterConfig map[string]interface{} `json:"adapterConfig,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

// APIKey is the response from POST /agents/:id/keys.
type APIKey struct {
	ID  string `json:"id"`
	Key string `json:"key"`
}

// do sends an authenticated request and decodes the response into v.
// It retries on 5xx or temporary errors when MaxRetries > 0 (exponential backoff).
func (c *Client) do(ctx context.Context, method, path string, body interface{}, v interface{}) error {
	u, err := url.JoinPath(c.BaseURL, path)
	if err != nil {
		return err
	}
	var reqBody []byte
	if body != nil {
		reqBody, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	var lastErr error
	for attempt := 0; attempt <= c.MaxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(attempt) * 100 * time.Millisecond
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(reqBody))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		if c.Token != "" {
			req.Header.Set("Authorization", "Bearer "+c.Token)
		}
		resp, err := c.HTTPClient.Do(req)
		if err != nil {
			lastErr = err
			if isRetryable(err) {
				continue
			}
			return err
		}
		code := resp.StatusCode
		if code >= 200 && code < 300 {
			if v != nil {
				err = json.NewDecoder(resp.Body).Decode(v)
			}
			_ = resp.Body.Close()
			return err
		}
		_ = resp.Body.Close()
		lastErr = fmt.Errorf("control plane API %s %s: %s", method, path, resp.Status)
		if code >= 500 && attempt < c.MaxRetries {
			continue
		}
		return lastErr
	}
	return lastErr
}

func isRetryable(err error) bool {
	if err == nil {
		return false
	}
	// Retry on timeout (context.DeadlineExceeded); do not retry on cancel
	return errors.Is(err, context.DeadlineExceeded)
}

// ListAgents returns agents for a company. Path: GET /api/companies/:companyId/agents.
func (c *Client) ListAgents(ctx context.Context, companyID string) ([]Agent, error) {
	path := fmt.Sprintf("api/companies/%s/agents", url.PathEscape(companyID))
	var out []Agent
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

// CreateAgent creates an agent. Path: POST /api/companies/:companyId/agents.
func (c *Client) CreateAgent(ctx context.Context, companyID string, req CreateAgentRequest) (*Agent, error) {
	path := fmt.Sprintf("api/companies/%s/agents", url.PathEscape(companyID))
	var out Agent
	err := c.do(ctx, http.MethodPost, path, req, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateAgentKey creates an API key for an agent. Path: POST /api/agents/:id/keys.
// Returns the raw key (only time it is visible).
func (c *Client) CreateAgentKey(ctx context.Context, agentID string) (*APIKey, error) {
	path := fmt.Sprintf("api/agents/%s/keys", url.PathEscape(agentID))
	var out APIKey
	err := c.do(ctx, http.MethodPost, path, map[string]string{"label": "hive-operator"}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// PatchAgent updates an agent (e.g. adapterConfig). Path: PATCH /api/agents/:id.
func (c *Client) PatchAgent(ctx context.Context, agentID string, patch map[string]interface{}) error {
	path := fmt.Sprintf("api/agents/%s", url.PathEscape(agentID))
	return c.do(ctx, http.MethodPatch, path, patch, nil)
}

// PauseAgent pauses an agent. Path: POST /api/agents/:id/pause.
func (c *Client) PauseAgent(ctx context.Context, agentID string) error {
	path := fmt.Sprintf("api/agents/%s/pause", url.PathEscape(agentID))
	return c.do(ctx, http.MethodPost, path, nil, nil)
}

// ResumeAgent resumes an agent. Path: POST /api/agents/:id/resume.
func (c *Client) ResumeAgent(ctx context.Context, agentID string) error {
	path := fmt.Sprintf("api/agents/%s/resume", url.PathEscape(agentID))
	return c.do(ctx, http.MethodPost, path, nil, nil)
}

// Health checks the control plane. Path: GET /api/health.
func (c *Client) Health(ctx context.Context) (statusCode int, err error) {
	u, err := url.JoinPath(c.BaseURL, "api/health")
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

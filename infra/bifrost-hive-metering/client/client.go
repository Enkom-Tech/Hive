// Package hivemetering posts inference usage to the Hive control plane (internal API).
package hivemetering

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

type Client struct {
	ControlPlaneBaseURL string
	OperatorBearer      string
	HTTP                *http.Client
	Provider            string
}

func (c *Client) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) trimBase() string {
	return strings.TrimRight(strings.TrimSpace(c.ControlPlaneBaseURL), "/")
}

// LookupCompany resolves a gateway virtual key hash to company UUID via internal API.
func (c *Client) LookupCompany(ctx context.Context, keyHash string) (string, error) {
	base := c.trimBase()
	if base == "" {
		return "", fmt.Errorf("empty ControlPlaneBaseURL")
	}
	u, err := url.Parse(base + "/api/internal/hive/gateway-virtual-key-lookup")
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("keyHash", keyHash)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	if b := strings.TrimSpace(c.OperatorBearer); b != "" {
		req.Header.Set("Authorization", "Bearer "+b)
	}
	res, err := c.client().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	if res.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("unknown virtual key")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("lookup %s: %s", res.Status, string(bytes.TrimSpace(body)))
	}
	var out struct {
		CompanyID string `json:"companyId"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.CompanyID == "" {
		return "", fmt.Errorf("lookup: empty companyId")
	}
	return out.CompanyID, nil
}

// PostGatewayAggregate sends one cost row (same shape as model-gateway-go).
func (c *Client) PostGatewayAggregate(ctx context.Context, companyID, model string, inputTokens, outputTokens, costCents int) error {
	base := c.trimBase()
	if base == "" {
		return fmt.Errorf("empty ControlPlaneBaseURL")
	}
	prov := strings.TrimSpace(c.Provider)
	if prov == "" {
		prov = "bifrost"
	}
	body := map[string]any{
		"companyId":     companyID,
		"source":        "gateway_aggregate",
		"agentId":       nil,
		"provider":      prov,
		"model":         model,
		"inputTokens":   inputTokens,
		"outputTokens":  outputTokens,
		"costCents":     costCents,
		"occurredAt":    time.Now().UTC().Format(time.RFC3339Nano),
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/internal/hive/inference-metering", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if b := strings.TrimSpace(c.OperatorBearer); b != "" {
		req.Header.Set("Authorization", "Bearer "+b)
	}
	res, err := c.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("metering %s: %s", res.Status, string(bytes.TrimSpace(b)))
	}
	return nil
}

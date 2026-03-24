// Package pairing calls the control plane anonymous worker-pairing HTTP API.
package pairing

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var (
	ErrRejected  = errors.New("pairing request was rejected")
	ErrExpired   = errors.New("pairing request expired")
	ErrNotFound  = errors.New("pairing request not found")
	ErrDelivered = errors.New("pairing token was already delivered; create a new request")
)

type createResponse struct {
	RequestID string `json:"requestId"`
	ExpiresAt string `json:"expiresAt"`
}

type pollResponse struct {
	Status            string `json:"status"`
	EnrollmentToken   string `json:"enrollmentToken"`
	AgentID           string `json:"agentId"`
	Error             string `json:"error"`
}

// CreateRequest POSTs /worker-pairing/requests under apiPrefix (e.g. https://board.example.com/api).
func CreateRequest(ctx context.Context, client *http.Client, apiPrefix, agentID string, clientInfo map[string]any) (requestID string, expiresAt time.Time, err error) {
	if client == nil {
		client = http.DefaultClient
	}
	apiPrefix = strings.TrimSuffix(strings.TrimSpace(apiPrefix), "/")
	if apiPrefix == "" {
		return "", time.Time{}, errors.New("empty api prefix")
	}
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return "", time.Time{}, errors.New("empty agent id")
	}

	body := map[string]any{"agentId": agentID}
	if len(clientInfo) > 0 {
		body["clientInfo"] = clientInfo
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", time.Time{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiPrefix+"/worker-pairing/requests", bytes.NewReader(raw))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", time.Time{}, err
	}
	if resp.StatusCode != http.StatusCreated {
		return "", time.Time{}, fmt.Errorf("create pairing request: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}

	var out createResponse
	if err := json.Unmarshal(b, &out); err != nil {
		return "", time.Time{}, fmt.Errorf("decode create response: %w", err)
	}
	out.RequestID = strings.TrimSpace(out.RequestID)
	if out.RequestID == "" {
		return "", time.Time{}, errors.New("create response missing requestId")
	}
	var exp time.Time
	if out.ExpiresAt != "" {
		exp, err = time.Parse(time.RFC3339, out.ExpiresAt)
		if err != nil {
			exp = time.Time{}
		}
	}
	return out.RequestID, exp, nil
}

// PollUntilReady polls GET /worker-pairing/requests/:id until status is ready or a terminal error.
func PollUntilReady(ctx context.Context, client *http.Client, apiPrefix, requestID string, interval time.Duration) (token string, err error) {
	if client == nil {
		client = http.DefaultClient
	}
	apiPrefix = strings.TrimSuffix(strings.TrimSpace(apiPrefix), "/")
	requestID = strings.TrimSpace(requestID)
	if apiPrefix == "" || requestID == "" {
		return "", errors.New("empty api prefix or request id")
	}
	if interval < time.Millisecond {
		interval = 2 * time.Second
	}

	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiPrefix+"/worker-pairing/requests/"+requestID, nil)
		if err != nil {
			return "", err
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		if err != nil {
			return "", err
		}

		if resp.StatusCode == http.StatusNotFound {
			return "", ErrNotFound
		}
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("poll pairing request: %s: %s", resp.Status, strings.TrimSpace(string(b)))
		}

		var pr pollResponse
		if err := json.Unmarshal(b, &pr); err != nil {
			return "", fmt.Errorf("decode poll response: %w", err)
		}
		switch pr.Status {
		case "ready":
			tok := strings.TrimSpace(pr.EnrollmentToken)
			if tok == "" {
				return "", errors.New("ready response missing enrollmentToken")
			}
			return tok, nil
		case "pending", "awaiting_token_fetch":
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(interval):
			}
			continue
		case "rejected":
			return "", ErrRejected
		case "expired":
			return "", ErrExpired
		case "delivered":
			return "", ErrDelivered
		default:
			return "", fmt.Errorf("unexpected pairing status %q", pr.Status)
		}
	}
}

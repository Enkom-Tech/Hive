package toolbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

const allowedActionsEnv = "HIVE_WORKER_TOOL_BRIDGE_ALLOWED_ACTIONS"

type Bridge struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (b *Bridge) Do(ctx context.Context, action string, input map[string]any) (map[string]any, error) {
	if !actionAllowed(action) {
		return nil, fmt.Errorf("tool bridge action not allowlisted: %s", action)
	}
	if strings.TrimSpace(b.BaseURL) == "" || strings.TrimSpace(b.Token) == "" {
		return nil, fmt.Errorf("tool bridge requires base URL and token")
	}
	body, err := json.Marshal(map[string]any{
		"action": action,
		"input":  input,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(b.BaseURL, "/")+"/api/worker-tools/bridge", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+b.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	limit := io.LimitReader(resp.Body, 32*1024)
	respBody, _ := io.ReadAll(limit)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("tool bridge call failed: status=%d", resp.StatusCode)
	}
	out := map[string]any{}
	if len(respBody) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func actionAllowed(action string) bool {
	action = strings.TrimSpace(action)
	if action == "" {
		return false
	}
	allow := strings.TrimSpace(os.Getenv(allowedActionsEnv))
	if allow == "" {
		return false
	}
	for _, part := range strings.Split(allow, ",") {
		if strings.EqualFold(strings.TrimSpace(part), action) {
			return true
		}
	}
	return false
}

func (b *Bridge) httpClient() *http.Client {
	if b.Client != nil {
		return b.Client
	}
	return &http.Client{}
}

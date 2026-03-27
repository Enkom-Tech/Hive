// Command bifrost-sync polls Hive inference-router-config and reconciles Bifrost openai provider keys (hive-sync-*).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/enkom/hive-infra/infra/bifrost-sync/transform"
)

type routerConfig struct {
	ModelGatewayBackend string `json:"modelGatewayBackend"`
	Models              struct {
		Models []transform.RouterModel `json:"models"`
	} `json:"models"`
}

func env(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func main() {
	boardBase := strings.TrimRight(env("HIVE_BIFROST_SYNC_BOARD_BASE_URL", ""), "/")
	token := env("HIVE_BIFROST_SYNC_BOARD_TOKEN", "")
	companyIDs := env("HIVE_BIFROST_SYNC_COMPANY_IDS", "")
	bifrostBase := strings.TrimRight(env("HIVE_BIFROST_SYNC_BIFROST_BASE_URL", ""), "/")
	bifrostTok := env("HIVE_BIFROST_SYNC_BIFROST_TOKEN", "")
	dummyVal := env("HIVE_BIFROST_SYNC_PROVIDER_KEY_VALUE", "hive-unspecified")
	dry := env("HIVE_BIFROST_SYNC_DRY_RUN", "") == "true"
	suffixes := strings.Split(env("HIVE_BIFROST_SYNC_ALLOWED_HOST_SUFFIXES", ".svc.cluster.local,.svc"), ",")

	if boardBase == "" || token == "" || companyIDs == "" || bifrostBase == "" || bifrostTok == "" {
		log.Fatal("missing required env: HIVE_BIFROST_SYNC_BOARD_BASE_URL, HIVE_BIFROST_SYNC_BOARD_TOKEN, HIVE_BIFROST_SYNC_COMPANY_IDS, HIVE_BIFROST_SYNC_BIFROST_BASE_URL, HIVE_BIFROST_SYNC_BIFROST_TOKEN")
	}

	allow := make([]string, 0, len(suffixes))
	for _, s := range suffixes {
		s = strings.TrimSpace(s)
		if s != "" {
			allow = append(allow, s)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	client := &http.Client{Timeout: 45 * time.Second}

	for _, companyID := range strings.Split(companyIDs, ",") {
		companyID = strings.TrimSpace(companyID)
		if companyID == "" {
			continue
		}
		if err := syncCompany(ctx, client, boardBase, token, bifrostBase, bifrostTok, companyID, dummyVal, dry, allow); err != nil {
			log.Fatalf("company %s: %v", companyID, err)
		}
	}
	log.Printf("bifrost-sync: done")
}

func syncCompany(
	ctx context.Context,
	client *http.Client,
	boardBase, boardToken, bifrostBase, bifrostToken, companyID, dummyVal string,
	dryRun bool,
	allow []string,
) error {
	rc, err := fetchRouterConfig(ctx, client, boardBase, boardToken, companyID)
	if err != nil {
		return err
	}
	if rc.ModelGatewayBackend != "" && rc.ModelGatewayBackend != "bifrost" {
		log.Printf("company %s: modelGatewayBackend=%q (skipping; not bifrost)", companyID, rc.ModelGatewayBackend)
		return nil
	}
	grouped := transform.GroupModelsByBaseURL(rc.Models.Models)
	if err := transform.ValidateGroupedBaseURLs(grouped, allow); err != nil {
		return err
	}
	desired := transform.BuildDesiredKeys(grouped, dummyVal)

	existing, err := getOpenAIProvider(ctx, client, bifrostBase, bifrostToken)
	if err != nil {
		return fmt.Errorf("get openai provider: %w", err)
	}
	merged, err := mergeProviderKeys(existing, desired)
	if err != nil {
		return err
	}
	if dryRun {
		enc, _ := json.MarshalIndent(merged, "", "  ")
		n := 0
		if ks, ok := merged["keys"].([]any); ok {
			n = len(ks)
		}
		log.Printf("dry-run: would PUT openai provider keys (%d keys):\n%s", n, string(enc))
		return nil
	}
	if err := putOpenAIProvider(ctx, client, bifrostBase, bifrostToken, merged); err != nil {
		return fmt.Errorf("put openai provider: %w", err)
	}
	return nil
}

func fetchRouterConfig(ctx context.Context, client *http.Client, boardBase, token, companyID string) (*routerConfig, error) {
	url := fmt.Sprintf("%s/api/companies/%s/inference-router-config", boardBase, companyID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		b := bytes.TrimSpace(body)
		snippet := string(b)
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		return nil, fmt.Errorf("board %s: %s", res.Status, snippet)
	}
	var rc routerConfig
	if err := json.Unmarshal(body, &rc); err != nil {
		return nil, err
	}
	return &rc, nil
}

// openAIProviderEnvelope matches GET /api/providers/openai JSON (pass-through for unknown fields).
type openAIProviderEnvelope map[string]json.RawMessage

func getOpenAIProvider(ctx context.Context, client *http.Client, bifrostBase, token string) (openAIProviderEnvelope, error) {
	url := bifrostBase + "/api/providers/openai"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusNotFound {
		return openAIProviderEnvelope{}, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		b := bytes.TrimSpace(body)
		snippet := string(b)
		if len(snippet) > 400 {
			snippet = snippet[:400]
		}
		return nil, fmt.Errorf("bifrost get openai: %s %s", res.Status, snippet)
	}
	var env openAIProviderEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, err
	}
	return env, nil
}

func mergeProviderKeys(existing openAIProviderEnvelope, desired []transform.DesiredKey) (map[string]any, error) {
	raw, err := json.Marshal(existing)
	if err != nil {
		return nil, err
	}
	var base map[string]any
	if err := json.Unmarshal(raw, &base); err != nil {
		return nil, err
	}
	keysRaw, ok := base["keys"]
	if !ok || keysRaw == nil {
		base["keys"] = []any{}
	}
	keysSlice, ok := base["keys"].([]any)
	if !ok {
		return nil, fmt.Errorf("unexpected keys type in provider JSON")
	}
	var kept []any
	for _, k := range keysSlice {
		obj, ok := k.(map[string]any)
		if !ok {
			continue
		}
		name, _ := obj["name"].(string)
		if strings.HasPrefix(name, transform.SyncKeyPrefix()) {
			continue
		}
		kept = append(kept, k)
	}
	for _, d := range desired {
		kept = append(kept, d)
	}
	base["keys"] = kept
	base["provider"] = "openai"
	return base, nil
}

func putOpenAIProvider(ctx context.Context, client *http.Client, bifrostBase, token string, body map[string]any) error {
	url := bifrostBase + "/api/providers/openai"
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		b = bytes.TrimSpace(b)
		snippet := string(b)
		if len(snippet) > 500 {
			snippet = snippet[:500]
		}
		return fmt.Errorf("%s: %s", res.Status, snippet)
	}
	return nil
}

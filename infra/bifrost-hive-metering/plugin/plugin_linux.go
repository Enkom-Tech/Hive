//go:build linux

// Package main is a Bifrost native plugin (build with go build -buildmode=plugin).
// Configure in Bifrost config.json under plugins with name hive_metering and this .so path.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	hivemetering "github.com/enkom/hive-infra/infra/bifrost-hive-metering/client"
	"github.com/maximhq/bifrost/core/schemas"
)

var (
	mu  sync.Mutex
	cli *hivemetering.Client
)

// Init receives plugin config from Bifrost (JSON object).
func Init(config any) error {
	mu.Lock()
	defer mu.Unlock()
	raw, err := json.Marshal(config)
	if err != nil {
		return err
	}
	var m struct {
		ControlPlaneBaseURL string `json:"control_plane_base_url"`
		OperatorBearer      string `json:"operator_bearer"`
		Provider            string `json:"provider"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	if strings.TrimSpace(m.ControlPlaneBaseURL) == "" || strings.TrimSpace(m.OperatorBearer) == "" {
		return fmt.Errorf("hive_metering: control_plane_base_url and operator_bearer are required")
	}
	cli = &hivemetering.Client{
		ControlPlaneBaseURL: m.ControlPlaneBaseURL,
		OperatorBearer:      m.OperatorBearer,
		Provider:            m.Provider,
	}
	return nil
}

func GetName() string { return "hive_metering" }

func Cleanup() error { return nil }

func PreLLMHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	return req, nil, nil
}

func PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, bifrostErr *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	if bifrostErr != nil || resp == nil {
		return resp, bifrostErr, nil
	}
	mu.Lock()
	c := cli
	mu.Unlock()
	if c == nil {
		return resp, bifrostErr, nil
	}
	vk, _ := ctx.Value(schemas.BifrostContextKeyVirtualKey).(string)
	vk = strings.TrimSpace(vk)
	if vk == "" || !strings.HasPrefix(vk, "sk-bf-") {
		return resp, bifrostErr, nil
	}
	sum := sha256.Sum256([]byte(vk))
	keyHash := hex.EncodeToString(sum[:])

	model, inTok, outTok, costCents, ok := extractUsage(resp)
	if !ok {
		return resp, bifrostErr, nil
	}

	go func() {
		bg, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		companyID, err := c.LookupCompany(bg, keyHash)
		if err != nil {
			return
		}
		idemRaw := fmt.Sprintf("%s|%s|%d|%d|%d", keyHash, model, inTok, outTok, costCents)
		idemSum := sha256.Sum256([]byte(idemRaw))
		idem := hex.EncodeToString(idemSum[:])
		_ = c.PostGatewayAggregate(bg, companyID, model, inTok, outTok, costCents, idem)
	}()
	return resp, bifrostErr, nil
}

func extractUsage(resp *schemas.BifrostResponse) (model string, inTok, outTok, costCents int, ok bool) {
	switch {
	case resp.ChatResponse != nil && resp.ChatResponse.Usage != nil:
		u := resp.ChatResponse.Usage
		model = resp.ChatResponse.Model
		inTok = u.PromptTokens
		outTok = u.CompletionTokens
		if u.Cost != nil && u.Cost.TotalCost > 0 {
			costCents = int(u.Cost.TotalCost * 100)
		}
		ok = u.PromptTokens+u.CompletionTokens > 0 || u.TotalTokens > 0
		return
	case resp.TextCompletionResponse != nil && resp.TextCompletionResponse.Usage != nil:
		u := resp.TextCompletionResponse.Usage
		model = resp.TextCompletionResponse.Model
		inTok = u.PromptTokens
		outTok = u.CompletionTokens
		if u.Cost != nil && u.Cost.TotalCost > 0 {
			costCents = int(u.Cost.TotalCost * 100)
		}
		ok = u.PromptTokens+u.CompletionTokens > 0 || u.TotalTokens > 0
		return
	case resp.ResponsesResponse != nil && resp.ResponsesResponse.Usage != nil:
		u := resp.ResponsesResponse.Usage
		model = "bifrost-responses"
		inTok = u.InputTokens
		outTok = u.OutputTokens
		ok = inTok+outTok > 0
		return
	default:
		return
	}
}

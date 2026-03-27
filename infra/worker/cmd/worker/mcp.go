package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/Enkom-Tech/hive-worker/internal/boardurl"
	"github.com/Enkom-Tech/hive-worker/internal/link"
	"github.com/Enkom-Tech/hive-worker/internal/provision"
	"github.com/Enkom-Tech/hive-worker/internal/tools"
)

func runMCPSubcommand(ctx context.Context) error {
	stateDir := strings.TrimSpace(os.Getenv("HIVE_WORKER_STATE_DIR"))
	jwt := link.ReadWorkerApiToken(stateDir)
	if jwt == "" {
		return fmt.Errorf(
			"missing worker API token: connect hive-worker to the control plane first (persisted worker-jwt). " +
				"Set HIVE_WORKER_STATE_DIR if the token is not in the default config directory",
		)
	}
	rawBase := strings.TrimSpace(os.Getenv("HIVE_CONTROL_PLANE_URL"))
	if rawBase == "" {
		return fmt.Errorf("HIVE_CONTROL_PLANE_URL is required")
	}
	apiBase := boardurl.APIPrefix(boardurl.PreferIPv4Loopback(boardurl.NormalizeControlPlaneURL(rawBase)))
	if apiBase == "" {
		return fmt.Errorf("invalid HIVE_CONTROL_PLANE_URL")
	}
	agentID := strings.TrimSpace(os.Getenv("HIVE_AGENT_ID"))
	if agentID == "" {
		return fmt.Errorf("HIVE_AGENT_ID is required for hive-worker mcp (set by the drone for each run)")
	}
	runID := strings.TrimSpace(os.Getenv("HIVE_RUN_ID"))

	cacheDir := strings.TrimSpace(os.Getenv(provision.CacheDirEnv))
	skills, err := tools.LoadWasmSkills(cacheDir)
	if err != nil {
		return fmt.Errorf("load wasm skills: %w", err)
	}

	httpIndexer := tools.IndexerHTTPClientFromEnv()
	maxConc := 1
	if s := strings.TrimSpace(os.Getenv("HIVE_MCP_MAX_CONCURRENT")); s != "" {
		if v, err := strconv.Atoi(s); err == nil && v > 0 && v <= 64 {
			maxConc = v
		}
	}
	cfg := tools.ServeConfig{
		CP: &tools.CPClient{
			APIBase: apiBase,
			JWT:     jwt,
			AgentID: agentID,
			RunID:   runID,
		},
		Wasm:          skills,
		MaxConcurrent: maxConc,
	}
	codeURL := strings.TrimSpace(os.Getenv("HIVE_MCP_CODE_URL"))
	if codeURL == "" {
		codeURL = strings.TrimSpace(os.Getenv("HIVE_MCP_URL"))
	}
	codeTok := strings.TrimSpace(os.Getenv("HIVE_MCP_CODE_TOKEN"))
	if codeTok == "" {
		codeTok = strings.TrimSpace(os.Getenv("HIVE_MCP_TOKEN"))
	}
	if codeURL != "" && codeTok != "" {
		cfg.CodeIndexer = &tools.IndexerGatewayConfig{
			BaseURL: codeURL, Token: codeTok, HTTP: httpIndexer,
			GatewayName: "code",
			Breaker:     tools.NewIndexerCircuitBreaker("code"),
		}
	}
	docsURL := strings.TrimSpace(os.Getenv("HIVE_MCP_DOCS_URL"))
	docsTok := strings.TrimSpace(os.Getenv("HIVE_MCP_DOCS_TOKEN"))
	if docsURL != "" && docsTok != "" {
		cfg.DocsIndexer = &tools.IndexerGatewayConfig{
			BaseURL: docsURL, Token: docsTok, HTTP: httpIndexer,
			GatewayName: "docs",
			Breaker:     tools.NewIndexerCircuitBreaker("docs"),
		}
	}
	return tools.RunMCPStdio(ctx, cfg)
}

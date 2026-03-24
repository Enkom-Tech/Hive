package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/Enkom-Tech/hive-worker/internal/boardurl"
	"github.com/Enkom-Tech/hive-worker/internal/link"
	"github.com/Enkom-Tech/hive-worker/internal/pairing"
)

func envTruthy(key string) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func shouldAutoPairFromEnv() bool {
	if envTruthy("HIVE_PAIRING") && link.TokenFromEnv() == "" {
		cp := strings.TrimSpace(os.Getenv("HIVE_CONTROL_PLANE_URL"))
		agent := strings.TrimSpace(os.Getenv("HIVE_AGENT_ID"))
		return cp != "" && agent != ""
	}
	return false
}

func pairingClientInfo() map[string]any {
	return map[string]any{
		"os":   runtime.GOOS,
		"arch": runtime.GOARCH,
	}
}

func credentialsFromPairing(ctx context.Context, controlPlaneURL, agentID string, pollInterval, timeout time.Duration) (*link.Credentials, error) {
	controlPlaneURL = strings.TrimSpace(controlPlaneURL)
	agentID = strings.TrimSpace(agentID)
	if controlPlaneURL == "" {
		return nil, fmt.Errorf("control plane URL is required (HIVE_CONTROL_PLANE_URL or -control-plane-url)")
	}
	if agentID == "" {
		return nil, fmt.Errorf("agent id is required (HIVE_AGENT_ID or -agent-id)")
	}
	apiPrefix := boardurl.APIPrefix(controlPlaneURL)
	if apiPrefix == "" {
		return nil, fmt.Errorf("invalid control plane URL")
	}
	client := http.DefaultClient
	reqID, expAt, err := pairing.CreateRequest(ctx, client, apiPrefix, agentID, pairingClientInfo())
	if err != nil {
		return nil, err
	}
	log.Printf("pairing: created request id=%s (approve on the board)", reqID)
	pollDeadline := time.Now().Add(timeout)
	if !expAt.IsZero() && expAt.Before(pollDeadline) {
		pollDeadline = expAt
	}
	pctx, pcancel := context.WithDeadline(ctx, pollDeadline)
	defer pcancel()
	tok, err := pairing.PollUntilReady(pctx, client, apiPrefix, reqID, pollInterval)
	if err != nil {
		return nil, err
	}
	log.Printf("pairing: request approved; connecting worker")
	ws := link.WebSocketURLForHTTPBase(controlPlaneURL)
	if ws == "" {
		return nil, fmt.Errorf("could not derive WebSocket URL from control plane URL")
	}
	return &link.Credentials{WSURL: ws, Token: tok, AgentID: agentID}, nil
}

func parsePairSubcommand(ctx context.Context, args []string) (*link.Credentials, error) {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	fs.SetOutput(os.Stderr)
	cp := fs.String("control-plane-url", "", "board HTTP origin (default: $HIVE_CONTROL_PLANE_URL)")
	agent := fs.String("agent-id", "", "managed worker agent id (default: $HIVE_AGENT_ID)")
	poll := fs.Duration("poll-interval", 2*time.Second, "interval between poll requests")
	timeout := fs.Duration("timeout", 15*time.Minute, "max time to wait for board approval")
	_ = fs.Parse(args)
	cpURL := strings.TrimSpace(*cp)
	if cpURL == "" {
		cpURL = strings.TrimSpace(os.Getenv("HIVE_CONTROL_PLANE_URL"))
	}
	agentID := strings.TrimSpace(*agent)
	if agentID == "" {
		agentID = strings.TrimSpace(os.Getenv("HIVE_AGENT_ID"))
	}
	return credentialsFromPairing(ctx, cpURL, agentID, *poll, *timeout)
}

func autoPairFromEnv(ctx context.Context) (*link.Credentials, error) {
	return credentialsFromPairing(ctx,
		os.Getenv("HIVE_CONTROL_PLANE_URL"),
		os.Getenv("HIVE_AGENT_ID"),
		2*time.Second,
		15*time.Minute,
	)
}

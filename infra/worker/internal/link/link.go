// Package link connects the worker to the control plane over WebSocket and handles run/cancel/status/log.
package link

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/Enkom-Tech/hive-worker/internal/adapter"
	"github.com/Enkom-Tech/hive-worker/internal/boardurl"
	"github.com/Enkom-Tech/hive-worker/internal/executor"
	"github.com/Enkom-Tech/hive-worker/internal/instanceid"
	"github.com/Enkom-Tech/hive-worker/internal/runstore"
	"github.com/Enkom-Tech/hive-worker/internal/version"
	"github.com/Enkom-Tech/hive-worker/internal/workspacesync"
	"github.com/gorilla/websocket"
)

const (
	statusRunning   = "running"
	statusDone      = "done"
	statusFailed    = "failed"
	statusCancelled = "cancelled"
)

// shouldRejectPlacement returns true when the control plane bound this run to a different stable instance id.
func shouldRejectPlacement(expectedWorkerInstanceID, localInstanceID string) bool {
	exp := strings.TrimSpace(expectedWorkerInstanceID)
	if exp == "" {
		return false
	}
	local := strings.TrimSpace(localInstanceID)
	if local == "" {
		return true
	}
	return !strings.EqualFold(local, exp)
}

// Client connects to the control plane WebSocket and dispatches runs.
type Client struct {
	Registry *adapter.Registry
	Store    *runstore.Store
	AgentID  string
	Token    string
	WSURL    string
	// StateDir is the directory for persisted instance-id (default: UserConfigDir/hive-worker when empty).
	StateDir string
	// AllowedAgentIDs, if non-empty, rejects run messages whose agentId is not in this list (multi-agent / pool host).
	AllowedAgentIDs []string
}

// Run starts the link client: connects, handles run/cancel messages, sends status and log. Blocks until ctx is done.
func (c *Client) Run(ctx context.Context) error {
	if c.WSURL == "" || c.Token == "" {
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		u, err := url.Parse(c.WSURL)
		if err != nil {
			return err
		}
		dialURL := *u
		q := dialURL.Query()
		q.Set("token", c.Token)
		dialURL.RawQuery = q.Encode()
		conn, resp, err := websocket.DefaultDialer.Dial(dialURL.String(), nil)
		if err != nil {
			if resp != nil {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				_ = resp.Body.Close()
				s := strings.TrimSpace(string(body))
				if len(s) > 200 {
					s = s[:200] + "…"
				}
				log.Printf(
					"link: connect failed: %v; http_status=%d http_body=%q; retry in 5s",
					err,
					resp.StatusCode,
					s,
				)
				if resp.StatusCode == http.StatusUnauthorized {
					if c.recoverFromLink401() {
						select {
						case <-ctx.Done():
							return ctx.Err()
						default:
						}
						continue
					}
				}
			} else {
				log.Printf("link: connect failed: %v; retry in 5s", err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(5 * time.Second):
			}
			continue
		}

		log.Printf("link: connected to %s", wsURLForLog(u))
		c.runLoop(ctx, conn)
		_ = conn.Close()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// recoverFromLink401 handles 401 on WebSocket upgrade: may switch to HIVE_DRONE_PROVISION_TOKEN when the
// persisted link token was rejected (e.g. control plane DB reset). Returns true if the next dial should run immediately.
func (c *Client) recoverFromLink401() bool {
	persisted := ReadPersistedLinkToken(c.StateDir)
	dpv := strings.TrimSpace(os.Getenv("HIVE_DRONE_PROVISION_TOKEN"))
	path := PersistedLinkTokenPathForLog(c.StateDir)
	if path == "" {
		path = "<HIVE_WORKER_STATE_DIR or user config dir>/hive-worker/link-token"
	}

	// Startup prefers persisted token over provision token; if the file is stale (DB wiped) but env has a *new* dpv, retry with it.
	if persisted != "" && c.Token == persisted && dpv != "" && dpv != c.Token {
		log.Printf("link: persisted link token was rejected; retrying with HIVE_DRONE_PROVISION_TOKEN from environment")
		c.Token = dpv
		return true
	}

	switch {
	case dpv != "" && c.Token == dpv:
		log.Printf(
			"link: HIVE_DRONE_PROVISION_TOKEN was rejected (one-time token: it is consumed after a successful hello). "+
				"Mint a new provision token from the board, or use the persisted link token after a successful link. "+
				"Persisted file: %s",
			path,
		)
	case persisted != "" && c.Token == persisted:
		log.Printf(
			"link: persisted link token at %s was rejected. If the control plane database was reset, delete that file and set a new HIVE_DRONE_PROVISION_TOKEN or HIVE_AGENT_KEY.",
			path,
		)
	default:
		log.Printf(
			"link: link authentication failed (401). Verify HIVE_AGENT_KEY / enrollment token, or replace the persisted file at %s after a control plane reset.",
			path,
		)
	}
	return false
}

func wsURLForLog(u *url.URL) string {
	if u == nil {
		return ""
	}
	dup := *u
	dup.RawQuery = ""
	dup.User = nil
	return dup.String()
}

func (c *Client) statsReporter(ctx context.Context, connectedAt time.Time, instanceID string) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			aruns, aagents := 0, 0
			if c.Store != nil {
				aruns = c.Store.ActiveCount()
				aagents = c.Store.ActiveAgentCount()
			}
			uptime := time.Since(connectedAt).Round(time.Second)
			agent := strings.TrimSpace(c.AgentID)
			if agent == "" {
				agent = "-"
			}
			inst := strings.TrimSpace(instanceID)
			if inst == "" {
				inst = "-"
			}
			if n := len(c.AllowedAgentIDs); n > 0 {
				log.Printf(
					"link: status connection=up agent_id=%s active_runs=%d active_agents=%d instance_id=%s pool_allowlist=%d uptime=%s",
					agent, aruns, aagents, inst, n, uptime,
				)
			} else {
				log.Printf(
					"link: status connection=up agent_id=%s active_runs=%d active_agents=%d instance_id=%s uptime=%s",
					agent, aruns, aagents, inst, uptime,
				)
			}
		}
	}
}

func (c *Client) runLoop(ctx context.Context, conn *websocket.Conn) {
	iid, errInst := instanceid.Ensure(c.StateDir)
	if errInst != nil {
		log.Printf("link: instance id: %v", errInst)
	}
	loopCtx, stopStats := context.WithCancel(ctx)
	defer stopStats()
	go c.statsReporter(loopCtx, time.Now(), iid)

	var sendMu sync.Mutex
	send := func(msg interface{}) {
		sendMu.Lock()
		defer sendMu.Unlock()
		_ = conn.WriteJSON(msg)
	}
	host, _ := os.Hostname()
	hello := map[string]interface{}{
		"type":     "hello",
		"hostname": host,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"version":  version.String(),
		"capabilities": map[string]interface{}{
			"placement": "v1",
			"pool":      "v1",
		},
	}
	if iid != "" {
		hello["instanceId"] = iid
	}
	send(hello)

	sendStatus := func(runID, agentID, status string, exitCode *int, errMsg string) {
		payload := map[string]interface{}{
			"type":    "status",
			"runId":   runID,
			"agentId": agentID,
			"status":  status,
		}
		if exitCode != nil {
			payload["exitCode"] = *exitCode
		}
		if errMsg != "" {
			payload["error"] = errMsg
		}
		send(payload)
	}

	sendLog := func(runID, agentID, stream, chunk, ts string) {
		send(map[string]string{
			"type":    "log",
			"runId":   runID,
			"agentId": agentID,
			"stream":  stream,
			"chunk":   chunk,
			"ts":      ts,
		})
	}

	go func() {
		<-ctx.Done()
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg struct {
			Type                     string          `json:"type"`
			Token                    string          `json:"token"`
			RunID                    string          `json:"runId"`
			AgentID                  string          `json:"agentId"`
			AdapterKey               string          `json:"adapterKey"`
			Context                  json.RawMessage `json:"context"`
			PlacementID              string          `json:"placementId"`
			ExpectedWorkerInstanceID string          `json:"expectedWorkerInstanceId"`
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg.Type == "link_token" {
			tok := strings.TrimSpace(msg.Token)
			if tok != "" {
				if err := PersistLinkToken(c.StateDir, tok); err != nil {
					log.Printf("link: persist link token: %v", err)
				} else {
					c.Token = tok
					log.Printf("link: stored link token for reconnect (remove HIVE_DRONE_PROVISION_TOKEN from the service environment if the process still has the one-time value)")
				}
			}
			continue
		}
		switch msg.Type {
		case "run":
			if msg.RunID == "" {
				continue
			}
			runID := msg.RunID
			if shouldRejectPlacement(msg.ExpectedWorkerInstanceID, iid) {
				agentID := msg.AgentID
				if agentID == "" {
					agentID = c.AgentID
				}
				send(map[string]interface{}{
					"type":    "ack",
					"runId":   runID,
					"agentId": agentID,
					"status":  "rejected",
					"code":    "placement_mismatch",
				})
				continue
			}
			agentID := msg.AgentID
			if agentID == "" {
				agentID = c.AgentID
			}
			if len(c.AllowedAgentIDs) > 0 {
				allowed := false
				for _, a := range c.AllowedAgentIDs {
					if strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(agentID)) {
						allowed = true
						break
					}
				}
				if !allowed {
					send(map[string]interface{}{
						"type":    "ack",
						"runId":   runID,
						"agentId": agentID,
						"status":  "rejected",
						"code":    "agent_not_allowed",
					})
					continue
				}
			}
			adapterKey := msg.AdapterKey
			registry := c.Registry
			store := c.Store
			go func() {
				ctxRun, cancel := context.WithCancel(context.Background())
				defer cancel()
				if store != nil {
					store.Register(runID, agentID, cancel)
				}
				defer func() {
					if store != nil {
						store.Unregister(runID)
					}
				}()

				sendStatus(runID, agentID, statusRunning, nil, "")

				payload := &executor.Payload{
					AgentID: agentID,
					RunID:   runID,
					Context: msg.Context,
				}
				workspaceDir := workspaceDirFromContext(msg.Context)
				var stdout, stderr []byte
				var runErr error
				ex := registry.Executor(adapterKey)
				switch execEx := ex.(type) {
				case *executor.ProcessExecutor:
					stdout, stderr, runErr = execEx.RunStream(ctxRun, payload, workspaceDir, func(stream, chunk, ts string) {
						sendLog(runID, agentID, stream, chunk, ts)
					})
				case *executor.AcpxExecutor:
					stdout, stderr, runErr = execEx.RunStream(ctxRun, payload, workspaceDir, func(stream, chunk, ts string) {
						sendLog(runID, agentID, stream, chunk, ts)
					})
				default:
					stdout, stderr, runErr = registry.Run(ctxRun, adapterKey, payload, workspaceDir)
				}

				finishedAt := time.Now().UTC().Format(time.RFC3339Nano)
				if ctxRun.Err() != nil {
					sendStatus(runID, agentID, statusCancelled, nil, "")
				} else if runErr != nil {
					exitOne := 1
					send(map[string]interface{}{
						"type":          "status",
						"runId":         runID,
						"agentId":       agentID,
						"status":        statusFailed,
						"exitCode":      exitOne,
						"error":         runErr.Error(),
						"finishedAt":    finishedAt,
						"stdoutExcerpt": excerpt(string(stdout), 4096),
						"stderrExcerpt": excerpt(string(stderr), 4096),
					})
				} else {
					exitZero := 0
					send(map[string]interface{}{
						"type":          "status",
						"runId":         runID,
						"agentId":       agentID,
						"status":        statusDone,
						"exitCode":      exitZero,
						"finishedAt":    finishedAt,
						"stdoutExcerpt": excerpt(string(stdout), 4096),
						"stderrExcerpt": excerpt(string(stderr), 4096),
					})
				}

				if workspacesync.Enabled() {
					wsRoot := workspaceDir
					if strings.TrimSpace(wsRoot) == "" {
						wsRoot = executor.DefaultWorkspaceRoot()
					}
					go func() {
						ctxSync, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
						defer cancel()
						if err := workspacesync.SyncWorkspace(ctxSync, wsRoot); err != nil {
							log.Printf("workspacesync: %v", err)
						}
					}()
				}
			}()
		case "cancel":
			if msg.RunID != "" && c.Store != nil {
				c.Store.Cancel(msg.RunID)
			}
		}
	}
}

func excerpt(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[len(s)-maxLen:]
}

// AgentAllowlistFromEnv parses HIVE_LINK_AGENT_ALLOWLIST (comma-separated board agent ids). When non-empty, only those agent ids may execute runs on this link (pool / shared instance).
func AgentAllowlistFromEnv() []string {
	raw := strings.TrimSpace(os.Getenv("HIVE_LINK_AGENT_ALLOWLIST"))
	if raw == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func workspaceDirFromContext(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return ""
	}
	hiveWorkspace, ok := obj["hiveWorkspace"].(map[string]any)
	if !ok {
		return ""
	}
	var candidate string
	for _, key := range []string{"cwd", "worktreePath", "path"} {
		if v, ok := hiveWorkspace[key].(string); ok && strings.TrimSpace(v) != "" {
			candidate = strings.TrimSpace(v)
			break
		}
	}
	if candidate == "" {
		return ""
	}

	absCandidate, err := filepath.Abs(candidate)
	if err != nil {
		absCandidate = candidate
	}
	root := executor.DefaultWorkspaceRoot()
	absRoot, err := filepath.Abs(root)
	if err != nil {
		absRoot = root
	}
	rel, err := filepath.Rel(absRoot, absCandidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		log.Printf("link: ignoring hiveWorkspace path outside root: %s", candidate)
		return ""
	}
	return absCandidate
}

// Credentials holds explicit WebSocket URL, enrollment token, and agent id for the link client.
type Credentials struct {
	WSURL   string
	Token   string
	AgentID string
}

// ResolveCredentialsFromEnv reads HIVE_CONTROL_PLANE_* and token env vars.
func ResolveCredentialsFromEnv() Credentials {
	return Credentials{
		WSURL:   WSURLFromEnv(),
		Token:   TokenFromEnv(),
		AgentID: strings.TrimSpace(os.Getenv("HIVE_AGENT_ID")),
	}
}

// WebSocketURLForHTTPBase converts a control plane HTTP(S) base (HIVE_CONTROL_PLANE_URL style) to the workers WebSocket URL.
func WebSocketURLForHTTPBase(httpBase string) string {
	base := boardurl.NormalizeControlPlaneURL(httpBase)
	if base == "" {
		return ""
	}
	base = strings.Replace(base, "http://", "ws://", 1)
	base = strings.Replace(base, "https://", "wss://", 1)
	return boardurl.PreferIPv4Loopback(base + "/api/workers/link")
}

// WSURLFromEnv returns the WebSocket URL for the control plane (HIVE_CONTROL_PLANE_WS_URL or derived from HIVE_CONTROL_PLANE_URL).
func WSURLFromEnv() string {
	if u := os.Getenv("HIVE_CONTROL_PLANE_WS_URL"); u != "" {
		s := strings.TrimSuffix(strings.TrimSpace(u), "/") + "/api/workers/link"
		return boardurl.PreferIPv4Loopback(s)
	}
	return WebSocketURLForHTTPBase(os.Getenv("HIVE_CONTROL_PLANE_URL"))
}

// TokenFromEnv returns the link secret for the WebSocket query param.
// Explicit env vars win over the persisted link-token file so a fresh hive_wen_…
// or agent API key in HIVE_AGENT_KEY is not shadowed by an old link-token from a
// previous run. Persisted file beats HIVE_DRONE_PROVISION_TOKEN so a consumed
// one-time hive_dpv_… left in the environment does not override the server-minted reconnect secret.
func TokenFromEnv() string {
	if t := os.Getenv("HIVE_AGENT_KEY"); t != "" {
		return t
	}
	if t := os.Getenv("HIVE_CONTROL_PLANE_TOKEN"); t != "" {
		return t
	}
	if t := ReadPersistedLinkToken(os.Getenv("HIVE_WORKER_STATE_DIR")); t != "" {
		return t
	}
	if t := os.Getenv("HIVE_DRONE_PROVISION_TOKEN"); t != "" {
		return t
	}
	return ""
}

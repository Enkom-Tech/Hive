// Package linkconfig resolves one or more WebSocket link credentials (multi-slot / supervisor mode).
package linkconfig

import (
	"encoding/json"
	"log"
	"os"
	"strings"

	"github.com/Enkom-Tech/hive-worker/internal/link"
)

type linkEntry struct {
	AgentID string `json:"agentId"`
	Token   string `json:"token"`
}

// ResolveLinks returns credentials for every outbound worker link to open.
// When HIVE_WORKER_LINKS_JSON is unset or invalid, falls back to a single link from ResolveCredentialsFromEnv.
func ResolveLinks() []link.Credentials {
	raw := strings.TrimSpace(os.Getenv("HIVE_WORKER_LINKS_JSON"))
	if raw == "" {
		return []link.Credentials{link.ResolveCredentialsFromEnv()}
	}
	var arr []linkEntry
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		log.Printf("linkconfig: invalid HIVE_WORKER_LINKS_JSON: %v", err)
		return []link.Credentials{link.ResolveCredentialsFromEnv()}
	}
	ws := link.WSURLFromEnv()
	out := make([]link.Credentials, 0, len(arr))
	for _, it := range arr {
		aid := strings.TrimSpace(it.AgentID)
		tok := strings.TrimSpace(it.Token)
		if aid == "" || tok == "" {
			continue
		}
		out = append(out, link.Credentials{WSURL: ws, Token: tok, AgentID: aid})
	}
	if len(out) == 0 {
		return []link.Credentials{link.ResolveCredentialsFromEnv()}
	}
	return out
}

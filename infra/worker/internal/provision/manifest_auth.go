package provision

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	manifestBearerEnv = "HIVE_PROVISION_MANIFEST_BEARER"
	linkTokenFileName = "link-token"
)

// manifestFetchBearer returns an optional Bearer token for GET HIVE_PROVISION_MANIFEST_URL.
// Precedence: HIVE_PROVISION_MANIFEST_BEARER, then the same secrets used for WebSocket link
// (agent key, control plane token, persisted link-token, drone provision token).
func manifestFetchBearer() string {
	if t := strings.TrimSpace(os.Getenv(manifestBearerEnv)); t != "" {
		return t
	}
	if t := strings.TrimSpace(os.Getenv("HIVE_AGENT_KEY")); t != "" {
		return t
	}
	if t := strings.TrimSpace(os.Getenv("HIVE_CONTROL_PLANE_TOKEN")); t != "" {
		return t
	}
	if t := readPersistedLinkTokenForManifest(); t != "" {
		return t
	}
	if t := strings.TrimSpace(os.Getenv("HIVE_DRONE_PROVISION_TOKEN")); t != "" {
		return t
	}
	return ""
}

func readPersistedLinkTokenForManifest() string {
	dir := strings.TrimSpace(os.Getenv("HIVE_WORKER_STATE_DIR"))
	if dir == "" {
		d, err := os.UserConfigDir()
		if err != nil {
			return ""
		}
		dir = filepath.Join(d, "hive-worker")
	}
	data, err := os.ReadFile(filepath.Join(dir, linkTokenFileName))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func applyManifestAuthHeader(req *http.Request) {
	if tok := manifestFetchBearer(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
}

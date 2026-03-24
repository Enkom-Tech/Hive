package provision

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

const (
	manifestURLEnv  = "HIVE_PROVISION_MANIFEST_URL"
	manifestJSONEnv = "HIVE_PROVISION_MANIFEST_JSON"
)

// AdapterManifestEntry is one adapter binary/archive source in a provision manifest.
type AdapterManifestEntry struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256,omitempty"`
}

// ProvisionManifest is the JSON shape for HIVE_PROVISION_MANIFEST_JSON / URL responses.
type ProvisionManifest struct {
	Version      string                         `json:"version"`
	Adapters     map[string]AdapterManifestEntry `json:"adapters"`
	AptPackages  []string                       `json:"aptPackages,omitempty"`
	NpmGlobal    []string                       `json:"npmGlobal,omitempty"`
	DockerImages []string                       `json:"dockerImages,omitempty"`
}

// LoadProvisionManifest reads HIVE_PROVISION_MANIFEST_JSON or fetches HIVE_PROVISION_MANIFEST_URL (HTTPS).
// When using a URL, optional Authorization: Bearer is set from HIVE_PROVISION_MANIFEST_BEARER or link secrets
// (see manifestFetchBearer).
func LoadProvisionManifest(ctx context.Context, client *http.Client) (*ProvisionManifest, error) {
	if inline := strings.TrimSpace(os.Getenv(manifestJSONEnv)); inline != "" {
		var m ProvisionManifest
		if err := json.Unmarshal([]byte(inline), &m); err != nil {
			return nil, fmt.Errorf("%s parse failed: %w", manifestJSONEnv, err)
		}
		return &m, nil
	}

	u := strings.TrimSpace(os.Getenv(manifestURLEnv))
	if u == "" {
		return nil, nil
	}
	if !strings.HasPrefix(strings.ToLower(u), "https://") {
		return nil, fmt.Errorf("%s must use HTTPS: %s", manifestURLEnv, u)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	applyManifestAuthHeader(req)
	if client == nil {
		client = &http.Client{}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("manifest fetch returned %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if err := verifyManifestHTTPSignature(body, resp); err != nil {
		return nil, err
	}
	var m ProvisionManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("manifest decode failed: %w", err)
	}
	return &m, nil
}

func manifestEntryForAdapter(ctx context.Context, client *http.Client, key string) (url string, sha string, ok bool, err error) {
	m, err := LoadProvisionManifest(ctx, client)
	if err != nil || m == nil {
		return "", "", false, err
	}
	e, found := m.Adapters[key]
	if !found {
		return "", "", false, nil
	}
	if strings.TrimSpace(e.URL) == "" {
		return "", "", false, fmt.Errorf("manifest.adapters.%s.url is empty", key)
	}
	return strings.TrimSpace(e.URL), strings.TrimSpace(e.SHA256), true, nil
}
